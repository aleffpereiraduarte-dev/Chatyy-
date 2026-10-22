defmodule ChatyyRouter.HomeTable do
  @moduledoc """
  Tabela de casa: cid -> {região, epoch}. Cache em ETS, cópia durável no
  Store e difusão por mensagem a todos os nós (o maior epoch vence; empate
  = maior nome de região, determinístico, os dois lados convergem).

  Conversa sem registro explícito usa hash de rendezvous (HRW) sobre as
  regiões configuradas — estável e sem coordenação; na 1ª escrita o dono
  grava o registro explícito (epoch 1). Em produção a fonte da verdade vira
  `conv_home(cid, region, epoch)` no PG replicado (PLANO §8.3) e a escolha
  da casa uma decisão de produto (proximidade); o HRW fica só como padrão.

  Região em failover (`failed`) é pulada no padrão: vai para a sucessora.
  """
  use GenServer
  alias ChatyyRouter.{Config, Net, Store}
  require Logger

  @ets :rt_home_cache

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # ---------- leitura (sem passar pelo GenServer) ----------

  def lookup(cid) do
    case :ets.lookup(@ets, cid) do
      [{_, region, epoch}] -> {region, epoch, :explicit}
      [] -> {default_region(cid), 0, :default}
    end
  end

  @doc """
  Casa de conversa SEM registro. ROUTER_DEFAULT_HOME fixa uma região (R1: "us",
  a casa externa = master; quem trata é o caminho de fan-out externo); sem ela,
  HRW sobre as regiões do cluster (pulando região em failover).
  """
  def default_region(cid) do
    case Config.get(:default_home) do
      nil ->
        r = hrw(cid, Config.region_names())
        if failed?(r), do: successor(r) || r, else: r

      r ->
        to_string(r)
    end
  end

  @doc "Fonte da tabela de casa: \"local\" (difusão no cluster) ou \"pg\" (+ conv_home no PG)."
  def pg?, do: to_string(Config.get(:home_source, "local")) == "pg"

  def hrw(cid, regions), do: Enum.max_by(regions, &:erlang.phash2({cid, &1}))

  def failed, do: :persistent_term.get({__MODULE__, :failed}, MapSet.new())
  def failed?(r), do: MapSet.member?(failed(), r)

  @doc """
  Sucessora da região (irmã preferida, depois o anel a partir dela),
  primeira que esteja viva e não seja a própria.
  """
  def successor(region) do
    names = Config.region_names()
    {before, rest} = Enum.split_while(names, &(&1 != region))
    ring = Enum.drop(rest, 1) ++ before
    prefs = Map.get(Config.sisters(), region, [])

    (prefs ++ ring)
    |> Enum.uniq()
    |> Enum.reject(&(&1 == region))
    |> Enum.find(&Net.alive?/1)
  end

  def entries, do: :ets.tab2list(@ets)

  def homed_at(region) do
    :ets.select(@ets, [{{:"$1", region, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  # ---------- escrita ----------

  @doc "Grava localmente e difunde a todos os nós vivos."
  def assign(cid, region, epoch) do
    GenServer.call(__MODULE__, {:merge, cid, region, epoch})

    for r <- Net.alive_regions(), r != Net.me() do
      Net.cast(r, __MODULE__, {:merge, cid, region, epoch})
    end

    # fonte da verdade durável: conv_home no master (outbox com repetição;
    # master fora => o epoch do cluster segue valendo e reconcilia depois)
    if pg?(), do: ChatyyRouter.HomeSync.enqueue(cid, region, epoch)
    :ok
  end

  def merge(cid, region, epoch), do: GenServer.call(__MODULE__, {:merge, cid, region, epoch})

  def set_failed(region, bool) do
    GenServer.call(__MODULE__, {:failed, region, bool})
    for r <- Net.alive_regions(), r != Net.me(), do: Net.cast(r, __MODULE__, {:failed, region, bool})
    :ok
  end

  def push_sync(region) do
    GenServer.cast(__MODULE__, {:push_sync, region})
  end

  # ---------- GenServer ----------

  @impl true
  def init(_) do
    if :ets.whereis(@ets) == :undefined do
      :ets.new(@ets, [:named_table, :public, :set, read_concurrency: true])
    end

    for {cid, {r, e}} <- Store.all(:rt_home), do: :ets.insert(@ets, {cid, r, e})
    {:ok, %{}}
  end

  @impl true
  def handle_call({:merge, cid, region, epoch}, _from, s), do: {:reply, do_merge(cid, region, epoch), s}

  def handle_call({:failed, region, bool}, _from, s) do
    do_failed(region, bool)
    {:reply, :ok, s}
  end

  @impl true
  def handle_cast({:merge, cid, region, epoch}, s) do
    do_merge(cid, region, epoch)
    {:noreply, s}
  end

  def handle_cast({:failed, region, bool}, s) do
    do_failed(region, bool)
    {:noreply, s}
  end

  def handle_cast({:push_sync, region}, s) do
    Net.cast(region, __MODULE__, {:sync, entries(), MapSet.to_list(failed())})
    {:noreply, s}
  end

  def handle_cast({:sync, entries, failed_list}, s) do
    for {cid, r, e} <- entries, do: do_merge(cid, r, e)
    # a região que me manda a lista conhece falhas que eu não vi
    for r <- failed_list, r != Net.me(), do: do_failed(r, true)
    {:noreply, s}
  end

  defp do_failed(region, true) do
    :persistent_term.put({__MODULE__, :failed}, MapSet.put(failed(), region))
  end

  defp do_failed(region, false) do
    :persistent_term.put({__MODULE__, :failed}, MapSet.delete(failed(), region))
  end

  defp do_merge(cid, region, epoch) do
    newer? =
      case :ets.lookup(@ets, cid) do
        [] -> true
        [{_, r0, e0}] -> epoch > e0 or (epoch == e0 and region > r0)
      end

    if newer? do
      :ets.insert(@ets, {cid, region, epoch})
      Store.put(:rt_home, cid, {region, epoch})

      if region != Net.me() do
        # se eu era o dono, o ConvServer local desce (vira seguidor)
        ChatyyRouter.Home.home_moved(cid, region, epoch)
      end

      :updated
    else
      :stale
    end
  end
end
