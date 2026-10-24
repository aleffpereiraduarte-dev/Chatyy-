defmodule ChatyyRouter.Telemetry do
  @moduledoc """
  Eventos no formato do `:telemetry` (`[:chatyy_router, ...]`, medidas, metadados).
  Se a lib `:telemetry` estiver carregada (integração futura com o resto do
  stack), o evento é repassado a ela; sempre alimenta `ChatyyRouter.Metrics`.

  Eventos:
    [:chatyy_router, :send, :stop]        %{duration_us}  %{result, cid}
    [:chatyy_router, :deliver, :stored]   %{count}        %{region}
    [:chatyy_router, :deliver, :push]     %{count}        %{}
    [:chatyy_router, :ack]                %{count}        %{}
    [:chatyy_router, :home, :purged]      %{count}        %{reason}
    [:chatyy_router, :inbox, :expired]    %{count}        %{}
    [:chatyy_router, :failover]           %{count}        %{from, to, convs}
    [:chatyy_router, :migrate]            %{duration_us}  %{cid, to}
    [:chatyy_router, :replica, :lag]      %{lag_us}       %{}
  """
  def execute(event, measurements, meta \\ %{}) do
    if function_exported?(:telemetry, :execute, 3) do
      apply(:telemetry, :execute, [event, measurements, meta])
    end

    ChatyyRouter.Metrics.observe(event, measurements, meta)
    :ok
  end
end

