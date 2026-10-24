defmodule ChatyyRouter.BodyCompare do
  @moduledoc """
  [sgu F1 2026-10-23] Comparador SÓ LEITURA roteador × PG das conversas marcadas (`body_store >= 1`).
  Plano /root/sem-gravar-no-us-2026-10-22/PLANO.md §4.1 ("Comparador") e §4.2 (critérios F1 → F2).

  Roda na casa em exercício de cada conversa (`BodyHome.acting?/1`), a cada ROUTER_F1_CMP_MS (60 s):
    * PG (réplica LOCAL), pelas funções SECURITY DEFINER do kit (`sgu_f1_msgs/sgu_f1_rx`, só conversas
      marcadas; o papel do roteador não lê chat_messages): mensagens com id >= marco (o maior entre
      `body_store_at` e agora − ROUTER_F1_CMP_WINDOW_S, padrão 7 d; o id Snowflake leva o ms) → só
      `sha256(content)` sai do banco, nunca o conteúdo; reações (S4) idem com `coalesce(enc, emoji)`;
      `chat_msg_device_dlv` (expected) → aparelhos esperados por mensagem;
    * roteador: índice do `:rt_body` daqui (sem ler corpo) + `{:keys, cid}` de cada nó vivo (cópias).
  Linhas mais novas que ROUTER_F1_CMP_GRACE_MS (120 s) ficam para a próxima volta (em voo).

  Métricas (/metrics):
    chatyy_router_rt_f1_body_mismatch{kind=…}            gauge, estado da última varredura (soma das conversas)
    chatyy_router_rt_f1_body_mismatch_events_total{kind=…} contador: cada (conversa, chave, kind) conta 1 vez
    chatyy_router_rt_f1_cmp_{enabled,cids,pg_rows,compared,scan_ms,last_ok_s,criterio_ok}
  kinds do CRITÉRIO (têm que ser 0 para a F2):
    faltando_casa        o PG tem a mensagem e a casa não
    hash_diferente       a casa tem, com sha256 diferente do PG
    faltando_irma        menos de ROUTER_BODY_COPIES (2) cópias com o mesmo sha fora da casa
    hash_diferente_irma  alguma cópia fora da casa com sha diferente
    inbox_faltando       a dlv espera o aparelho e a lista congelada do roteador não tem
    reacao_faltando / reacao_hash_diferente   o mesmo para as reações E2EE (S4)
  kinds INFORMATIVOS (não bloqueiam; explicam):
    inbox_sobrando       o roteador espera um aparelho que a dlv não espera (ex.: o aparelho que enviou,
                         quando o /fanout não diz qual foi)
    so_no_roteador       a casa tem e o PG não (envio que falhou no PG, ou o GC de 30 d do PG — U1)
    apagada_no_pg        a linha do PG está apagada (deleted_at) e o conteúdo mudou ou sumiu
    aparelhos_desconhecidos  guardada sem a lista de aparelhos (diretório fora na hora; o reparo completa)
  Com RT_STORE_REPAIR=pg o que falta na casa é COPIADO da réplica (src pg_repair; contado em
  rt_store_src_total{src="pg_repair"}) — por padrão desligado, para a falta aparecer.
  Kill: RT_F1_CMP=0 (≤ 2 s; as métricas vão a 0 com enabled 0).
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{BodyHome, BodyStore, Clock, Config, Metrics, Net}
  alias ChatyyRouter.PG.Conn

  # sha do PG para linha-esqueleto da F2 (ddl 006 de /root/sem-gravar-no-us-2026-10-22/todos)
  @skel "rt"
  @criterio [:faltando_casa, :hash_diferente, :faltando_irma, :hash_diferente_irma, :inbox_faltando, :reacao_faltando, :reacao_hash_diferente]
  @info [:inbox_sobrando, :so_no_roteador, :apagada_no_pg, :aparelhos_desconhecidos]
  @pt {__MODULE__, :state}
  @sf_epoch 1_767_225_600_000

  def kinds, do: @criterio ++ @info
  def criterio_kinds, do: @criterio

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  @doc "ms → menor id Snowflake daquele instante (id = (ms − 2026-01-01) << 12 | região << 8 | contador)."
  def mid_floor(ms), do: max(ms - @sf_epoch, 0) * 4096
  def mid_ms(mid) when is_integer(mid), do: div(mid, 4096) + @sf_epoch

  # ───────────────────────── lógica pura (testada) ─────────────────────────

  @doc """
  pg:    [%{mid, sha, type, deleted}]                  (mensagens do PG na janela)
  pg_rx: [%{ref, email, sha, type}]                    (reações E2EE do PG; type "r" reação | "v" estado)
  local: %{sub => {ts, sha, devices | nil, kind}}      (índice da casa)
  peers: %{região => %{sub => sha}}                    (cópias nos outros nós vivos)
  dlv:   %{mid => MapSet de aparelhos esperados}
  opts:  now_ms, grace_ms, wanted (cópias fora da casa), since_mid
  → %{gauges: %{kind => n}, samples: %{kind => [sub]}, compared, pg_rows, missing_by_type}
  """
  def compare(pg, pg_rx, local, peers, dlv, opts) do
    now = Keyword.fetch!(opts, :now_ms)
    grace = Keyword.get(opts, :grace_ms, 120_000)
    wanted = Keyword.get(opts, :wanted, 2)
    since = Keyword.get(opts, :since_mid, 0)
    aged? = fn mid -> now - mid_ms(mid) > grace end

    add = fn acc, kind, sub -> Map.update(acc, kind, [sub], &[sub | &1]) end

    {hits, compared, by_type} =
      Enum.reduce(pg, {%{}, 0, %{}}, fn r, {acc, n, bt} ->
        sub = r.mid

        cond do
          not aged?.(sub) ->
            {acc, n, bt}

          true ->
            l = Map.get(local, sub)
            sha_l = l && elem(l, 1)
            # [sgu TODOS 2026-10-24] esqueleto da F2 (body_loc='rt': o PG não tem o envelope, sgu_f1_msgs devolve sha "rt"):
            # compara só a EXISTÊNCIA na casa e nas cópias, e a cópia tem que bater com o sha da casa. Antes isto contava
            # hash_diferente para toda mensagem F2 (959: 2 em 24/10) e o critério da F1 nunca zerava com a F2 ligada.
            skel = r.sha == @skel
            ref = if skel, do: sha_l, else: r.sha

            acc =
              cond do
                skel and r.deleted -> acc
                r.deleted and sha_l != r.sha -> add.(acc, :apagada_no_pg, sub)
                l == nil -> add.(acc, :faltando_casa, sub)
                not skel and sha_l != r.sha -> add.(acc, :hash_diferente, sub)
                true -> acc
              end

            bt = if l == nil and not r.deleted, do: Map.update(bt, r.type || "", 1, &(&1 + 1)), else: bt

            # cópias fora da casa (só faz sentido se o PG e a casa concordam)
            acc =
              if l != nil and sha_l == ref do
                same = Enum.count(peers, fn {_r, m} -> Map.get(m, sub) == ref end)
                diff = Enum.any?(peers, fn {_r, m} -> Map.has_key?(m, sub) and Map.get(m, sub) != ref end)
                acc = if same < wanted, do: add.(acc, :faltando_irma, sub), else: acc
                if diff, do: add.(acc, :hash_diferente_irma, sub), else: acc
              else
                acc
              end

            # aparelhos: dlv × lista congelada
            acc =
              case l do
                {_, _, nil, _} ->
                  add.(acc, :aparelhos_desconhecidos, sub)

                {_, _, devs, _} ->
                  exp = Map.get(dlv, sub, MapSet.new())
                  mine = MapSet.new(devs)
                  acc = if MapSet.size(MapSet.difference(exp, mine)) > 0, do: add.(acc, :inbox_faltando, sub), else: acc
                  if MapSet.size(MapSet.difference(mine, exp)) > 0 and MapSet.size(exp) > 0, do: add.(acc, :inbox_sobrando, sub), else: acc

                nil ->
                  acc
              end

            {acc, n + 1, bt}
        end
      end)

    pg_mids = MapSet.new(pg, & &1.mid)

    hits =
      Enum.reduce(local, hits, fn
        {sub, {ts, _sha, _d, :msg}}, acc when is_integer(sub) ->
          if sub >= since and now - ts > grace and not MapSet.member?(pg_mids, sub), do: add.(acc, :so_no_roteador, sub), else: acc

        _, acc ->
          acc
      end)

    hits =
      Enum.reduce(pg_rx, hits, fn r, acc ->
        sub = {:rx, r.ref, r.email, Map.get(r, :type, "r")}

        case Map.get(local, sub) do
          nil -> if aged?.(r.ref), do: add.(acc, :reacao_faltando, sub), else: acc
          {_, sha, _, _} when sha != r.sha -> add.(acc, :reacao_hash_diferente, sub)
          _ -> acc
        end
      end)

    %{
      gauges: Map.new(kinds(), fn k -> {k, length(Map.get(hits, k, []))} end),
      samples: Map.new(hits, fn {k, l} -> {k, l |> Enum.reverse() |> Enum.take(10)} end),
      hits: hits,
      compared: compared,
      pg_rows: length(pg),
      missing_by_type: by_type
    }
  end

  @doc "Linhas texto do PG → mapas."
  def parse_pg(rows), do: for([m, sha, t, d] <- rows, do: %{mid: String.to_integer(m), sha: sha, type: t, deleted: d in ["t", "true"]})
  def parse_rx(rows), do: for([m, e, sha, t] <- rows, do: %{ref: String.to_integer(m), email: BodyStore.canon(e), sha: sha, type: t})

  def parse_dlv(rows) do
    Enum.reduce(rows, %{}, fn [m, d], acc -> Map.update(acc, String.to_integer(m), MapSet.new([d]), &MapSet.put(&1, d)) end)
  end

  # ───────────────────────── processo ─────────────────────────

  @impl true
  def init(_) do
    if Config.pg_enabled?() and to_string(Config.get(:f1_cmp, "1")) != "0" do
      put_state(%{enabled: 1, cids: %{}})
      Process.send_after(self(), :scan, 20_000)
      {:ok, %{seen: MapSet.new()}}
    else
      :ignore
    end
  end

  @impl true
  def handle_info(:scan, s) do
    s =
      if ChatyyRouter.Flags.get(:f1_cmp) == false do
        put_state(%{enabled: 0, cids: %{}})
        s
      else
        try do
          scan(s)
        rescue
          e ->
            Metrics.inc(:rt_f1_cmp_errors)
            Logger.warning("router f1_cmp: #{inspect(e) |> String.slice(0, 200)}")
            s
        end
      end

    Process.send_after(self(), :scan, int_cfg(:f1_cmp_ms, 60_000))
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  @impl true
  def handle_call(:scan_now, _f, s) do
    s = scan(s)
    {:reply, report(), s}
  end

  def scan_now, do: GenServer.call(__MODULE__, :scan_now, 120_000)

  defp scan(s) do
    t0 = System.monotonic_time(:millisecond)
    now = Clock.now_ms()
    win = int_cfg(:f1_cmp_window_s, 7 * 86_400) * 1000
    max = int_cfg(:f1_cmp_max, 20_000)
    cids = Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1)

    {per, seen} =
      Enum.reduce(cids, {%{}, MapSet.new()}, fn cid, {acc, seen} ->
        since_ms = max(((BodyHome.conv(cid) || %{})[:since_ms]) || 0, now - win)
        lo = mid_floor(since_ms)

        with {:ok, %{rows: prow}} <- q(pg_sql(max), [cid, lo]),
             {:ok, %{rows: rxrow}} <- q(rx_sql(max), [cid, lo]),
             {:ok, %{rows: drow}} <- q(dlv_sql(max), [cid, since_ms]) do
          local = Map.new(BodyStore.aux(cid), fn {sub, a} -> {sub, a} end)

          peers =
            (Net.alive_regions() -- [Net.me()])
            |> Task.async_stream(fn r -> {r, Net.call(r, BodyStore, {:keys, cid}, Net.tmo(r, 5_000))} end,
              timeout: 32_000, on_timeout: :kill_task, max_concurrency: 16)
            |> Enum.flat_map(fn
              {:ok, {r, l}} when is_list(l) -> [{r, Map.new(l)}]
              _ -> []
            end)
            |> Map.new()

          wanted = min(Config.body_copies(), length(BodyHome.copy_targets(BodyHome.home(cid), Net.me(), 99)))

          r = compare(parse_pg(prow), parse_rx(rxrow), local, peers, parse_dlv(drow),
                now_ms: now, grace_ms: int_cfg(:f1_cmp_grace_ms, 120_000), wanted: wanted, since_mid: lo)

          # eventos: cada (conversa, kind, chave) conta uma vez
          keys = for {k, subs} <- r.hits, sub <- subs, into: MapSet.new(), do: {cid, k, sub}

          for {_c, k, _} <- MapSet.difference(keys, s.seen) |> MapSet.to_list() do
            Metrics.inc({:rt_f1_body_mismatch_events, k})
          end

          if ChatyyRouter.Flags.get(:store_repair) == true, do: repair_from_pg(cid, Map.get(r.hits, :faltando_casa, []))

          row = %{home: BodyHome.home(cid), acting: Net.me(), pg_rows: r.pg_rows, compared: r.compared,
                  router_rows: map_size(local), copies_seen: Map.new(peers, fn {p, m} -> {p, map_size(m)} end),
                  kinds: r.gauges, samples: r.samples, missing_by_type: r.missing_by_type, since_ms: since_ms}

          {Map.put(acc, cid, row), MapSet.union(seen, keys)}
        else
          {:error, e} ->
            Metrics.inc(:rt_f1_cmp_errors)
            Logger.warning("router f1_cmp pg cid=#{cid}: #{inspect(e) |> String.slice(0, 200)}")
            {Map.put(acc, cid, %{error: inspect(e) |> String.slice(0, 200)}), seen}
        end
      end)

    put_state(%{enabled: 1, cids: per, scan_ms: System.monotonic_time(:millisecond) - t0, last_ok_s: div(now, 1000)})
    %{s | seen: seen}
  end

  defp q(sql, params), do: Conn.query(:replica, sql, params, 15_000)

  # funções SECURITY DEFINER do kit F1 (ddl/003-f1.sql): só conversas marcadas; do content só sai o sha256
  defp pg_sql(max), do: "SELECT id::text, sha, type, deleted::text FROM sgu_f1_msgs($1::bigint, $2::bigint, #{max})"
  defp rx_sql(max), do: "SELECT message_id::text, email, sha, rx_type FROM sgu_f1_rx($1::bigint, $2::bigint, #{max})"

  defp dlv_sql(max) do
    """
    SELECT message_id::text, device_id FROM chat_msg_device_dlv
     WHERE conversation_id = $1::bigint AND msg_at >= to_timestamp($2::bigint / 1000.0) AND expected AND device_id <> '?'
     LIMIT #{max * 4}
    """
  end

  # RT_STORE_REPAIR=pg: o que falta na casa vem da réplica (src pg_repair). Passa pelo /store normal (cópias).
  defp repair_from_pg(_cid, []), do: :ok

  defp repair_from_pg(cid, mids) do
    ids = mids |> Enum.filter(&is_integer/1) |> Enum.take(500)
    sql = "SELECT id::text, content, sender_email, type FROM sgu_f1_bodies($1::bigint, $2::bigint[])"

    case q(sql, [cid, "{" <> Enum.map_join(ids, ",", &Integer.to_string/1) <> "}"]) do
      {:ok, %{rows: rows}} ->
        for [m, content, from, type] <- rows, content != nil and content != "" do
          mid = String.to_integer(m)
          BodyStore.store(%{cid: cid, mid: mid, env: content, from: from, type: type, ts: mid_ms(mid), src: :pg_repair})
        end

      _ ->
        :ok
    end
  end

  # ───────────────────────── saída ─────────────────────────

  defp put_state(m), do: :persistent_term.put(@pt, Map.merge(:persistent_term.get(@pt, %{}), m))

  def report do
    st = :persistent_term.get(@pt, %{enabled: 0, cids: %{}})
    cids = Map.get(st, :cids, %{})
    tot = totals(cids)

    %{
      region: Net.me(),
      enabled: st.enabled,
      scan_ms: st[:scan_ms],
      last_ok_s: st[:last_ok_s],
      totals: tot,
      criterio_ok: Enum.all?(@criterio, &(Map.get(tot, &1, 0) == 0)) and not Enum.any?(Map.values(cids), &Map.has_key?(&1, :error)),
      cids: Map.new(cids, fn {c, r} -> {Integer.to_string(c), Map.update(r, :samples, %{}, &samples_json/1)} end)
    }
  end

  defp samples_json(m), do: Map.new(m, fn {k, l} -> {k, Enum.map(l, &sub_json/1)} end)
  defp sub_json({:rx, m, e, t}), do: "rx:#{m}:#{e}:#{t}"
  defp sub_json(m), do: m

  defp totals(cids) do
    Enum.reduce(Map.values(cids), Map.new(kinds(), &{&1, 0}), fn
      %{kinds: k}, acc -> Map.merge(acc, k, fn _, a, b -> a + b end)
      _, acc -> acc
    end)
  end

  @doc "Linhas Prometheus (Metrics.gauges); vazio se o comparador nunca subiu."
  def prom_lines do
    case :persistent_term.get(@pt, nil) do
      nil ->
        []

      st ->
        cids = Map.get(st, :cids, %{})
        tot = totals(cids)
        on = st.enabled == 1
        sum = fn k -> Enum.reduce(Map.values(cids), 0, fn r, a -> a + Map.get(r, k, 0) end) end
        rep = report()

        [
          for(k <- kinds(), do: "chatyy_router_rt_f1_body_mismatch{kind=\"#{k}\"} #{if on, do: Map.get(tot, k, 0), else: 0}\n"),
          "chatyy_router_rt_f1_cmp_enabled #{st.enabled}\n",
          "chatyy_router_rt_f1_cmp_cids #{map_size(cids)}\n",
          "chatyy_router_rt_f1_cmp_pg_rows #{sum.(:pg_rows)}\n",
          "chatyy_router_rt_f1_cmp_compared #{sum.(:compared)}\n",
          "chatyy_router_rt_f1_cmp_scan_ms #{st[:scan_ms] || 0}\n",
          "chatyy_router_rt_f1_cmp_last_ok_s #{st[:last_ok_s] || 0}\n",
          "chatyy_router_rt_f1_cmp_criterio_ok #{if on and rep.criterio_ok, do: 1, else: 0}\n"
        ]
    end
  end
end
