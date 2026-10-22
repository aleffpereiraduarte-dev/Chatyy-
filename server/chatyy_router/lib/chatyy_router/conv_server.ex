defmodule ChatyyRouter.Home do
  @moduledoc """
  Porta de entrada da casa em cada nó: acha/sobe o `ConvServer` da conversa,
  recebe importação (migração) e avisa o dono local quando a casa mudou.
  Só é chamado na 1ª mensagem de cada conversa por nó de origem (o pid fica
  em cache em `ChatyyRouter.Router`).
  """
  use GenServer
  alias ChatyyRouter.{ConvServer, HomeTable, Net, Store}
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def ensure(cid) do
    case Registry.lookup(ChatyyRouter.ConvRegistry, cid) do
      [{pid, _}] -> {:ok, pid}
      [] -> GenServer.call(__MODULE__, {:ensure, cid}, 15_000)
    end
  end

  def home_moved(cid, region, epoch) do
    case Registry.lookup(ChatyyRouter.ConvRegistry, cid) do
      [{pid, _}] -> send(pid, {:home_moved, region, epoch})
      [] -> GenServer.cast(__MODULE__, {:stepdown, cid, epoch})
    end
  end

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_call({:ensure, cid}, _from, s) do
    me = Net.me()

    reply =
      case HomeTable.lookup(cid) do
        {r, e, _} when r != me ->
          {:moved, r, e}

        _ ->
          case Registry.lookup(ChatyyRouter.ConvRegistry, cid) do
            [{pid, _}] -> {:ok, pid}
            [] -> start(cid)
          end
      end

    {:reply, reply, s}
  end

  def handle_call({:import, cid, epoch, rows}, _from, s) do
    for {t, k, v} <- rows, do: Store.put(t, k, v)
    meta = Store.get(:rt_meta, cid) || %{last_seq: 0, epoch: 0}
    Store.put(:rt_meta, cid, %{meta | epoch: epoch})
    HomeTable.merge(cid, Net.me(), epoch)

    # a nova casa já nasce com cópia na SUA irmã
    if sister = HomeTable.successor(Net.me()) do
      for {:rt_msg, _k, msg} <- rows do
        Net.cast(sister, ChatyyRouter.Replica, {:put, %{msg | epoch: epoch, home: Net.me()}})
      end
    end

    {:reply, :ok, s}
  end

  @impl true
  def handle_cast({:stepdown, cid, epoch}, s) do
    ConvServer.stepdown_cleanup(cid, epoch)
    {:noreply, s}
  end

  defp start(cid) do
    case DynamicSupervisor.start_child(ChatyyRouter.ConvSup, {ConvServer, cid}) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, {:moved, r, e}} -> {:moved, r, e}
      other -> {:error, other}
    end
  end
end

