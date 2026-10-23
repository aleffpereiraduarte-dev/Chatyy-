defmodule ChatyyRouter.PurgeGcTest do
  @moduledoc "[sgu F3] regra de apagar (persisted de todos / R1 / 30 d) e compactação do Seglog em disco."
  use ExUnit.Case, async: false
  alias ChatyyRouter.{PurgeGc, Seglog, SeglogCompact}

  @day 86_400_000
  @now 1_800_000_000_000

  defp d(dev, opts \\ []) do
    %{
      dev: dev,
      expected: Keyword.get(opts, :expected, true),
      is_sender: Keyword.get(opts, :sender, false),
      msg_ms: @now - Keyword.get(opts, :age, 3_600_000),
      persisted_ms: Keyword.get(opts, :per),
      revoked_ms: Keyword.get(opts, :rev),
      last_seen_ms: Keyword.get(opts, :seen, @now - 60_000)
    }
  end

  defp dec(devs, age \\ 3_600_000), do: PurgeGc.decide(devs, now_ms: @now, msg_ms: @now - age)

  describe "decide/2" do
    test "todos os aparelhos vivos persisted → apaga" do
      assert dec([d("A", per: @now - 120_000), d("B", per: @now - 90_000, sender: true)]) == {:purge, :all_persisted}
    end

    test "um aparelho sem persisted → fica (só ack de entrega não basta)" do
      assert dec([d("A", per: @now - 120_000), d("B")]) == {:keep, :pendente}
    end

    test "persisted recente (< 60 s) → fica (graça)" do
      assert dec([d("A", per: @now - 5_000)]) == {:keep, :graca}
    end

    test "R1: aparelho sem uso há > 30 d sai da conta; revogado também" do
      devs = [d("A", per: @now - 120_000), d("B", seen: @now - 31 * @day), d("C", rev: @now - @day)]
      assert dec(devs) == {:purge, :all_persisted_r1}
    end

    test "nenhum esperado vivo → fica (fantasmas não liberam)" do
      assert dec([d("B", seen: @now - 40 * @day)]) == {:keep, :sem_esperado}
      assert dec([d("?", per: @now - 120_000)]) == {:keep, :sem_esperado}
      assert dec([d("A", expected: false, per: @now - 120_000)]) == {:keep, :sem_esperado}
    end

    test "sem linha na dlv → fica; 30 d → ttl mesmo pendente" do
      assert dec([]) == {:keep, :sem_dlv}
      assert dec([d("A")], 30 * @day) == {:purge, :ttl}
      assert dec([], 31 * @day) == {:purge, :ttl}
    end

    test "last_seen nulo conta como vivo (conservador)" do
      assert dec([d("A", per: @now - 120_000), d("B", seen: nil)]) == {:keep, :pendente}
    end

    test "inbox por aparelho" do
      o = [now_ms: @now, msg_ms: @now - 3_600_000]
      assert PurgeGc.decide_inbox(d("A", per: @now - 120_000), o) == {:purge, :inbox_persisted}
      assert PurgeGc.decide_inbox(d("A"), o) == {:keep, :pendente}
      assert PurgeGc.decide_inbox(nil, o) == {:keep, :sem_dlv}
      assert PurgeGc.decide_inbox(nil, now_ms: @now, msg_ms: @now - 31 * @day) == {:purge, :ttl}
    end
  end

  test "flags do arquivo: padrão dryrun; 0 e 1 explícitos" do
    assert PurgeGc.file_flags("") == %{purge: "dryrun", compact: "dryrun"}
    assert PurgeGc.file_flags("RT_ROUTE=1\nRT_PURGE=1\nRT_COMPACT=0\n") == %{purge: "1", compact: "0"}
    assert PurgeGc.file_flags("# RT_PURGE=1\nRT_PURGE=0\n").purge == "0"
    assert PurgeGc.file_flags("RT_PURGE=yes").purge == "dryrun"
  end

  test "build_devs: congelados do registro mandam; persisted da dlv ou do :rt_body_ack; R1 do e2ee5_devices" do
    dlv = [%{dev: "A", expected: true, persisted_ms: 10}, %{dev: "X", expected: true, persisted_ms: nil}]
    devs = PurgeGc.build_devs(["A", "B"], dlv, %{"B" => 20}, %{"B" => %{revoked_ms: nil, last_seen_ms: 5}})
    assert Enum.map(devs, &{&1.dev, &1.persisted_ms}) == [{"A", 10}, {"B", 20}]
    assert Enum.find(devs, &(&1.dev == "B")).last_seen_ms == 5
    # sem lista congelada: os expected da dlv
    assert PurgeGc.build_devs(nil, dlv, %{}, %{}) |> Enum.map(& &1.dev) == ["A", "X"]
    assert PurgeGc.build_devs(nil, [], %{}, %{}) == []
  end

  test "parse_dlv agrupa por mid" do
    m = PurgeGc.parse_dlv([["10", "AAAA", "t", "1000", "2000"], ["10", "BBBB", "f", "1000", nil], ["11", "AAAA", "t", "1", nil]])
    assert length(m[10]) == 2 and Enum.find(m[10], &(&1.dev == "AAAA")).persisted_ms == 2000
    assert [%{persisted_ms: nil}] = m[11]
  end

  test "lápide: drop_local grava {cid, sub} e purged?/2 responde; conversa sem marca não conta" do
    Application.put_env(:chatyy_router, :store, "ram")
    ChatyyRouter.Metrics.init()
    {:ok, pid} = Seglog.start_link(:rt_f3_purged)
    Process.unlink(pid)

    try do
      refute PurgeGc.purged?(959, 42)
      :ok = PurgeGc.drop_local(959, [42, {:rx, 42, "a@b"}], :all_persisted)
      assert PurgeGc.purged?(959, 42)
      assert PurgeGc.purged?(959, {:rx, 42, "a@b"})
      refute PurgeGc.purged?(960, 42)
      # caminho rápido da F1 com conversa NÃO marcada: só conta, não apaga nada
      :ok = PurgeGc.all_persisted({7777, 1}, %{})
      refute PurgeGc.purged?(7777, 1)
    after
      GenServer.stop(pid)
      Application.delete_env(:chatyy_router, :store)
    end
  end

  describe "compactação (Seglog em disco)" do
    @t :rt_f3_cmp_test
    @far 4_102_444_800_000

    setup do
      dir = Path.join(System.tmp_dir!(), "f3cmp-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      ChatyyRouter.Metrics.init()

      for {k, v} <- [store: "disc", log_dir: dir, fsync: "always", seg_max_bytes: 4_096, log_max_mb: 20_480],
          do: Application.put_env(:chatyy_router, k, v)

      on_exit(fn ->
        stop()
        for k <- [:store, :log_dir, :fsync, :seg_max_bytes, :log_max_mb], do: Application.delete_env(:chatyy_router, k)
        File.rm_rf!(dir)
      end)

      start()
      {:ok, dir: Path.join(dir, Atom.to_string(@t))}
    end

    defp start do
      {:ok, pid} = Seglog.start_link(@t)
      Process.unlink(pid)
      pid
    end

    defp stop do
      case Process.whereis(:"#{@t}_w") do
        nil -> :ok
        pid -> GenServer.stop(pid)
      end
    end

    defp gc_now, do: (send(Process.whereis(:"#{@t}_w"), :gc); :sys.get_state(:"#{@t}_w"))
    defp age_all(dir), do: for(f <- File.ls!(dir), do: File.touch!(Path.join(dir, f), System.os_time(:second) - 2 * 86_400))

    test "1 pendente segura o segmento; a compactação move o vivo e o GC apaga os arquivos velhos", %{dir: dir} do
      body = String.duplicate("x", 300)
      for i <- 1..60, do: :ok = Seglog.put(@t, {959, i}, %{body: body, i: i}, @far, {i, nil})
      assert length(File.ls!(dir)) > 3

      # quase tudo confirmado; 1 pendente no 1º segmento e 1 no meio
      for i <- 1..60, i not in [2, 30], do: Seglog.delete(@t, {959, i})
      :sys.get_state(:"#{@t}_w")
      nsegs = length(File.ls!(dir))
      gc_now()
      # o 1º segmento ainda tem o item 2 vivo: nada foi apagado em ordem
      assert length(File.ls!(dir)) == nsegs

      age_all(dir)
      dry = SeglogCompact.compact(@t, dry_run: true, min_age_ms: 3_600_000, force_sys: true)
      assert dry.moved == 2 and dry.dead_bytes > 0
      assert length(File.ls!(dir)) == nsegs

      r = SeglogCompact.compact(@t, dry_run: false, min_age_ms: 3_600_000, force_sys: true)
      assert r.moved == 2 and r.races == 0
      gc_now()
      assert length(File.ls!(dir)) <= 2
      assert Seglog.get(@t, {959, 2}).i == 2
      assert Seglog.get(@t, {959, 30}).i == 30

      # depois de reiniciar: vivos continuam, apagados não ressuscitam
      stop()
      start()
      assert Seglog.size(@t) == 2
      assert Seglog.get(@t, {959, 30}).i == 30
      assert Seglog.get(@t, {959, 31}) == nil

      # apagar depois da compactação também não ressuscita
      Seglog.delete(@t, {959, 30})
      :sys.get_state(:"#{@t}_w")
      stop()
      start()
      assert Seglog.get(@t, {959, 30}) == nil
      assert Seglog.get(@t, {959, 2}).i == 2
    end

    test "segmento novo demais (< min_age) não é tocado", %{dir: dir} do
      for i <- 1..30, do: :ok = Seglog.put(@t, {1, i}, String.duplicate("y", 300), @far)
      for i <- 2..30, do: Seglog.delete(@t, {1, i})
      r = SeglogCompact.compact(@t, dry_run: false, min_age_ms: 3_600_000, force_sys: true)
      assert r.moved == 0 and r.candidates == 0
      assert Seglog.get(@t, {1, 1}) =~ "y"
      assert length(File.ls!(dir)) > 1
    end

    test "chave apagada durante a compactação (no escritor) não volta", %{dir: dir} do
      for i <- 1..30, do: :ok = Seglog.put(@t, {7, i}, String.duplicate("z", 300), @far)
      for i <- 3..30, do: Seglog.delete(@t, {7, i})
      :sys.get_state(:"#{@t}_w")
      age_all(dir)

      # simula: o delete roda (no processo de quem chama) enquanto a compactação está no escritor
      w = Process.whereis(:"#{@t}_w")
      me = self()

      :sys.replace_state(w, fn s ->
        [{k, _, _, _, _, _}] = :ets.lookup(Seglog.idx(@t), {7, 1})
        :ets.take(Seglog.idx(@t), k) && send(me, :taken)
        {r, s2} = SeglogCompact.run(s, dry_run: false, min_age_ms: 3_600_000)
        send(me, {:r, r})
        s2
      end)

      assert_receive :taken
      assert_receive {:r, r}
      # {7,1} sumiu do índice antes da troca: nada a mover para ele; {7,2} move
      assert r.moved == 1
      GenServer.cast(w, {:del, {7, 1}})
      :sys.get_state(w)
      stop()
      start()
      assert Seglog.get(@t, {7, 1}) == nil
      assert Seglog.get(@t, {7, 2}) =~ "z"
    end
  end
end
