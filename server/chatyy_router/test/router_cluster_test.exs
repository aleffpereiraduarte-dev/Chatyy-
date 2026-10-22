defmodule ChatyyRouter.ClusterTest do
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{Router, Store, TestProbe}

  @day 86_400_000

  defp send!(c, r, cid, cmi, devices, body \\ "x") do
    {:ok, seq, epoch} = on(c, r, Router, :send_msg, [cid, "u_#{r}", "dev_#{r}", cmi, body, [devices: devices]])
    {seq, epoch}
  end

  defp send_retry(c, r, cid, cmi, devices, timeout \\ 15_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    Stream.repeatedly(fn ->
      case on(c, r, Router, :send_msg, [cid, "u_#{r}", "dev_#{r}", cmi, "x", [devices: devices]]) do
        {:ok, seq, epoch} ->
          {seq, epoch}

        _err ->
          if System.monotonic_time(:millisecond) > deadline, do: raise("send_retry timeout")
          Process.sleep(100)
          nil
      end
    end)
    |> Enum.find(& &1)
  end

  defp home_of(c, r, cid), do: on(c, r, ChatyyRouter.HomeTable, :lookup, [cid])
  defp assign(c, r, cid, region, epoch), do: on(c, r, ChatyyRouter.HomeTable, :assign, [cid, region, epoch])
  defp rows(c, r, t, p), do: on(c, r, Store, :prefix, [t, p])
  defp inbox(c, r, dev), do: on(c, r, Store, :inbox, [dev])

  describe "3 nós" do
    setup do
      c = start(["a", "b", "c"])
      on_exit(fn -> stop(c) end)
      {:ok, c: c}
    end

    test "ordem total por conversa com 2 remetentes concorrentes e entrega por região", %{c: c} do
      cid = "conv-ordem"
      assign(c, "a", cid, "b", 1)
      eventually(fn -> home_of(c, "c", cid) |> elem(0) == "b" end)
      on(c, "a", TestProbe, :start, ["d_a", false])
      on(c, "c", TestProbe, :start, ["d_c", false])
      devs = [{"d_a", "a"}, {"d_c", "c"}]

      tasks =
        for r <- ["a", "c"] do
          Task.async(fn -> for i <- 1..150, do: send!(c, r, cid, "#{r}-#{i}", devs) |> elem(0) end)
        end

      seqs = tasks |> Enum.flat_map(&Task.await(&1, 60_000))
      assert Enum.sort(seqs) == Enum.to_list(1..300)
      # cada remetente vê seus seq crescentes
      for t <- Enum.chunk_every(seqs, 150), do: assert(t == Enum.sort(t))

      eventually(fn -> length(on(c, "a", TestProbe, :seqs, ["d_a"])) == 300 end)
      eventually(fn -> length(on(c, "c", TestProbe, :seqs, ["d_c"])) == 300 end)
      assert on(c, "a", TestProbe, :seqs, ["d_a"]) == Enum.to_list(1..300)
      assert on(c, "c", TestProbe, :seqs, ["d_c"]) == Enum.to_list(1..300)
      # mensagem só existe na casa (b) e na cópia da irmã (c); não em a
      assert length(rows(c, "b", :rt_msg, cid)) == 300
      assert rows(c, "a", :rt_msg, cid) == []
      eventually(fn -> length(rows(c, "c", :rt_replica, cid)) == 300 end)
    end

    test "dedupe por cmi: reenvio devolve o mesmo seq", %{c: c} do
      cid = "conv-dedupe"
      {s1, _} = send!(c, "a", cid, "m1", [{"x", "b"}])
      {s2, _} = send!(c, "c", cid, "m1", [{"x", "b"}])
      assert s1 == s2
    end

    test "ack de TODOS os aparelhos apaga na casa, na irmã e nas inboxes", %{c: c} do
      cid = "conv-ack"
      assign(c, "a", cid, "a", 1)
      eventually(fn -> home_of(c, "b", cid) |> elem(0) == "a" end)
      devs = [{"p1", "b"}, {"p2", "c"}, {"p3", "c"}]
      for i <- 1..5, do: send!(c, "a", cid, "k#{i}", devs)

      eventually(fn -> length(inbox(c, "b", "p1")) == 5 and length(inbox(c, "c", "p2")) == 5 end)
      eventually(fn -> length(rows(c, "b", :rt_replica, cid)) == 5 end)

      on(c, "b", Router, :ack, ["p1", cid, 5])
      on(c, "c", Router, :ack, ["p2", cid, 5])
      Process.sleep(400)
      # p3 ainda não confirmou: corpo continua na casa
      assert length(rows(c, "a", :rt_msg, cid)) == 5
      assert inbox(c, "b", "p1") == []
      assert length(inbox(c, "c", "p3")) == 5

      on(c, "c", Router, :ack, ["p3", cid, 3])
      eventually(fn -> length(rows(c, "a", :rt_msg, cid)) == 2 end)
      on(c, "c", Router, :ack, ["p3", cid, 5])
      eventually(fn -> rows(c, "a", :rt_msg, cid) == [] and rows(c, "a", :rt_pend, cid) == [] end)
      eventually(fn -> rows(c, "b", :rt_replica, cid) == [] end)
      assert inbox(c, "c", "p3") == []
    end

    test "aparelho offline 30 dias: inbox expira; antes disso fetch devolve", %{c: c} do
      cid = "conv-off"
      assign(c, "a", cid, "a", 1)
      eventually(fn -> home_of(c, "c", cid) |> elem(0) == "a" end)
      send!(c, "b", cid, "o1", [{"off", "c"}])
      eventually(fn -> length(on(c, "c", Router, :fetch, ["off"])) == 1 end)

      # 29 dias: ainda lá
      for r <- ["a", "b", "c"], do: on(c, r, ChatyyRouter.Clock, :advance, [29 * @day])
      on(c, "c", ChatyyRouter.Janitor, :run_now, [])
      assert length(inbox(c, "c", "off")) == 1

      # 31 dias: some da inbox, da casa e da cópia
      for r <- ["a", "b", "c"], do: on(c, r, ChatyyRouter.Clock, :advance, [2 * @day])
      assert %{inbox: 1} = on(c, "c", ChatyyRouter.Janitor, :run_now, [])
      assert %{msgs: 1} = on(c, "a", ChatyyRouter.Janitor, :run_now, [])
      on(c, "b", ChatyyRouter.Janitor, :run_now, [])
      assert inbox(c, "c", "off") == []
      assert rows(c, "a", :rt_msg, cid) == []
      assert rows(c, "b", :rt_replica, cid) == []
    end

    test "queda do nó-casa: irmã assume com epoch+1, seq continua, pendências reentregues", %{c: c} do
      cid = "conv-queda"
      # anel a,b,c: irmã de b = c
      assign(c, "a", cid, "b", 1)
      eventually(fn -> home_of(c, "c", cid) |> elem(0) == "b" end)
      on(c, "a", TestProbe, :start, ["qa", true])
      devs = [{"qa", "a"}, {"qoff", "c"}]
      for i <- 1..50, do: send!(c, "a", cid, "q#{i}", devs)
      eventually(fn -> length(rows(c, "c", :rt_replica, cid)) == 50 end)

      kill(c, "b")
      # sem casa: erro rápido (cliente reenvia), até a irmã assumir
      {seq, epoch} = send_retry(c, "a", cid, "q51", devs)
      assert seq == 51
      assert epoch == 2
      assert {"c", 2, :explicit} = home_of(c, "a", cid)
      # cmi antigo continua deduplicado na nova casa
      assert {50, 2} == send!(c, "a", cid, "q50", devs)
      eventually(fn -> length(inbox(c, "c", "qoff")) == 51 end)
      eventually(fn -> Enum.uniq(on(c, "a", TestProbe, :seqs, ["qa"])) |> Enum.sort() == Enum.to_list(1..51) end)
    end

    test "partição: casa isolada recusa escrita (sem quórum); maioria assume; ao curar a antiga desce", %{c: c} do
      cid = "conv-part"
      assign(c, "b", cid, "a", 1)
      eventually(fn -> home_of(c, "c", cid) |> elem(0) == "a" end)
      for i <- 1..10, do: send!(c, "b", cid, "p#{i}", [{"pc", "c"}])
      eventually(fn -> length(rows(c, "b", :rt_replica, cid)) == 10 end)

      partition(c, ["a"], ["b", "c"])
      # lado minoritário: casa viva, mas sem quórum
      assert {:error, :no_quorum} = on(c, "a", Router, :send_msg, [cid, "u", "da", "iso1", "x", [devices: [{"pc", "c"}]]])

      # maioria: b (irmã de a) assume
      {seq, epoch} = send_retry(c, "c", cid, "p11", [{"pc", "c"}])
      assert seq == 11 and epoch == 2

      heal(c, ["a"], ["b", "c"])
      wait_full_mesh(c)
      eventually(fn -> home_of(c, "a", cid) == {"b", 2, :explicit} end)
      # a antiga casa encaminha p/ a nova; o cmi recusado antes entra uma vez só
      {s12, _} = send_retry(c, "a", cid, "iso1", [{"pc", "c"}])
      {s12b, _} = send_retry(c, "c", cid, "iso1", [{"pc", "c"}])
      assert s12 == 12 and s12b == 12
      eventually(fn -> rows(c, "a", :rt_msg, cid) == [] end)
      eventually(fn -> Enum.map(inbox(c, "c", "pc"), &elem(&1, 1)) == Enum.to_list(1..12) end)
    end

    test "kill switch: RT_ROUTE desligado recusa na hora", %{c: c} do
      on(c, "a", ChatyyRouter.Flags, :override, [false])
      assert {:error, :disabled} = on(c, "a", Router, :send_msg, ["k", "u", "d", "c1", "x", [devices: []]])
      on(c, "a", ChatyyRouter.Flags, :override, [true])
      assert {:ok, 1, _} = on(c, "a", Router, :send_msg, ["k", "u", "d", "c1", "x", [devices: []]])
    end
  end

  describe "5 nós" do
    setup do
      c = start(["a", "b", "c", "d", "e"], sisters: %{"a" => ["d"]})
      on_exit(fn -> stop(c) end)
      {:ok, c: c}
    end

    test "migração da casa a->e sem perda nem duplicata, com envios em voo", %{c: c} do
      cid = "conv-mig"
      assign(c, "b", cid, "a", 1)
      eventually(fn -> Enum.all?(~w(b c d e), &(home_of(c, &1, cid) |> elem(0) == "a")) end)
      devs = [{"m1", "d"}]

      sender =
        Task.async(fn ->
          for i <- 1..200, do: send_retry(c, "c", cid, "mg#{i}", devs) |> elem(0)
        end)

      Process.sleep(50)
      assert {:ok, "e", 2} = on(c, "b", Router, :migrate, [cid, "e"])
      seqs = Task.await(sender, 60_000)
      assert Enum.sort(seqs) == Enum.to_list(1..200)
      assert seqs == Enum.sort(seqs)
      eventually(fn -> home_of(c, "d", cid) == {"e", 2, :explicit} end)
      assert rows(c, "a", :rt_msg, cid) == []
      eventually(fn -> Enum.map(inbox(c, "d", "m1"), &elem(&1, 1)) == Enum.to_list(1..200) end)
    end

    test "irmã preferida (a->d) assume com quórum 3 de 5", %{c: c} do
      cid = "conv-sis"
      assign(c, "b", cid, "a", 1)
      eventually(fn -> home_of(c, "d", cid) |> elem(0) == "a" end)
      send!(c, "b", cid, "s1", [{"z", "e"}])
      eventually(fn -> length(rows(c, "d", :rt_replica, cid)) == 1 end)
      kill(c, "a")
      {seq, epoch} = send_retry(c, "e", cid, "s2", [{"z", "e"}])
      assert {seq, epoch} == {2, 2}
      assert {"d", 2, :explicit} = home_of(c, "b", cid)
    end

    test "partição 2|3: lado de 2 não escreve nem promove", %{c: c} do
      cid = "conv-23"
      assign(c, "c", cid, "a", 1)
      eventually(fn -> home_of(c, "e", cid) |> elem(0) == "a" end)
      send!(c, "b", cid, "x1", [{"z", "e"}])
      eventually(fn -> length(rows(c, "d", :rt_replica, cid)) == 1 end)
      partition(c, ["a", "b"], ["c", "d", "e"])
      assert {:error, :no_quorum} = on(c, "b", Router, :send_msg, [cid, "u", "db", "x2", "x", [devices: [{"z", "e"}]]])
      {seq, _} = send_retry(c, "e", cid, "x3", [{"z", "e"}])
      assert seq == 2
      # lado {a,b}: nenhuma promoção (cid novo cuja casa HRW cai em c/d/e não sobe ali)
      Process.sleep(1_000)
      assert on(c, "b", ChatyyRouter.HomeTable, :failed, []) |> MapSet.size() == 0
    end
  end
end
