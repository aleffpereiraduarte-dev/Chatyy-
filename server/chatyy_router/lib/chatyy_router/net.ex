defmodule ChatyyRouter.Net do
  @moduledoc """
  Camada de rede entre regiões. Toda chamada inter-nó passa por aqui para:
    * respeitar o bloqueio de partição (testes e "isolar região" em operação);
    * nunca levantar exit por nó morto (vira {:error, :unreachable}).
  A distribuição Erlang em si roda sobre a WG com TLS (ver deploy/).
  """
  alias ChatyyRouter.Config

  def me, do: Config.region()

  def node_of(region) do
    case List.keyfind(Config.regions(), region, 0) do
      {_, n} -> n
      nil -> nil
    end
  end

  def region_of(node) do
    case List.keyfind(Config.regions(), node, 1) do
      {r, _} -> r
      nil -> nil
    end
  end

  def blocked, do: :persistent_term.get({__MODULE__, :blocked}, MapSet.new())
  def blocked?(region), do: MapSet.member?(blocked(), region)

  @doc "Simula partição: corta e impede reconexão com estas regiões."
  def block(regions) do
    :persistent_term.put({__MODULE__, :blocked}, MapSet.union(blocked(), MapSet.new(regions)))

    for r <- regions, n = node_of(r), n != nil do
      :erlang.disconnect_node(n)
    end

    :ok
  end

  def unblock(regions) do
    :persistent_term.put({__MODULE__, :blocked}, MapSet.difference(blocked(), MapSet.new(regions)))
    :ok
  end

  def alive?(region) do
    cond do
      region == me() -> true
      blocked?(region) -> false
      true -> node_of(region) in Node.list()
    end
  end

  def alive_regions, do: Enum.filter(Config.region_names(), &alive?/1)
  def alive_count, do: length(alive_regions())
  def quorum?, do: alive_count() >= Config.quorum()

  def call(region, name, msg, timeout \\ 5_000) do
    if alive?(region) do
      try do
        GenServer.call({name, node_of(region)}, msg, timeout)
      catch
        :exit, _ -> {:error, :unreachable}
      end
    else
      {:error, :unreachable}
    end
  end

  def cast(region, name, msg) do
    if alive?(region) do
      GenServer.cast({name, node_of(region)}, msg)
    else
      :dropped
    end
  end

  def pid_alive?(pid) do
    n = node(pid)
    n == node() or (n in Node.list() and not blocked?(region_of(n)))
  end

  def cast_pid(pid, msg) do
    if pid_alive?(pid), do: GenServer.cast(pid, msg), else: :dropped
  end

  def call_pid(pid, msg, timeout) do
    if pid_alive?(pid) do
      try do
        GenServer.call(pid, msg, timeout)
      catch
        :exit, {:noproc, _} -> {:error, :noproc}
        :exit, {:normal, _} -> {:error, :noproc}
        :exit, {{:shutdown, _}, _} -> {:error, :noproc}
        :exit, {:timeout, _} -> {:error, :timeout}
        :exit, _ -> {:error, :unreachable}
      end
    else
      {:error, :unreachable}
    end
  end

  @doc """
  Timeout de uma chamada à região proporcional ao RTT medido (pares Ásia↔América do Sul
  têm 350–450 ms e jitter): max(mínimo, 8 × RTT), teto 30 s. Sem medida ainda = mínimo
  (≥ 3 s). A DETECÇÃO de nó fora não usa isto: é a distribuição (net_ticktime 20 s) +
  60 s de failover + quórum.
  """
  def tmo(region, min_ms \\ 3_000) do
    rtt =
      case ChatyyRouter.Net.Cluster.rtts()[region] do
        {us, _} -> div(us, 1000)
        _ -> 0
      end

    min(max(max(min_ms, 3_000), rtt * 8), 30_000)
  end

  @doc "RTT de ida e volta de uma chamada vazia ao nó da região (µs)."
  def ping_us(region) do
    t0 = System.monotonic_time(:microsecond)

    case call(region, ChatyyRouter.Net.Cluster, :ping, 5_000) do
      :pong -> System.monotonic_time(:microsecond) - t0
      _ -> nil
    end
  end
end

defmodule ChatyyRouter.Net.Cluster do
  @moduledoc """
  Mantém a malha: conecta explicitamente às regiões configuradas (connect_all
  false) a cada tick, exceto as bloqueadas. Avisa HomeTable/Directory no nodeup.
  """
  use GenServer
  alias ChatyyRouter.{Config, Net}
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @rtt :rt_peer_rtt

  @doc "Último RTT medido por região: %{região => {µs, ms_desde_epoch}}"
  def rtts do
    if :ets.whereis(@rtt) == :undefined, do: %{}, else: Map.new(:ets.tab2list(@rtt), fn {r, us, at} -> {r, {us, at}} end)
  end

  @impl true
  def init(_) do
    :net_kernel.monitor_nodes(true)
    if :ets.whereis(@rtt) == :undefined, do: :ets.new(@rtt, [:named_table, :public, :set])
    send(self(), :tick)
    Process.send_after(self(), :ping, 2_000)
    {:ok, %{}}
  end

  @impl true
  def handle_call(:ping, _from, s), do: {:reply, :pong, s}
  # voto de quórum do failover (aqui p/ nunca bloquear atrás de um tick)
  def handle_call({:sees_down?, r}, _from, s), do: {:reply, not Net.alive?(r), s}

  @impl true
  def handle_info(:tick, s) do
    if Node.alive?() do
      for {r, n} <- Config.regions(), r != Net.me(), not Net.blocked?(r), n not in Node.list() do
        # conexão em processo à parte: link de 300 ms não trava o tick
        spawn(fn -> :net_kernel.connect_node(n) end)
      end
    end

    Process.send_after(self(), :tick, Config.tick_ms())
    {:noreply, s}
  end

  # RTT de cada par (chamada vazia pela distribuição TLS), p/ /metrics e alertas
  def handle_info(:ping, s) do
    for r <- Net.alive_regions(), r != Net.me() do
      spawn(fn ->
        case Net.ping_us(r) do
          nil -> ChatyyRouter.Metrics.inc({:ping_fail, r})
          us ->
            :ets.insert(@rtt, {r, us, System.os_time(:millisecond)})
            ChatyyRouter.Metrics.hist({:rtt, r}, us)
        end
      end)
    end

    Process.send_after(self(), :ping, Config.get(:ping_ms, 10_000))
    {:noreply, s}
  end

  def handle_info({:nodeup, n}, s) do
    r = Net.region_of(n)

    cond do
      r == nil ->
        :ok

      Net.blocked?(r) ->
        :erlang.disconnect_node(n)

      true ->
        Logger.info("router: região #{r} conectada (#{n})")
        ChatyyRouter.Metrics.inc({:nodeup, r})
        ChatyyRouter.HomeTable.push_sync(r)
        ChatyyRouter.Directory.push_sync(r)
    end

    {:noreply, s}
  end

  def handle_info({:nodedown, n}, s) do
    if r = Net.region_of(n) do
      Logger.warning("router: região #{r} caiu (#{n})")
      ChatyyRouter.Metrics.inc({:nodedown, r})
      :ets.delete(@rtt, r)
    end
    {:noreply, s}
  end
end
