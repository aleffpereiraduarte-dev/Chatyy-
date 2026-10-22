defmodule ChatyyRouter.Delivery do
  @moduledoc """
  Lado da REGIÃO DO APARELHO: grava na inbox por aparelho (store-and-forward,
  expira em 30 d, corpo no Seglog com fsync), confirma a quem mandou que a
  região guardou e entrega ao hub. 8 shards por nó (hash do cid).

  Quem mandou pode ser:
    * a casa no cluster (ConvServer) → {:region_stored, seq, região};
    * R1 — casa EXTERNA (US): o `ChatyyRouter.Fanout` da região do remetente
      → {:ext_stored, cid, seq, região}. Aqui `seq` = message_id do US.
  Sem gravar (disco cheio/E/S) não confirma: quem mandou reentrega.
  """
  use GenServer
  alias ChatyyRouter.{Config, Net, Store, Telemetry}

  @shards 8
  def shards, do: @shards
  def name(cid), do: :"rt_delivery_#{rem(:erlang.phash2(cid), @shards)}"
  def name_i(i), do: :"rt_delivery_#{i}"

  def child_specs do
    for i <- 0..(@shards - 1) do
      Supervisor.child_spec({__MODULE__, name_i(i)}, id: {__MODULE__, i})
    end
  end

  def start_link(name), do: GenServer.start_link(__MODULE__, nil, name: name)

  @doc """
  Aparelho confirmou até `upto` na conversa: apaga da inbox local e, se a casa
  é uma região do cluster, avisa a casa (AckOutbox). Casa externa (R1): o US
  já sabe do ack pelo caminho de hoje (chat_delivery_ack → fila sombra dlv).
  """
  def ack(device, cid, upto) do
    rows = Store.inbox_upto_home(device, cid, upto)
    for {seq, _} <- rows, do: Store.delete(:rt_inbox, {device, cid, seq})
    regions = Config.region_names()

    cluster_home? =
      case rows |> Enum.map(&elem(&1, 1)) |> Enum.uniq() do
        [] -> elem(ChatyyRouter.HomeTable.lookup(cid), 0) in regions
        homes -> Enum.any?(homes, &(&1 in regions))
      end

    if cluster_home?, do: ChatyyRouter.AckOutbox.add(cid, device, upto)

    Telemetry.execute([:chatyy_router, :ack], %{count: 1})
    :ok
  end

  def fetch(device) do
    for {cid, seq, {msg, _exp}} <- Store.inbox(device), do: %{msg | cid: cid, seq: seq}
  end

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_cast({:deliver, msg, devs}, s) do
    exp = msg.ts + Config.retention_ms()
    fresh = Enum.reject(devs, fn d -> Store.member?(:rt_inbox, {d, msg.cid, msg.seq}) end)
    slim = Map.delete(msg, :home_pid)

    case Store.put_many(:rt_inbox, for(d <- fresh, do: {{d, msg.cid, msg.seq}, {slim, exp}})) do
      :ok ->
        confirm(msg)
        Telemetry.execute([:chatyy_router, :deliver, :stored], %{count: length(fresh)}, %{region: Net.me()})
        for d <- fresh, do: ChatyyRouter.Hub.push(d, msg)

      {:error, _} ->
        Telemetry.execute([:chatyy_router, :deliver, :store_error], %{count: length(fresh)})
    end

    {:noreply, s}
  end

  defp confirm(%{home_pid: pid, ext: true} = msg) when is_pid(pid),
    do: Net.cast_pid(pid, {:ext_stored, msg.cid, msg.seq, Net.me()})

  defp confirm(%{home_pid: pid} = msg) when is_pid(pid), do: Net.cast_pid(pid, {:region_stored, msg.seq, Net.me()})
  defp confirm(_), do: :ok
end

