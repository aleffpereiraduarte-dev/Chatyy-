defmodule ChatyyRouter.BodyPGTest do
  @moduledoc """
  [sgu F1] BodyStore/BodyCompare contra um PG DE ENSAIO (container descartável; nunca a produção):
  as funções SECURITY DEFINER do kit (ddl/003-f1.sql), a lista de conversas, o comparador, o reparo
  pelo PG e os acks/persisted da dlv. Só roda com RT_PG_F1_TEST=1 + RT_PG_F1_PORT + RT_PG_F1_PASS_FILE
  (ver /root/sem-gravar-no-us-2026-10-22/f1/qa/pg-ensaio.sh). O SQL de ensaio é aplicado por psql
  (`RT_PG_F1_PSQL`, comando que lê SQL do stdin como superusuário).
  """
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{BodyCompare, BodyHome, BodyStore, Directory, Flags, Metrics}

  @moduletag skip: System.get_env("RT_PG_F1_TEST") != "1" && "defina RT_PG_F1_TEST=1 (PG de ensaio)"
  @cid 95_901
  @regions ["a", "b", "c"]

  defp psql(sql) do
    {out, 0} = System.cmd("sh", ["-c", "printf '%s' \"$SQL\" | " <> System.fetch_env!("RT_PG_F1_PSQL")], env: [{"SQL", sql}], stderr_to_stdout: true)
    out
  end

  setup do
    now = System.os_time(:millisecond)
    mid = fn ago, n -> BodyCompare.mid_floor(now - ago) + n end
    [m1, m2, m3] = for n <- 1..3, do: mid.(600_000, n)

    psql("""
    DELETE FROM chat_msg_device_dlv; DELETE FROM chat_message_reactions; DELETE FROM chat_messages; DELETE FROM chat_conversations;
    INSERT INTO chat_conversations (id, home_region, e2ee_mode, body_store, body_store_at) VALUES (#{@cid}, 'a-qa', 1, 1, now() - interval '1 hour'), (95902, 'b', 0, 1, now());
    INSERT INTO chat_messages (id, conversation_id, sender_email, content) VALUES
      (#{m1}, #{@cid}, 'u1@chatyy.com.br', 'ENV-1'), (#{m2}, #{@cid}, 'u1@chatyy.com.br', 'ENV-2'), (#{m3}, #{@cid}, 'u1@chatyy.com.br', 'ENV-3'),
      -- ANTES do body_store_at (2 h atrás; a conversa entrou há 1 h): o comparador NÃO olha
      (#{mid.(7_200_000, 9)}, #{@cid}, 'u1@chatyy.com.br', 'ANTIGA');
    INSERT INTO chat_message_reactions (message_id, email, emoji, enc) VALUES (#{m1}, 'U2@onemundo.com.br', '?', 'RX-ENV'),
      (#{m1}, 'U2@onemundo.com.br', 'v{"s":1}', 'V-ENV');
    INSERT INTO chat_msg_device_dlv (message_id, conversation_id, uid, device_id, expected, msg_at) VALUES
      (#{m1}, #{@cid}, 2, 'd2', true, now() - interval '10 min'), (#{m2}, #{@cid}, 2, 'd2', true, now() - interval '10 min'),
      (#{m3}, #{@cid}, 2, 'd2', true, now() - interval '10 min');
    """)

    env = [
      ack_source: "dlv", dir_source: "local", home_source: "local",
      pg_host: "127.0.0.1", pg_port: System.fetch_env!("RT_PG_F1_PORT"), pg_db: "postgres",
      pg_user: "chatyy_router_ro", pg_pass_file: System.fetch_env!("RT_PG_F1_PASS_FILE"),
      body_conv_ms: 200, body_ack_poll_ms: 300, body_repair_ms: 3_600_000, f1_cmp_ms: 3_600_000, f1_cmp_grace_ms: 1_000,
      body_sisters: %{"a" => ["b", "c"], "b" => ["c", "a"], "c" => ["a", "b"]}
    ]

    c = start(@regions, env: env)
    for r <- @regions, do: :ok = on(c, r, Flags, :override, [:store, true])
    on(c, "a", Directory, :put_members, [@cid, ["u1", "u2"]])
    on(c, "a", Directory, :put_devices, ["u1", [{"d1", "a"}]])
    on(c, "a", Directory, :put_devices, ["u2", [{"d2", "b"}]])
    on_exit(fn -> stop(c) end)
    {:ok, c: c, mids: [m1, m2, m3]}
  end

  test "lista do PG (casa 'a-qa' → a), portões, comparador, reparo pelo PG e persisted da dlv", %{c: c, mids: [m1, m2, m3]} do
    eventually(fn -> Enum.all?(@regions, &(on(c, &1, BodyHome, :check, [@cid]) == :ok)) end, 10_000)
    assert on(c, "b", BodyHome, :home, [@cid]) == "a"
    assert on(c, "c", BodyHome, :check, [95902]) == {:error, :not_e2ee}

    for {m, e} <- [{m1, "ENV-1"}, {m2, "ENV-2"}] do
      {:ok, %{copies: 3}} = on(c, "c", BodyStore, :store, [%{cid: @cid, mid: m, env: e, from: "u1@chatyy.com.br", from_device: "d1"}])
    end

    rep = on(c, "a", BodyCompare, :scan_now, [], 60_000)
    row = rep.cids[Integer.to_string(@cid)]
    assert row.pg_rows == 3 and row.compared == 3
    assert row.kinds.faltando_casa == 1 and row.samples.faltando_casa == [m3]
    assert row.kinds.reacao_faltando == 2
    assert row.kinds.so_no_roteador == 0
    for k <- [:hash_diferente, :faltando_irma, :hash_diferente_irma, :inbox_faltando], do: assert(row.kinds[k] == 0, "#{k}")
    refute rep.criterio_ok
    assert on(c, "a", Metrics, :counter, [{:rt_f1_body_mismatch_events, :faltando_casa}]) == 1
    # 2ª volta igual não conta evento de novo
    on(c, "a", BodyCompare, :scan_now, [], 60_000)
    assert on(c, "a", Metrics, :counter, [{:rt_f1_body_mismatch_events, :faltando_casa}]) == 1

    # S4: reação chega pela fila → some do comparador
    {:ok, _} = on(c, "b", BodyStore, :store, [%{cid: @cid, kind: "reaction", ref: m1, from: "u2@onemundo.com.br", env: "RX-ENV", from_device: "d2"}])
    {:ok, _} = on(c, "b", BodyStore, :store, [%{cid: @cid, kind: "reaction", ref: m1, from: "u2@onemundo.com.br", env: "V-ENV", from_device: "d2", meta: %{"rx_kind" => "v"}}])

    # reparo pelo PG (RT_STORE_REPAIR=pg): a 3ª vem da réplica com o MESMO sha
    :ok = on(c, "a", Flags, :override, [:store_repair, true])
    on(c, "a", BodyCompare, :scan_now, [], 60_000)
    eventually(fn -> on(c, "a", ChatyyRouter.Store, :get, [:rt_body, {@cid, m3}]) != nil end)
    assert on(c, "a", ChatyyRouter.Store, :get, [:rt_body, {@cid, m3}]).src == :pg_repair
    rep = on(c, "a", BodyCompare, :scan_now, [], 60_000)
    assert rep.criterio_ok, inspect(rep.totals)

    # persisted na dlv (fila sombra) → sai do pull do d2 sem ninguém chamar /ack_store
    assert length(on(c, "b", BodyStore, :pull, ["d2", [cid: @cid]]).messages) == 3
    psql("UPDATE chat_msg_device_dlv SET acked_at = now(), persisted_at = now() WHERE message_id IN (#{m1}, #{m2});")
    eventually(fn -> Enum.map(on(c, "b", BodyStore, :pull, ["d2", [cid: @cid]]).messages, & &1.mid) == [m3] end, 10_000)

    # métricas no /metrics
    prom = on(c, "a", Metrics, :prometheus, [])
    assert prom =~ ~s(chatyy_router_rt_f1_body_mismatch{kind="faltando_casa"} 0)
    assert prom =~ "chatyy_router_rt_f1_cmp_criterio_ok 1"
    assert prom =~ ~s(chatyy_router_rt_store_src_total{src="pg_repair"} 1)
  end
end