defmodule ChatyyRouter.ConvServer do
  @moduledoc """
  Dono da conversa na região-casa. Único lugar que atribui `seq` (ordem total
  por conversa). Fluxo do `send`:
    kill switch -> casa/epoch conferidos -> quórum -> dedupe por cmi ->
    seq+1 -> grava (msg, pendências, dedupe, meta) -> réplica na irmã ->
    responde {:ok, seq, epoch} -> fan-out p/ a Delivery de cada região.
  Apaga o corpo quando TODOS os aparelhos derem ack (ou 30 d, no Janitor).
  """
  use GenServer, restart: :transient
  alias ChatyyRouter.{Config, HomeTable, Net, Store, Telemetry}
  require Logger

  def start_link(cid), do: GenServer.start_link(__MODULE__, cid, name: via(cid))
  def via(cid), do: {:via, Registry, {ChatyyRouter.ConvRegistry, cid}}

  # ---------------- init ----------------

  @impl true
  def init(cid) do
    me = Net.me()

    case HomeTable.lookup(cid) do
      {r, e, _} when r != me ->
        {:stop, {:moved, r, e}}

      {^me, e0, kind} ->
        meta = Store.get(:rt_meta, cid) || %{last_seq: 0, epoch: 0}
        promoted = promote_replica(cid)
        last = max(meta.last_seq, max_msg_seq(cid))
        epoch = Enum.max([e0, meta.epoch, promoted.epoch])

        epoch =
          if kind == :default or promoted.epoch > e0 or epoch > e0 do
            # registro explícito (ou epoch novo após failover/promoção)
            new = max(epoch, e0 + 1)
            HomeTable.assign(cid, me, new)
            new
          else
            epoch
          end

        Store.put(:rt_meta, cid, %{last_seq: last, epoch: epoch})
        :pg.join(:chatyy_router, {:conv, cid}, self())

        unstored =
          for {seq, {_devs, regions}} <- Store.prefix(:rt_pend, cid), regions != [], into: %{} do
            {seq, regions}
          end

        if unstored != %{}, do: Process.send_after(self(), :redeliver, 50)

        {:ok,
         %{cid: cid, me: me, epoch: epoch, seq: last, mode: :active, unstored: unstored},
         Config.idle_ms()}
    end
  end

  # Fui irmã e agora sou casa: a cópia vira o original.
  defp promote_replica(cid) do
    rows = Store.prefix(:rt_replica, cid)

    epoch =
      Enum.reduce(rows, 0, fn {seq, msg}, acc ->
        if Store.get(:rt_msg, {cid, seq}) == nil do
          Store.put(:rt_msg, {cid, seq}, msg)
          regions = msg.devices |> Enum.map(&elem(&1, 1)) |> Enum.uniq()
          # reentrega a todas as regiões dos aparelhos ainda pendentes
          # (inbox é idempotente; o app deduplica frame por seq/cmi)
          Store.put(:rt_pend, {cid, seq}, {msg.devices, regions})
          if msg.cmi, do: Store.put(:rt_dedupe, {cid, msg.cmi}, {seq, msg.ts})
        end

        Store.delete(:rt_replica, {cid, seq})
        max(acc, msg.epoch)
      end)

    if rows != [] do
      Telemetry.execute([:chatyy_router, :replica, :promoted], %{count: length(rows)}, %{cid: cid})
    end

    %{epoch: epoch, count: length(rows)}
  end

  defp max_msg_seq(cid) do
    case Store.prefix(:rt_msg, cid) do
      [] -> 0
      rows -> rows |> Enum.map(&elem(&1, 0)) |> Enum.max()
    end
  end

  # ---------------- send ----------------

  @impl true
  def handle_call({:send, req}, _from, s) do
    {reply, s} = do_send(req, s)

    case reply do
      {:moved, _, _} -> {:stop, :normal, reply, s}
      _ -> {:reply, reply, s, Config.idle_ms()}
    end
  end

  def handle_call({:acked, dev, upto}, _from, s) do
    do_acked(dev, upto, s)
    {:reply, :ok, s, Config.idle_ms()}
  end

  def handle_call({:migrate, to}, _from, s) do
    t0 = System.monotonic_time(:microsecond)
    s = %{s | mode: :draining}
    cid = s.cid
    new_epoch = s.epoch + 1

    rows =
      for(t <- [:rt_msg, :rt_pend], {seq, v} <- Store.prefix(t, cid), do: {t, {cid, seq}, v}) ++
        for({cmi, v} <- Store.prefix(:rt_dedupe, cid), do: {:rt_dedupe, {cid, cmi}, v}) ++
        [{:rt_meta, cid, %{last_seq: s.seq, epoch: new_epoch}}]

    case Net.call(to, ChatyyRouter.Home, {:import, cid, new_epoch, rows}, 15_000) do
      :ok ->
        old_sister = HomeTable.successor(s.me)
        HomeTable.assign(cid, to, new_epoch)
        local_cleanup(cid)
        if old_sister, do: Net.cast(old_sister, ChatyyRouter.Replica, {:drop_conv, cid})
        Telemetry.execute([:chatyy_router, :migrate], %{duration_us: System.monotonic_time(:microsecond) - t0}, %{cid: cid, to: to})
        {:stop, :normal, {:ok, to, new_epoch}, s}

      err ->
        {:reply, {:error, err}, %{s | mode: :active}}
    end
  end

  def handle_call(:state, _from, s), do: {:reply, s, s}

  defp do_send(req, s) do
    cid = s.cid

    cond do
      not ChatyyRouter.Flags.route?() ->
        {{:error, :disabled}, s}

      s.mode != :active ->
        {{:error, :retry}, s}

      true ->
        case HomeTable.lookup(cid) do
          {r, e, _} when r != s.me or e != s.epoch ->
            {{:moved, r, e}, s}

          _ ->
            if Net.quorum?() do
              accept(req, s)
            else
              {{:error, :no_quorum}, s}
            end
        end
    end
  end

  defp accept(req, s) do
    cid = s.cid
    cmi = req[:cmi]

    case cmi && Store.get(:rt_dedupe, {cid, cmi}) do
      {seq, _} ->
        Telemetry.execute([:chatyy_router, :send, :dup], %{count: 1})
        {{:ok, seq, s.epoch}, s}

      _ ->
        seq = s.seq + 1
        now = ChatyyRouter.Clock.now_ms()
        devs = req[:devices] || []

        msg = %{
          cid: cid,
          seq: seq,
          epoch: s.epoch,
          home: s.me,
          home_pid: self(),
          from: req[:from],
          from_device: req[:from_device],
          cmi: cmi,
          body: req[:body],
          ts: now,
          meta: req[:meta] || %{},
          devices: devs
        }

        regions = devs |> Enum.map(&elem(&1, 1)) |> Enum.uniq()
        Store.put(:rt_msg, {cid, seq}, msg)
        if devs != [], do: Store.put(:rt_pend, {cid, seq}, {devs, regions})
        if cmi, do: Store.put(:rt_dedupe, {cid, cmi}, {seq, now})
        Store.put(:rt_meta, cid, %{last_seq: seq, epoch: s.epoch})

        replicate(msg)

        if devs == [] do
          purge(cid, seq, :no_recipients)
        end

        s = %{s | seq: seq}
        s = fanout(msg, regions, s)
        {{:ok, seq, s.epoch}, s}
    end
  end

  defp replicate(msg) do
    case HomeTable.successor(Net.me()) do
      nil ->
        Telemetry.execute([:chatyy_router, :replica, :skipped], %{count: 1})

      sister ->
        if Config.ack_mode() == "sister" do
          t0 = System.monotonic_time(:microsecond)

          case Net.call(sister, ChatyyRouter.Replica, {:put, msg}, 2_000) do
            :ok ->
              Telemetry.execute([:chatyy_router, :replica, :lag], %{lag_us: System.monotonic_time(:microsecond) - t0})

            _ ->
              Telemetry.execute([:chatyy_router, :replica, :sync_fail], %{count: 1})
          end
        else
          Net.cast(sister, ChatyyRouter.Replica, {:put, msg})
        end
    end
  end

  defp fanout(msg, regions, s) do
    slim = Map.delete(msg, :devices)

    missing =
      Enum.reduce(regions, [], fn r, acc ->
        devs = for {d, ^r} <- msg.devices, do: d

        case Net.cast(r, ChatyyRouter.Delivery.name(msg.cid), {:deliver, slim, devs}) do
          :dropped -> [r | acc]
          _ -> acc
        end
      end)

    # aguarda {:region_stored} de todas; as que não estavam vivas ficam p/ reentrega
    unstored = Map.put(s.unstored, msg.seq, regions)
    if missing != [], do: Process.send_after(self(), :redeliver, Config.redeliver_ms())
    %{s | unstored: unstored}
  end

  # ---------------- confirmações ----------------

  @impl true
  def handle_cast({:region_stored, seq, region}, s) do
    s =
      case Map.get(s.unstored, seq) do
        nil ->
          s

        regions ->
          left = List.delete(regions, region)

          case Store.get(:rt_pend, {s.cid, seq}) do
            {devs, _} -> Store.put(:rt_pend, {s.cid, seq}, {devs, left})
            nil -> :ok
          end

          if left == [], do: %{s | unstored: Map.delete(s.unstored, seq)}, else: %{s | unstored: Map.put(s.unstored, seq, left)}
      end

    {:noreply, s, Config.idle_ms()}
  end

  def handle_cast({:acked, dev, upto}, s) do
    do_acked(dev, upto, s)
    {:noreply, s, Config.idle_ms()}
  end

  defp do_acked(dev, upto, s) do
    cid = s.cid
    sister = HomeTable.successor(s.me)

    for {seq, {devs, regions}} <- Store.prefix_upto(:rt_pend, cid, upto) do
      left = Enum.reject(devs, fn {d, _} -> d == dev end)

      cond do
        left == [] -> purge(cid, seq, :all_acked)
        left != devs -> Store.put(:rt_pend, {cid, seq}, {left, regions})
        true -> :ok
      end
    end

    if sister, do: Net.cast(sister, ChatyyRouter.Replica, {:acked, cid, dev, upto})
    Telemetry.execute([:chatyy_router, :ack, :home], %{count: 1})
  end

  @doc false
  def purge(cid, seq, reason) do
    Store.delete(:rt_msg, {cid, seq})
    Store.delete(:rt_pend, {cid, seq})

    if sister = HomeTable.successor(Net.me()) do
      Net.cast(sister, ChatyyRouter.Replica, {:purge, cid, seq})
    end

    Telemetry.execute([:chatyy_router, :home, :purged], %{count: 1}, %{reason: reason})
  end

  # ---------------- infos ----------------

  @impl true
  def handle_info(:redeliver, s) do
    for {seq, regions} <- s.unstored, r <- regions, Net.alive?(r) do
      case {Store.get(:rt_msg, {s.cid, seq}), Store.get(:rt_pend, {s.cid, seq})} do
        {msg, {devs, _}} when msg != nil ->
          ds = for {d, ^r} <- devs, do: d
          slim = msg |> Map.delete(:devices) |> Map.put(:home_pid, self())
          Net.cast(r, ChatyyRouter.Delivery.name(s.cid), {:deliver, slim, ds})
          Telemetry.execute([:chatyy_router, :deliver, :redeliver], %{count: 1})

        _ ->
          :ok
      end
    end

    # mensagens já apagadas (ack/expiração) saem da lista
    unstored = Map.filter(s.unstored, fn {seq, _} -> Store.get(:rt_pend, {s.cid, seq}) != nil end)
    if unstored != %{}, do: Process.send_after(self(), :redeliver, Config.redeliver_ms())
    {:noreply, %{s | unstored: unstored}, Config.idle_ms()}
  end

  def handle_info({:home_moved, region, epoch}, s) do
    if region != s.me and epoch > s.epoch do
      Logger.warning("router: conversa #{inspect(s.cid)} mudou p/ #{region} epoch #{epoch}; descendo")
      stepdown_cleanup(s.cid, epoch)
      {:stop, :normal, s}
    else
      {:noreply, s}
    end
  end

  def handle_info(:timeout, s) do
    if s.unstored == %{}, do: {:stop, :normal, s}, else: {:noreply, s, :hibernate}
  end

  def handle_info(_, s), do: {:noreply, s}

  @doc """
  A casa foi para outra região (failover ou migração feita por outro nó):
  o que sobrou aqui (cauda não replicada) é descartado e contado; o cliente
  reenvia pelo cmi e a nova casa deduplica.
  """
  def stepdown_cleanup(cid, _epoch) do
    n = length(Store.prefix(:rt_msg, cid))
    local_cleanup(cid)
    if n > 0, do: Telemetry.execute([:chatyy_router, :stepdown, :orphans], %{count: n}, %{cid: cid})
  end

  defp local_cleanup(cid) do
    for t <- [:rt_msg, :rt_pend, :rt_dedupe], {k, _} <- Store.prefix(t, cid), do: Store.delete(t, {cid, k})
    Store.delete(:rt_meta, cid)
  end
