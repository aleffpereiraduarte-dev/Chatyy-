defmodule ChatyyRouter.HomeConsensusTest do
  @moduledoc "Regressão da casa dupla (carga r4: rota parcial SG↔BR2) e do AckOutbox sem backoff."
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{HomeTable, Router}

  setup do
    c = start(["a", "b", "c"])
    on_exit(fn -> stop(c) end)
    {:ok, c: c}
  end

  defp send(c, r, cid, cmi), do: on(c, r, Router, :send_msg, [cid, "u", "d_#{r}", cmi, "x", [devices: [{"dv", "b"}]]])
  defp owners(c, cid), do: for(r <- ["a", "b", "c"], on(c, r, Registry, :lookup, [ChatyyRouter.ConvRegistry, cid]) != [], do: r)

  test "rota parcial a|c: ack e envio vindos de c NUNCA criam 2ª casa; seq continua ao curar", %{c: c} do
    partition(c, ["a"], ["c"])
    cid = "parcial-1"
    :ok = on(c, "a", HomeTable, :assign, [cid, "a", 1])
    for i <- 1..5, do: assert({:ok, ^i, 1} = send(c, "a", cid, "m#{i}"))
    # c nunca recebeu o commit (sem rota até a); o ack de lá pergunta à maioria (b) e não cria nada
    assert on(c, "c", Router, :home_cast_ack, [cid, "dv", 5]) != :ok
    assert {"a", 1, :explicit} = on(c, "c", HomeTable, :lookup, [cid])
    assert {:error, _} = send(c, "c", cid, "m6")
    assert owners(c, cid) == ["a"]
    for r <- ["b", "c"], do: assert({"a", 1, _} = on(c, r, HomeTable, :lookup, [cid]))
    heal(c, ["a"], ["c"])
    eventually(fn -> match?({:ok, 6, 1}, send(c, "c", cid, "m6")) end, 10_000)
    assert owners(c, cid) == ["a"]
  end

  test "ack de conversa sem casa em lugar nenhum não cria casa e sai do outbox com backoff", %{c: c} do
    cid = "sem-casa"
    :ok = on(c, "c", ChatyyRouter.AckOutbox, :add, [cid, "dv", 9])
    eventually(fn -> on(c, "c", ChatyyRouter.AckOutbox, :pending, []) == 0 end, 5_000)
    for r <- ["a", "b", "c"], do: assert({_, 0, :default} = on(c, r, HomeTable, :lookup, [cid]))
    assert owners(c, cid) == []
    assert on(c, "c", ChatyyRouter.Metrics, :counter, [:ack_outbox_dropped]) == 1
  end

  test "casa inalcançável: AckOutbox espaça as tentativas (não 50/s)", %{c: c} do
    cid = "longe"
    :ok = on(c, "a", HomeTable, :assign, [cid, "a", 1])
    eventually(fn -> {"a", 1, :explicit} == on(c, "c", HomeTable, :lookup, [cid]) end)
    partition(c, ["a"], ["c"])
    :ok = on(c, "c", ChatyyRouter.AckOutbox, :add, [cid, "dv", 3])
    Process.sleep(3_000)
    [{_, 3, n, _, _}] = on(c, "c", :ets, :lookup, [:rt_ack_outbox, {cid, "dv"}])
    # 200+400+800+1600 ms → ≤ 5 tentativas em 3 s (antes: ~150)
    assert n <= 5
    heal(c, ["a"], ["c"])
  end

  test "criação concorrente da mesma conversa nova nas 3 regiões: 1 casa, seqs únicos", %{c: c} do
    cid = "nova-concorrente"
    res = for(r <- ["a", "b", "c"], do: Task.async(fn -> send(c, r, cid, "k#{r}") end)) |> Enum.map(&Task.await(&1, 20_000))
    seqs = for {:ok, s, _} <- res, do: s
    assert Enum.sort(seqs) == Enum.uniq(Enum.sort(seqs))
    assert length(owners(c, cid)) <= 1
    homes = for r <- ["a", "b", "c"], do: on(c, r, HomeTable, :lookup, [cid]) |> elem(0)
    eventually(fn -> (for r <- ["a", "b", "c"], do: on(c, r, HomeTable, :lookup, [cid]) |> elem(0)) |> Enum.uniq() |> length() == 1 end)
    _ = homes
  end

  test "sem maioria ninguém cria casa", %{c: c} do
    partition(c, ["a"], ["b", "c"])
    eventually(fn -> not on(c, "a", ChatyyRouter.Net, :quorum?, []) end)
    # conversa cujo proponente (HRW) seria a: o isolado não consegue criar
    cid = Enum.find(1..500, fn i -> HomeTable.hrw("q#{i}", ["a", "b", "c"]) == "a" end) |> then(&"q#{&1}")
    assert {:error, _} = send(c, "a", cid, "x1")
    assert {_, 0, :default} = on(c, "a", HomeTable, :lookup, [cid])
  end

  test "métrica com nome em tupla aninhada não quebra o /metrics" do
    ChatyyRouter.Metrics.init()
    ChatyyRouter.Metrics.inc({:send, {:replica, :unreachable}})
    ChatyyRouter.Metrics.inc({:send, :ok})
    out = ChatyyRouter.Metrics.prometheus() |> then(fn _ -> :ok end)
    assert out == :ok
  end
end
