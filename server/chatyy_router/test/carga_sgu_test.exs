defmodule ChatyyRouter.CargaSguTest do
  @moduledoc """
  [sgu TODOS 2026-10-24] Carga do /store e /pull + falhas (casa fora, irmã fora, US fora, casa+irmã fora) num cluster
  LOCAL de 11 nós com a topologia de produção (regiões, irmãs do corpo, US nunca irmã), Seglog em disco com fsync
  ("disc"/"always", log_dir próprio por nó em /var/tmp). Dados 100 % sintéticos (cid ≥ 9_000_000, "qa-carga-…").
  Rodar no worker NJ: mix test --only carga test/carga_sgu_test.exs  (CARGA_RATES="50,200,500,0" CARGA_SECS=20)
  Saída: linhas "CARGA_RESULT <json>" (o kit /root/sem-gravar-no-us-2026-10-22/todos/carga/rodar.sh junta em resultado.json).
  Limite: todos os nós no mesmo host (sem RTT de WAN, um disco só p/ 11 fsync) → a latência real ≈ esta + RTT até a
  irmã mais longe da casa (capacidade/projecao.txt usa o rtt_us medido em produção).
  """
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{BodyHome, BodyStore, Directory, Flags, TestCarga}
  @moduletag :carga
  @moduletag timeout: 1_800_000

  @regions ~w(br br2 scl mia mex usw sg in eu mad us)
  @edges @regions -- ["us"]
  # = ROUTER_SISTERS de produção (/etc/chatyy-router/env 24/10)
  @sis %{"br" => ["br2", "scl"], "br2" => ["br", "scl"], "scl" => ["br2", "br"], "mia" => ["usw", "mex"], "mex" => ["usw", "mia"],
         "usw" => ["mia", "mex"], "sg" => ["in", "usw"], "in" => ["sg", "eu"], "eu" => ["mad", "br"], "mad" => ["eu", "mia"],
         "us" => ["mia", "usw"]}

  setup do
    run = System.get_env("CARGA_RUN", "#{System.os_time(:second)}")
    root = "/var/tmp/rt-carga/#{run}"
    File.rm_rf!(root)

    c =
      start(@regions,
        env: [store: "disc", fsync: "always", ack_mode: "sister", body_copies: 2, never_sister: ["us"], body_sisters: @sis,
              replica_timeout_ms: 2_000],
        env_by_region: fn r -> [log_dir: Path.join(root, r)] end
      )

    for r <- @regions, do: :ok = on(c, r, Flags, :override, [:store, true])
    on_exit(fn -> stop(c); File.rm_rf!(root) end)
    {:ok, c: c, root: root}
  end

  defp out(name, m), do: IO.puts("CARGA_RESULT " <> JSON.encode!(%{"teste" => name, "r" => jsonable(m)}))

  defp jsonable(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string_k(k), jsonable(v)} end)
  defp jsonable(l) when is_list(l), do: Enum.map(l, &jsonable/1)
  defp jsonable(t) when is_tuple(t), do: inspect(t)
  defp jsonable(x), do: x
  defp to_string_k(k) when is_binary(k), do: k
  defp to_string_k(k), do: inspect(k) |> String.trim_leading(":")

  # conversa sintética: u1 (remetente, 2 aparelhos) + u2 (1 aparelho) [+ u3 em grupo]; casa explícita
  defp convs(c, base, n, opts \\ []) do
    grupo = opts[:grupo] || 0

    for i <- 0..(n - 1) do
      cid = base + i
      home = Enum.at(@edges, rem(i, length(@edges)))
      origin = Enum.at(@edges, rem(i + 3, length(@edges)))
      extra = for g <- 1..grupo//1, grupo > 0, do: "qa-carga-g#{g}-#{cid}"
      on(c, "br", Directory, :put_members, [cid, ["qa-carga-u1-#{cid}", "qa-carga-u2-#{cid}" | extra]])
      on(c, "br", Directory, :put_devices, ["qa-carga-u1-#{cid}", [{"qa-carga-d1-#{cid}", origin}, {"qa-carga-d1b-#{cid}", home}]])
      on(c, "br", Directory, :put_devices, ["qa-carga-u2-#{cid}", [{"qa-carga-d2-#{cid}", home}]])
      for u <- extra, do: on(c, "br", Directory, :put_devices, [u, [{"#{u}-d", home}]])
      :ok = on(c, "br", BodyHome, :put_conv, [cid, %{home_raw: home}])
      {cid, home}
    end
  end

  defp wait_convs(c, cids), do: eventually(fn -> Enum.all?(@regions, fn r -> Enum.all?(cids, &(on(c, r, BodyHome, :check, [&1]) == :ok)) end) end, 60_000)

  defp footprint(c), do: Map.new(@regions, fn r -> {r, on(c, r, TestCarga, :footprint, [])} end)

  test "carga /store por taxa + /pull com fila crescente + memória/disco por mensagem", %{c: c} do
    cs = convs(c, 9_000_000, 400)
    cids = Enum.map(cs, &elem(&1, 0))
    wait_convs(c, cids)
    f0 = footprint(c)

    rates = System.get_env("CARGA_RATES", "50,200,500,0") |> String.split(",") |> Enum.map(&String.to_integer/1)
    secs = String.to_integer(System.get_env("CARGA_SECS", "20"))
    origins = ["br", "eu", "usw", "sg"]

    for rate <- rates do
      n_each = if rate == 0, do: 5_000, else: max(div(rate * secs, length(origins)), 50)
      rate_each = if rate == 0, do: 0, else: max(div(rate, length(origins)), 1)

      rs =
        origins
        |> Task.async_stream(fn o -> {o, on(c, o, TestCarga, :store, [[n: n_each, rate: rate_each, conc: 64, cids: cids,
                                       mid_base: ChatyyRouter.BodyCompare.mid_floor(System.os_time(:millisecond)) + :erlang.phash2({o, rate}, 1_000_000) * 4]], 900_000)} end,
             timeout: :infinity)
        |> Enum.map(fn {:ok, x} -> x end)

      out("store_rate_#{rate}", %{alvo_msg_s: rate, por_origem: Map.new(rs, fn {o, r} -> {o, Map.delete(r, :stored)} end),
                                  rps_total: rs |> Enum.map(fn {_, r} -> r.rps end) |> Enum.sum() |> Float.round(1)})
    end

    f1 = footprint(c)
    total = f1 |> Map.values() |> Enum.map(& &1.rt_body) |> Enum.sum()

    out("footprint_store", %{
      entradas_rt_body_soma_nos: total,
      por_no: Map.new(@regions, fn r -> {r, %{rt_body: f1[r].rt_body, beam_mb_delta: div(f1[r].beam_bytes - f0[r].beam_bytes, 1_048_576),
                                               ets_mb_delta: div(f1[r].ets_bytes - f0[r].ets_bytes, 1_048_576),
                                               disco_mb: div(f1[r].disk_bytes, 1_048_576)}} end),
      bytes_ram_por_entrada: if(total > 0, do: div(Enum.sum(for r <- @regions, do: f1[r].ets_bytes - f0[r].ets_bytes), total), else: 0),
      bytes_disco_por_entrada: if(total > 0, do: div(Enum.sum(for r <- @regions, do: f1[r].disk_bytes - f0[r].disk_bytes), total), else: 0)
    })

    # pull: aparelho u2 de cada conversa (tudo pendente), com cid e sem cid, de um nó que não é a casa
    devs = for {cid, _h} <- cs, do: {"qa-carga-d2-#{cid}", cid}
    out("pull_com_cid", on(c, "mex", TestCarga, :pull, [devs, [conc: 16]], 900_000))
    out("pull_sem_cid", on(c, "mex", TestCarga, :pull, [Enum.take(devs, 50), [conc: 8, sem_cid: true]], 900_000))

    # persisted de metade: pull só devolve o resto
    for {cid, home} <- Enum.take(cs, 200) do
      mids = on(c, home, BodyStore, :aux, [cid]) |> Enum.map(&elem(&1, 0)) |> Enum.filter(&is_integer/1)
      :ok = on(c, home, BodyStore, :ack, ["qa-carga-d2-#{cid}", cid, mids, true])
    end

    Process.sleep(1_000)
    out("pull_apos_persisted_metade", on(c, "mex", TestCarga, :pull, [devs, [conc: 16]], 900_000))
  end

  test "falhas: irmã fora, casa fora, US fora, casa+irmã fora — tempo até voltar a ter 3 cópias e perda", %{c: c} do
    [{cid, "br"} | _] = cs = convs(c, 9_100_000, 11)
    cids = Enum.map(cs, &elem(&1, 0))
    wait_convs(c, cids)
    base = ChatyyRouter.BodyCompare.mid_floor(System.os_time(:millisecond)) + 3_000_000
    pre = on(c, "mex", TestCarga, :store, [[n: 200, rate: 0, conc: 16, cids: [cid], mid_base: base]], 120_000)
    assert pre.ok3 == 200
    before = MapSet.new(for {_, m} <- pre.stored, do: m)
    pull_mids = fn node -> on(c, node, BodyStore, :pull, ["qa-carga-d2-#{cid}", [cid: cid, limit: 5_000]], 60_000).messages |> Enum.map(& &1.mid) |> MapSet.new() end

    # 1) irmã fora (br2): a cópia vai à próxima da cadeia, ✓ continua com 3 cópias
    partition(c, ["br2"], @regions -- ["br2"])
    eventually(fn -> not on(c, "br", ChatyyRouter.Net, :alive?, ["br2"]) end)
    r1 = on(c, "mex", TestCarga, :until_ok, [cid, base + 10_001, 30_000], 60_000)
    l1 = on(c, "mex", TestCarga, :store, [[n: 200, rate: 100, conc: 8, cids: [cid], mid_base: base + 20_000]], 120_000)
    heal(c, ["br2"], @regions -- ["br2"])
    wait_full_mesh(c)
    t = System.monotonic_time(:millisecond)
    on(c, "br", BodyStore, :repair_now, [], 120_000)
    eventually(fn -> on(c, "br2", BodyStore, :aux, [cid]) |> length() >= 400 end, 120_000)
    out("falha_irma_fora", %{ms_ate_3_copias: r1, durante: Map.delete(l1, :stored), ms_reparo_irma_na_volta: System.monotonic_time(:millisecond) - t})

    # 2) casa fora (br): a 1ª irmã viva (br2) assume, pull sem perda
    partition(c, ["br"], @regions -- ["br"])
    eventually(fn -> not on(c, "mex", ChatyyRouter.Net, :alive?, ["br"]) end)
    acting = on(c, "mex", BodyHome, :acting, [cid])
    r2 = on(c, "mex", TestCarga, :until_ok, [cid, base + 30_001, 30_000], 60_000)
    l2 = on(c, "mex", TestCarga, :store, [[n: 200, rate: 100, conc: 8, cids: [cid], mid_base: base + 40_000]], 120_000)
    got = pull_mids.("mex")
    falta = MapSet.difference(before, got) |> MapSet.size()
    heal(c, ["br"], @regions -- ["br"])
    wait_full_mesh(c)
    t = System.monotonic_time(:millisecond)
    on(c, "br", BodyStore, :repair_now, [], 120_000)
    eventually(fn -> MapSet.subset?(MapSet.new(for {_, m} <- l2.stored, do: m), on(c, "br", BodyStore, :aux, [cid]) |> Enum.map(&elem(&1, 0)) |> MapSet.new()) end, 120_000)
    out("falha_casa_fora", %{acting: acting, ms_ate_3_copias: r2, durante: Map.delete(l2, :stored), perdidas_no_pull: falta,
                             ms_casa_completa_na_volta: System.monotonic_time(:millisecond) - t})
    assert falta == 0

    # 3) US fora: nunca é irmã → conversas das casas regionais não sentem
    partition(c, ["us"], @regions -- ["us"])
    eventually(fn -> not on(c, "br", ChatyyRouter.Net, :alive?, ["us"]) end)
    l3 = on(c, "mex", TestCarga, :store, [[n: 500, rate: 0, conc: 32, cids: cids, mid_base: base + 50_000]], 120_000)
    heal(c, ["us"], @regions -- ["us"])
    wait_full_mesh(c)
    out("falha_us_fora", Map.delete(l3, :stored))
    assert l3.ok3 == 500

    # 4) casa + 1ª irmã fora (br + br2): cadeia br→br2,scl → scl assume; quantas cópias sobram?
    partition(c, ["br", "br2"], @regions -- ["br", "br2"])
    eventually(fn -> not on(c, "mex", ChatyyRouter.Net, :alive?, ["br"]) and not on(c, "mex", ChatyyRouter.Net, :alive?, ["br2"]) end)
    acting4 = on(c, "mex", BodyHome, :acting, [cid])
    r4 = on(c, "mex", TestCarga, :until_ok, [cid, base + 60_001, 15_000], 60_000)
    l4 = on(c, "mex", TestCarga, :store, [[n: 100, rate: 50, conc: 8, cids: [cid], mid_base: base + 70_000]], 120_000)
    got4 = pull_mids.("mex")
    falta4 = MapSet.difference(before, got4) |> MapSet.size()
    heal(c, ["br", "br2"], @regions -- ["br", "br2"])
    wait_full_mesh(c)
    t = System.monotonic_time(:millisecond)
    on(c, "br", BodyStore, :repair_now, [], 120_000)
    ok_back = eventually(fn -> on(c, "br", BodyStore, :aux, [cid]) |> length() >= 400 end, 120_000)
    out("falha_casa_e_irma_fora", %{acting: acting4, ate_3_copias: r4, durante: Map.delete(l4, :stored), perdidas_no_pull: falta4,
                                    ms_casa_completa_na_volta: System.monotonic_time(:millisecond) - t, voltou: ok_back})

    # 5) casa morre DE VERDADE (processo parado, não volta): o que estava só na casa? (ack sister = já estava em 2 cópias)
    kill(c, "scl")
    eventually(fn -> not on(c, "mex", ChatyyRouter.Net, :alive?, ["scl"]) end)
    r5 = on(c, "mex", TestCarga, :until_ok, [cid, base + 80_001, 15_000], 60_000)
    out("falha_scl_morto", %{ate_3_copias: r5, perdidas_no_pull: MapSet.difference(before, pull_mids.("mex")) |> MapSet.size()})
  end
end
