defmodule ChatyyRouter.Config do
  @moduledoc """
  Configuração lida do application env (testes) ou de variáveis de ambiente
  (systemd EnvironmentFile). Nenhum segredo passa por aqui: o cookie fica em
  $HOME/.erlang.cookie (0400) e as chaves TLS no ssl_dist_optfile.

  Variáveis:
    ROUTER_REGION    região deste nó (ex.: "br2")
    ROUTER_REGIONS   anel, em ordem: "br2=router@10.8.0.7,mia=router@10.8.0.8,mad=router@10.8.0.10"
    ROUTER_SISTERS   irmã preferida por região: "br2=mia;mia=mad;mad=br2" (fallback = próxima do anel)
    ROUTER_QUORUM    regiões vistas (contando a si) p/ aceitar escrita e p/ promover (padrão = maioria)
    ROUTER_FAILOVER_MS  tempo fora antes de promover a irmã (padrão 60000)
    ROUTER_STORE     "disc" | "ram"
    ROUTER_ACK_MODE  "sister" (PADRÃO: só confirma/entrega depois de a irmã gravar c/ fsync; RPO 0)
                     | "local" (cópia assíncrona; RPO ≤ lag da irmã) — decisão do founder pendente
    ROUTER_FSYNC     "always" (padrão: put só volta após datasync, em grupo) | "none" (bench)
    ROUTER_LOG_DIR   diretório do Seglog (padrão /var/lib/chatyy-router/log)
    ROUTER_LOG_MAX_MB  teto de disco POR tabela de log (padrão 20480) → put = {:error, :disk_full}
    ROUTER_HOT_MS    janela do cache quente de corpos recém-gravados (padrão 60000)
    ROUTER_FANOUT    1|0 — R1: aceita /fanout (entrega de mensagem cuja casa é externa, ex. US)
    ROUTER_FANOUT_SKIP_REGIONS  regiões que o /fanout não entrega (padrão "us" = WS direto no hub US)
    ROUTER_PRESENCE_OWN_REGION  presença local só conta socket com esta região (padrão "us" no nó us)
    ROUTER_CTL_PORT  porta HTTP de controle em 127.0.0.1 (padrão 4790)
    ROUTER_FLAGS_FILE  kill switch (RT_ROUTE=0 desliga)
    ROUTER_HUB_URL   presença/entrega do hub Go (stub; não chamado no protótipo)
  """

  @day 86_400_000

  def get(key, default \\ nil) do
    case Application.get_env(:chatyy_router, key) do
      nil -> env(key, default)
      v -> v
    end
  end

  defp env(key, default) do
    name = "ROUTER_" <> String.upcase(Atom.to_string(key))

    case System.get_env(name) do
      nil -> default
      "" -> default
      v -> parse(key, v)
    end
  end

  @ints ~w(quorum failover_ms tick_ms redeliver_ms retention_ms dedupe_ms ctl_port idle_ms janitor_ms replica_timeout_ms hot_ms seg_max_bytes log_max_mb ping_ms fanout_ttl_ms ack_ttl_ms)a
  defp parse(k, v) when k in @ints, do: String.to_integer(v)
  defp parse(:regions, v), do: parse_regions(v)
  defp parse(:sisters, v), do: parse_sisters(v)
  defp parse(_k, v), do: v

  def parse_regions(v) do
    v
    |> String.split(",", trim: true)
    |> Enum.map(fn pair ->
      [r, n] = String.split(String.trim(pair), "=", parts: 2)
      {r, String.to_atom(n)}
    end)
  end

  def parse_sisters(v) do
    v
    |> String.split(";", trim: true)
    |> Map.new(fn pair ->
      [r, s] = String.split(String.trim(pair), "=", parts: 2)
      {r, String.split(s, ",", trim: true)}
    end)
  end

  def region, do: get(:region) || "local"
  def regions, do: get(:regions, [{region(), node()}])
  def region_names, do: Enum.map(regions(), &elem(&1, 0))

  @doc """
  Regiões que o R1 `/fanout` NÃO entrega (ROUTER_FANOUT_SKIP_REGIONS, padrão "us"): socket direto no hub US
  já recebeu pelo broadcast do próprio hub (o rt_fanout_hub roda DEPOIS dele) e o hub não tem dedupe
  fastIDs/rootIDs como o leaf — entregar de novo lá só duplicaria.
  """
  def fanout_skip_regions do
    case get(:fanout_skip_regions, "us") do
      l when is_list(l) -> l
      s -> String.split(to_string(s), ",", trim: true)
    end
  end

  @doc """
  Presença local só conta socket desta origem (ROUTER_PRESENCE_OWN_REGION). No nó us o /rt/presence é o do
  HUB, que enxerga TAMBÉM os sockets que chegam pelos leafs (região = a do leaf): sem o filtro o nó us
  diria "online aqui" para todo mundo. Padrão: "us" no nó us; nos edges (leaf só vê os próprios) sem filtro.
  """
  def presence_own_region do
    case get(:presence_own_region) do
      nil -> if region() == "us", do: "us", else: nil
      "" -> nil
      "*" -> nil
      v -> to_string(v)
    end
  end
  def sisters, do: get(:sisters, %{})

  @doc "Regiões que nunca servem de irmã/sucessora de outras (ROUTER_NEVER_SISTER=\"us\": o US só observa/recebe)."
  def never_sister do
    case get(:never_sister, []) do
      l when is_list(l) -> l
      s -> String.split(to_string(s), ",", trim: true)
    end
  end
  def quorum, do: get(:quorum) || div(length(regions()), 2) + 1
  def failover_ms, do: get(:failover_ms, 60_000)
  def tick_ms, do: get(:tick_ms, 1_000)
  def redeliver_ms, do: get(:redeliver_ms, 5_000)
  def retention_ms, do: get(:retention_ms, 30 * @day)
  def dedupe_ms, do: get(:dedupe_ms, 7 * @day)
  def idle_ms, do: get(:idle_ms, 300_000)
  def janitor_ms, do: get(:janitor_ms, 3_600_000)
  def store, do: to_string(get(:store, "disc"))
  def ack_mode, do: to_string(get(:ack_mode, "sister"))
  def ctl_port, do: get(:ctl_port, 4790)
  def flags_file, do: get(:flags_file, "/etc/chatyy-router/flags")
  def hub_url, do: get(:hub_url, "http://127.0.0.1:8086")
  def hub_module do
    case get(:hub_module, ChatyyRouter.Hub.Stub) do
      m when is_atom(m) -> m
      "http" -> ChatyyRouter.Hub.Http
      "stub" -> ChatyyRouter.Hub.Stub
      s when is_binary(s) -> String.to_existing_atom("Elixir." <> String.trim_leading(s, "Elixir."))
    end
  end

  @doc "Alguma fonte PG ligada (home/directory/ack)? Só então sobem as conexões PG."
  def pg_enabled? do
    to_string(get(:home_source, "local")) == "pg" or to_string(get(:dir_source, "local")) == "pg" or
      to_string(get(:ack_source, "off")) == "dlv"
  end
  def autostart?, do: get(:autostart, true) != false
end

defmodule ChatyyRouter.Clock do
  @moduledoc "Relógio com deslocamento injetável (testes de expiração de 30 dias)."
  def now_ms, do: System.os_time(:millisecond) + :persistent_term.get({__MODULE__, :offset}, 0)
  def advance(ms), do: :persistent_term.put({__MODULE__, :offset}, offset() + ms)
  def offset, do: :persistent_term.get({__MODULE__, :offset}, 0)
end
