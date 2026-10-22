defmodule ChatyyRouter.BenchTest do
  use ExUnit.Case, async: false
  import ChatyyRouter.TestCluster
  @moduletag :bench

  test "benchmark local (3 nós no mesmo host)" do
    c = start(["a", "b", "c"], tick_ms: 1_000)
    on_exit(fn -> stop(c) end)
    n = String.to_integer(System.get_env("BENCH_N", "20000"))

    for {label, home, target, conc} <- [
          {"tudo local (origem=casa=destino)", "a", "a", 64},
          {"origem a -> casa b -> destino c", "b", "c", 64},
          {"origem a -> casa b -> destino c (conc 8)", "b", "c", 8}
        ] do
      r = on(c, "a", ChatyyRouter.Bench, :run, [[n: n, conc: conc, convs: 256, home: home, target: target]], 300_000)
      IO.puts("\nBENCH #{label}: " <> inspect(Map.drop(r, [:origin]), pretty: true, width: 160))
    end
  end
end
