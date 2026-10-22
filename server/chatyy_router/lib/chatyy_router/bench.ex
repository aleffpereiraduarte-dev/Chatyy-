defmodule ChatyyRouter.Bench do
  @moduledoc """
  Benchmark: origem = este nó, casa = `home`, aparelho destino em `target`
  (hub stub com auto-ack e eco da entrega para a origem).

  Mede:
    send_*   latência do `send` (até a casa gravar e devolver o seq)
    e2e_*    origem -> casa -> região do destino -> eco de volta à origem
             (inclui a perna de volta target->origem: entrega ≈ e2e − ping(target)/2)
    *_rps    vazão do envio e da entrega completa
  """
  alias ChatyyRouter.{HomeTable, Net, Router}

  def run(opts) do
    n = Keyword.get(opts, :n, 10_000)
    conc = Keyword.get(opts, :conc, 32)
    convs = Keyword.get(opts, :convs, 64)
    bytes = Keyword.get(opts, :bytes, 200)
    home = Keyword.get(opts, :home, Net.me())
    target = Keyword.get(opts, :target, Net.me())
    run_id = Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)
    payload = :crypto.strong_rand_bytes(bytes)

    cids = for i <- 1..convs, do: "bench:#{Net.me()}:#{run_id}:#{i}"
    devs = for i <- 1..convs, do: "bdev:#{run_id}:#{i}"

    cids |> Task.async_stream(&HomeTable.assign(&1, home, 1), max_concurrency: 32, timeout: 30_000) |> Stream.run()

    for d <- devs do
      :ok = sub(target, d)
    end

    t0s = :ets.new(:bench_t0, [:public, :set, write_concurrency: true])
    me = self()
    collector = spawn_link(fn -> collect(t0s, n, [], me) end)

    pings = %{home: median_ping(home), target: median_ping(target)}
    cid_t = List.to_tuple(cids)
    dev_t = List.to_tuple(devs)

    start = System.monotonic_time(:microsecond)

    results =
      1..conc
      |> Task.async_stream(
        fn w ->
          for k <- Enum.filter(w..n//conc, &(&1 <= n)) do
            i = rem(k, convs)
            cid = elem(cid_t, i)
            dev = elem(dev_t, i)
            t = System.monotonic_time(:microsecond)
            :ets.insert(t0s, {k, t})

            r =
              Router.send_msg(cid, "bench", "bench-origin", "c#{run_id}-#{k}", payload,
                devices: [{dev, target}],
                meta: %{reply_to: collector, ref: k}
              )

            {r, System.monotonic_time(:microsecond) - t}
          end
        end,
        max_concurrency: conc,
        timeout: :infinity
      )
      |> Enum.flat_map(fn {:ok, l} -> l end)

    send_wall = System.monotonic_time(:microsecond) - start
    oks = for {{:ok, _, _}, us} <- results, do: us
    errors = results |> Enum.reject(&match?({{:ok, _, _}, _}, &1)) |> Enum.frequencies_by(fn {r, _} -> inspect(r) end)

    send(collector, {:expect, length(oks)})

    e2e =
      receive do
        {:collected, l} -> l
      after
        60_000 -> []
      end

    total_wall = System.monotonic_time(:microsecond) - start

    for d <- devs, do: unsub(target, d)

    %{
      origin: Net.me(),
      home: home,
      target: target,
      n: n,
      conc: conc,
      convs: convs,
      bytes: bytes,
      ok: length(oks),
      errors: errors,
      ping_us: pings,
      send_rps: round(length(oks) / max(send_wall, 1) * 1_000_000),
      e2e_rps: round(length(e2e) / max(total_wall, 1) * 1_000_000),
      delivered: length(e2e),
      send_us: pct(oks),
      e2e_us: pct(e2e)
    }
  end

  defp sub(region, d) do
    if region == Net.me(),
      do: ChatyyRouter.Hub.Stub.subscribe(d, auto_ack: true),
      else: Net.call(region, ChatyyRouter.Hub.Stub, {:subscribe, d, [auto_ack: true]})
  end

  defp unsub(region, d) do
    if region == Net.me(),
      do: ChatyyRouter.Hub.Stub.unsubscribe(d),
      else: Net.call(region, ChatyyRouter.Hub.Stub, {:unsubscribe, d})
  end

  defp collect(t0s, expect, acc, parent) do
    if length(acc) >= expect do
      send(parent, {:collected, acc})
    else
      receive do
        {:rt_delivered, k, _dev} ->
          now = System.monotonic_time(:microsecond)

          case :ets.lookup(t0s, k) do
            [{_, t}] ->
              :ets.delete(t0s, k)
              collect(t0s, expect, [now - t | acc], parent)

            [] ->
              collect(t0s, expect, acc, parent)
          end

        {:expect, e} ->
          collect(t0s, e, acc, parent)
      after
        60_000 -> send(parent, {:collected, acc})
      end
    end
  end

  defp median_ping(region) do
    l = for _ <- 1..21, p = Net.ping_us(region), p != nil, do: p
    if l == [], do: nil, else: Enum.at(Enum.sort(l), div(length(l), 2))
  end

  def pct([]), do: %{}

  def pct(l) do
    s = Enum.sort(l)
    len = length(s)
    at = fn p -> Enum.at(s, min(len - 1, trunc(p * len))) end
    %{p50: at.(0.5), p95: at.(0.95), p99: at.(0.99), max: List.last(s)}
  end
end
