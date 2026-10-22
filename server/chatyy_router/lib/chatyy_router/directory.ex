defmodule ChatyyRouter.Directory do
  @moduledoc """
  Quem recebe: membros por conversa e aparelhos por usuário (com a região do
  edge onde o aparelho está). No protótipo é um ETS difundido entre os nós.
  Em produção:
    * membros  -> `chat_conversation_members` do PG replicado (global);
    * aparelhos -> `e2ee5_devices` (não revogados, vistos < 30 d) +
      região atual = presença do hub Go (`ChatyyRouter.Hub.region_of/1`).
  """
  use GenServer
  alias ChatyyRouter.Net

  @members :rt_members
  @devices :rt_devices

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def members(cid) do
    case :ets.lookup(@members, cid) do
      [{_, uids}] -> uids
      [] -> []
    end
  end

  def devices(uid) do
    case :ets.lookup(@devices, uid) do
      [{_, devs}] -> devs
      [] -> []
    end
  end

  @doc "Aparelhos destino ({device, região}), inclusive os OUTROS aparelhos do remetente."
  def recipients(cid, sender_device) do
    for uid <- members(cid), {d, r} <- devices(uid), d != sender_device, do: {d, r}
  end

  def put_members(cid, uids), do: broadcast({:members, cid, uids})
  def put_devices(uid, devs), do: broadcast({:devices, uid, devs})

  def push_sync(region) do
    Net.cast(region, __MODULE__, {:sync, :ets.tab2list(@members), :ets.tab2list(@devices)})
  end

  defp broadcast(msg) do
    GenServer.call(__MODULE__, msg)
    for r <- Net.alive_regions(), r != Net.me(), do: Net.cast(r, __MODULE__, msg)
    :ok
  end

  @impl true
  def init(_) do
    for t <- [@members, @devices], :ets.whereis(t) == :undefined do
      :ets.new(t, [:named_table, :public, :set, read_concurrency: true])
    end

    {:ok, %{}}
  end

  @impl true
  def handle_call(msg, _from, s) do
    apply_msg(msg)
    {:reply, :ok, s}
  end

  @impl true
  def handle_cast({:sync, members, devices}, s) do
    :ets.insert(@members, members)
    :ets.insert(@devices, devices)
    {:noreply, s}
  end

  def handle_cast(msg, s) do
    apply_msg(msg)
    {:noreply, s}
  end

  defp apply_msg({:members, cid, uids}), do: :ets.insert(@members, {cid, uids})
  defp apply_msg({:devices, uid, devs}), do: :ets.insert(@devices, {uid, devs})
end

defmodule ChatyyRouter.Hub do
  @moduledoc """
  Interface com o hub Go (WS dos apps) e a presença. SÓ INTERFACE no protótipo.

    push(device, msg)      entrega o frame ao aparelho se o WS estiver no
                           edge; senão o hub dispara o push (APNs/FCM).
    region_of(device)      região onde o aparelho está conectado agora.

  Contrato previsto com o hub (HTTP 127.0.0.1, JSON):
    POST {hub}/rt/deliver   {"device","cid","seq","epoch","body_b64","ts"}  -> 200 {"online":bool}
    GET  {hub}/rt/presence?device=D                                          -> {"region":"br2","online":true}
  E no sentido inverso o hub/PHP chama o Control deste nó:
    POST 127.0.0.1:4790/send  /ack  GET /fetch  (ver ChatyyRouter.Control)
  """
  @callback push(device :: term, msg :: map) :: :ok
  @callback region_of(device :: term) :: {:ok, String.t()} | {:error, term}

  def impl, do: ChatyyRouter.Config.hub_module()
  def push(device, msg), do: impl().push(device, msg)
  def region_of(device), do: impl().region_of(device)
end

defmodule ChatyyRouter.Hub.Stub do
  @moduledoc """
  Hub falso: aparelhos "conectados" = processos inscritos. Usado em testes e
  no benchmark (auto-ack e eco de entrega para medir latência ponta a ponta).
  """
  @behaviour ChatyyRouter.Hub
  use GenServer

  @subs :rt_hub_subs

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "opts: auto_ack: bool, pid: quem recebe {:rt_frame, device, msg}"
  def subscribe(device, opts), do: GenServer.call(__MODULE__, {:subscribe, device, opts})
  def unsubscribe(device), do: GenServer.call(__MODULE__, {:unsubscribe, device})

  @impl ChatyyRouter.Hub
  def push(device, msg) do
    case :ets.lookup(@subs, device) do
      [{_, opts}] ->
        if pid = opts[:pid], do: send(pid, {:rt_frame, device, msg})

        case msg do
          %{meta: %{reply_to: rp, ref: ref}} -> send(rp, {:rt_delivered, ref, device})
          _ -> :ok
        end

        if opts[:auto_ack], do: ChatyyRouter.Delivery.ack(device, msg.cid, msg.seq)
        ChatyyRouter.Telemetry.execute([:chatyy_router, :deliver, :push], %{count: 1})

      [] ->
        # offline: fica na inbox; em produção o hub mandaria push
        ChatyyRouter.Telemetry.execute([:chatyy_router, :deliver, :offline], %{count: 1})
    end

    :ok
  end

  @impl ChatyyRouter.Hub
  def region_of(_device), do: {:error, :stub}

  @impl GenServer
  def init(_) do
    if :ets.whereis(@subs) == :undefined do
      :ets.new(@subs, [:named_table, :public, :set, read_concurrency: true])
    end

    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:subscribe, d, opts}, _f, s) do
    :ets.insert(@subs, {d, Map.new(opts)})
    {:reply, :ok, s}
  end

  def handle_call({:unsubscribe, d}, _f, s) do
    :ets.delete(@subs, d)
    {:reply, :ok, s}
  end
end

defmodule ChatyyRouter.Hub.Http do
  @moduledoc "Esqueleto do adaptador real (hub Go via HTTP local). Não ligado no protótipo."
  @behaviour ChatyyRouter.Hub
  @impl true
  def push(_device, _msg), do: :ok
  @impl true
  def region_of(_device), do: {:error, :not_wired}
end

defmodule ChatyyRouter.Flags do
  @moduledoc """
  Kill switch. Arquivo (padrão /etc/chatyy-router/flags) com `RT_ROUTE=0|1`,
  relido a cada 2 s; `override/1` (Control POST /flags) vale até o restart.
  RT_ROUTE=0 => `send` responde {:error, :disabled} na hora e o chamador
  (leaf/PHP) volta ao caminho de hoje (gravar no master).
  """
  use GenServer
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def route?, do: :persistent_term.get({__MODULE__, :route}, true)
  def override(v) when is_boolean(v), do: GenServer.call(__MODULE__, {:override, v})

  @impl true
  def init(_) do
    send(self(), :reload)
    {:ok, %{override: nil}}
  end

  @impl true
  def handle_call({:override, v}, _f, s) do
    :persistent_term.put({__MODULE__, :route}, v)
    Logger.warning("router: kill switch override route=#{v}")
    {:reply, :ok, %{s | override: v}}
  end

  @impl true
  def handle_info(:reload, s) do
    if s.override == nil do
      v =
        case File.read(ChatyyRouter.Config.flags_file()) do
          {:ok, body} -> not String.contains?(body, "RT_ROUTE=0")
          _ -> true
        end

      if v != route?() do
        Logger.warning("router: kill switch arquivo route=#{v}")
        :persistent_term.put({__MODULE__, :route}, v)
      end
    end

    Process.send_after(self(), :reload, 2_000)
    {:noreply, s}
  end
end
