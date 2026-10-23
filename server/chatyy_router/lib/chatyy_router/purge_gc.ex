defmodule ChatyyRouter.PurgeGc do
  @moduledoc """
  [sgu F3 2026-10-23] GC do roteador para conversas MARCADAS (plano
  /root/sem-gravar-no-us-2026-10-22/PLANO.md §6, kit .../f3). Módulo NOVO e isolado: sozinho não muda
  nada. Pontos de integração (LEIA.txt do kit; `f3/roteador/integrar.py` aplica por âncora):
    1. supervisor: `ChatyyRouter.PurgeGc` na lista do `pg_enabled?` (application.ex, 1 linha);
    2. env `ROUTER_BODY_PURGE_MODULE=ChatyyRouter.PurgeGc` — este módulo implementa o ponto de
       extensão `ChatyyRouter.BodyStore.Purge` da F1 (`all_persisted/2`, caminho rápido);
    3. /metrics: `ChatyyRouter.PurgeGc.prom_lines/0` (telemetry.ex, 1 linha);
    4. BodyStore não regrava chave já apagada: a F1 consulta `BodyStore.Purge.purged?/2` (callback
       opcional → `purged?/2` daqui) no `accept` e no `put_copies`. Se faltar, a varredura reapaga o
       que voltar (conta `resurrected`);
    5. (opcional) `Seglog.compact/2` no escritor; sem ele a compactação usa `:sys.replace_state/2`.

  Conversas: só as presentes em `sgu_f3_flags` (réplica local do PG; o WAL leva aos 11 nós).
    `mode='dryrun'` → só conta e loga; `mode='apply'` → apaga, e só se o arquivo de flags tiver
    `RT_PURGE=1`. Sem linha → nunca toca. `RT_PURGE=0` → nem conta (kill: vale na próxima volta, ≤ 5 min;
    o caminho rápido `all_persisted/2` confere o arquivo na hora). Padrão (sem linha) = dryrun.

  Regra (igual à do PHP `api/sgu-f3-gc.php`, para o relatório não divergir) — `decide/2`:
    * apagável quando TODO aparelho esperado VIVO tem `persisted` há mais de ROUTER_PURGE_GRACE_MS
      (60 s). Esperados = os aparelhos CONGELADOS no registro (`:rt_body` aux, destinatários + outros
      aparelhos do remetente); sem lista, os `expected` da dlv. `persisted` = dlv `persisted_at` ou
      `:rt_body_ack` (F1). Vivo = não revogado e com uso < 30 d (R1; `last_seen_at` nulo conta como vivo);
    * nenhum esperado vivo, ou sem dlv/lista → NÃO apaga (fica para os 30 d);
    * idade ≥ retenção (30 d) → `ttl` (o Seglog já vence; aqui antecipa o apagar nas cópias);
    * inbox por aparelho do R1 (`:rt_inbox` {device, cid, mid}) deste nó: sai quando AQUELE aparelho
      tem `persisted`.
  Quem decide o corpo é a casa em exercício (`BodyHome.acting?/1`); o apagar vai a TODOS os nós vivos
  (casa + 2 irmãs e quem mais tiver cópia) e fica uma LÁPIDE local `:rt_f3_purged` {cid, sub} (Seglog
  próprio, 31 d) para o reparo não ressuscitar. Lápides são reenviadas aos pares a cada hora (nó que
  estava fora recebe). Concorrência com o BodyStore gravando a MESMA chave: aceita (ver Seglog); a
  lápide + varredura corrige.

  Compactação física do Seglog: `ChatyyRouter.SeglogCompact`, 1×/ROUTER_COMPACT_MS (24 h);
  `RT_COMPACT=1` reescreve, `RT_COMPACT=0` não roda, padrão só mede.

  Métricas (`prom_lines/0`):
    chatyy_router_rt_purge_total{mode="dryrun|apply",reason="all_persisted|all_persisted_r1|ttl|inbox_persisted"}
    chatyy_router_rt_purge_keep{reason="pendente|sem_esperado|sem_dlv|graca|inbox_*"}   gauge da última volta
    chatyy_router_rt_purge_resurrected_total   chave apagada que voltou (reparo) e foi reapagada
    chatyy_router_rt_purge_{enabled,convs_dryrun,convs_apply,tombstones,scan_ms,last_ok_s}
    chatyy_router_seglog_{live,dead}_bytes{table}   chatyy_router_seglog_compact_{moved,bytes,segments,races}_total{mode}
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, Net, Store, Seglog, SeglogCompact}
  alias ChatyyRouter.PG.Conn

  @pt {__MODULE__, :state}
  @flagged {__MODULE__, :flagged}
  @tomb :rt_f3_purged
  @day 86_400_000

  # ───────────────────────── configuração ─────────────────────────

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  @doc "RT_PURGE / RT_COMPACT do arquivo de flags (o mesmo do ChatyyRouter.Flags). Valores: \"0\" | \"1\" | \"dryrun\"."
  def file_flags(body \\ nil) do
    body =
      body ||
        case File.read(Config.flags_file()) do
          {:ok, b} -> b
          _ -> ""
        end

    %{purge: flag_val(body, "RT_PURGE", "dryrun"), compact: flag_val(body, "RT_COMPACT", "dryrun")}
  end

  # a ÚLTIMA linha da chave vale (igual ao Flags.line?/3 da F1); valor desconhecido = padrão
  defp flag_val(body, var, default) do
    case Regex.scan(~r/^\s*#{var}=["']?([A-Za-z0-9]+)["']?\s*$/m, body) |> List.last() do
      [_, v] when v in ["0", "1", "dryrun"] -> v
      _ -> default
    end
  end

  @doc "Conversa marcada para a F3 (qualquer modo)? Lido do cache da última varredura."
  def flagged?(cid), do: Map.has_key?(:persistent_term.get(@flagged, %{}), cid)

  @doc "Modo da conversa: \"dryrun\" | \"apply\" | nil."
  def mode(cid), do: Map.get(:persistent_term.get(@flagged, %{}), cid)

  @doc "Chave já apagada pela F3 (lápide local)? Integração 4: o BodyStore não regrava."
  def purged?(cid, sub) do
    :ets.whereis(Seglog.idx(@tomb)) != :undefined and Seglog.member?(@tomb, {cid, sub})
  end

  # ───────────────────────── lógica pura (testada) ─────────────────────────

  @doc """
  Decide UMA chave. `devs` = um mapa por aparelho esperado:
    %{dev, expected, persisted_ms, revoked_ms, last_seen_ms}
  opts: now_ms, msg_ms, retention_ms (30 d), stale_ms (30 d, R1), grace_ms (60 s).
  → {:purge, :all_persisted | :all_persisted_r1 | :ttl} | {:keep, :pendente | :sem_esperado | :sem_dlv | :graca}
  """
  def decide(devs, opts) do
    now = Keyword.fetch!(opts, :now_ms)
    msg_ms = Keyword.get(opts, :msg_ms)
    ret = Keyword.get(opts, :retention_ms, 30 * @day)
    stale = Keyword.get(opts, :stale_ms, 30 * @day)
    grace = Keyword.get(opts, :grace_ms, 60_000)

    expected = Enum.filter(devs, &(&1[:expected] == true and &1[:dev] not in [nil, "", "?"]))
    {live, gone} = Enum.split_with(expected, &live?(&1, now, stale))

    cond do
      is_integer(msg_ms) and now - msg_ms >= ret -> {:purge, :ttl}
      devs == [] -> {:keep, :sem_dlv}
      live == [] -> {:keep, :sem_esperado}
      Enum.any?(live, &(not is_integer(&1[:persisted_ms]))) -> {:keep, :pendente}
      Enum.any?(live, &(now - &1.persisted_ms < grace)) -> {:keep, :graca}
      gone != [] -> {:purge, :all_persisted_r1}
      true -> {:purge, :all_persisted}
    end
  end

  @doc "Aparelho conta na regra? (não revogado e com uso nos últimos 30 d; sem last_seen = conta)"
  def live?(d, now, stale_ms) do
    not is_integer(d[:revoked_ms]) and (not is_integer(d[:last_seen_ms]) or now - d.last_seen_ms < stale_ms)
  end

  @doc "Inbox de UM aparelho: sai quando esse aparelho gravou (persisted) há mais que a graça, ou 30 d."
  def decide_inbox(row, opts) do
    now = Keyword.fetch!(opts, :now_ms)
    grace = Keyword.get(opts, :grace_ms, 60_000)
    ret = Keyword.get(opts, :retention_ms, 30 * @day)
    msg_ms = Keyword.get(opts, :msg_ms)

    cond do
      is_integer(msg_ms) and now - msg_ms >= ret -> {:purge, :ttl}
      row == nil -> {:keep, :sem_dlv}
      is_integer(row[:persisted_ms]) and now - row.persisted_ms >= grace -> {:purge, :inbox_persisted}
      is_integer(row[:persisted_ms]) -> {:keep, :graca}
      true -> {:keep, :pendente}
    end
  end

  @doc """
  Monta a lista de aparelhos de UMA chave do corpo:
    frozen  = aparelhos congelados no registro (lista) ou nil
    dlv     = linhas da dlv da mensagem [%{dev, expected, persisted_ms}]
    acks    = %{dev => persisted_ms} vindos do :rt_body_ack
    devinfo = %{dev => %{revoked_ms, last_seen_ms}}
  """
  def build_devs(frozen, dlv, acks, devinfo) do
    dlv_per = Map.new(dlv, &{&1.dev, &1[:persisted_ms]})
    exp = if is_list(frozen), do: frozen, else: for(r <- dlv, r[:expected] == true, do: r.dev)

    for d <- Enum.uniq(exp) do
      info = Map.get(devinfo, d, %{})
      per = [Map.get(dlv_per, d), Map.get(acks, d)] |> Enum.filter(&is_integer/1) |> Enum.min(fn -> nil end)
      %{dev: d, expected: true, persisted_ms: per, revoked_ms: info[:revoked_ms], last_seen_ms: info[:last_seen_ms]}
    end
  end

  @doc "Linhas texto da réplica (dlv) → %{mid => [%{dev, expected, persisted_ms, msg_ms}]}."
  def parse_dlv(rows) do
    Enum.reduce(rows, %{}, fn [m, d, e, msg, per], acc ->
      r = %{dev: d, expected: e in ["t", "true"], msg_ms: int(msg), persisted_ms: int(per)}
      Map.update(acc, String.to_integer(m), [r], &[r | &1])
    end)
  end

  defp int(nil), do: nil
  defp int(s), do: String.to_integer(s)

  # ───────────────────────── caminho rápido (BodyStore.Purge da F1) ─────────────────────────

  @doc """
  Chamado pelo BodyStore (casa em exercício) quando TODOS os aparelhos congelados confirmaram
  `persisted` (contrato `ChatyyRouter.BodyStore.Purge`). Só apaga com conversa `apply` + RT_PURGE=1;
  senão conta dry-run. A varredura cobre o resto (R1, TTL, graça).
  """
  def all_persisted({cid, sub}, _rec) do
    ff = file_flags()

    case mode(cid) do
      nil ->
        ChatyyRouter.Metrics.inc(:rt_f1_would_purge)

      m ->
        cond do
          m == "apply" and ff.purge == "1" ->
            drop_everywhere(cid, [sub], :all_persisted)
            count("apply", :all_persisted)

          ff.purge != "0" ->
            count("dryrun", :all_persisted)

          true ->
            :ok
        end
    end

    :ok
  end

  # ───────────────────────── processo ─────────────────────────

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "Varredura agora (rpc/teste). Devolve o resumo."
  def run_now, do: GenServer.call(__MODULE__, :run, 120_000)

  @doc "Compactação agora: mode \"1\" reescreve, outro valor só mede."
  def compact_now(mode \\ "dryrun"), do: GenServer.call(__MODULE__, {:compact, mode}, 600_000)

  @impl true
  def init(_) do
    if to_string(Config.get(:purge_gc, "1")) == "0" do
      :ignore
    else
      {:ok, _} = Seglog.start_link(@tomb)
      put_state(%{enabled: 1})
      Process.send_after(self(), :scan, int_cfg(:purge_first_ms, 60_000))
      Process.send_after(self(), :compact, int_cfg(:compact_first_ms, 600_000))
      Process.send_after(self(), :gossip, 3_600_000)
      {:ok, %{last: nil}}
    end
  end

  @impl true
  def handle_call(:run, _f, s) do
    r = safe_scan()
    {:reply, r, %{s | last: r}}
  end

  def handle_call({:compact, mode}, _f, s), do: {:reply, do_compact(mode), s}

  @impl true
  def handle_cast({:drop, cid, subs, why}, s) do
    drop_local(cid, subs, why)
    {:noreply, s}
  end

  def handle_cast({:tombs, keys}, s) do
    # lápides de outro nó (gossip): grava as que faltam e apaga o corpo se ainda existir
    for {cid, sub} <- keys, not purged?(cid, sub), do: drop_local(cid, [sub], :gossip)
    {:noreply, s}
  end

  @impl true
  def handle_info(:scan, s) do
    r = safe_scan()
    Process.send_after(self(), :scan, int_cfg(:purge_ms, 300_000))
    {:noreply, %{s | last: r}}
  end

  def handle_info(:compact, s) do
    ff = file_flags()
    if ff.purge != "0" and ff.compact != "0", do: do_compact(ff.compact)
    Process.send_after(self(), :compact, int_cfg(:compact_ms, @day))
    {:noreply, s}
  end

  def handle_info(:gossip, s) do
    keys = for {k, _exp, _aux} <- Seglog.meta_all(@tomb), do: k

    if keys != [] do
      for r <- Net.alive_regions() -- [Net.me()], ch <- Enum.chunk_every(keys, 5_000), do: Net.cast(r, __MODULE__, {:tombs, ch})
    end

    Process.send_after(self(), :gossip, 3_600_000)
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  defp safe_scan do
    try do
      scan()
    rescue
      e ->
        ChatyyRouter.Metrics.inc(:rt_purge_errors)
        Logger.warning("router f3_purge: #{inspect(e) |> String.slice(0, 200)}")
        %{error: true}
    end
  end

  @doc false
  def scan do
    t0 = System.monotonic_time(:millisecond)
    now = ChatyyRouter.Clock.now_ms()
    ff = file_flags()

    if ff.purge == "0" do
      :persistent_term.put(@flagged, %{})
      put_state(%{enabled: 0, keep: %{}, convs_dryrun: 0, convs_apply: 0})
      %{enabled: 0}
    else
      flags = load_flags()
      :persistent_term.put(@flagged, flags)
      res = Enum.reduce(flags, %{purged: %{}, keep: %{}}, fn {cid, mode}, acc -> scan_conv(cid, mode, ff, now, acc) end)
      Seglog.expire(@tomb, now)

      put_state(%{
        enabled: 1,
        keep: res.keep,
        convs_dryrun: Enum.count(flags, &(elem(&1, 1) == "dryrun")),
        convs_apply: Enum.count(flags, &(elem(&1, 1) == "apply")),
        tombstones: Seglog.size(@tomb),
        scan_ms: System.monotonic_time(:millisecond) - t0,
        last_ok_s: div(now, 1000)
      })

      res
    end
  end

  # %{cid => "dryrun" | "apply"}; tabela ausente (DDL do kit F3 não aplicado) → nada marcado
  defp load_flags do
    with {:ok, %{rows: [["true"]]}} <- Conn.query(:replica, "SELECT (to_regclass('public.sgu_f3_flags') IS NOT NULL)::text", [], 5_000),
         {:ok, %{rows: rows}} <- Conn.query(:replica, "SELECT conversation_id::text, mode FROM sgu_f3_flags", [], 5_000) do
      for [c, m] <- rows, m in ["dryrun", "apply"], into: %{}, do: {String.to_integer(c), m}
    else
      {:ok, _} -> %{}
      {:error, e} -> raise "flags: #{inspect(e) |> String.slice(0, 120)}"
    end
  end

  # tabelas da F1 (:rt_body no Seglog, :rt_body_ack no Mnesia) — ausentes antes da F1 / nos testes
  defp body_table?, do: :rt_body in Store.log_tables() and :ets.whereis(Seglog.idx(:rt_body)) != :undefined

  defp acks_table? do
    :rt_body_ack in Store.mnesia_tables() and
      (try do
         :rt_body_ack in :mnesia.system_info(:tables)
       catch
         _, _ -> false
       end)
  end
  defp acting?(cid), do: Code.ensure_loaded?(ChatyyRouter.BodyHome) and apply(ChatyyRouter.BodyHome, :acting?, [cid])

  defp scan_conv(cid, mode, ff, now, acc) do
    apply? = mode == "apply" and ff.purge == "1"
    tag = if apply?, do: "apply", else: "dryrun"
    opts = [now_ms: now, retention_ms: Config.retention_ms(), grace_ms: int_cfg(:purge_grace_ms, 60_000), stale_ms: int_cfg(:purge_stale_ms, 30 * @day)]

    # lápides que voltaram (reparo/cópia sem a integração 4): reapaga
    if body_table?() and apply? do
      back = for {{^cid, sub}, _, _} <- Seglog.meta_all(@tomb), Store.member?(:rt_body, {cid, sub}), do: sub

      if back != [] do
        for sub <- back, do: Store.delete(:rt_body, {cid, sub})
        ChatyyRouter.Metrics.inc(:rt_purge_resurrected, length(back))
      end
    end

    # corpos (:rt_body) — só a casa em exercício decide
    body =
      if body_table?() and acting?(cid) do
        :ets.select(Seglog.idx(:rt_body), [{{{cid, :"$1"}, :_, :_, :_, :_, :"$2"}, [], [{{:"$1", :"$2"}}]}])
      else
        []
      end

    inbox = Seglog.select_keys(:rt_inbox, {:"$1", cid, :"$2"}, [], {{:"$1", :"$2"}})

    mids =
      (for({sub, _} <- body, is_integer(sub), do: sub) ++ for({_, m} <- inbox, is_integer(m), do: m))
      |> Enum.uniq()

    dlv = dlv_rows(cid, mids)
    acks = body_acks(cid)

    frozen_devs = for {_, {_ts, _sha, devs, _kind}} <- body, is_list(devs), d <- devs, do: d
    dlv_devs = for {_, rows} <- dlv, r <- rows, do: r.dev
    devinfo = dev_info(Enum.uniq(frozen_devs ++ dlv_devs))

    {acc, drops} =
      Enum.reduce(body, {acc, %{}}, fn {sub, {ts, _sha, frozen, _kind}}, {acc, drops} ->
        rows = if is_integer(sub), do: Map.get(dlv, sub, []), else: []
        devs = build_devs(frozen, rows, Map.get(acks, sub, %{}), devinfo)

        case decide(devs, Keyword.put(opts, :msg_ms, ts)) do
          {:purge, why} ->
            count(tag, why)
            {bump(acc, :purged, why), Map.update(drops, why, [sub], &[sub | &1])}

          {:keep, why} ->
            {bump(acc, :keep, why), drops}
        end
      end)

    if apply?, do: for({why, subs} <- drops, do: drop_everywhere(cid, subs, why))

    acc =
      Enum.reduce(inbox, acc, fn {dev, mid}, acc ->
        rows = Map.get(dlv, mid, [])
        row = Enum.find(rows, &(&1.dev == dev))
        msg_ms = rows |> Enum.map(& &1.msg_ms) |> Enum.reject(&is_nil/1) |> Enum.min(fn -> nil end)

        case decide_inbox(row, Keyword.put(opts, :msg_ms, msg_ms)) do
          {:purge, why} ->
            if apply?, do: Store.delete(:rt_inbox, {dev, cid, mid})
            count(tag, why)
            bump(acc, :purged, why)

          {:keep, why} ->
            bump(acc, :keep, {:inbox, why})
        end
      end)

    if body != [] or inbox != [] do
      Logger.info("router f3_purge cid=#{cid} modo=#{tag} corpo=#{length(body)} inbox=#{length(inbox)} apagaria=#{inspect(acc.purged)} fica=#{inspect(acc.keep)}")
    end

    acc
  end

  # apaga aqui + manda todos os nós vivos apagarem (cópias das irmãs e quem mais tiver)
  defp drop_everywhere(cid, subs, why) do
    drop_local(cid, subs, why)
    for r <- Net.alive_regions() -- [Net.me()], do: Net.cast(r, __MODULE__, {:drop, cid, subs, why})
    :ok
  end

  @doc false
  def drop_local(cid, subs, why) do
    now = ChatyyRouter.Clock.now_ms()
    # lápide primeiro (fsync): se cair no meio, a varredura termina de apagar
    :ok = Seglog.put_many(@tomb, for(sub <- subs, do: {{cid, sub}, why, now + 31 * @day, nil}))

    if body_table?() do
      for sub <- subs, do: Store.delete(:rt_body, {cid, sub})

      if acks_table?() do
        for sub <- subs,
            k <- :mnesia.dirty_select(:rt_body_ack, [{{:rt_body_ack, {cid, sub, :_}, :_}, [], [{:element, 2, :"$_"}]}]),
            do: Store.delete(:rt_body_ack, k)
      end
    end

    :ok
  end

  defp bump(acc, k, why), do: Map.update!(acc, k, &Map.update(&1, why, 1, fn n -> n + 1 end))
  defp count(tag, why), do: ChatyyRouter.Metrics.inc({:rt_purge, tag, why})

  defp body_acks(cid) do
    if acks_table?() do
      :mnesia.dirty_select(:rt_body_ack, [{{:rt_body_ack, {cid, :"$1", :"$2"}, {:_, :"$3"}}, [{:"=/=", :"$3", nil}], [{{:"$1", :"$2", :"$3"}}]}])
      |> Enum.reduce(%{}, fn {sub, dev, per}, acc -> Map.update(acc, sub, %{dev => per}, &Map.put(&1, dev, per)) end)
    else
      %{}
    end
  end

  defp dlv_rows(_cid, []), do: %{}

  defp dlv_rows(cid, mids) do
    sql = """
    SELECT message_id::text, device_id, expected::text,
           (EXTRACT(EPOCH FROM msg_at)*1000)::bigint::text, (EXTRACT(EPOCH FROM persisted_at)*1000)::bigint::text
      FROM chat_msg_device_dlv
     WHERE message_id = ANY($1::bigint[]) AND conversation_id = $2::bigint AND device_id <> '?'
    """

    mids
    |> Enum.chunk_every(1_000)
    |> Enum.reduce(%{}, fn ch, acc ->
      case Conn.query(:replica, sql, ["{" <> Enum.map_join(ch, ",", &Integer.to_string/1) <> "}", cid], 15_000) do
        {:ok, %{rows: rows}} -> Map.merge(acc, parse_dlv(rows))
        {:error, e} -> raise "dlv: #{inspect(e) |> String.slice(0, 120)}"
      end
    end)
  end

  # R1: revogado / último uso por aparelho (e2ee5_devices; o id do aparelho é aleatório e único)
  defp dev_info([]), do: %{}

  defp dev_info(devs) do
    sql = """
    SELECT device_id, (EXTRACT(EPOCH FROM MAX(revoked_at))*1000)::bigint::text, (EXTRACT(EPOCH FROM MAX(last_seen_at))*1000)::bigint::text
      FROM e2ee5_devices WHERE device_id = ANY($1::text[]) GROUP BY device_id
    """

    devs
    |> Enum.filter(&(is_binary(&1) and &1 =~ ~r/^[A-Za-z0-9_-]{1,64}$/))
    |> Enum.chunk_every(1_000)
    |> Enum.reduce(%{}, fn ch, acc ->
      case Conn.query(:replica, sql, ["{" <> Enum.join(ch, ",") <> "}"], 15_000) do
        {:ok, %{rows: rows}} ->
          Map.merge(acc, Map.new(rows, fn [d, rev, seen] -> {d, %{revoked_ms: int(rev), last_seen_ms: int(seen)}} end))

        {:error, e} ->
          raise "devices: #{inspect(e) |> String.slice(0, 120)}"
      end
    end)
  end

  # ───────────────────────── compactação ─────────────────────────

  defp do_compact(mode) do
    tag = if mode == "1", do: "apply", else: "dryrun"

    for t <- Store.log_tables() ++ [@tomb], into: %{} do
      r =
        try do
          SeglogCompact.compact(t,
            dry_run: mode != "1",
            min_age_ms: int_cfg(:compact_min_age_ms, 20 * 3_600_000),
            max_bytes: int_cfg(:compact_max_mb, 64) * 1_048_576
          )
        rescue
          e -> %{error: inspect(e) |> String.slice(0, 160)}
        end

      for k <- [:moved, :bytes, :segments, :races], is_integer(r[k]), r[k] > 0 do
        ChatyyRouter.Metrics.inc({:seglog_compact, tag, k}, r[k])
      end

      if is_integer(r[:live_bytes]), do: put_state(%{{:live, t} => r.live_bytes, {:dead, t} => r.dead_bytes})
      Logger.info("router f3_compact #{t} modo=#{tag} #{inspect(r)}")
      {t, r}
    end
  end

  # ───────────────────────── métricas ─────────────────────────

  defp put_state(m), do: :persistent_term.put(@pt, Map.merge(:persistent_term.get(@pt, %{}), m))

  @doc "Linhas Prometheus (gauges + contadores com rótulo). Vazio se nunca subiu."
  def prom_lines do
    case :persistent_term.get(@pt, nil) do
      nil ->
        []

      st ->
        snap = ChatyyRouter.Metrics.snapshot()

        [
          for({{:c, {:rt_purge, tag, why}}, v} <- snap, do: "chatyy_router_rt_purge_total{mode=\"#{tag}\",reason=\"#{why}\"} #{v}\n"),
          for({{:c, {:seglog_compact, tag, k}}, v} <- snap, do: "chatyy_router_seglog_compact_#{k}_total{mode=\"#{tag}\"} #{v}\n"),
          for {why, n} <- Map.get(st, :keep, %{}) do
            w = case why do {:inbox, x} -> "inbox_#{x}"; x -> to_string(x) end
            "chatyy_router_rt_purge_keep{reason=\"#{w}\"} #{n}\n"
          end,
          for({{kind, t}, v} <- st, kind in [:live, :dead], do: "chatyy_router_seglog_#{kind}_bytes{table=\"#{t}\"} #{v}\n"),
          for(k <- [:enabled, :convs_dryrun, :convs_apply, :tombstones, :scan_ms, :last_ok_s], do: "chatyy_router_rt_purge_#{k} #{Map.get(st, k, 0)}\n")
        ]
    end
  end
end