end

defmodule ChatyyRouter.Replica do
  @moduledoc "Cópia do journal da casa na região-irmã (para failover)."
  use GenServer
  alias ChatyyRouter.Store

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_call({:put, msg}, _f, s) do
    put(msg)
    {:reply, :ok, s}
  end

  @impl true
  def handle_cast({:put, msg}, s) do
    put(msg)
    {:noreply, s}
  end

  def handle_cast({:acked, cid, dev, upto}, s) do
    for {seq, msg} <- Store.prefix_upto(:rt_replica, cid, upto) do
      left = Enum.reject(msg.devices, fn {d, _} -> d == dev end)

      cond do
        left == [] -> Store.delete(:rt_replica, {cid, seq})
        left != msg.devices -> Store.put(:rt_replica, {cid, seq}, %{msg | devices: left})
        true -> :ok
      end
    end

    {:noreply, s}
  end

  def handle_cast({:drop_conv, cid}, s) do
    for {seq, _} <- Store.prefix(:rt_replica, cid), do: Store.delete(:rt_replica, {cid, seq})
    {:noreply, s}
  end

  def handle_cast({:purge, cid, seq}, s) do
    Store.delete(:rt_replica, {cid, seq})
    {:noreply, s}
  end

  defp put(msg) do
    Store.put(:rt_replica, {msg.cid, msg.seq}, Map.delete(msg, :home_pid))
  end

  @doc "Conversas com cópia aqui cuja casa era `region`: [{cid, epoch_max}]"
  def convs_of(region) do
    Store.all(:rt_replica)
    |> Enum.filter(fn {_, m} -> m.home == region end)
    |> Enum.reduce(%{}, fn {{cid, _}, m}, acc -> Map.update(acc, cid, m.epoch, &max(&1, m.epoch)) end)
  end
end
