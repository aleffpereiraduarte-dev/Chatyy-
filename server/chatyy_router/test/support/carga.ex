defmodule ChatyyRouter.TestCarga do
  @moduledoc """
  [sgu TODOS 2026-10-24] Gerador de carga SINTÉTICA do /store e do /pull que roda DENTRO de um peer do cluster de
  teste (a medição não passa pelo stdio do :peer). Conversas/aparelhos/envelopes são inventados (cid ≥ 9_000_000,
  "qa-carga-…"): nada de conversa real nem da 971.
  """
  alias ChatyyRouter.{BodyCompare, BodyStore}

  @doc "Envelope aleatório do tamanho dado (base64, como o content E2EE)."
  def env(bytes), do: :crypto.strong_rand_bytes(div(bytes * 3, 4)) |> Base.encode64() |> binary_part(0, bytes)

  @doc """
  Grava `n` mensagens a `rate` msg/s (0 = o mais rápido possível) com `conc` processos, cids da lista, envelopes de
  `bytes`. Devolve latências (µs) e resultado por tipo. mid = Snowflake do instante + contador (único por run).
  """
  def store(opts) do
    n = opts[:n] || 1000
    rate = opts[:rate] || 0
    conc = opts[:conc] || 32
    cids = List.to_tuple(opts[:cids])
    bytes = opts[:bytes] || 840
    base = opts[:mid_base] || BodyCompare.mid_floor(System.os_time(:millisecond))
    payload = for _ <- 1..64, do: env(bytes)
    payload = List.to_tuple(payload)
    t_start = System.monotonic_time(:microsecond)
    gap_us = if rate > 0, do: div(1_000_000, rate), else: 0

    res =
      0..(n - 1)
      |> Task.async_stream(
        fn k ->
          if gap_us > 0 do
            due = t_start + k * gap_us
            now = System.monotonic_time(:microsecond)
            if due > now, do: Process.sleep(div(due - now, 1000))
          end

          cid = elem(cids, rem(k, tuple_size(cids)))
          t = System.monotonic_time(:microsecond)

          r =
            try do
              BodyStore.store(%{cid: cid, mid: base + k, env: elem(payload, rem(k, 64)), from: "qa-carga-u1@chatyy.com.br",
                                from_device: "qa-carga-d1-#{cid}", type: "text", cmi: "qa-carga-#{base}-#{k}"})
            catch
              kind, why -> {:error, {kind, why}}
            end

          {classify(r), System.monotonic_time(:microsecond) - t, base + k, cid}
        end,
        max_concurrency: conc, timeout: :infinity, ordered: false)
      |> Enum.map(fn {:ok, x} -> x end)

    wall = System.monotonic_time(:microsecond) - t_start
    lat = for {:ok3, us, _, _} <- res, do: us
    %{n: n, wall_ms: div(wall, 1000), rps: if(wall > 0, do: Float.round(n * 1_000_000 / wall, 1), else: 0),
      ok3: length(lat), results: Enum.frequencies_by(res, &elem(&1, 0)), lat_us: pct(lat),
      stored: for({:ok3, _, mid, cid} <- res, do: {cid, mid})}
  end

  defp classify({:ok, %{copies: c, wanted: w}}) when c >= w, do: :ok3
  defp classify({:ok, %{copies: c}}), do: :"partial_#{c}"
  defp classify({:error, e}), do: {:error, e}
  defp classify(other), do: {:other, other}

  @doc "Pull de cada aparelho (com cid ou sem); latência e itens."
  def pull(devs_cids, opts \\ []) do
    conc = opts[:conc] || 16

    res =
      devs_cids
      |> Task.async_stream(
        fn {dev, cid} ->
          t = System.monotonic_time(:microsecond)
          o = if(cid && !opts[:sem_cid], do: [cid: cid], else: []) ++ [limit: opts[:limit] || 500]
          r = BodyStore.pull(dev, o)
          {length(r.messages), System.monotonic_time(:microsecond) - t}
        end,
        max_concurrency: conc, timeout: :infinity, ordered: false)
      |> Enum.map(fn {:ok, x} -> x end)

    %{pulls: length(res), items: res |> Enum.map(&elem(&1, 0)) |> Enum.sum(), lat_us: pct(Enum.map(res, &elem(&1, 1)))}
  end

  @doc "Repete store de 1 mensagem até dar 3 cópias (ou prazo); devolve ms até o 1º sucesso."
  def until_ok(cid, mid, timeout_ms) do
    t0 = System.monotonic_time(:millisecond)
    do_until(cid, mid, t0, t0 + timeout_ms, 0)
  end

  defp do_until(cid, mid, t0, deadline, tries) do
    r =
      try do
        BodyStore.store(%{cid: cid, mid: mid, env: env(600), from: "qa-carga-u1@chatyy.com.br", from_device: "qa-carga-d1-#{cid}",
                          type: "text", cmi: "qa-falha-#{mid}"})
      catch
        k, w -> {:error, {k, w}}
      end

    now = System.monotonic_time(:millisecond)

    case classify(r) do
      :ok3 -> %{ms: now - t0, tries: tries + 1, result: :ok3}
      other when now >= deadline -> %{ms: now - t0, tries: tries + 1, result: other, timeout: true}
      _ -> Process.sleep(50) && do_until(cid, mid, t0, deadline, tries + 1)
    end
  end

  def pct([]), do: %{}

  def pct(l) do
    s = Enum.sort(l)
    n = length(s)
    at = fn p -> Enum.at(s, min(n - 1, trunc(p * n))) end
    %{n: n, p50: at.(0.5), p95: at.(0.95), p99: at.(0.99), max: List.last(s)}
  end

  @doc "Memória do BEAM e bytes do Seglog deste nó."
  def footprint do
    dir = ChatyyRouter.Config.get(:log_dir, nil)
    disk = if dir && File.dir?(dir), do: du(dir), else: 0
    %{beam_bytes: :erlang.memory(:total), ets_bytes: :erlang.memory(:ets), disk_bytes: disk,
      rt_body: ChatyyRouter.Store.size(:rt_body)}
  end

  defp du(dir) do
    Path.wildcard(Path.join(dir, "**/*")) |> Enum.map(fn f -> case File.stat(f) do {:ok, %{type: :regular, size: s}} -> s; _ -> 0 end end) |> Enum.sum()
  end
end
