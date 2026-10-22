defmodule ChatyyRouter.PGTest do
  @moduledoc """
  Cliente PG mínimo contra o PG REAL (só roda com RT_PG_TEST=1, no BR2):
    * réplica local 127.0.0.1:55432 como chatyy_router_ro (SCRAM) — só leitura;
    * master 10.8.0.1:5432 como chatyy_router_cas — só a função CAS, numa linha
      de teste com cid NEGATIVO (apagada depois pelo postgres no US).
  Senhas: RT_PG_RO_FILE / RT_PG_CAS_FILE (0600, fora da árvore sincronizada).
  """
  use ExUnit.Case, async: false
  alias ChatyyRouter.PG

  @moduletag skip: System.get_env("RT_PG_TEST") != "1" && "defina RT_PG_TEST=1 (PG real)"
  @test_cid -990_001

  defp ro do
    {:ok, c} =
      PG.connect(
        host: "127.0.0.1",
        port: 55432,
        user: "chatyy_router_ro",
        password_file: System.get_env("RT_PG_RO_FILE"),
        statement_timeout: 5_000
      )

    c
  end

  defp cas do
    {:ok, c} =
      PG.connect(
        host: "10.8.0.1",
        port: 5432,
        user: "chatyy_router_cas",
        password_file: System.get_env("RT_PG_CAS_FILE"),
        connect_timeout: 8_000
      )

    c
  end

  test "réplica: SCRAM, parâmetros, NULL, erro SQL não derruba a conexão, só leitura" do
    c = ro()
    assert {:ok, %{rows: [["true"]]}} = PG.query(c, "SELECT pg_is_in_recovery()::text")
    assert {:ok, %{columns: ["a", "b", "n"], rows: [["42", "olá", nil]]}} =
             PG.query(c, "SELECT $1::int AS a, $2::text AS b, $3::text AS n", [42, "olá", nil])

    assert {:ok, %{rows: [[n]]}} = PG.query(c, "SELECT count(*)::text FROM conv_home")
    assert String.to_integer(n) >= 0
    assert {:error, %PG.Error{fields: %{"C" => "42P01"}}} = PG.query(c, "SELECT * FROM tabela_que_nao_existe")
    assert {:ok, %{rows: [["1"]]}} = PG.query(c, "SELECT 1::text")
    # papel ro não escreve nem chama a CAS
    assert {:error, %PG.Error{}} = PG.query(c, "SELECT * FROM conv_home_cas(-1, 0, 'br', 'x')")
    assert {:error, %PG.Error{}} = PG.query(c, "SELECT count(*) FROM chat_messages")
    PG.close(c)
  end

  test "réplica: senha errada é recusada" do
    assert {:error, %PG.Error{fields: %{"C" => "28P01"}}} =
             PG.connect(host: "127.0.0.1", port: 55432, user: "chatyy_router_ro", password: "errada")
  end

  test "Directory em modo pg lê membros e aparelhos da réplica" do
    for {k, v} <- [
          dir_source: "pg",
          pg_port: "55432",
          pg_pass_file: System.get_env("RT_PG_RO_FILE"),
          region: "br2",
          regions: [{"br2", node()}]
        ],
        do: Application.put_env(:chatyy_router, k, v)

    ChatyyRouter.Metrics.init()
    start_supervised!(ChatyyRouter.PG.Conn.child_spec(:replica))
    start_supervised!(ChatyyRouter.Directory)

    {t, {:ok, uids}} = :timer.tc(fn -> ChatyyRouter.Directory.members_result(2585) end)
    assert length(uids) == 2
    {t2, {:ok, ^uids}} = :timer.tc(fn -> ChatyyRouter.Directory.members_result(2585) end)
    assert {:ok, devs} = ChatyyRouter.Directory.devices_result(hd(uids))
    assert Enum.all?(devs, fn {d, r} -> is_binary(d) and r == "br2" end)
    assert {:ok, rec} = ChatyyRouter.Directory.recipients_result(2585, nil)
    IO.puts("\n  directory: membros 1ª #{div(t, 1000)} ms, cache #{t2} µs; destinatários 2585 = #{length(rec)}")
    assert {:ok, []} = ChatyyRouter.Directory.members_result("nao-numerico")
  after
    for k <- [:dir_source, :pg_port, :pg_pass_file, :region, :regions], do: Application.delete_env(:chatyy_router, k)
  end

  test "master: conv_home_cas e conv_home_advance (cid negativo de teste)" do
    c = cas()
    q = fn sql, p -> PG.query(c, sql, p) end
    cas_sql = "SELECT ok::text, region, epoch::text FROM conv_home_cas($1::bigint, $2::int, $3, 'teste-router')"
    adv_sql = "SELECT ok::text, region, epoch::text FROM conv_home_advance($1::bigint, $2, $3::int, 'teste-router')"

    {t, r1} = :timer.tc(fn -> q.(cas_sql, [@test_cid, 0, "br"]) end)
    assert {:ok, %{rows: [["true", "br", "1"]]}} = r1
    # CAS com epoch esperado velho: recusa e devolve o atual
    assert {:ok, %{rows: [["false", "br", "1"]]}} = q.(cas_sql, [@test_cid, 0, "mad"])
    assert {:ok, %{rows: [["true", "mad", "2"]]}} = q.(cas_sql, [@test_cid, 1, "mad"])
    # advance: só se mais novo; repetir é idempotente; empate = maior nome de região
    assert {:ok, %{rows: [["true", "scl", "5"]]}} = q.(adv_sql, [@test_cid, "scl", 5])
    assert {:ok, %{rows: [["true", "scl", "5"]]}} = q.(adv_sql, [@test_cid, "scl", 5])
    assert {:ok, %{rows: [["false", "scl", "5"]]}} = q.(adv_sql, [@test_cid, "br", 5])
    assert {:ok, %{rows: [["false", "scl", "5"]]}} = q.(adv_sql, [@test_cid, "usw", 4])
    # papel cas não lê tabelas nem escreve direto
    assert {:error, %PG.Error{}} = q.("SELECT count(*) FROM conv_home", [])
    assert {:error, %PG.Error{}} = q.("DELETE FROM conv_home WHERE cid = $1::bigint", [@test_cid])
    IO.puts("\n  master CAS via WG: 1ª chamada #{div(t, 1000)} ms")
    PG.close(c)
  end

  test "HomeSync: CAS no master chega pela réplica; assign do cluster vai ao master pelo outbox" do
    cid = -990_002
    alias ChatyyRouter.TestCluster, as: TC
    c = TC.start(["br2"])

    try do
      for {k, v} <- [
            home_source: "pg",
            pg_port: "55432",
            pg_pass_file: System.get_env("RT_PG_RO_FILE"),
            pg_master_pass_file: System.get_env("RT_PG_CAS_FILE"),
            pg_poll_ms: "200"
          ],
          do: TC.on(c, "br2", :application, :set_env, [:chatyy_router, k, v])

      specs =
        [ChatyyRouter.PG.Conn.child_spec(:replica), ChatyyRouter.PG.Conn.child_spec(:master)] ++
          ChatyyRouter.HomeSync.child_specs()

      for spec <- specs, do: {:ok, _} = TC.on(c, "br2", Supervisor, :start_child, [ChatyyRouter.Supervisor, spec])
      on = fn m, f, a -> TC.on(c, "br2", m, f, a) end
      ev = fn f ->
        t0 = System.monotonic_time(:millisecond)
        TC.eventually(f, 15_000)
        System.monotonic_time(:millisecond) - t0
      end

      # operador troca a casa no master -> roteador vê pela réplica
      assert {:ok, "mad", 1} = on.(ChatyyRouter.HomeSync, :cas, [cid, 0, "mad"])
      t1 = ev.(fn -> match?({"mad", 1, :explicit}, on.(ChatyyRouter.HomeTable, :lookup, [cid])) end)

      # cluster decide (failover/migração) -> outbox -> conv_home_advance no master
      :ok = on.(ChatyyRouter.HomeTable, :assign, [cid, "scl", 3])
      t2 = ev.(fn -> match?({:conflict, "scl", 3}, on.(ChatyyRouter.HomeSync, :cas, [cid, -1, "x"])) end)

      # o operador volta a mexer (CAS sobre o epoch 3) -> cluster adota epoch 4
      assert {:ok, "eu", 4} = on.(ChatyyRouter.HomeSync, :cas, [cid, 3, "eu"])
      t3 = ev.(fn -> match?({"eu", 4, :explicit}, on.(ChatyyRouter.HomeTable, :lookup, [cid])) end)
      # linha velha da réplica (overlap) pode reenfileirar o par do cluster: o advance
      # devolve o atual do master e o outbox esvazia (idempotente)
      ev.(fn -> on.(ChatyyRouter.HomeSync, :status, []).outbox.pending == 0 end)
      st = on.(ChatyyRouter.HomeSync, :status, [])
      IO.puts("\n  home_sync: master->réplica->roteador #{t1} ms; cluster->master #{t2} ms; adoção #{t3} ms; #{inspect(Map.take(st.sync, [:rows, :polls]))}")
    after
      TC.stop(c)
    end
  end
end
