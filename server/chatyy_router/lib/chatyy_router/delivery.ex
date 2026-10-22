defmodule ChatyyRouter.Delivery do
  @moduledoc """
  Lado da REGIÃO DO APARELHO: grava na inbox por aparelho (store-and-forward,
  expira em 30 d), confirma à casa que a região guardou e entrega ao hub.
  8 shards por nó (hash do cid) para não serializar tudo num processo.
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

  @doc "Aparelho confirmou até `upto` na conversa: apaga da inbox local e avisa a casa."
  def ack(device, cid, upto) do
    for seq <- Store.inbox_upto(device, cid, upto), do: Store.delete(:rt_inbox, {device, cid, seq})
    ChatyyRouter.AckOutbox.add(cid, device, upto)
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
    key_new? = fn d -> Store.get(:rt_inbox, {d, msg.cid, msg.seq}) == nil end
    fresh = Enum.filter(devs, key_new?)

    for d <- fresh, do: Store.put(:rt_inbox, {d, msg.cid, msg.seq}, {msg, exp})

    if pid = msg[:home_pid], do: Net.cast_pid(pid, {:region_stored, msg.seq, Net.me()})
    Telemetry.execute([:chatyy_router, :deliver, :stored], %{count: length(fresh)}, %{region: Net.me()})

    for d <- fresh, do: ChatyyRouter.Hub.push(d, msg)
    {:noreply, s}
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
