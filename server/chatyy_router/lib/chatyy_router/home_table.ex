defmodule ChatyyRouter.HomeTable do
  @moduledoc """
  Tabela de casa: cid -> {região, epoch}. Cache em ETS (`:rt_home_cache`, só
  registros COMPROMETIDOS), cópia durável no Store (`:rt_home`).

  ## Toda criação/troca de casa passa por MAIORIA (correção 22/10, bug da carga r4)

  Antes: `assign` era cast só às regiões vivas e, sem registro, o HRW padrão
  deixava qualquer nó (até pelo caminho do ACK) criar a casa com epoch 1; o
  empate de epoch era resolvido pelo maior nome de região. Com rota parcial
  (SG sem TCP até o BR2) o SG criou uma 2ª casa da mesma conversa com o MESMO
  epoch e seq recomeçando em 1.

  Agora (Paxos de 1 decreto, simplificado — a fase 2 com o epoch como número):
    * `propose(cid, região, epoch)` manda {:accept, …} a TODAS as regiões vivas
      (chamada, não cast). Cada aceitadora aceita só se `epoch` > tudo o que ela
      já aceitou/comprometeu para o cid (mesmo par repetido = idempotente) e
      grava o aceite no Store (`:rt_home_acc`). Com `Config.quorum()` aceites
      (contando a própria) a proposta está ESCOLHIDA: grava, faz cast do
      {:commit} a todos e devolve :ok. Sem maioria: manda {:abort} p/ desfazer
      os aceites dela e devolve {:conflict, região, epoch} (o que viu de maior)
      ou {:error, :no_quorum}.
    * Conversa NOVA só nasce com epoch 1 e só se a consulta à maioria (`resolve`)
      não achou NADA. Quem já existe nunca é "atropelado" por uma casa nova.
    * Epoch > 1 só por failover (casa fora + quórum), migração (com cópia do
      estado) ou decisão de operador (/assign, conv_home_cas).
    * O caminho do ACK e o de leitura NUNCA criam casa (`create: false`).
    * Merge de registros vindos de outros nós/PG: epoch maior vence; MESMO
      epoch com região diferente NÃO é desempatado pelo nome: fica o que já
      está (métrica `home_conflict` + log). Com a maioria isso não acontece.
    * Quem não tem o registro local pergunta à maioria (`resolve/1`): vale um
      registro comprometido de qualquer um ou um aceite visto em ≥ quórum.

  Região em failover (`failed`) é pulada no padrão HRW: vai para a sucessora.
  O HRW só decide QUEM propõe a casa de uma conversa nova; não decide a casa.
  """
  use GenServer
  alias ChatyyRouter.{Config, Net, Store, Telemetry}
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
  Região que PROPÕE a casa de uma conversa sem registro. ROUTER_DEFAULT_HOME fixa
  uma região (R1: "us", a casa externa = master); sem ela, HRW sobre as regiões do
  cluster (pulando região em failover).
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
    |> Enum.reject(&(&1 in Config.never_sister()))
    |> Enum.find(&Net.alive?/1)
  end

  def entries, do: :ets.tab2list(@ets)

  def homed_at(region) do
    :ets.select(@ets, [{{:"$1", region, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  # ---------- consulta à maioria ----------

  @doc """
  Casa conhecida pelo cluster: local se houver; senão pergunta às regiões vivas.
  {:ok, região, epoch} | :none (ninguém tem nada: pode nascer) |
  {:error, :unknown} (há aceites sem maioria, ou sem quórum p/ afirmar :none).
  """
  def resolve(cid) do
    case :ets.lookup(@ets, cid) do
      [{_, r, e}] ->
        {:ok, r, e}

      [] ->
        others = Net.alive_regions() -- [Net.me()]
        mine = {nil, local_acc(cid)}

        answers =
          [mine] ++
            (others
             |> Task.async_stream(fn r -> Net.call(r, __MODULE__, {:query, cid}, Net.tmo(r)) end,
               timeout: 31_000, on_timeout: :kill_task, max_concurrency: 16)
             |> Enum.flat_map(fn
               {:ok, {:home, c, a}} -> [{c, a}]
               _ -> []
             end))

        committed = for {{r, e}, _} <- answers, do: {r, e}
        accepted = for {_, {r, e}} <- answers, do: {r, e}

        cond do
          committed != [] ->
            {r, e} = Enum.max_by(committed, &elem(&1, 1))
            merge(cid, r, e)
            {:ok, r, e}

          (best = majority_acc(accepted)) != nil ->
            {r, e} = best
            merge(cid, r, e)
            {:ok, r, e}

          accepted == [] and length(answers) >= Config.quorum() ->
            :none

          true ->
            {:error, :unknown}
        end
    end
  end

  defp majority_acc(accepted) do
    accepted
    |> Enum.frequencies()
    |> Enum.find_value(fn {re, n} -> if n >= Config.quorum(), do: re end)
  end

  defp local_acc(cid) do
    case Store.get(:rt_home_acc, cid) do
      {r, e} -> {r, e}
      nil -> nil
    end
  end

  # ---------- escrita (sempre por maioria) ----------

  @doc """
  Propõe {região, epoch}. :ok (escolhida e comprometida) |
  {:conflict, região, epoch} (há algo igual/maior) | {:error, :no_quorum}.
  """
  def propose(cid, region, epoch) do
    t0 = System.monotonic_time(:microsecond)
    others = Net.alive_regions() -- [Net.me()]
    me_res = GenServer.call(__MODULE__, {:accept, cid, region, epoch})

    res =
      [me_res] ++
        (others
         |> Task.async_stream(fn r -> Net.call(r, __MODULE__, {:accept, cid, region, epoch}, Net.tmo(r)) end,
           timeout: 31_000, on_timeout: :kill_task, max_concurrency: 16)
         |> Enum.map(fn
           {:ok, v} -> v
           _ -> {:error, :timeout}
         end))

    oks = Enum.count(res, &(&1 == :accepted))
    Telemetry.execute([:chatyy_router, :home, :propose], %{duration_us: System.monotonic_time(:microsecond) - t0})

    if oks >= Config.quorum() do
      commit(cid, region, epoch)
      if pg?(), do: ChatyyRouter.HomeSync.enqueue(cid, region, epoch)
      :ok
    else
      # desfaz os meus aceites (quem aceitou e não teve maioria não segura o cid)
      GenServer.cast(__MODULE__, {:abort, cid, region, epoch})
      for r <- others, do: Net.cast(r, __MODULE__, {:abort, cid, region, epoch})
      Telemetry.execute([:chatyy_router, :home, :propose_fail], %{count: 1})

      case for({:rejected, r, e} <- res, do: {r, e}) do
        [] -> {:error, :no_quorum}
        l -> l |> Enum.max_by(&elem(&1, 1)) |> then(fn {r, e} -> {:conflict, r, e} end)
      end
    end
  end

  @doc """
  Atribuição explícita (operador/bench/failover/migração): epoch = maior visto + 1,
  pela maioria. Compatível com a API antiga (o 3º argumento é o epoch mínimo).
  """
  def assign(cid, region, min_epoch) do
    seen =
      case resolve(cid) do
        {:ok, _r, e} -> e
        _ -> 0
      end

    e = max(min_epoch, seen + 1)

    case propose(cid, region, e) do
      {:conflict, _r, e2} when e2 >= e -> propose(cid, region, e2 + 1)
      other -> other
    end
  end

  @doc """
  Conversa nova: só cria (epoch 1) se ninguém tem nada. {:ok, região, epoch} com a
  casa que valer (minha ou de outro) | {:error, motivo}.
  """
  def claim(cid, region) do
    case resolve(cid) do
      {:ok, r, e} ->
        {:ok, r, e}

      :none ->
        case propose(cid, region, 1) do
          :ok ->
            {:ok, region, 1}

          {:conflict, r, e} ->
            # outra proposta concorrente: espera um pouco e reconsulta (sem atropelar)
            Process.sleep(50 + :rand.uniform(150))

            case resolve(cid) do
              {:ok, r2, e2} -> {:ok, r2, e2}
              _ -> {:error, {:contended, r, e}}
            end

          err ->
            err
        end

      err ->
        err
    end
  end

  @doc "Registro vindo de commit/sync/PG/moved: aplica a regra de merge (sem desempate por nome)."
  def merge(cid, region, epoch), do: GenServer.call(__MODULE__, {:merge, cid, region, epoch})

  defp commit(cid, region, epoch) do
    GenServer.call(__MODULE__, {:merge, cid, region, epoch})
    for r <- Net.alive_regions(), r != Net.me(), do: Net.cast(r, __MODULE__, {:commit, cid, region, epoch})
    :ok
  end

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

  def handle_call({:query, cid}, _from, s) do
    c = case :ets.lookup(@ets, cid) do
      [{_, r, e}] -> {r, e}
      [] -> nil
    end

    {:reply, {:home, c, local_acc(cid)}, s}
  end

  # aceitadora: só aceita epoch MAIOR que tudo o que já viu (mesmo par = idempotente)
  def handle_call({:accept, cid, region, epoch}, _from, s) do
    cur =
      [local_acc(cid), case(:ets.lookup(@ets, cid), do: ([{_, r, e}] -> {r, e}; [] -> nil))]
      |> Enum.reject(&is_nil/1)
      |> Enum.max_by(&elem(&1, 1), fn -> nil end)

    reply =
      case cur do
        nil -> :accept
        {^region, ^epoch} -> :accept
        {_r, e} when epoch > e -> :accept
        {r, e} -> {:rejected, r, e}
      end

    case reply do
      :accept ->
        Store.put(:rt_home_acc, cid, {region, epoch})
        {:reply, :accepted, s}

      rej ->
        {:reply, rej, s}
    end
  end

  def handle_call({:failed, region, bool}, _from, s) do
    do_failed(region, bool)
    {:reply, :ok, s}
  end

  @impl true
  def handle_cast({:commit, cid, region, epoch}, s) do
    do_merge(cid, region, epoch)
    {:noreply, s}
  end

  # compat: nós antigos ainda difundem {:merge} por cast
  def handle_cast({:merge, cid, region, epoch}, s) do
    do_merge(cid, region, epoch)
    {:noreply, s}
  end

  def handle_cast({:abort, cid, region, epoch}, s) do
    case Store.get(:rt_home_acc, cid) do
      {^region, ^epoch} ->
        # só desfaz se ainda não virou registro comprometido aqui
        case :ets.lookup(@ets, cid) do
          [{_, ^region, ^epoch}] -> :ok
          _ -> Store.delete(:rt_home_acc, cid)
        end

      _ ->
        :ok
    end

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
    verdict =
      case :ets.lookup(@ets, cid) do
        [] -> :newer
        [{_, ^region, ^epoch}] -> :same
        [{_, _r0, e0}] when epoch > e0 -> :newer
        [{_, r0, e0}] when epoch == e0 -> {:conflict, r0}
        _ -> :stale
      end

    case verdict do
      :newer ->
        :ets.insert(@ets, {cid, region, epoch})
        Store.put(:rt_home, cid, {region, epoch})
        # o aceite pendente fica coberto pelo registro
        case Store.get(:rt_home_acc, cid) do
          {_, e} when e <= epoch -> Store.delete(:rt_home_acc, cid)
          _ -> :ok
        end

        if region != Net.me() do
          # se eu era o dono, o ConvServer local desce (vira seguidor)
          ChatyyRouter.Home.home_moved(cid, region, epoch)
        end

        :updated

      :same ->
        :stale

      {:conflict, r0} ->
        # MESMO epoch, região diferente: não se desempata por nome (era a casa dupla)
        ChatyyRouter.Metrics.inc(:home_conflict)
        Logger.error("router: CONFLITO de casa #{inspect(cid)} epoch #{epoch}: tenho #{r0}, chegou #{region} — mantido #{r0}")
        :stale

      :stale ->
        :stale
    end
  end
end
