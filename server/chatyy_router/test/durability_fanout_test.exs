defmodule ChatyyRouter.DurabilityFanoutTest do
  @moduledoc "ACK_MODE=sister (confirma só depois da irmã gravar) e R1 /fanout (casa externa)."
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{Router, Store, TestProbe}

  describe "ack_mode sister" do
    setup do
      c = start(["a", "b", "c"], ack_mode: "sister", sisters: %{"a" => ["b"], "b" => ["c"], "c" => ["a"]})
      for r <- ["a", "b", "c"], do: on(c, r, :application, :set_env, [:chatyy_router, :replica_timeout_ms, 300])
      on_exit(fn -> stop(c) end)
      {:ok, c: c}
    end

    test "irmã travada: não confirma nem entrega; reenvio com o mesmo cmi confirma o MESMO seq uma vez", %{c: c} do
      cid = "conv-sis"
      on(c, "a", ChatyyRouter.HomeTable, :assign, [cid, "a", 1])
      eventually(fn -> on(c, "c", ChatyyRouter.HomeTable, :lookup, [cid]) |> elem(0) == "a" end)
      on(c, "c", TestProbe, :start, ["d_c", false])
      devs = [{"d_c", "c"}]
      {:ok, 1, _} = on(c, "c", Router, :send_msg, [cid, "u", "dc0", "m1", "x", [devices: devs]])
      eventually(fn -> on(c, "b", Store, :prefix, [:rt_replica, cid]) |> length() == 1 end)

      # trava a Replica da irmã (b): a chamada síncrona estoura o timeout
      rep = on(c, "b", Process, :whereis, [ChatyyRouter.Replica])
      :ok = on(c, "b", :sys, :suspend, [rep])
      assert {:error, {:replica, _}} = on(c, "c", Router, :send_msg, [cid, "u", "dc0", "m2", "x", [devices: devs]])
      Process.sleep(300)
      # não entregou: a cópia ainda não existe, um failover reusaria o seq
      assert on(c, "c", TestProbe, :seqs, ["d_c"]) == [1]
      :ok = on(c, "b", :sys, :resume, [rep])

      {:ok, 2, _} = on(c, "c", Router, :send_msg, [cid, "u", "dc0", "m2", "x", [devices: devs]])
      {:ok, 3, _} = on(c, "c", Router, :send_msg, [cid, "u", "dc0", "m3", "x", [devices: devs]])
      eventually(fn -> on(c, "c", TestProbe, :seqs, ["d_c"]) == [1, 2, 3] end)
      Process.sleep(300)
      assert on(c, "c", TestProbe, :seqs, ["d_c"]) == [1, 2, 3]
      assert on(c, "b", Store, :prefix, [:rt_replica, cid]) |> Enum.map(&elem(&1, 0)) == [1, 2, 3]
    end

    test "tick de reentrega publica sozinho a mensagem quando a irmã volta", %{c: c} do
      cid = "conv-sis2"
      on(c, "a", ChatyyRouter.HomeTable, :assign, [cid, "a", 1])
      eventually(fn -> on(c, "c", ChatyyRouter.HomeTable, :lookup, [cid]) |> elem(0) == "a" end)
      on(c, "c", TestProbe, :start, ["d_c2", false])
      rep = on(c, "b", Process, :whereis, [ChatyyRouter.Replica])
      :ok = on(c, "b", :sys, :suspend, [rep])
      assert {:error, _} = on(c, "c", Router, :send_msg, [cid, "u", "dc0", "n1", "x", [devices: [{"d_c2", "c"}]]])
      :ok = on(c, "b", :sys, :resume, [rep])
      eventually(fn -> on(c, "c", TestProbe, :seqs, ["d_c2"]) == [1] end, 5_000)
    end

    test "queda da casa logo após confirmar: a irmã tem TUDO o que foi confirmado (RPO 0)", %{c: c} do
      cid = "conv-rpo"
      on(c, "a", ChatyyRouter.HomeTable, :assign, [cid, "a", 1])
      eventually(fn -> on(c, "c", ChatyyRouter.HomeTable, :lookup, [cid]) |> elem(0) == "a" end)
      devs = [{"d_off", "c"}]
      seqs = for i <- 1..40, do: on(c, "c", Router, :send_msg, [cid, "u", "dc0", "r#{i}", "x", [devices: devs]]) |> elem(1)
      assert seqs == Enum.to_list(1..40)
      # sem esperar nada: mata a casa
      kill(c, "a")
      {:ok, 41, e} = send_retry(c, "c", cid, "r41", devs)
      assert e >= 2
      assert on(c, "b", Store, :prefix_keys, [:rt_msg, cid]) == Enum.to_list(1..41)
    end
  end

  describe "R1 fanout (casa externa)" do
    setup do
      c = start(["a", "b", "c"])
      for r <- ["a", "b", "c"], do: on(c, r, ChatyyRouter.Flags, :override, [:fanout, true])
      on_exit(fn -> stop(c) end)
      {:ok, c: c}
    end

    test "entrega por região sem casa no cluster; ack apaga a inbox e não vai a casa nenhuma", %{c: c} do
      on(c, "b", TestProbe, :start, ["fb", false])
      on(c, "c", TestProbe, :start, ["fc", false])
      req = %{cid: "us-1033", seq: 900_001, home: "us", from: "x@chatyy", from_device: "dx", body: "cifrado", frame: ~s({"type":"chat_message"}),
              devices: [{"fb", "b"}, {"fc", "c"}, {"fus", "us"}]}
      {:ok, r} = on(c, "a", ChatyyRouter.Fanout, :fanout, [req])
      assert r.regions == 2 and r.devices == 2 and r.outside == 1
      eventually(fn -> on(c, "b", TestProbe, :seqs, ["fb"]) == [900_001] and on(c, "c", TestProbe, :seqs, ["fc"]) == [900_001] end)
      eventually(fn -> on(c, "a", ChatyyRouter.Fanout, :pending, []) == 0 end)
      assert [{"us-1033", 900_001, {%{body: "cifrado", frame: ~s({"type":"chat_message"}), msg_id: 900_001}, _}}] =
               on(c, "b", Store, :inbox, ["fb"])
      :ok = on(c, "b", Router, :ack, ["fb", "us-1033", 900_001])
      assert on(c, "b", Store, :inbox, ["fb"]) == []
      assert on(c, "b", ChatyyRouter.AckOutbox, :pending, []) == 0
      assert on(c, "b", ChatyyRouter.Store, :size, [:rt_msg]) == 0
    end

    test "região fora na hora do fanout recebe quando volta (reentrega)", %{c: c} do
      partition(c, ["a"], ["c"])
      on(c, "c", TestProbe, :start, ["fc2", false])
      {:ok, _} = on(c, "a", ChatyyRouter.Fanout, :fanout, [%{cid: "us-2", seq: 7, devices: [{"fc2", "c"}], body: "y"}])
      Process.sleep(400)
      assert on(c, "c", TestProbe, :seqs, ["fc2"]) == []
      assert on(c, "a", ChatyyRouter.Fanout, :pending, []) == 1
      heal(c, ["a"], ["c"])
      eventually(fn -> on(c, "c", TestProbe, :seqs, ["fc2"]) == [7] end, 10_000)
      eventually(fn -> on(c, "a", ChatyyRouter.Fanout, :pending, []) == 0 end)
    end

    test "kill switch RT_FANOUT=0 → disabled", %{c: c} do
      on(c, "a", ChatyyRouter.Flags, :override, [:fanout, false])
      assert {:error, :disabled} = on(c, "a", ChatyyRouter.Fanout, :fanout, [%{cid: "k", seq: 1, devices: [{"z", "b"}]}])
    end
  end

  defp send_retry(c, r, cid, cmi, devices, timeout \\ 20_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    Stream.repeatedly(fn ->
      case on(c, r, Router, :send_msg, [cid, "u", "dc0", cmi, "x", [devices: devices]]) do
        {:ok, _, _} = ok ->
          ok

        _ ->
          if System.monotonic_time(:millisecond) > deadline, do: raise("send_retry timeout")
          Process.sleep(100)
          nil
      end
    end)
    |> Enum.find(& &1)
  end
end
