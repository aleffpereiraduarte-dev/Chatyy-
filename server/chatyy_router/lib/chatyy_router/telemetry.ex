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

  def prometheus do
    rows = snapshot()

    counters =
      for {{:c, name}, v} <- rows do
        "chatyy_router_#{fmt(name)}_total #{v}\n"
      end

    hists =
      for {{:hc, name}, cnt} <- rows do
        sum = Enum.find_value(rows, 0, fn {{:hs, ^name}, s} -> s; _ -> nil end)

        buckets =
          (@buckets_us ++ [:inf])
          |> Enum.reduce({0, []}, fn b, {acc, out} ->
            c = Enum.find_value(rows, 0, fn {{:h, ^name, ^b}, c} -> c; _ -> nil end)
            le = if b == :inf, do: "+Inf", else: Integer.to_string(b)
            {acc + c, [~s(chatyy_router_#{name}_us_bucket{le="#{le}"} #{acc + c}\n) | out]}
          end)
          |> elem(1)
          |> Enum.reverse()

        [buckets, "chatyy_router_#{name}_us_sum #{sum}\n", "chatyy_router_#{name}_us_count #{cnt}\n"]
      end

    IO.iodata_to_binary([counters, hists])
  end

  defp fmt({a, b}), do: "#{a}_#{b}"
  defp fmt(a), do: to_string(a)
end
