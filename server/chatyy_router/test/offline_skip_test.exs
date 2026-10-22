defmodule ChatyyRouter.OfflineSkipTest do
  @moduledoc "RT_OFFLINE=skip (22/10): aparelho sem presença em lugar nenhum não é guardado no nó do remetente."
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  alias ChatyyRouter.{Directory, Fanout, Flags, Store, TestProbe}

  setup do
    c = start(["a", "b"])
    for r <- ["a", "b"] do
      on(c, r, Flags, :override, [:fanout, true])
      on(c, r, :application, :set_env, [:chatyy_router, :presence_ttl_ms, 50])
    end
    on_exit(fn -> stop(c) end)
    {:ok, c: c}
  end

  test "fallback não vira 'última região conhecida'", %{c: c} do
    assert on(c, "a", Directory, :region_info, ["d_nunca"]) == {"a", :fallback}
    assert on(c, "a", Directory, :fallback?, ["d_nunca"])
    Process.sleep(80)
    # vencido: continua fallback (antes virava "last" = região deste nó para sempre)
    assert on(c, "a", Directory, :region_info, ["d_nunca"]) == {"a", :fallback}
    refute on(c, "a", Directory, :fallback?, ["d_outro"])
  end

  test "flag desligada = comportamento antigo; ligada = aparelho offline fica no caminho de hoje", %{c: c} do
    on(c, "b", TestProbe, :start, ["d_on", false])
    # d_on: região real (b) vinda do diretório; d_off: sem presença (fallback = a)
    on(c, "a", Directory, :region_info, ["d_off"])
    on(c, "a", Directory, :put_members, ["959x", ["u1"]])
    on(c, "a", Directory, :put_devices, ["u1", [{"d_on", "b"}, {"d_off", "a"}]])

    {:ok, r} = on(c, "a", Fanout, :fanout, [%{cid: "959x", seq: 1, body: "x"}])
    assert r.devices == 2 and r.outside == 0
    eventually(fn -> length(on(c, "a", Store, :inbox, ["d_off"])) == 1 end)

    :ok = on(c, "a", Flags, :override, [:offline_skip, true])
    {:ok, r2} = on(c, "a", Fanout, :fanout, [%{cid: "959x", seq: 2, body: "y"}])
    assert r2.devices == 1 and r2.outside == 1
    eventually(fn -> on(c, "b", TestProbe, :seqs, ["d_on"]) == [1, 2] end)
    Process.sleep(200)
    assert on(c, "a", Store, :inbox, ["d_off"]) |> Enum.map(&elem(&1, 1)) == [1]
  end
end
