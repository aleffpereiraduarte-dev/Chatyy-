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
    RT_F0_CMP=0    [sgu F0] desliga o comparador inbox × dlv (ChatyyRouter.DlvCompare; só medição).
                   Padrão ligado (se a AckSource estiver ligada e ROUTER_F0_CMP != 0 no boot).
    [sgu F1 2026-10-23] armazenamento durável do corpo (ChatyyRouter.BodyStore):
    RT_STORE=0|1   /store e a cópia do /fanout. PADRÃO 0 (inerte). Com 0 nada novo é gravado; o que já
                   está guardado continua servindo /pull (kill global da F1 em ≤ 2 s).
    RT_F1_CMP=0    desliga o comparador roteador × PG (ChatyyRouter.BodyCompare). Padrão ligado.
    RT_STORE_REPAIR=pg  o comparador COPIA do PG (réplica) o que faltar na casa (conta como reparo, não
                   como acerto). Padrão desligado: na F1 a falta tem que aparecer.
    [sgu F4 2026-10-23] RT_F4=1  conv_pts na casa + recibos/apagar para todos/contadores (ChatyyRouter.F4) nas
                   conversas body_store >= 3. PADRÃO 0 (inerte): sem pts novo, /store recusa receipt/delete.
    RT_INHERIT=auto  herança de inbox automática (A5) quando um aparelho é revogado e outro do mesmo uid
                   nasce ±24 h da revogação. Padrão desligado (só o POST /inherit explícito).
  `override/2` (Control POST /flags?route=&fanout=) vale até o restart.
  """
  use GenServer
  require Logger

  @defaults %{route: true, fanout: false, hub_http: false, offline_skip: false, f0_cmp: true, store: false, f1_cmp: true, store_repair: false, inherit_auto: false, f4: false}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def route?, do: :persistent_term.get({__MODULE__, :route}, @defaults.route)
  def fanout?, do: :persistent_term.get({__MODULE__, :fanout}, @defaults.fanout)
  def get(k), do: :persistent_term.get({__MODULE__, k}, @defaults[k])

  def override(v) when is_boolean(v), do: override(:route, v)
  def override(k, v) when k in [:route, :fanout, :hub_http, :offline_skip, :f0_cmp, :store, :f1_cmp, :store_repair, :inherit_auto, :f4] and is_boolean(v), do: GenServer.call(__MODULE__, {:override, k, v})

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

    for {k, var} <- [route: "RT_ROUTE", fanout: "RT_FANOUT", hub_http: "RT_HUB", offline_skip: "RT_OFFLINE", f0_cmp: "RT_F0_CMP",
                    store: "RT_STORE", f1_cmp: "RT_F1_CMP", store_repair: "RT_STORE_REPAIR", inherit_auto: "RT_INHERIT", f4: "RT_F4"],
        not Map.has_key?(s.override, k) do
      v =
        cond do
          k == :hub_http -> String.contains?(body, "RT_HUB=http")
          k == :offline_skip -> String.contains?(body, "RT_OFFLINE=skip")
          k == :store_repair -> line?(body, "RT_STORE_REPAIR", "pg")
          k == :inherit_auto -> line?(body, "RT_INHERIT", "auto")
          k == :store -> line?(body, "RT_STORE", "1")
          k == :f4 -> line?(body, "RT_F4", "1")
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

  # [sgu F1] chave exata no começo da linha (RT_STORE não casa com RT_STORE_REPAIR); a última linha vale
  defp line?(body, key, val) do
    body
    |> String.split("\n")
    |> Enum.map(&String.trim/1)
    |> Enum.filter(&String.starts_with?(&1, key <> "="))
    |> List.last()
    |> case do
      nil -> false
      l -> String.trim(String.trim_leading(l, key <> "="), ~s("' )) == val
    end
  end
end
