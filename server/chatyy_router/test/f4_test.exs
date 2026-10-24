defmodule ChatyyRouter.F4Test do
  @moduledoc """
  [sgu F4] conversa body_store = 3 sem nenhuma linha no PG: conv_pts na casa, recibos ✓✓/lida, apagar para todos,
  contadores da lista (não lidas/última/peers) — casa + 2 irmãs, failover, reinício, inerte sem a flag.
  """
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{BodyHome, BodyStore, Directory, F4, Flags, Store}

  @regions ["a", "b", "c", "d", "e"]
  @sis %{"a" => ["b", "c"], "b" => ["c", "d"], "c" => ["d", "e"], "d" => ["e", "a"], "e" => ["a", "b"]}

  setup do
    c = start(@regions)

    for r <- @regions do
      on(c, r, :application, :set_env, [:chatyy_router, :body_sisters, @sis])
      on(c, r, :application, :set_env, [:chatyy_router, :replica_timeout_ms, 1_000])
      :ok = on(c, r, Flags, :override, [:store, true])
      :ok = on(c, r, Flags, :override, [:f4, true])
    end

    on_exit(fn -> stop(c) end)
    {:ok, c: c}
  end

  defp conv(c, cid, home, mode \\ 3) do
    on(c, "a", Directory, :put_members, [cid, ["u1", "u2"]])
    on(c, "a", Directory, :put_devices, ["u1", [{"d1a", "a"}, {"d1b", "b"}]])
    on(c, "a", Directory, :put_devices, ["u2", [{"d2", "c"}]])
    :ok = on(c, "a", BodyHome, :put_conv, [cid, %{home_raw: home, mode: mode}])
    eventually(fn -> Enum.all?(@regions, &(on(c, &1, BodyHome, :mode, [cid]) == mode)) end)
  end

  defp msg(c, r, cid, mid, uid \\ "u1", extra \\ %{}) do
    dev = if uid == "u1", do: "d1a", else: "d2"
    on(c, r, BodyStore, :store, [Map.merge(%{cid: cid, mid: mid, env: "ENV#{mid}", from: "#{uid}@chatyy.com.br", from_uid: uid, from_device: dev}, extra)])
  end

  defp rc(c, r, cid, uid, rtype, upto_mid),
    do: on(c, r, BodyStore, :store, [%{cid: cid, kind: "receipt", from_uid: uid, rtype: rtype, upto_mid: upto_mid, from_device: "x"}])

  defp del(c, r, cid, uid, mid),
    do: on(c, r, BodyStore, :store, [%{cid: cid, kind: "delete", from_uid: uid, from: "#{uid}@chatyy.com.br", ref: mid}])

  defp sum(c, r, cid, uid), do: hd(on(c, r, F4, :summaries, [uid, [cid]]))
  defp entries(c, r, cid), do: on(c, r, F4, :entries, [cid])

  test "inerte: sem RT_F4 ou com body_store < 3 não há pts e recibo/apagar são recusados", %{c: c} do
    conv(c, 401, "a", 2)
    assert {:ok, r} = msg(c, "e", 401, 1)
    refute Map.has_key?(r, :pts)
    assert {:error, :not_f4} = rc(c, "e", 401, "u2", "r", 1)
    assert entries(c, "a", 401) == []

    conv(c, 402, "a", 3)
    for r <- @regions, do: :ok = on(c, r, Flags, :override, [:f4, false])
    assert {:ok, r} = msg(c, "e", 402, 1)
    refute Map.has_key?(r, :pts)
    assert {:error, :not_f4} = del(c, "e", 402, "u1", 1)
    assert on(c, "a", F4, :summaries, ["u2", [402]]) |> hd() |> Map.get(:unread) == 0
  end

  test "conv_pts: crescente na casa, as 2 irmãs têm as mesmas entradas; 40 envios concorrentes sem repetir", %{c: c} do
    conv(c, 410, "a")
    assert {:ok, %{pts: 1, copies: 3}} = msg(c, "e", 410, 100)
    assert {:ok, %{pts: 2}} = msg(c, "d", 410, 101)

    1..40
    |> Task.async_stream(fn i -> msg(c, Enum.at(["b", "c", "e"], rem(i, 3)), 410, 200 + i) end, max_concurrency: 20)
    |> Enum.each(fn {:ok, {:ok, _}} -> :ok end)

    pts = entries(c, "a", 410) |> Enum.map(& &1.pts)
    assert pts == Enum.to_list(1..42)
    eventually(fn -> entries(c, "b", 410) == entries(c, "a", 410) and entries(c, "c", 410) == entries(c, "a", 410) end)
    assert on(c, "b", F4, :hw, [410]) == 42
    # duplicata (mesmo mid/envelope) não gasta pts
    assert {:ok, %{dup: true}} = msg(c, "e", 410, 100)
    assert on(c, "a", F4, :hw, [410]) == 42
  end

  test "não lidas, última, ✓✓/lida por recibo; mandar = ler; recibo velho é stale", %{c: c} do
    conv(c, 420, "b")
    for m <- [10, 11, 12], do: {:ok, _} = msg(c, "a", 420, m)
    s = sum(c, "e", 420, "u2")
    assert s.unread == 3 and s.last.mid == 12 and s.last.from_uid == "u1"
    assert sum(c, "e", 420, "u1").unread == 0

    # u2 recebeu tudo (✓✓) e leu até 11
    assert {:ok, %{pts: _}} = rc(c, "a", 420, "u2", "d", 12)
    assert {:ok, _} = rc(c, "d", 420, "u2", "r", 11)
    assert sum(c, "e", 420, "u2").unread == 1
    assert %{"u2" => %{d: dp, r: rp}} = sum(c, "e", 420, "u1").peers
    assert dp == 3 and rp == 2

    # recibo igual = duplicata; menor = stale
    assert {:ok, %{dup: true}} = rc(c, "a", 420, "u2", "r", 11)
    assert {:ok, %{stale: true}} = rc(c, "a", 420, "u2", "r", 10)

    # mid desconhecido (ex.: anterior à F4 ou de outra casa): resolve pelo maior mid <= o pedido
    assert {:ok, _} = rc(c, "a", 420, "u2", "r", 99)
    assert sum(c, "e", 420, "u2").unread == 0

    # u2 responde: zera o dele; u1 tem 1 não lida
    {:ok, _} = msg(c, "c", 420, 13, "u2")
    assert sum(c, "e", 420, "u2").unread == 0
    assert sum(c, "e", 420, "u1").unread == 1
    assert {:error, :receipt_unresolved} = rc(c, "a", 420, "u2", "r", 1)

    # o recibo vai à fila dos aparelhos (events), inclusive os do próprio usuário
    ev = on(c, "a", BodyStore, :pull, ["d1a", [cid: 420]]).events
    assert Enum.any?(ev, &(&1.kind == :receipt and &1.rtype == "r" and &1.upto == 3))
  end

  test "apagar para todos: só o autor; lápide no corpo (casa+irmãs); fora das não lidas; evento na fila", %{c: c} do
    conv(c, 430, "c")
    {:ok, _} = msg(c, "a", 430, 50)
    {:ok, _} = msg(c, "a", 430, 51)
    :ok = on(c, "a", BodyStore, :ack, ["d2", 430, [50, 51], true])
    assert sum(c, "a", 430, "u2").unread == 2

    assert {:error, :forbidden} = del(c, "b", 430, "u2", 50)
    assert {:error, :unknown_target} = del(c, "b", 430, "u1", 9999)
    assert {:ok, %{tomb: true}} = del(c, "b", 430, "u1", 50)

    tomb = F4.tomb_env(50)
    eventually(fn -> Enum.all?(["c", "d", "e"], &(on(c, &1, Store, :get, [:rt_body, {430, 50}]).sha == BodyStore.sha(tomb))) end)
    s = sum(c, "a", 430, "u2")
    assert s.unread == 1 and s.last.mid == 51
    assert Enum.find(entries(c, "d", 430), &(&1.mid == 50 and &1.kind == :msg)).deleted == true

    # d2 já tinha gravado: recebe de novo a lápide (confirmações reabertas) e o evento
    p = on(c, "a", BodyStore, :pull, ["d2", [cid: 430]])
    assert Enum.map(p.messages, & &1.mid) == [50] and hd(p.messages).env == tomb
    assert [%{kind: :delete, ref: 50}] = p.events
    # repetido = duplicata; edição depois da lápide = stale
    assert {:ok, %{dup: true}} = del(c, "b", 430, "u1", 50)
    assert {:ok, %{stale: true}} = msg(c, "a", 430, 50, "u1", %{kind: "edit", env: "VOLTA", rev: 10})
    {:ok, _} = del(c, "b", 430, "u1", 51)
    assert sum(c, "a", 430, "u2").last.deleted == true
    # o PHP não tem a linha: pergunta ao roteador em qual conversa a mensagem está
    assert %{cid: 430, from_uid: "u1", deleted: true} = on(c, "e", F4, :locate, [[401, 430], 51])
    assert on(c, "e", F4, :locate, [[430], 777]) == nil
  end

  test "since_pts: o aparelho recebe tudo que mudou depois do pts (edição, lápide, recibo)", %{c: c} do
    conv(c, 440, "a")
    for m <- [1, 2, 3], do: {:ok, _} = msg(c, "b", 440, m)
    :ok = on(c, "a", BodyStore, :ack, ["d2", 440, [1, 2, 3], true])
    {:ok, %{pts: p3}} = msg(c, "b", 440, 4)
    {:ok, _} = msg(c, "b", 440, 2, "u1", %{kind: "edit", env: "E2b", rev: 77})
    {:ok, _} = rc(c, "b", 440, "u1", "r", 4)

    r = on(c, "e", BodyStore, :pull, ["d2", [cid: 440, since_pts: p3 - 1]])
    assert Enum.map(r.messages, & &1.mid) == [2, 4]
    assert [%{kind: :receipt}] = r.events
    assert on(c, "e", BodyStore, :pull, ["d2", [cid: 440, since_pts: 99]]).messages == []
    # limite corta pelo menor pts (cursor seguro): 2 primeiros depois de 0 = mids 1 e 3 (o 2 foi editado → pts novo)
    lim = on(c, "e", BodyStore, :pull, ["d2", [cid: 440, since_pts: 0, limit: 2]])
    assert Enum.map(lim.messages, & &1.mid) == [1, 3]
    # pts original da mensagem editada não muda; o da chave sim
    assert on(c, "a", F4, :mid_pts, [440, 2]) == 2
    assert on(c, "a", F4, :sub_pts, [440, 2]) > p3
  end

  test "casa fora: a irmã segue o pts de onde parou; volta e reinício refazem os índices", %{c: c} do
    conv(c, 450, "a")
    for m <- 1..5, do: {:ok, _} = msg(c, "e", 450, m)
    partition(c, ["a"], @regions -- ["a"])
    eventually(fn -> not on(c, "e", ChatyyRouter.Net, :alive?, ["a"]) end)
    assert on(c, "e", BodyHome, :acting, [450]) == "b"
    assert {:ok, %{pts: 6, acting: "b"}} = msg(c, "e", 450, 6)
    assert sum(c, "e", 450, "u2").unread == 6

    heal(c, ["a"], @regions -- ["a"])
    wait_full_mesh(c)
    on(c, "a", BodyStore, :repair_now, [])
    eventually(fn -> on(c, "a", F4, :hw, [450]) == 6 end)
    assert {:ok, %{pts: 7}} = msg(c, "e", 450, 7)

    # reinício do índice em RAM (boot): hw/midx refeitos do Seglog
    for t <- [:rt_f4_hw, :rt_f4_midx, :rt_f4_subpts], do: on(c, "a", :ets, :delete_all_objects, [t])
    assert on(c, "a", F4, :hw, [450]) == 0
    :ok = on(c, "a", F4, :rebuild, [])
    assert on(c, "a", F4, :hw, [450]) == 7 and on(c, "a", F4, :mid_pts, [450, 3]) == 3
  end

  test "F3 apaga o corpo e os contadores ficam (o log não depende do corpo)", %{c: c} do
    conv(c, 460, "d")
    for m <- [1, 2], do: {:ok, _} = msg(c, "a", 460, m)
    for r <- @regions, do: on(c, r, Store, :delete, [:rt_body, {460, 1}])
    s = sum(c, "a", 460, "u2")
    assert s.unread == 2 and s.pts == 2
    assert {:ok, %{pts: 3}} = msg(c, "a", 460, 3)
  end
end
