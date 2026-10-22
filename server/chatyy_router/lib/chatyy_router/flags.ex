defmodule ChatyyRouter.Flags do
  @moduledoc """
  Kill switches. Arquivo (padrão /etc/chatyy-router/flags), relido a cada 2 s:
    RT_ROUTE=0|1   R2+: `send` (escrita na casa) responde {:error, :disabled}
                   na hora e o chamador (leaf/PHP) volta a gravar no master.
    RT_FANOUT=0|1  R1: `/fanout` (entrega de mensagem com casa externa)
                   responde `disabled` e o leaf usa o broadcast de hoje.
                   PADRÃO 0 — R1 só liga explicitamente.
    RT_HUB=http    entrega pelo hub/leaf real (POST /rt/deliver em ROUTER_HUB_URL);
                   sem isso, ROUTER_HUB_MODULE (padrão Stub = não entrega).
    RT_OFFLINE=skip  R1 (22/10): aparelho SEM presença em nenhuma região e sem região real
                   conhecida NÃO é guardado/entregue no nó do remetente (que não é onde ele
                   vai reconectar): fica no caminho de hoje (root + push + sync). Padrão: desligado
                   (comportamento antigo = região deste nó).
  `override/2` (Control POST /flags?route=&fanout=) vale até o restart.
  """
  use GenServer
  require Logger

  @defaults %{route: true, fanout: false, hub_http: false, offline_skip: false}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def route?, do: :persistent_term.get({__MODULE__, :route}, @defaults.route)
  def fanout?, do: :persistent_term.get({__MODULE__, :fanout}, @defaults.fanout)
  def get(k), do: :persistent_term.get({__MODULE__, k}, @defaults[k])

  def override(v) when is_boolean(v), do: override(:route, v)
  def override(k, v) when k in [:route, :fanout, :hub_http, :offline_skip] and is_boolean(v), do: GenServer.call(__MODULE__, {:override, k, v})

  @impl true
  def init(_) do
    send(self(), :reload)
    {:ok, %{override: %{}}}
  end

  @impl true
  def handle_call({:override, k, v}, _f, s) do
    :persistent_term.put({__MODULE__, k}, v)
    Logger.warning("router: kill switch override #{k}=#{v}")
    {:reply, :ok, %{s | override: Map.put(s.override, k, v)}}
  end

  @impl true
  def handle_info(:reload, s) do
    body =
      case File.read(ChatyyRouter.Config.flags_file()) do
        {:ok, b} -> b
        _ -> ""
      end

    for {k, var} <- [route: "RT_ROUTE", fanout: "RT_FANOUT", hub_http: "RT_HUB", offline_skip: "RT_OFFLINE"],
        not Map.has_key?(s.override, k) do
      v =
        cond do
          k == :hub_http -> String.contains?(body, "RT_HUB=http")
          k == :offline_skip -> String.contains?(body, "RT_OFFLINE=skip")
          String.contains?(body, var <> "=0") -> false
          String.contains?(body, var <> "=1") -> true
          true -> @defaults[k]
        end

      if v != get(k) do
        Logger.warning("router: kill switch arquivo #{k}=#{v}")
        :persistent_term.put({__MODULE__, k}, v)
      end
    end

    Process.send_after(self(), :reload, 2_000)
    {:noreply, s}
  end
end