defmodule ChatyyRouter.Fanout do
  @moduledoc """
  R1 — entrega de mensagem cuja CASA É EXTERNA (hoje o master US). A mensagem
  já foi gravada no US pelo caminho de hoje (leaf/PHP); o leaf da região do
  remetente chama `POST 127.0.0.1:4790/fanout` e este módulo:
    1. resolve os aparelhos destino (Directory, ou a lista que veio);
    2. agrupa por região e manda à `Delivery` de cada região (inbox local com
       fsync + entrega pelo hub de lá) — sem passar pelo US;
    3. guarda em RAM o que ainda não foi confirmado por região e reentrega a
       cada ROUTER_REDELIVER_MS até ROUTER_FANOUT_TTL_MS (10 min).
  Não é fonte da verdade: se este nó cair, o app recupera pelo caminho de
  hoje (sync do US). Por isso a fila de pendências é só RAM.
  Kill: RT_FANOUT=0 no arquivo de flags (ou POST /flags?fanout=0) → `disabled`
  e o leaf usa o broadcast de hoje.
  """
  use GenServer
  alias ChatyyRouter.{Config, Directory, Net, Telemetry}

  @shards 4
  def name(cid), do: :"rt_fanout_#{rem(:erlang.phash2(cid), @shards)}"

  def child_specs do
    for i <- 0..(@shards - 1),
        do: Supervisor.child_spec({__MODULE__, :"rt_fanout_#{i}"}, id: {__MODULE__, i})
  end

  def start_link(name), do: GenServer.start_link(__MODULE__, nil, name: name)

  @doc """
  req: %{cid, seq (message_id do US), home ("us"), from, from_device, body,
         ts?, meta?, devices? [{device, região}]}
  → {:ok, %{regions: n, devices: n}} | {:error, :disabled | :no_recipients}
  """
  def fanout(req) do
    if ChatyyRouter.Flags.fanout?() do
      GenServer.call(name(req.cid), {:fanout, req}, 10_000)
    else
      {:error, :disabled}
    end
  end

  def pending, do: Enum.sum(for i <- 0..(@shards - 1), do: GenServer.call(:"rt_fanout_#{i}", :pending))

  @impl true
  def init(_) do
    Process.send_after(self(), :redeliver, Config.redeliver_ms())
    {:ok, %{pend: %{}}}
  end

  @impl true
  def handle_call(:pending, _f, s), do: {:reply, map_size(s.pend), s}

  def handle_call({:fanout, req}, _f, s) do
    t0 = System.monotonic_time(:microsecond)
    devs =
      case req[:devices] do
        nil -> Directory.recipients_result(req.cid, req[:from_device])
        l -> {:ok, l}
      end

    case devs do
      {:error, _} -> {:reply, {:error, :directory_unavailable}, s}
      {:ok, []} -> {:reply, {:error, :no_recipients}, s}
      {:ok, devs} -> do_fanout(req, devs, t0, s)
    end
  end

  defp do_fanout(req, devs, t0, s) do
      msg = %{
        cid: req.cid,
        seq: req.seq,
        epoch: req[:epoch] || 0,
        home: req[:home] || "us",
        ext: true,
        home_pid: self(),
        from: req[:from],
        from_device: req[:from_device],
        cmi: req[:cmi],
        body: req[:body],
        frame: req[:frame],
        msg_id: req.seq,
        ts: req[:ts] || ChatyyRouter.Clock.now_ms(),
        meta: req[:meta] || %{}
      }

      regions = Config.region_names()
      {inside, outside} = Enum.split_with(devs, fn {_, r} -> r in regions end)
      # aparelho fora do cluster (ex.: WS direto no US) fica no caminho de hoje
      if outside != [], do: Telemetry.execute([:chatyy_router, :fanout, :outside], %{count: length(outside)})
      by_region = Enum.group_by(inside, &elem(&1, 1), &elem(&1, 0))
      for {r, ds} <- by_region, do: Net.cast(r, ChatyyRouter.Delivery.name(msg.cid), {:deliver, msg, ds})
      key = {msg.cid, msg.seq}
      dl = System.monotonic_time(:millisecond) + Config.get(:fanout_ttl_ms, 600_000)
      s = %{s | pend: Map.put(s.pend, key, {msg, by_region, dl})}
      Telemetry.execute([:chatyy_router, :fanout, :stop], %{duration_us: System.monotonic_time(:microsecond) - t0})
      s = if by_region == %{}, do: %{s | pend: Map.delete(s.pend, key)}, else: s
      {:reply, {:ok, %{regions: map_size(by_region), devices: length(inside), outside: length(outside)}}, s}
  end

  @impl true
  def handle_cast({:ext_stored, cid, seq, region}, s) do
    key = {cid, seq}

    pend =
      case Map.get(s.pend, key) do
        nil ->
          s.pend

        {msg, by_region, dl} ->
          left = Map.delete(by_region, region)
          if left == %{}, do: Map.delete(s.pend, key), else: Map.put(s.pend, key, {msg, left, dl})
      end

    {:noreply, %{s | pend: pend}}
  end

  @impl true
  def handle_info(:redeliver, s) do
    now = System.monotonic_time(:millisecond)

    pend =
      for {key, {msg, by_region, dl} = v} <- s.pend, reduce: %{} do
        acc ->
          if now > dl do
            Telemetry.execute([:chatyy_router, :fanout, :expired], %{count: map_size(by_region)})
            acc
          else
            for {r, ds} <- by_region, Net.alive?(r) do
              Net.cast(r, ChatyyRouter.Delivery.name(msg.cid), {:deliver, msg, ds})
              Telemetry.execute([:chatyy_router, :fanout, :redeliver], %{count: 1})
            end

            Map.put(acc, key, v)
          end
      end

    Process.send_after(self(), :redeliver, Config.redeliver_ms())
    {:noreply, %{s | pend: pend}}
  end
end

defmodule ChatyyRouter.AckOutbox do
  @moduledoc """
  Acks a caminho da casa. Coalesce por {cid, device} (fica o maior seq) e
  reenvia até a casa (ou a nova casa após failover) confirmar.
  """
  use GenServer
  alias ChatyyRouter.Router

  @ets :rt_ack_outbox

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def add(cid, device, upto) do
    key = {cid, device}

    case :ets.lookup(@ets, key) do
      [{_, u}] when u >= upto -> :ok
      _ -> :ets.insert(@ets, {key, upto})
    end

    :ok
  end

  def pending, do: :ets.info(@ets, :size)

  @impl true
  def init(_) do
    if :ets.whereis(@ets) == :undefined do
      :ets.new(@ets, [:named_table, :public, :set, write_concurrency: true])
    end

    send(self(), :flush)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:flush, s) do
    rows = :ets.tab2list(@ets)

    rows
    |> Task.async_stream(
      fn {{cid, dev} = key, upto} ->
        case Router.home_cast_ack(cid, dev, upto) do
          :ok -> :ets.delete_object(@ets, {key, upto})
          _ -> :keep
        end
      end,
      max_concurrency: 64,
      timeout: 10_000,
      on_timeout: :kill_task
    )
    |> Stream.run()

    Process.send_after(self(), :flush, if(rows == [], do: 100, else: 20))
    {:noreply, s}
  end
end
