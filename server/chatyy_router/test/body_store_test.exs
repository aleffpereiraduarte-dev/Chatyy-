defmodule ChatyyRouter.BodyStoreTest do
  @moduledoc """
  [sgu F1] corpo durável por conversa marcada: casa + 2 irmãs, sem seq (chave = mid do leaf), cenários
  do plano (irmã fora, casa fora, casa troca, aparelho novo A5, reação S4, duplicata, ordem, kill).
  """
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{BodyHome, BodyStore, Directory, Flags, Metrics, Store}

  @regions ["a", "b", "c", "d", "e"]
  @sis %{"a" => ["b", "c"], "b" => ["c", "d"], "c" => ["d", "e"], "d" => ["e", "a"], "e" => ["a", "b"]}

  setup do
    c = start(@regions)

    for r <- @regions do
      on(c, r, :application, :set_env, [:chatyy_router, :body_sisters, @sis])
      on(c, r, :application, :set_env, [:chatyy_router, :replica_timeout_ms, 1_000])
      :ok = on(c, r, Flags, :override, [:store, true])
    end

    on_exit(fn -> stop(c) end)
    {:ok, c: c}
  end

  defp conv(c, cid, home, extra \\ %{}) do
    on(c, "a", Directory, :put_members, [cid, ["u1", "u2"]])
    on(c, "a", Directory, :put_devices, ["u1", [{"d1a", "a"}, {"d1b", "b"}]])
    on(c, "a", Directory, :put_devices, ["u2", [{"d2", "c"}]])
    :ok = on(c, "a", BodyHome, :put_conv, [cid, Map.merge(%{home_raw: home}, extra)])
    eventually(fn -> Enum.all?(@regions, &(on(c, &1, BodyHome, :check, [cid]) == :ok)) end)
  end

  defp put(c, r, cid, mid, env, extra \\ %{}) do
    on(c, r, BodyStore, :store, [Map.merge(%{cid: cid, mid: mid, env: env, from: "u1@chatyy.com.br", from_device: "d1a"}, extra)])
  end

  defp has(c, r, cid, mid), do: on(c, r, Store, :get, [:rt_body, {cid, mid}])
  defp holders(c, cid, mid), do: for(r <- @regions, has(c, r, cid, mid) != nil, do: r)
  defp mids(pull), do: Enum.map(pull.messages, & &1.mid)

  test "casa + 2 irmãs com o mesmo sha; duplicata e conflito; aparelhos congelados na hora", %{c: c} do
    conv(c, 101, "a")
    assert {:ok, %{copies: 3, wanted: 3}} = put(c, "e", 101, 1001, "E1")
    assert holders(c, 101, 1001) == ["a", "b", "c"]
    rec = has(c, "a", 101, 1001)
    assert rec.sha == BodyStore.sha("E1") and rec.env == "E1"
    assert Enum.sort(rec.devices) == ["d1b", "d2"]

    # duplicata (mesmo mid, mesmo envelope) de outro nó: 1 registro só
    assert {:ok, %{dup: true}} = put(c, "d", 101, 1001, "E1")
    assert on(c, "a", Store, :size, [:rt_body]) == 1

    # conflito: mesmo mid, envelope diferente → fica o 1º
    assert {:ok, %{conflict: true}} = put(c, "b", 101, 1001, "OUTRO")
    assert has(c, "a", 101, 1001).sha == BodyStore.sha("E1")
    assert has(c, "b", 101, 1001).sha == BodyStore.sha("E1")
    assert on(c, "a", Metrics, :counter, [:rt_store_conflict_mid]) == 1

    # aparelho novo depois da mensagem não entra nela (como no WA); entra nas próximas
    on(c, "a", Directory, :put_devices, ["u2", [{"d2", "c"}, {"d2x", "c"}]])
    {:ok, _} = put(c, "a", 101, 1002, "E2")
    assert Enum.sort(has(c, "a", 101, 1001).devices) == ["d1b", "d2"]
    assert Enum.sort(has(c, "a", 101, 1002).devices) == ["d1b", "d2", "d2x"]
  end

  test "irmã fora: a cópia vai à próxima viva da cadeia; na volta o reparo completa a irmã", %{c: c} do
    conv(c, 102, "a")
    partition(c, ["c"], @regions -- ["c"])
    eventually(fn -> not on(c, "a", ChatyyRouter.Net, :alive?, ["c"]) end)
    assert {:ok, %{copies: 3}} = put(c, "e", 102, 2001, "S1")
    assert holders(c, 102, 2001) == ["a", "b", "d"]

    heal(c, ["c"], @regions -- ["c"])
    wait_full_mesh(c)
    on(c, "a", BodyStore, :repair_now, [])
    assert "c" in holders(c, 102, 2001)
  end

  test "casa fora: a irmã em exercício aceita e serve o pull; a casa volta e busca o que faltou", %{c: c} do
    conv(c, 103, "a")
    {:ok, %{copies: 3}} = put(c, "e", 103, 3000, "H0")
    partition(c, ["a"], @regions -- ["a"])
    eventually(fn -> not on(c, "e", ChatyyRouter.Net, :alive?, ["a"]) end)

    assert on(c, "e", BodyHome, :acting, [103]) == "b"
    assert {:ok, %{copies: 3, acting: "b"}} = put(c, "e", 103, 3001, "H1")
    assert holders(c, 103, 3001) == ["b", "c", "d"]
    assert mids(on(c, "e", BodyStore, :pull, ["d2", [cid: 103]])) == [3000, 3001]
    # sem cid: pergunta a todos; só a casa em exercício responde (sem duplicar)
    assert mids(on(c, "d", BodyStore, :pull, ["d2"])) == [3000, 3001]

    heal(c, ["a"], @regions -- ["a"])
    wait_full_mesh(c)
    assert has(c, "a", 103, 3001) == nil
    on(c, "a", BodyStore, :repair_now, [])
    assert has(c, "a", 103, 3001).sha == BodyStore.sha("H1")
    assert mids(on(c, "e", BodyStore, :pull, ["d2", [cid: 103]])) == [3000, 3001]
  end

  test "casa troca (A2): a casa nova completa tudo e passa a receber; aparelhos e acks seguem", %{c: c} do
    conv(c, 104, "a")
    for m <- 4001..4003, do: {:ok, _} = put(c, "b", 104, m, "T#{m}")
    :ok = on(c, "b", BodyStore, :ack, ["d2", 104, [4001], true])

    :ok = on(c, "a", BodyHome, :put_conv, [104, %{home_raw: "d"}])
    eventually(fn -> Enum.all?(4001..4003, &(has(c, "d", 104, &1) != nil)) end)
    assert on(c, "e", BodyHome, :acting, [104]) == "d"
    # d trouxe o ack junto com o corpo (e a dlv refaria) → 4001 não é mais pendência do d2
    eventually(fn -> mids(on(c, "e", BodyStore, :pull, ["d2", [cid: 104]])) == [4002, 4003] end)

    assert {:ok, %{copies: 3, acting: "d"}} = put(c, "c", 104, 4004, "T4004")
    assert holders(c, 104, 4004) == ["a", "d", "e"]
  end

  test "aparelho novo (A5): herda só as pendências do antigo até a herança", %{c: c} do
    conv(c, 105, "c")
    {:ok, _} = put(c, "a", 105, 5001, "N1")
    {:ok, _} = put(c, "a", 105, 5002, "N2")
    :ok = on(c, "a", BodyStore, :ack, ["d2", 105, [5001], true])

    assert on(c, "b", BodyStore, :inherit, ["u2", "d2", "d2new"]) == :ok
    eventually(fn -> length(on(c, "e", BodyStore, :inherits, [])) == 1 end)
    eventually(fn -> mids(on(c, "e", BodyStore, :pull, ["d2new", [cid: 105]])) == [5002] end)

    Process.sleep(5)
    {:ok, _} = put(c, "a", 105, 5003, "N3")
    # depois da herança o aparelho antigo não é mais quem decide: a mensagem nova não é herdada
    assert mids(on(c, "e", BodyStore, :pull, ["d2new", [cid: 105]])) == [5002]
    assert {:error, :bad_request} = on(c, "a", BodyStore, :inherit, ["u2", "x", "x"])
  end

  test "reação (S4): fila própria, a mais nova substitui e reabre; velha é ignorada", %{c: c} do
    conv(c, 106, "b")
    {:ok, _} = put(c, "a", 106, 6001, "M")
    rx = fn env, ts -> put(c, "e", 106, nil, env, %{kind: "reaction", ref: 6001, from: "U2@OneMundo.com.br", ts: ts}) end
    assert {:ok, %{copies: 3}} = rx.("R1", 100)
    key = {:rx, 6001, "u2@chatyy.com.br", "r"}
    assert has(c, "b", 106, key).sha == BodyStore.sha("R1")

    :ok = on(c, "a", BodyStore, :ack, ["d2", 106, [key], true])
    assert on(c, "a", BodyStore, :pull, ["d2", [cid: 106]]).reactions == []

    assert {:ok, %{copies: 3}} = rx.("R2", 200)
    assert has(c, "c", 106, key).sha == BodyStore.sha("R2")
    assert [%{env: "R2"}] = on(c, "a", BodyStore, :pull, ["d2", [cid: 106]]).reactions

    assert {:ok, %{stale: true}} = rx.("R0", 50)
    assert has(c, "b", 106, key).sha == BodyStore.sha("R2")
    p = on(c, "a", BodyStore, :pull, ["d1b", [cid: 106]])
    assert mids(p) == [6001] and length(p.reactions) == 1

    # estado (v) do MESMO usuário na MESMA mensagem: chave própria, não substitui a reação (r)
    assert {:ok, %{copies: 3}} = put(c, "e", 106, nil, "V1", %{kind: "reaction", ref: 6001, from: "u2@chatyy.com.br", ts: 150, meta: %{"rx_kind" => "v"}})
    assert has(c, "b", 106, {:rx, 6001, "u2@chatyy.com.br", "v"}).sha == BodyStore.sha("V1")
    assert has(c, "b", 106, key).sha == BodyStore.sha("R2")
    assert length(on(c, "a", BodyStore, :pull, ["d1b", [cid: 106]]).reactions) == 2
    assert {:error, :bad_request} = put(c, "e", 106, nil, "X", %{kind: "reaction", ref: 6001, from: "u2@chatyy.com.br", rx_type: "z"})
  end

  test "edição E2EE no lugar: kind=edit com rev maior substitui e reabre; sem marca = conflito; rev velha = stale", %{c: c} do
    conv(c, 112, "a")
    {:ok, %{copies: 3}} = put(c, "e", 112, 12_001, "ORIG")
    :ok = on(c, "a", BodyStore, :ack, ["d2", 112, [12_001], true])
    assert mids(on(c, "a", BodyStore, :pull, ["d2", [cid: 112]])) == []

    # sem marca de edição: continua conflito, fica o original
    assert {:ok, %{conflict: true}} = put(c, "b", 112, 12_001, "EDIT1")
    assert has(c, "a", 112, 12_001).sha == BodyStore.sha("ORIG")

    # com kind=edit + edited_at: substitui em casa e nas 2 cópias, mantém os aparelhos, reabre o d2
    devs = has(c, "a", 112, 12_001).devices
    assert {:ok, %{copies: 3}} = put(c, "b", 112, 12_001, "EDIT1", %{kind: "edit", edited_at: 5_000})
    for r <- ["a", "b", "c"], do: assert(has(c, r, 112, 12_001).sha == BodyStore.sha("EDIT1"))
    assert has(c, "a", 112, 12_001).devices == devs and has(c, "a", 112, 12_001).rev == 5_000
    assert mids(on(c, "a", BodyStore, :pull, ["d2", [cid: 112]])) == [12_001]

    # revisão igual/menor: stale; a maior seguinte vence
    assert {:ok, %{stale: true}} = put(c, "b", 112, 12_001, "EDIT-VELHA", %{kind: "edit", rev: 4_000})
    assert has(c, "a", 112, 12_001).sha == BodyStore.sha("EDIT1")
    assert {:ok, _} = put(c, "d", 112, 12_001, "EDIT2", %{kind: "edit", rev: 6_000})
    assert has(c, "c", 112, 12_001).sha == BodyStore.sha("EDIT2")
    # mesma edição de novo = duplicata
    assert {:ok, %{dup: true}} = put(c, "d", 112, 12_001, "EDIT2", %{kind: "edit", rev: 6_000})

    # cópia atrasada com a revisão velha não sobrescreve a nova (rev maior vence no keep?)
    :ok = on(c, "c", BodyStore, :put_copies, [[%{has(c, "a", 112, 12_001) | env: "EDIT1", sha: BodyStore.sha("EDIT1"), rev: 5_000}]])
    assert has(c, "c", 112, 12_001).sha == BodyStore.sha("EDIT2")
  end

  test "ordem e concorrência: chave = mid do leaf, pull em ordem de mid, since, sem duplicar", %{c: c} do
    conv(c, 107, "a")
    for m <- [7005, 7003, 7009, 7001], do: {:ok, _} = put(c, "e", 107, m, "O#{m}")
    assert mids(on(c, "d", BodyStore, :pull, ["d2", [cid: 107]])) == [7001, 7003, 7005, 7009]
    assert mids(on(c, "d", BodyStore, :pull, ["d2", [cid: 107, since: 7003]])) == [7005, 7009]

    # 60 envios (20 mids × 3 nós ao mesmo tempo)
    1..60
    |> Task.async_stream(fn i -> put(c, Enum.at(["b", "c", "e"], rem(i, 3)), 107, 8000 + rem(i, 20), "C#{rem(i, 20)}") end, max_concurrency: 30)
    |> Enum.each(fn {:ok, {:ok, _}} -> :ok end)

    got = mids(on(c, "d", BodyStore, :pull, ["d2", [cid: 107, since: 7999]]))
    assert got == Enum.to_list(8000..8019)
    assert on(c, "a", Store, :size, [:rt_body]) == 24
  end

  test "kill e portões: RT_STORE=0, conversa não marcada, conversa sem E2EE, /fanout assíncrono", %{c: c} do
    conv(c, 108, "a")
    :ok = on(c, "e", Flags, :override, [:store, false])
    assert {:error, :disabled} = put(c, "e", 108, 9001, "K")
    assert {:error, :not_enabled} = put(c, "a", 999_999, 9001, "K")
    :ok = on(c, "a", BodyHome, :put_conv, [109, %{home_raw: "a", e2ee: false}])
    eventually(fn -> on(c, "b", BodyHome, :check, [109]) == {:error, :not_e2ee} end)
    assert {:error, :not_e2ee} = put(c, "b", 109, 9001, "K")
    assert {:error, :bad_request} = put(c, "b", 108, nil, "K")

    # gancho do /fanout (R1): cópia assíncrona com src fanout
    :ok = on(c, "c", BodyStore, :from_fanout, [%{cid: 108, seq: 9002, body: "F", from: "u1@chatyy.com.br", ts: 1}])
    eventually(fn -> has(c, "a", 108, 9002) != nil end)
    assert has(c, "a", 108, 9002).src == :fanout
    # com o kill no nó de entrada, o gancho não copia
    :ok = on(c, "e", BodyStore, :from_fanout, [%{cid: 108, seq: 9003, body: "F"}])
    Process.sleep(200)
    assert has(c, "a", 108, 9003) == nil
  end

  test "ponto de extensão da F3: chave com lápide não é regravada (store/cópia)", %{c: c} do
    for r <- @regions, do: on(c, r, :application, :set_env, [:chatyy_router, :body_purge_module, ChatyyRouter.TestFakeF3])

    conv(c, 111, "a")
    assert {:ok, %{copies: 3}} = put(c, "e", 111, 11_001, "V")
    assert {:ok, %{purged: true}} = put(c, "e", 111, 11_002, "V")
    assert holders(c, 111, 11_002) == []
    assert :ok = on(c, "b", BodyStore, :put_copies, [[%{has(c, "a", 111, 11_001) | mid: 11_002}]])
    assert holders(c, 111, 11_002) == []
  end

  test "idempotência por (cid, from_uid, cmi): reenvio com OUTRO mid devolve o mid guardado; pull all/mids + metadados", %{c: c} do
    conv(c, 113, "a")
    meta = %{cmi: "cmi-1", from_uid: "u1", reply_to_id: 77, edit_of: nil, mentions: ["u2"]}
    assert {:ok, %{mid: 13_001, copies: 3}} = put(c, "e", 113, 13_001, "C1", meta)
    # o esqueleto no PG falhou; o app reenviou com mid novo e o mesmo cmi
    assert {:ok, %{mid: 13_001, dup: true, cmi_dup: true}} = put(c, "d", 113, 13_009, "C1", meta)
    assert holders(c, 113, 13_009) == []
    # outro remetente com o mesmo cmi = outra mensagem
    assert {:ok, %{mid: 13_010}} = put(c, "d", 113, 13_010, "C2", %{meta | from_uid: "u2"})
    # a irmã também conhece o cmi (casa fora → ela responde igual)
    partition(c, ["a"], @regions -- ["a"])
    eventually(fn -> not on(c, "e", ChatyyRouter.Net, :alive?, ["a"]) end)
    assert {:ok, %{mid: 13_001, cmi_dup: true}} = put(c, "e", 113, 13_011, "C1", meta)
    heal(c, ["a"], @regions -- ["a"])
    wait_full_mesh(c)

    :ok = on(c, "a", BodyStore, :ack, ["d2", 113, [13_001], true])
    eventually(fn -> mids(on(c, "e", BodyStore, :pull, ["d2", [cid: 113]])) == [13_010] end)
    assert mids(on(c, "e", BodyStore, :pull, ["d2", [cid: 113, all: true]])) == [13_001, 13_010]
    [m] = on(c, "e", BodyStore, :pull, ["d2", [cid: 113, mids: [13_001]]]).messages
    assert m.cmi == "cmi-1" and m.from_uid == "u1" and m.reply_to_id == 77 and m.mentions == ["u2"] and m.from_device == "d1a"
    # mids vale até para quem não era esperado (o PHP pede por id)
    assert [_] = on(c, "e", BodyStore, :pull, ["outro", [cid: 113, mids: [13_001]]]).messages
  end

  test "persisted de todos tira do pull e conta 'apagaria' — a F1 NÃO apaga", %{c: c} do
    conv(c, 110, "a")
    {:ok, _} = put(c, "e", 110, 10_001, "P")
    :ok = on(c, "b", BodyStore, :ack, ["d1b", 110, [10_001], false])
    # só entregue (sem persisted) continua pendente
    assert mids(on(c, "e", BodyStore, :pull, ["d1b", [cid: 110]])) == [10_001]
    :ok = on(c, "b", BodyStore, :ack, ["d1b", 110, [10_001], true])
    :ok = on(c, "b", BodyStore, :ack, ["d2", 110, [10_001], true])
    eventually(fn -> on(c, "a", Metrics, :counter, [:rt_f1_would_purge]) == 1 end)
    eventually(fn -> mids(on(c, "e", BodyStore, :pull, ["d1b", [cid: 110]])) == [] end)
    assert holders(c, 110, 10_001) == ["a", "b", "c"]
  end
end
