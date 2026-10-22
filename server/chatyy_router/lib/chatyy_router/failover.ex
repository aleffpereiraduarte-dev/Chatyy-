defmodule ChatyyRouter.Failover do
  @moduledoc """
  Failover da casa. Uma região R é dada como fora quando:
    1. este nó não a vê há >= ROUTER_FAILOVER_MS (padrão 60 s);
    2. QUÓRUM: pelo menos `Config.quorum()` regiões FORA de R (contando esta)
       confirmam que também não a veem (lição de 19/10: WG caído c/ host vivo);
    3. este nó é a sucessora de R (irmã preferida, depois o anel).
  Então: marca R como `failed` (conversas novas não caem nela), e para cada
  conversa que tinha R como casa (as que têm cópia aqui + as registradas)
  grava casa = eu com epoch+1 (fence) e sobe o ConvServer (promove a cópia
  e reentrega pendências). O nó antigo, ao voltar, recebe a tabela com epoch
  maior e desce (vira seguidor). Do lado isolado, sem quórum, ninguém escreve.
  """
  use GenServer
  alias ChatyyRouter.{Config, HomeTable, Net, Replica, Telemetry}
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def state, do: GenServer.call(__MODULE__, :state)

  @impl true
  def init(_) do
    Process.send_after(self(), :tick, Config.tick_ms())
    {:ok, %{down_since: %{}, taken: MapSet.new()}}
  end

  @impl true
  def handle_call(:state, _f, s), do: {:reply, s, s}

  @impl true
  def handle_info(:tick, s) do
    now = System.monotonic_time(:millisecond)
    me = Net.me()

    s =
      Enum.reduce(Config.region_names() -- [me], s, fn r, s ->
        if Net.alive?(r) do
          s =
            if MapSet.member?(s.taken, r) do
              # voltou: conversas novas podem cair nela de novo; as que
              # mudaram de casa ficam aqui (failback = migração explícita)
              Logger.warning("router: região #{r} voltou; limpando failed")
              HomeTable.set_failed(r, false)
              %{s | taken: MapSet.delete(s.taken, r)}
            else
              s
            end

          %{s | down_since: Map.delete(s.down_since, r)}
        else
          since = Map.get(s.down_since, r, now)
          s = %{s | down_since: Map.put(s.down_since, r, since)}

          if now - since >= Config.failover_ms() and not MapSet.member?(s.taken, r) and
               HomeTable.successor(r) == me and quorum_down?(r) do
            takeover(r)
            %{s | taken: MapSet.put(s.taken, r)}
          else
            s
          end
        end
      end)

    Process.send_after(self(), :tick, Config.tick_ms())
    {:noreply, s}
  end

  defp quorum_down?(r) do
    others = Net.alive_regions() -- [Net.me(), r]

    votes =
      1 +
        Enum.count(others, fn o -> Net.call(o, ChatyyRouter.Net.Cluster, {:sees_down?, r}, 3_000) == true end)

    votes >= Config.quorum()
  end

  defp takeover(r) do
    me = Net.me()
    t0 = System.monotonic_time(:microsecond)
    HomeTable.set_failed(r, true)

    from_replica = Replica.convs_of(r)
    registered = for {cid, e} <- HomeTable.homed_at(r), into: %{}, do: {cid, e}
    convs = Map.merge(registered, from_replica, fn _k, a, b -> max(a, b) end)

    for {cid, e} <- convs do
      HomeTable.assign(cid, me, e + 1)
      ChatyyRouter.Home.ensure(cid)
    end

    Logger.warning("router: FAILOVER #{r} -> #{me}: #{map_size(convs)} conversas")

    Telemetry.execute(
      [:chatyy_router, :failover],
      %{count: 1, convs: map_size(convs), duration_us: System.monotonic_time(:microsecond) - t0},
      %{from: r, to: me}
    )
  end
end

defmodule ChatyyRouter.Janitor do
  @moduledoc """
  Expiração (padrão 1×/h): inbox com exp vencido (30 d offline), corpo na
  casa e cópia na irmã com ts > 30 d, dedupe > 7 d.
  """
  use GenServer
  alias ChatyyRouter.{Clock, Config, Store, Telemetry}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  def run_now, do: GenServer.call(__MODULE__, :run, 60_000)

  @impl true
  def init(_) do
    Process.send_after(self(), :run, Config.janitor_ms())
    {:ok, %{}}
  end

  @impl true
  def handle_call(:run, _f, s), do: {:reply, sweep(), s}

  @impl true
  def handle_info(:run, s) do
    sweep()
    Process.send_after(self(), :run, Config.janitor_ms())
    {:noreply, s}
  end

  def sweep do
    now = Clock.now_ms()
    alias ChatyyRouter.Seglog

    # corpos na casa vencidos (> 30 d): leva junto as pendências
    old = :ets.select(Seglog.idx(:rt_msg), [{{:"$1", :_, :_, :_, :"$2", :_}, [{:<, :"$2", now}], [:"$1"]}])
    for k <- old, do: Store.delete(:rt_pend, k)
    msgs = Seglog.expire(:rt_msg, now)
    reps = Seglog.expire(:rt_replica, now)
    inbox = Seglog.expire(:rt_inbox, now)

    dd = for {k, {_seq, ts}} <- Store.all(:rt_dedupe), ts < now - Config.dedupe_ms(), do: k
    for k <- dd, do: Store.delete(:rt_dedupe, k)

    Telemetry.execute([:chatyy_router, :inbox, :expired], %{count: inbox})
    Telemetry.execute([:chatyy_router, :home, :expired], %{count: msgs + reps})
    %{inbox: inbox, msgs: msgs, replica: reps, dedupe: length(dd)}
  end
end
