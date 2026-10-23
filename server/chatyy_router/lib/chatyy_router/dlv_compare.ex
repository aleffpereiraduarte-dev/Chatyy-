defmodule ChatyyRouter.DlvCompare do
  @moduledoc """
  [sgu F0 2026-10-23] Comparador SÓ LEITURA: inbox por aparelho DESTE nó (`:rt_inbox`, R1) × fila
  sombra `chat_msg_device_dlv` (réplica local, a mesma que a `AckSource` lê). Pergunta: o aparelho que
  recebeu a mensagem no roteador é o mesmo que a dlv esperava e que deu ack (e, com a coluna nova,
  que confirmou `persisted`)? Plano /root/sem-gravar-no-us-2026-10-22/PLANO.md §3.1 ("Roteador").

  Não muda entrega, ack, purge nem o caminho quente: lê o índice ETS do Seglog (sem corpo) e faz 1
  SELECT na réplica a cada ROUTER_F0_CMP_MS (padrão 60 s), janela ROUTER_F0_CMP_WINDOW_S (24 h),
  teto de ROUTER_F0_CMP_MAX linhas (20 000) de cada lado.

  Sobe só com a AckSource ligada (ROUTER_ACK_SOURCE=dlv + PG). Kill: env ROUTER_F0_CMP=0 (no boot)
  ou `RT_F0_CMP=0` no arquivo de flags (relido a cada 2 s; a varredura seguinte não roda e as
  métricas zeram com `enabled 0`).

  Métricas (/metrics):
    chatyy_router_rt_inbox_vs_dlv_mismatch{kind=...}  gauge — estado na última varredura:
      inbox_sem_dlv    inbox aqui há > graça, e a dlv não tem o (mid, aparelho) como esperado
      dlv_sem_inbox    dlv espera (mid, aparelho), sem ack, há > graça; o aparelho tem inbox NESTE nó
                       (é "daqui"), a conversa está no roteador, e a inbox não tem essa mensagem
                       (só destinatários; linhas is_sender=true vão para o kind abaixo)
      dlv_sem_inbox_remetente  o mesmo, para OUTRO aparelho do remetente (self-sync, coluna is_sender;
                       o Directory.recipients inclui os outros aparelhos do remetente)
      ack_divergente   inbox ainda pendente e a dlv já ackou há > graça (a AckSource devia ter apagado)
      persisted_divergente  (só com a coluna persisted_at) inbox ainda pendente e a dlv tem persisted_at
                       há > graça: o aparelho confirmou que GRAVOU, mas o ack de entrega (acked_at, que
                       é o que a AckSource usa) não fechou a inbox
    chatyy_router_rt_inbox_vs_dlv_mismatch_events_total{kind=...}  contador — entradas que SAÍRAM da
      inbox entre duas varreduras:
      inbox_apagada_sem_ack   saiu e a dlv não tem ack desse aparelho (expirou/outro caminho)
      apagada_sem_persisted   (só com a coluna persisted_at) saiu por ack, mas a dlv não tem
                              persisted_at → o roteador apagou corpo que o aparelho não confirmou gravado
  Contrato da dlv (kit PHP F0): persisted_at/persist_via só vêm do sinal "persisted" e NUNCA mexem em
  acked_at; linhas criadas só pelo persisted podem ter acked_at NULL. As colunas são detectadas (e
  re-detectadas a cada 30 varreduras enquanto faltarem): sem elas, persisted = nil e is_sender = false.
    chatyy_router_rt_f0_cmp_{enabled,compared,inbox,dlv_rows,dlv_persisted,persisted_col,scan_ms,last_ok_s}
    chatyy_router_rt_f0_cmp_errors_total
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, Seglog}
  alias ChatyyRouter.PG.Conn

  @gauge_kinds [:inbox_sem_dlv, :dlv_sem_inbox, :dlv_sem_inbox_remetente, :ack_divergente, :persisted_divergente]
  @event_kinds [:inbox_apagada_sem_ack, :apagada_sem_persisted]
  @pt {__MODULE__, :state}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "Liga no boot? (AckSource ligada e ROUTER_F0_CMP != 0)"
  def on? do
    ChatyyRouter.AckSource.on?() and to_string(Config.get(:f0_cmp, "1")) != "0"
  end

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  # ───────────────────────── lógica pura (testada) ─────────────────────────

  @doc """
  Compara. Entradas:
    inbox: [{device, cid, mid, ts_ms}] (entradas da inbox deste nó na janela)
    dlv:   [%{cid, mid, dev, expected: bool, acked_ms: int|nil, persisted_ms: int|nil}]
    prev:  MapSet de {device, cid, mid} vistas na varredura anterior (nil = 1ª varredura)
    opts:  now_ms, grace_ms, persisted_col (bool), cids (conversas "no roteador": as da inbox + configuradas)
  Saída: %{gauges: %{kind => n}, events: %{kind => n}, compared: n, persisted: n, keys: MapSet}
  """
  def compare(inbox, dlv, prev, opts) do
    now = Keyword.fetch!(opts, :now_ms)
    grace = Keyword.get(opts, :grace_ms, 300_000)
    pcol = Keyword.get(opts, :persisted_col, false)
    extra_cids = Keyword.get(opts, :cids, []) |> MapSet.new()

    dmap = Map.new(dlv, fn r -> {{r.dev, r.cid, r.mid}, r} end)
    keys = MapSet.new(inbox, fn {d, c, m, _} -> {d, c, m} end)
    local_devs = MapSet.new(inbox, &elem(&1, 0))
    cids = MapSet.union(extra_cids, MapSet.new(inbox, &elem(&1, 1)))
    old? = fn ts -> is_integer(ts) and now - ts > grace end

    {isd, ackd, perd} =
      Enum.reduce(inbox, {0, 0, 0}, fn {d, c, m, ts}, {a, b, p} ->
        r = Map.get(dmap, {d, c, m})

        cond do
          not old?.(ts) -> {a, b, p}
          r == nil or r.expected != true -> {a + 1, b, p}
          old?.(r.acked_ms) -> {a, b + 1, p}
          pcol and old?.(r.persisted_ms) -> {a, b, p + 1}
          true -> {a, b, p}
        end
      end)

    missing =
      Enum.filter(dlv, fn r ->
        r.expected == true and r.acked_ms == nil and MapSet.member?(local_devs, r.dev) and
          MapSet.member?(cids, r.cid) and old?.(r[:msg_ms] || 0) and
          not MapSet.member?(keys, {r.dev, r.cid, r.mid}) and
          not (prev != nil and MapSet.member?(prev, {r.dev, r.cid, r.mid}))
      end)

    dsi_s = Enum.count(missing, &(Map.get(&1, :is_sender) == true))

    gone = if prev == nil, do: [], else: MapSet.difference(prev, keys) |> MapSet.to_list()

    {sem_ack, pdiv} =
      Enum.reduce(gone, {0, 0}, fn k, {a, b} ->
        case Map.get(dmap, k) do
          %{acked_ms: ack} = r when is_integer(ack) ->
            if pcol and r.persisted_ms == nil, do: {a, b + 1}, else: {a, b}

          _ ->
            {a + 1, b}
        end
      end)

    compared = Enum.count(inbox, fn {d, c, m, _} -> Map.has_key?(dmap, {d, c, m}) end)

    %{
      gauges: %{
        inbox_sem_dlv: isd,
        dlv_sem_inbox: length(missing) - dsi_s,
        dlv_sem_inbox_remetente: dsi_s,
        ack_divergente: ackd,
        persisted_divergente: perd
      },
      events: %{inbox_apagada_sem_ack: sem_ack, apagada_sem_persisted: if(pcol, do: pdiv, else: 0)},
      compared: compared,
      persisted: Enum.count(dlv, &is_integer(&1.persisted_ms)),
      keys: keys
    }
  end

  @doc "Entradas {key, exp, aux} do índice → [{dev, cid, mid, ts_ms}] (só cid/mid inteiros, na janela)."
  def inbox_rows(meta, retention_ms, since_ms, max) do
    meta
    |> Stream.flat_map(fn
      {{d, c, m}, exp, _aux} when is_binary(d) and is_integer(c) and is_integer(m) and is_integer(exp) ->
        ts = exp - retention_ms
        if ts >= since_ms, do: [{d, c, m, ts}], else: []

      _ ->
        []
    end)
    |> Enum.take(max)
  end

  @doc "Linhas texto da réplica → mapas."
  def parse_dlv(rows) do
    for [c, m, d, e, msg, ack | rest] <- rows do
      [per, snd] = Enum.take(rest ++ [nil, nil], 2)

      %{
        cid: String.to_integer(c),
        mid: String.to_integer(m),
        dev: d,
        expected: e in ["t", "true"],
        msg_ms: int(msg),
        acked_ms: int(ack),
        persisted_ms: int(per),
        is_sender: snd in ["t", "true"]
      }
    end
  end

  defp int(nil), do: nil
  defp int(s), do: String.to_integer(s)

  # ───────────────────────── processo ─────────────────────────

  @impl true
  def init(_) do
    if on?() do
      put_state(%{enabled: 1})
      Process.send_after(self(), :scan, 15_000)
      {:ok, %{prev: nil, pcol: nil, scol: false, pcol_checks: 0}}
    else
      :ignore
    end
  end

  @impl true
  def handle_info(:scan, s) do
    s =
      if ChatyyRouter.Flags.get(:f0_cmp) == false do
        put_state(%{enabled: 0})
        %{s | prev: nil}
      else
        try do
          scan(s)
        rescue
          e ->
            ChatyyRouter.Metrics.inc(:rt_f0_cmp_errors)
            Logger.warning("router f0_cmp: #{inspect(e) |> String.slice(0, 200)}")
            s
        end
      end

    Process.send_after(self(), :scan, int_cfg(:f0_cmp_ms, 60_000))
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  defp scan(s) do
    t0 = System.monotonic_time(:millisecond)
    now = ChatyyRouter.Clock.now_ms()
    win = int_cfg(:f0_cmp_window_s, 86_400)
    max = int_cfg(:f0_cmp_max, 20_000)
    s = detect_pcol(s)
    inbox = inbox_rows(Seglog.meta_all(:rt_inbox), Config.retention_ms(), now - win * 1000, max)
    cids = (Enum.map(inbox, &elem(&1, 1)) ++ cfg_cids()) |> Enum.uniq()

    if cids == [] do
      put_state(%{enabled: 1, compared: 0, inbox: 0, dlv_rows: 0, dlv_persisted: 0, persisted_col: b(s.pcol),
                  scan_ms: 0, last_ok_s: div(now, 1000), gauges: Map.new(@gauge_kinds, &{&1, 0})})
      %{s | prev: MapSet.new()}
    else
      pc =
        (if s.pcol, do: ", (EXTRACT(EPOCH FROM persisted_at)*1000)::bigint::text", else: ", NULL::text") <>
          if(s.scol, do: ", is_sender::text", else: ", 'false'")

      sql = """
      SELECT conversation_id::text, message_id::text, device_id, expected::text,
             (EXTRACT(EPOCH FROM msg_at)*1000)::bigint::text, (EXTRACT(EPOCH FROM acked_at)*1000)::bigint::text#{pc}
        FROM chat_msg_device_dlv
       WHERE msg_at > now() - make_interval(secs => $1::int)
         AND conversation_id = ANY($2::bigint[])
         AND device_id <> '?'
       LIMIT #{max}
      """

      case Conn.query(:replica, sql, [win, "{" <> Enum.map_join(cids, ",", &Integer.to_string/1) <> "}"], 15_000) do
        {:ok, %{rows: rows}} ->
          dlv = parse_dlv(rows)

          r =
            compare(inbox, dlv, s.prev,
              now_ms: now,
              grace_ms: int_cfg(:f0_cmp_grace_ms, 300_000),
              persisted_col: s.pcol == true,
              cids: cfg_cids()
            )

          for {k, n} <- r.events, n > 0, do: ChatyyRouter.Metrics.inc({:rt_inbox_vs_dlv_mismatch_events, k}, n)

          put_state(%{
            enabled: 1,
            gauges: r.gauges,
            compared: r.compared,
            inbox: length(inbox),
            dlv_rows: length(dlv),
            dlv_persisted: r.persisted,
            persisted_col: b(s.pcol),
            scan_ms: System.monotonic_time(:millisecond) - t0,
            last_ok_s: div(now, 1000)
          })

          %{s | prev: r.keys}

        {:error, e} ->
          ChatyyRouter.Metrics.inc(:rt_f0_cmp_errors)
          Logger.warning("router f0_cmp pg: #{inspect(e) |> String.slice(0, 200)}")
          s
      end
    end
  end

  # coluna persisted_at (kit PHP da F0): detecta no início e, enquanto não existir, a cada 30 varreduras
  defp detect_pcol(%{pcol: true, scol: true} = s), do: s

  defp detect_pcol(%{pcol: p, pcol_checks: n} = s) when p == nil or rem(n, 30) == 0 do
    sql = "SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_msg_device_dlv' AND column_name IN ('persisted_at', 'is_sender')"

    case Conn.query(:replica, sql, [], 5_000) do
      {:ok, %{rows: rows}} ->
        cols = List.flatten(rows)
        %{s | pcol: "persisted_at" in cols, scol: "is_sender" in cols, pcol_checks: n + 1}

      _ -> %{s | pcol_checks: n + 1}
    end
  end

  defp detect_pcol(s), do: %{s | pcol_checks: s.pcol_checks + 1}

  defp cfg_cids do
    case Config.get(:f0_cmp_cids, "959,2586") do
      l when is_list(l) -> l
      v -> v |> to_string() |> String.split(",", trim: true) |> Enum.flat_map(&(case Integer.parse(String.trim(&1)) do {i, ""} -> [i]; _ -> [] end))
    end
  end

  defp b(true), do: 1
  defp b(_), do: 0

  defp put_state(m), do: :persistent_term.put(@pt, Map.merge(:persistent_term.get(@pt, %{}), m))

  @doc "Linhas Prometheus (chamado por Metrics.gauges; vazio se o comparador nunca subiu)."
  def prom_lines do
    case :persistent_term.get(@pt, nil) do
      nil ->
        []

      st ->
        g = Map.get(st, :gauges, %{})

        [
          for(k <- @gauge_kinds, do: "chatyy_router_rt_inbox_vs_dlv_mismatch{kind=\"#{k}\"} #{if st.enabled == 1, do: Map.get(g, k, 0), else: 0}\n"),
          for(k <- [:enabled, :compared, :inbox, :dlv_rows, :dlv_persisted, :persisted_col, :scan_ms, :last_ok_s],
              do: "chatyy_router_rt_f0_cmp_#{k} #{Map.get(st, k, 0)}\n")
        ]
    end
  end

  def event_kinds, do: @event_kinds
end