defmodule ChatyyRouter.Metrics do
  @moduledoc "Contadores e histogramas simples em ETS (write_concurrency), saída Prometheus."
  @table :chatyy_router_metrics
  @buckets_us [250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000]

  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:named_table, :public, :set, write_concurrency: true, read_concurrency: true])
    end

    :ok
  end

  def inc(name, by \\ 1), do: :ets.update_counter(@table, {:c, name}, by, {{:c, name}, 0})

  def hist(name, us) do
    b = Enum.find(@buckets_us, :inf, &(us <= &1))
    :ets.update_counter(@table, {:h, name, b}, 1, {{:h, name, b}, 0})
    :ets.update_counter(@table, {:hs, name}, us, {{:hs, name}, 0})
    :ets.update_counter(@table, {:hc, name}, 1, {{:hc, name}, 0})
  end

  def observe([:chatyy_router, :send, :stop], %{duration_us: d}, meta) do
    inc({:send, Map.get(meta, :result, :ok)})
    hist(:send, d)
  end

  def observe([:chatyy_router, :replica, :lag], %{lag_us: d}, _), do: hist(:replica_lag, d)
  def observe([:chatyy_router, :fanout, :stop], %{duration_us: d}, _), do: inc(:fanout) && hist(:fanout, d)
  def observe([:chatyy_router, :migrate], %{duration_us: d}, _), do: hist(:migrate, d)

  def observe(event, m, _meta) do
    name = event |> tl() |> Enum.map_join("_", &to_string/1)
    inc(String.to_atom(name), Map.get(m, :count, 1))
  end

  def counter(name) do
    case :ets.lookup(@table, {:c, name}) do
      [{_, v}] -> v
      [] -> 0
    end
  end

  def snapshot do
    :ets.tab2list(@table)
  end

  @labeled [:nodeup, :nodedown, :ping_fail, :rtt]

  def prometheus do
    rows = snapshot()

    counters =
      for {{:c, name}, v} <- rows do
        {n, l} = name_labels(name)
        "chatyy_router_#{n}_total#{lbl(l)} #{v}\n"
      end

    hists =
      for {{:hc, name}, cnt} <- rows do
        {n, l} = name_labels(name)
        sum = Enum.find_value(rows, 0, fn {{:hs, ^name}, s} -> s; _ -> nil end)

        buckets =
          (@buckets_us ++ [:inf])
          |> Enum.reduce({0, []}, fn b, {acc, out} ->
            c = Enum.find_value(rows, 0, fn {{:h, ^name, ^b}, c} -> c; _ -> nil end)
            le = if b == :inf, do: "+Inf", else: Integer.to_string(b)
            {acc + c, ["chatyy_router_#{n}_us_bucket#{lbl([{"le", le} | l])} #{acc + c}\n" | out]}
          end)
          |> elem(1)
          |> Enum.reverse()

        [buckets, "chatyy_router_#{n}_us_sum#{lbl(l)} #{sum}\n", "chatyy_router_#{n}_us_count#{lbl(l)} #{cnt}\n"]
      end

    IO.iodata_to_binary([counters, hists, gauges()])
  end

  # [sgu F0] contador com rótulo kind (ChatyyRouter.DlvCompare)
  defp name_labels({:rt_inbox_vs_dlv_mismatch_events, k}), do: {"rt_inbox_vs_dlv_mismatch_events", [{"kind", to_string(k)}]}
  # [sgu F1] (ChatyyRouter.BodyStore / BodyCompare)
  defp name_labels({:rt_f1_body_mismatch_events, k}), do: {"rt_f1_body_mismatch_events", [{"kind", to_string(k)}]}
  defp name_labels({:rt_store, r}), do: {"rt_store", [{"result", to_string(r)}]}
  defp name_labels({:rt_store, r, why}), do: {"rt_store", [{"result", to_string(r)}, {"why", to_string(why)}]}
  defp name_labels({:rt_store_src, r}), do: {"rt_store_src", [{"src", to_string(r)}]}
  defp name_labels({a, r}) when a in @labeled, do: {to_string(a), [{"region", to_string(r)}]}
  defp name_labels(name), do: {fmt(name), []}

  defp lbl([]), do: ""
  defp lbl(l), do: "{" <> Enum.map_join(l, ",", fn {k, v} -> ~s(#{k}="#{v}") end) <> "}"

  @doc "Gauges calculados na hora do scrape (estado do nó e do cluster)."
  def gauges do
    alias ChatyyRouter.{Config, Net, Store, Seglog}
    safe = fn f -> try do f.() catch _, _ -> nil end end
    me = Net.me()
    alive = safe.(fn -> Net.alive_regions() end) || [me]
    rtts = safe.(fn -> Net.Cluster.rtts() end) || %{}

    peers =
      for r <- Config.region_names(), r != me do
        up = if r in alive, do: 1, else: 0
        rtt = case rtts[r] do {us, _} -> Float.round(us / 1000, 1); _ -> nil end
        ["chatyy_router_peer_up{region=\"#{r}\"} #{up}\n" | if(rtt, do: ["chatyy_router_peer_rtt_ms{region=\"#{r}\"} #{rtt}\n"], else: [])]
      end

    tables =
      for t <- Store.tables() do
        "chatyy_router_store_entries{table=\"#{t}\"} #{safe.(fn -> Store.size(t) end) || 0}\n"
      end

    logs =
      for t <- Store.log_tables(), st = safe.(fn -> Seglog.stats(t) end), st != nil do
        [
          "chatyy_router_log_bytes{table=\"#{t}\"} #{st.bytes}\n",
          "chatyy_router_log_segments{table=\"#{t}\"} #{st.segments}\n",
          "chatyy_router_log_index_bytes{table=\"#{t}\"} #{st.index_mem_bytes}\n"
        ]
      end

    b = fn x -> if x, do: 1, else: 0 end

    [
      peers,
      tables,
      logs,
      "chatyy_router_regions_configured #{length(Config.region_names())}\n",
      "chatyy_router_regions_alive #{length(alive)}\n",
      "chatyy_router_quorum_size #{Config.quorum()}\n",
      "chatyy_router_quorum_ok #{b.(safe.(fn -> Net.quorum?() end))}\n",
      "chatyy_router_failed_regions #{safe.(fn -> MapSet.size(ChatyyRouter.HomeTable.failed()) end) || 0}\n",
      "chatyy_router_route_enabled #{b.(ChatyyRouter.Flags.route?())}\n",
      "chatyy_router_fanout_enabled #{b.(ChatyyRouter.Flags.fanout?())}\n",
      "chatyy_router_hub_http_enabled #{b.(ChatyyRouter.Flags.get(:hub_http))}\n",
      "chatyy_router_ack_mode_sister #{b.(Config.ack_mode() == "sister")}\n",
      "chatyy_router_ack_outbox #{safe.(fn -> ChatyyRouter.AckOutbox.pending() end) || 0}\n",
      "chatyy_router_ack_outbox_stuck #{safe.(fn -> ChatyyRouter.AckOutbox.stuck() end) || 0}\n",
      "chatyy_router_fanout_pending #{safe.(fn -> ChatyyRouter.Fanout.pending() end) || 0}\n",
      "chatyy_router_mnesia_bytes #{safe.(fn -> Store.mnesia_bytes() end) || 0}\n",
      "chatyy_router_beam_memory_bytes #{:erlang.memory(:total)}\n",
      "chatyy_router_beam_processes #{:erlang.system_info(:process_count)}\n",
      "chatyy_router_dist_connections #{length(Node.list())}\n",
      safe.(fn -> ChatyyRouter.DlvCompare.prom_lines() end) || [],
      # [sgu F3 2026-10-23]
      safe.(fn -> ChatyyRouter.PurgeGc.prom_lines() end) || [],
      safe.(fn -> ChatyyRouter.BodyStore.prom_lines() end) || [],
      safe.(fn -> ChatyyRouter.BodyCompare.prom_lines() end) || [],
      # [sgu F4 2026-10-23]
      safe.(fn -> ChatyyRouter.F4.prom_lines() end) || [],
      "chatyy_router_up 1\n"
    ]
  end

  # nomes de métrica vêm de termos (ex.: {:send, {:replica, :unreachable}}): achata e limpa p/ [a-z0-9_]
  defp fmt(t), do: t |> slug() |> String.replace(~r/[^a-zA-Z0-9_]+/, "_") |> String.trim("_")
  defp slug(t) when is_tuple(t), do: t |> Tuple.to_list() |> Enum.map_join("_", &slug/1)
  defp slug(l) when is_list(l), do: Enum.map_join(l, "_", &slug/1)
  defp slug(a) when is_atom(a) or is_binary(a) or is_number(a), do: to_string(a)
  defp slug(o), do: inspect(o)
end
