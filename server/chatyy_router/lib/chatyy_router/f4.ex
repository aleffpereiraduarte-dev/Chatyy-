defmodule ChatyyRouter.F4 do
  @moduledoc """
  [sgu F4 2026-10-23] "Nível WhatsApp": conversa com `body_store = 3` não tem NENHUMA linha de mensagem no PG do US
  (nem esqueleto). O roteador regional (casa + 2 irmãs, BodyStore) e os aparelhos passam a ser a fonte da verdade de:
  ordem (`conv_pts` dado pela casa), recibos ✓✓/lida, reações, apagar para todos, edição e os contadores da lista.
  Desenho: /root/sem-gravar-no-us-2026-10-22/f4/DESENHO.md.

  INERTE por padrão: só age com `RT_F4=1` no arquivo de flags E a conversa em `body_store >= 3` (BodyHome, réplica).
  Sem isso nenhum registro novo recebe pts, /store recusa `receipt`/`delete` (`not_f4`) e o resto do roteador não muda.

  O que este módulo guarda (Seglog `:rt_f4_log`, mesmo disco/fsync do corpo, replicado junto com o registro do
  BodyStore — as cópias recalculam a mesma entrada do mesmo registro, então casa e irmãs ficam iguais):
      {cid, pts}  → entrada %{pts, sub, kind, mid, from_uid, ts, type, rtype, upto, deleted}   (aux = a própria entrada)
      {cid, :hw}  → %{pts, ts}   marca d'água do pts da conversa (sobrevive à F3 apagar os corpos)
  `kind`: :msg (mensagem nova) · :edit (edição no lugar / lápide do apagar) · :reaction · :receipt · :delete.
  Nada de conteúdo: o envelope continua só no `:rt_body` (e some com a F3); a entrada é metadado que já é claro hoje
  (CONTRATO e2ee §2.5). Expira com ts + 30 d (a marca d'água com 10× isso).

  conv_pts: inteiro crescente POR CONVERSA, dado só pela casa em exercício (BodyHome.acting/1) na hora do aceite.
  Pode ter buracos (escrita que falhou depois de reservar) e, numa queda da casa NO MEIO de um aceite (antes das
  cópias), a irmã que assume pode repetir um pts: a ordem do app é (pts, mid) — mid Snowflake desempata.

  Contadores por usuário (sem estado extra, calculados das entradas):
      read_pts(u) = max(recibo "r" de u, pts da última mensagem do próprio u)   (mandar = ler, como no WA)
      unread(u)   = nº de :msg com pts > read_pts(u), de outro usuário, não apagadas
      last        = última :msg (pts), com `deleted`
      peers       = por outro usuário: %{d: pts entregue, r: pts lido}  (✓✓ / azul no app)
  """
  require Logger
  alias ChatyyRouter.{BodyHome, Clock, Config, Metrics, Seglog, Store}

  @t :rt_f4_log
  @hw :rt_f4_hw
  @midx :rt_f4_midx
  @subpts :rt_f4_subpts
  @lock :rt_f4_lock
  # revisão da lápide do apagar para todos: maior que qualquer edição (ms) → vence em casa e nas cópias
  @tomb_rev 9_000_000_000_000_000

  def tomb_rev, do: @tomb_rev

  # ------------------------------------------------------------ estado

  def init_tables do
    for t <- [@hw, @midx, @subpts, @lock], :ets.whereis(t) == :undefined do
      :ets.new(t, [:named_table, :public, :set, write_concurrency: true, read_concurrency: true])
    end

    :ok
  end

  @doc "Refaz os índices em RAM a partir do Seglog (boot)."
  def rebuild do
    init_tables()

    if :ets.whereis(Seglog.idx(@t)) != :undefined do
      for {{cid, k}, _seg, _off, _len, _exp, aux} <- :ets.tab2list(Seglog.idx(@t)) do
        case k do
          :hw -> bump_hw(cid, aux[:pts] || 0)
          p when is_integer(p) -> index(cid, aux)
          _ -> :ok
        end
      end
    end

    :ok
  end

  @doc "F4 ligada para ESCREVER nesta conversa (flag RT_F4 + body_store >= 3)."
  def on?(cid), do: ChatyyRouter.Flags.get(:f4) == true and is_integer(cid) and BodyHome.mode(cid) >= 3

  @doc "Conversa F4 (para LER: mesmo com a flag desligada, o que já existe continua servindo)."
  def conv?(cid), do: is_integer(cid) and BodyHome.mode(cid) >= 3

  def hw(cid) do
    case :ets.whereis(@hw) != :undefined and :ets.lookup(@hw, cid) do
      [{_, p}] -> p
      _ -> 0
    end
  end

  defp bump_hw(cid, p) when is_integer(p) do
    if p > hw(cid), do: :ets.insert(@hw, {cid, p})
    :ok
  end

  defp bump_hw(_, _), do: :ok

  @doc "pts mais recente da chave do BodyStore (mid, {:rx,…}, {:rc,…}, {:del,…}) ou nil."
  def sub_pts(cid, sub) do
    case :ets.whereis(@subpts) != :undefined and :ets.lookup(@subpts, {cid, sub}) do
      [{_, p}] -> p
      _ -> nil
    end
  end

  @doc "pts ORIGINAL da mensagem (o da criação, não o da última edição) ou nil."
  def mid_pts(cid, mid) do
    case :ets.whereis(@midx) != :undefined and :ets.lookup(@midx, {cid, mid}) do
      [{_, p}] -> p
      _ -> nil
    end
  end

  defp index(cid, %{pts: p, sub: sub} = e) do
    if e.kind == :msg and is_integer(e.mid), do: :ets.insert(@midx, {{cid, e.mid}, p})
    case sub_pts(cid, sub) do
      old when is_integer(old) and old >= p -> :ok
      _ -> :ets.insert(@subpts, {{cid, sub}, p})
    end

    bump_hw(cid, p)
  end

  defp index(_, _), do: :ok

  # ------------------------------------------------------------ aceite (casa em exercício)

  @doc """
  Prepara o pedido na casa em exercício (antes do lock da chave): recibo resolve `upto` (pts) e gera o envelope
  determinístico; apagar confere o autor da mensagem-alvo. {:ok, req} | {:error, motivo}.
  """
  def prepare(%{kind: :receipt} = req) do
    upto =
      cond do
        is_integer(req[:upto_pts]) and req[:upto_pts] > 0 -> min(req[:upto_pts], hw(req.cid))
        is_integer(req[:upto_mid]) and req[:upto_mid] > 0 -> resolve_mid(req.cid, req[:upto_mid])
        true -> 0
      end

    if upto <= 0 do
      {:error, :receipt_unresolved}
    else
      env = receipt_env(req.from_uid, req.rtype, upto, req[:upto_mid])
      {:ok, %{req | env: env, sha: ChatyyRouter.BodyStore.sha(env), size: byte_size(env)} |> Map.put(:upto, upto)}
    end
  end

  def prepare(%{kind: :delete, ref: ref} = req) do
    body = Store.get(:rt_body, {req.cid, ref})

    case target_entry(req.cid, ref) do
      nil ->
        {:error, :unknown_target}

      %{from_uid: u} when is_binary(u) ->
        if u == req.from_uid, do: {:ok, req}, else: {:error, :forbidden}

      _ ->
        # entrada sem uid (corpo veio do /fanout do leaf): confere o e-mail do autor no corpo, se ainda existir
        canon = &ChatyyRouter.BodyStore.canon/1
        if body != nil and req[:from] != nil and canon.(body[:from]) == canon.(req[:from]), do: {:ok, req}, else: {:error, :forbidden}
    end
  end

  def prepare(req), do: {:ok, req}

  @doc "Envelope do recibo (metadado em claro, determinístico: mesmo upto = mesmo sha = duplicata)."
  def receipt_env(uid, rtype, upto, upto_mid) do
    ~s({"t":"rc","u":"#{uid}","r":"#{rtype}","upto_pts":#{upto},"upto_mid":#{upto_mid || 0}})
  end

  def delete_env(uid, mid), do: ~s({"t":"del","u":"#{uid}","mid":#{mid}})
  def tomb_env(mid), do: ~s({"e2e_del":1,"mid":#{mid}})

  @doc "Maior pts de :msg com mid <= upto_mid (Snowflake ~ ordem de tempo); exato se o mid é conhecido."
  def resolve_mid(cid, upto_mid) do
    case mid_pts(cid, upto_mid) do
      p when is_integer(p) ->
        p

      nil ->
        :ets.select(@midx, [{{{cid, :"$1"}, :"$2"}, [{:"=<", :"$1", upto_mid}], [:"$2"]}])
        |> Enum.max(fn -> 0 end)
    end
  end

  def target_entry(cid, mid) do
    case mid_pts(cid, mid) do
      p when is_integer(p) -> entry(cid, p)
      nil -> nil
    end
  end

  def entry(cid, p) do
    case :ets.whereis(Seglog.idx(@t)) != :undefined and :ets.lookup(Seglog.idx(@t), {cid, p}) do
      [{_, _, _, _, _, aux}] -> aux
      _ -> nil
    end
  end

  @doc "Carimba o pts no registro que vai ser gravado (só na casa em exercício e com a F4 ligada)."
  def stamp(rec) do
    if on?(rec.cid) do
      p = next_pts(rec.cid)
      Metrics.inc(:rt_f4_pts)
      Map.put(rec, :pts, p)
    else
      rec
    end
  end

  defp next_pts(cid) do
    lock(cid)

    try do
      p = hw(cid) + 1
      :ets.insert(@hw, {cid, p})
      p
    after
      :ets.delete(@lock, cid)
    end
  end

  defp lock(cid, n \\ 400) do
    cond do
      :ets.insert_new(@lock, {cid, self()}) -> :ok
      n == 0 -> :ok
      true -> Process.sleep(1) && lock(cid, n - 1)
    end
  end

  @doc "Entrada do log de um registro do BodyStore com pts (nil sem pts)."
  def entry_of(%{pts: p} = rec) when is_integer(p) do
    kind =
      cond do
        rec.kind == :msg and Map.get(rec, :edit) == true -> :edit
        true -> rec.kind
      end

    %{
      pts: p,
      sub: rec.mid,
      kind: kind,
      mid: (case rec.kind do :msg -> rec.mid; _ -> rec[:ref] end),
      from_uid: rec[:from_uid],
      ts: rec.ts,
      type: rec[:type],
      rtype: rec[:rtype],
      upto: rec[:upto],
      deleted: Map.get(rec, :tomb) == true
    }
  end

  def entry_of(_), do: nil

  @doc """
  Grava as entradas dos registros (casa depois do aceite; irmãs/reparo nas cópias). Apagar para todos marca a
  entrada da mensagem-alvo como `deleted` (contadores e prévia). Idempotente. :ok | {:error, motivo}.
  """
  def log_recs(recs) do
    es = for r <- recs, BodyHome.mode(r.cid) >= 3, e = entry_of(r), e != nil, do: {r.cid, e}

    if es == [] do
      :ok
    else
      marks =
        for {cid, %{kind: :delete, mid: m}} <- es, is_integer(m),
            p = mid_pts(cid, m), p != nil, old = entry(cid, p), old != nil, old.deleted != true,
            do: {{cid, p}, %{old | deleted: true}}

      # a lápide (edição com deleted) também marca a própria mensagem
      tombs =
        for {cid, %{kind: :edit, deleted: true, mid: m}} <- es, p = mid_pts(cid, m), p != nil,
            old = entry(cid, p), old != nil, old.deleted != true, do: {{cid, p}, %{old | deleted: true}}

      hws =
        es
        |> Enum.group_by(&elem(&1, 0), fn {_, e} -> e.pts end)
        |> Enum.map(fn {cid, ps} -> {{cid, :hw}, %{pts: max(Enum.max(ps), hw(cid)), ts: Clock.now_ms()}} end)

      rows = (for({cid, e} <- es, do: {{cid, e.pts}, e}) ++ marks ++ tombs ++ hws) |> Enum.uniq_by(&elem(&1, 0))

      case Store.put_many(@t, rows) do
        :ok ->
          for {cid, e} <- es, do: index(cid, e)
          for {{cid, :hw}, v} <- hws, do: bump_hw(cid, v.pts)
          :ok

        err ->
          Metrics.inc(:rt_f4_log_fail)
          err
      end
    end
  end

  @doc "Todas as entradas da conversa (ordem de pts), sem ler disco."
  def entries(cid) do
    if :ets.whereis(Seglog.idx(@t)) == :undefined do
      []
    else
      :ets.select(Seglog.idx(@t), [{{{cid, :"$1"}, :_, :_, :_, :_, :"$2"}, [{:is_integer, :"$1"}], [:"$2"]}])
      |> Enum.sort_by(& &1.pts)
    end
  end

  # ------------------------------------------------------------ contadores (lista)

  @doc "Resumo da conversa para o usuário (calculado AQUI: chamar na casa em exercício)."
  def summary(cid, uid) do
    uid = to_string(uid)
    es = entries(cid)

    {own, rcpt_r, last, peers} =
      Enum.reduce(es, {0, 0, nil, %{}}, fn e, {own, rr, last, peers} ->
        case e.kind do
          :msg ->
            own = if e.from_uid == uid, do: max(own, e.pts), else: own
            {own, rr, e, peers}

          :receipt when e.from_uid == uid ->
            {own, if(e.rtype == "r", do: max(rr, e.upto || 0), else: rr), last, peers}

          :receipt ->
            p = Map.get(peers, e.from_uid, %{d: 0, r: 0})
            u = e.upto || 0
            p = if e.rtype == "r", do: %{p | r: max(p.r, u), d: max(p.d, u)}, else: %{p | d: max(p.d, u)}
            {own, rr, last, Map.put(peers, e.from_uid, p)}

          _ ->
            {own, rr, last, peers}
        end
      end)

    read_pts = max(own, rcpt_r)
    unread = Enum.count(es, &(&1.kind == :msg and &1.pts > read_pts and &1.from_uid != uid and &1.deleted != true))

    %{
      cid: cid,
      pts: hw(cid),
      unread: unread,
      read_pts: read_pts,
      last: last && Map.take(last, [:mid, :pts, :ts, :from_uid, :type, :deleted]),
      peers: peers,
      n: length(es)
    }
  end

  @doc "Resumos de várias conversas (na casa em exercício de cada uma; as outras casas pela dist)."
  def summaries(uid, cids) do
    cids = Enum.filter(cids, &conv?/1)

    cids
    |> Enum.group_by(&BodyHome.acting/1)
    |> Task.async_stream(
      fn {r, cs} ->
        if r == ChatyyRouter.Net.me(),
          do: summaries_local(uid, cs),
          else: ChatyyRouter.Net.call(r, ChatyyRouter.BodyStore, {:f4_sum, uid, cs}, ChatyyRouter.Net.tmo(r, 5_000))
      end,
      timeout: 32_000, on_timeout: :kill_task, max_concurrency: 16, ordered: false)
    |> Enum.flat_map(fn
      {:ok, l} when is_list(l) -> l
      _ -> []
    end)
    |> Enum.sort_by(& &1.cid)
  end

  def summaries_local(uid, cids), do: for(c <- cids, do: summary(c, uid))

  @doc """
  Em qual das conversas F4 `cids` a mensagem `mid` está (o PG não tem a linha para dizer): pergunta à casa em
  exercício de cada uma. → %{cid, pts, from_uid, deleted} | nil
  """
  def locate(cids, mid) do
    cids
    |> Enum.filter(&conv?/1)
    |> Enum.group_by(&BodyHome.acting/1)
    |> Enum.flat_map(fn {r, cs} ->
      if r == ChatyyRouter.Net.me(),
        do: locate_local(cs, mid),
        else: (case ChatyyRouter.Net.call(r, ChatyyRouter.BodyStore, {:f4_locate, cs, mid}, ChatyyRouter.Net.tmo(r, 5_000)) do l when is_list(l) -> l; _ -> [] end)
    end)
    |> List.first()
  end

  def locate_local(cids, mid) do
    for c <- cids, e = target_entry(c, mid), e != nil, do: %{cid: c, pts: e.pts, from_uid: e.from_uid, deleted: e.deleted, type: e.type}
  end

  def status do
    cids = Enum.filter(BodyHome.enabled_cids(), &conv?/1)

    %{
      f4_on: ChatyyRouter.Flags.get(:f4) == true,
      f4_cids: cids,
      acting: Enum.filter(cids, &BodyHome.acting?/1),
      log_entries: if(:ets.whereis(Seglog.idx(@t)) == :undefined, do: 0, else: Store.size(@t)),
      hw: Map.new(cids, &{&1, hw(&1)}),
      retention_ms: Config.retention_ms()
    }
  end

  def prom_lines do
    cids = Enum.filter(BodyHome.enabled_cids(), &conv?/1)

    [
      "chatyy_router_rt_f4_enabled #{if ChatyyRouter.Flags.get(:f4) == true, do: 1, else: 0}\n",
      "chatyy_router_rt_f4_cids #{length(cids)}\n",
      "chatyy_router_rt_f4_log_entries #{if :ets.whereis(Seglog.idx(@t)) == :undefined, do: 0, else: Store.size(@t)}\n"
    ]
  end

  @doc false
  def log_warning(what), do: Logger.warning("router f4: " <> what)
end
