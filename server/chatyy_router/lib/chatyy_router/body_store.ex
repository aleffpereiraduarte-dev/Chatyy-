defmodule ChatyyRouter.BodyHome do
  @moduledoc """
  [sgu F1 2026-10-23] Quais conversas guardam o corpo no roteador e onde é a casa delas.
  Plano: /root/sem-gravar-no-us-2026-10-22/PLANO.md §2 (flag por conversa) e §11 A2.

  Fonte (cada nó lê a SUA réplica local, que recebe o mesmo valor do master pelo WAL):
      SELECT id, home_region, body_store, body_store_at, e2ee_mode FROM chat_conversations WHERE body_store >= 1
  relida a cada ROUTER_BODY_CONV_MS (10 s). Sem a coluna `body_store` (DDL do kit F1 ainda não
  aplicado) a lista é vazia = nada é guardado. Falha do PG mantém a última lista boa.

  Casa (A2: `home_region` do leaf casa-auto MANDA; o `conv_home`/HomeTable do roteador não decide aqui):
    * `home_region` normalizado: minúsculas; sufixo de instância QA tirado ("usw-qa" → "usw");
      vale se for uma região do anel e não for uma região que nunca é irmã/casa (ROUTER_NEVER_SISTER, "us");
    * senão (vazio, "us" = casa externa, região desconhecida): HRW determinístico por cid sobre as
      regiões que podem ser casa — todos os nós chegam à MESMA casa sem conversar.
  Casa em exercício (`acting/1`): a casa se viva; senão a 1ª viva da cadeia de irmãs dela
  (ROUTER_BODY_SISTERS, depois o anel). É quem aceita /store, responde /pull e roda o comparador.

  Ensaios/testes: `put_conv/2` (difundido a todos os nós vivos) tem precedência sobre o PG.
  """
  alias ChatyyRouter.{Config, Net}

  @ets :rt_body_conv
  @manual :rt_body_conv_manual

  def init_tables do
    for t <- [@ets, @manual], :ets.whereis(t) == :undefined do
      :ets.new(t, [:named_table, :public, :set, read_concurrency: true])
    end

    :ok
  end

  @doc "%{home_raw, mode, since_ms, e2ee} | nil"
  def conv(cid) do
    case safe(@manual, cid) do
      [{_, c}] -> c
      [] -> case safe(@ets, cid) do
        [{_, c}] -> c
        [] -> nil
      end
    end
  end

  defp safe(t, k), do: if(:ets.whereis(t) == :undefined, do: [], else: :ets.lookup(t, k))

  def mode(cid), do: (conv(cid) || %{mode: 0}).mode

  @doc ":ok | {:error, :not_enabled | :not_e2ee}"
  def check(cid) do
    case conv(cid) do
      %{mode: m, e2ee: true} when m >= 1 -> :ok
      %{mode: m} when m >= 1 -> {:error, :not_e2ee}
      _ -> {:error, :not_enabled}
    end
  end

  def enabled_cids do
    ids = fn t -> if :ets.whereis(t) == :undefined, do: [], else: for({cid, %{mode: m}} <- :ets.tab2list(t), m >= 1, do: cid) end
    manual = if :ets.whereis(@manual) == :undefined, do: [], else: :ets.tab2list(@manual)
    off = for {cid, %{mode: m}} <- manual, m < 1, do: cid
    (ids.(@ets) ++ ids.(@manual)) |> Enum.uniq() |> Kernel.--(off) |> Enum.sort()
  end

  @doc "Troca a lista vinda do PG inteira (o que saiu da lista sai daqui)."
  def replace_pg(rows) do
    init_tables()
    new = Map.new(rows)
    for {cid, _} <- :ets.tab2list(@ets), not Map.has_key?(new, cid), do: :ets.delete(@ets, cid)
    :ets.insert(@ets, Map.to_list(new))
    :ok
  end

  @doc "Ensaio: marca a conversa em todos os nós vivos (mode 0 = desmarca)."
  def put_conv(cid, c) do
    c = Map.merge(%{home_raw: nil, mode: 1, since_ms: 0, e2ee: true}, c)
    for r <- Net.alive_regions() do
      Net.call(r, ChatyyRouter.BodyStore, {:put_conv, cid, c})
    end

    :ok
  end

  def put_local(cid, c) do
    init_tables()
    :ets.insert(@manual, {cid, c})
    :ok
  end

  # ---------------- casa ----------------

  def home(cid) do
    case normalize((conv(cid) || %{})[:home_raw]) do
      nil -> fallback_home(cid)
      r -> r
    end
  end

  def homeable, do: Config.region_names() -- (Config.never_sister() ++ ["us"])

  def normalize(nil), do: nil

  def normalize(raw) do
    r = raw |> to_string() |> String.trim() |> String.downcase()
    base = r |> String.split("-", parts: 2) |> hd()

    cond do
      r in homeable() -> r
      base in homeable() -> base
      true -> nil
    end
  end

  def fallback_home(cid) do
    case homeable() do
      [] -> Net.me()
      l -> Enum.max_by(l, &:erlang.phash2({:body_home, cid, &1}))
    end
  end

  @doc "Cadeia de cópia da casa: irmãs preferidas (A4) e depois o anel; nunca a própria nem ROUTER_NEVER_SISTER."
  def chain(home) do
    names = Config.region_names()
    {before, rest} = Enum.split_while(names, &(&1 != home))
    ring = Enum.drop(rest, 1) ++ before

    (Map.get(Config.body_sisters(), home, []) ++ ring)
    |> Enum.uniq()
    |> Enum.filter(&(&1 in names))
    |> Enum.reject(&(&1 == home or &1 in Config.never_sister()))
  end

  @doc "Até `n` regiões VIVAS para as cópias, quando quem grava é `me` (a casa ou a irmã em exercício)."
  def copy_targets(home, me, n \\ Config.body_copies()) do
    ([home] ++ chain(home))
    |> Enum.reject(&(&1 == me))
    |> Enum.filter(&Net.alive?/1)
    |> Enum.take(n)
  end

  def acting(cid) do
    h = home(cid)
    if Net.alive?(h), do: h, else: Enum.find(chain(h), h, &Net.alive?/1)
  end

  def acting?(cid), do: acting(cid) == Net.me()
end

defmodule ChatyyRouter.BodyStore.Purge do
  @moduledoc """
  [sgu F1] Ponto de extensão da F3 (apagar). A F1 NUNCA apaga corpo: quando todos os aparelhos
  esperados de uma chave já confirmaram `persisted`, o BodyStore chama `all_persisted/2` do módulo
  em ROUTER_BODY_PURGE_MODULE (padrão `ChatyyRouter.BodyStore.NoPurge`, que só conta
  `rt_f1_would_purge_total`). A F3 implementa este behaviour (dry-run → `Store.delete(:rt_body, k)`
  na casa + `{:drop, ...}` nas cópias) e a compactação física fica no Seglog.
  """
  @callback all_persisted(key :: {term, term}, rec :: map) :: :ok
  @doc "Opcional: chave já apagada pela F3 (lápide) — o BodyStore não regrava (cópia, reparo, reenvio)."
  @callback purged?(cid :: term, sub :: term) :: boolean
  @optional_callbacks purged?: 2

  def purged?(cid, sub) do
    m = impl()
    Code.ensure_loaded?(m) and function_exported?(m, :purged?, 2) and m.purged?(cid, sub) == true
  end

  def impl do
    case ChatyyRouter.Config.get(:body_purge_module) do
      nil -> ChatyyRouter.BodyStore.NoPurge
      m when is_atom(m) -> m
      s -> String.to_existing_atom("Elixir." <> String.trim_leading(to_string(s), "Elixir."))
    end
  end
end

defmodule ChatyyRouter.BodyStore.NoPurge do
  @moduledoc false
  @behaviour ChatyyRouter.BodyStore.Purge
  @impl true
  def all_persisted(_key, _rec), do: ChatyyRouter.Metrics.inc(:rt_f1_would_purge) && :ok
end

defmodule ChatyyRouter.BodyStore do
  @moduledoc """
  [sgu F1 2026-10-23] Armazenamento DURÁVEL do corpo (envelope cifrado E2EE v5) por conversa marcada,
  na casa + 2 irmãs com fsync (Seglog), enquanto o PG continua recebendo tudo (dupla escrita).
  Plano: /root/sem-gravar-no-us-2026-10-22/PLANO.md §4 · decisões A1, A2, A4, A5, S4 (§11).

  A1: o leaf continua dono do aceite/id/entrega ao vivo. Aqui NÃO há seq: a chave é `{cid, mid}` com o
  mid Snowflake do leaf (ou o id do PG, que é o mesmo formato). Reação (S4) entra na mesma fila com chave
  `{cid, {:rx, mid_alvo, email_canon, tipo}}` (tipo "r" reação / "v" estado, campo `rx_type` ou `meta.rx_kind`):
  a mais nova (ts) substitui a anterior e reabre as confirmações.
  Edição E2EE no lugar (chat_edit: mesmo mid, conteúdo novo) só com marca explícita `kind:"edit"` (+ `rev` ou
  `edited_at` em ms; padrão ts): a revisão maior substitui, mantém os aparelhos congelados e reabre as
  confirmações; revisão igual/menor = `stale`. Sem a marca, mesmo mid + sha diferente continua conflito.

  Entradas (todas idempotentes por chave; mesma chave + mesmo sha = duplicata; sha diferente = conflito,
  fica a 1ª e conta `rt_store_total{result="conflict"}`):
    * `POST 127.0.0.1:4790/store` — contrato p/ leaf/hub/PHP (`sguStore()`), responde depois do fsync
      local + das cópias: `{"ok":true,"copies":3,"wanted":3}`;
    * `/fanout` do R1 (o leaf da casa já chama hoje p/ LEAF_RT_FANOUT_CIDS, com o content do PG em
      body_b64): cópia ASSÍNCRONA, não atrasa o fan-out (src = fanout);
    * reparo pelo PG (comparador, só com RT_STORE_REPAIR=pg; src = pg_repair).

  Registro (`:rt_body`): cid, mid, kind (msg|reaction), ref, from, from_device, ts, type, size, sha
  (sha256 hex do envelope — o mesmo que o PG calcula sobre `content`), env, devices (aparelhos
  esperados CONGELADOS na hora: destinatários + outros aparelhos do remetente, Directory), home, src,
  stored_ms, meta. Expira com ts + 30 d (Seglog). Cópias nas irmãs = o MESMO registro, na mesma tabela
  (quem é casa é decidido na leitura por `BodyHome.acting/1`): troca de casa (A2) não exige migração; a
  casa nova completa o que falta pelo reparo (anti-entropia a cada ROUTER_BODY_REPAIR_MS, 60 s, e na
  hora em que vira casa).

  Confirmações (`:rt_body_ack`, Mnesia local, refeito da fila sombra dlv a cada ROUTER_BODY_ACK_POLL_MS):
  ack de entrega e `persisted` por aparelho. Pendente p/ um aparelho = esperado e ainda sem `persisted`.
  A5: herança (`:rt_inherit`, em todos os nós): o aparelho novo recebe as pendências do antigo até o
  momento da herança. Explícita (`POST /inherit`) ou automática com RT_INHERIT=auto.
  F3: ver `ChatyyRouter.BodyStore.Purge` (aqui nada é apagado).

  Kill: RT_STORE=0 no arquivo de flags (≤ 2 s): /store responde `disabled`, o /fanout para de copiar;
  o que já está guardado continua no /pull.
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{BodyHome, Clock, Config, Directory, Metrics, Net, Seglog, Store}
  alias ChatyyRouter.PG.Conn

  @inflight :rt_body_inflight
  @inherit :rt_body_inherit_mem
  @purged :rt_body_would_purge
  @status :rt_body_status

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  # ======================================================================== API

  @doc """
  Guarda. `req` (mapa, chaves átomo): cid, mid, env (binário), kind ("msg"|"reaction"), ref (mid alvo da
  reação), from, from_device, ts, type, size, devices (lista opcional de ids), meta, src.
  {:ok, %{copies, wanted, dup?, conflict?, acting}} | {:error, motivo}.
  """
  def store(req) do
    t0 = System.monotonic_time(:microsecond)

    res =
      with :ok <- on(),
           {:ok, req} <- normalize(req),
           :ok <- BodyHome.check(req.cid),
           :ok <- f4_gate(req) do
        route_store(req)
      end

    result =
      case res do
        {:ok, %{conflict: true}} -> :conflict
        {:ok, %{dup: true}} -> :dup
        {:ok, %{copies: c, wanted: w}} when c < w -> :partial
        {:ok, _} -> :ok
        {:error, e} when e in [:disabled, :not_enabled, :not_e2ee, :bad_request, :not_f4, :unknown_target, :forbidden, :receipt_unresolved] -> e
        {:error, _} -> :miss
      end

    if result == :bad_request do
      # motivo no rótulo e no log (sem conteúdo): rt_store_total{result="bad_request",why="…"}
      why = bad_why(req)
      Metrics.inc({:rt_store, :bad_request, why})

      Logger.warning(
        "router f1: /store bad_request why=#{why} cid=#{inspect(is_map(req) && req[:cid])} kind=#{inspect(is_map(req) && req[:kind])} " <>
          "src=#{inspect(is_map(req) && req[:src])} mid=#{inspect(is_map(req) && req[:mid])} env_bytes=#{if is_map(req) and is_binary(req[:env]), do: byte_size(req[:env]), else: "-"}"
      )
    else
      Metrics.inc({:rt_store, result})
    end
    if result in [:ok, :partial], do: Metrics.inc({:rt_store_src, (is_map(req) && req[:src]) || :store})
    if result in [:ok, :dup, :partial, :conflict], do: Metrics.hist(:rt_store, System.monotonic_time(:microsecond) - t0)
    res
  end

  @doc "Gancho do /fanout (R1): cópia assíncrona p/ conversa marcada. Nunca falha nem espera."
  def from_fanout(req) do
    try do
      cid = req[:cid]

      if ChatyyRouter.Flags.get(:store) == true and is_integer(cid) and BodyHome.check(cid) == :ok do
        spawn(fn ->
          store(%{cid: cid, mid: req[:seq], env: req[:body], kind: "msg", from: req[:from],
                  from_device: req[:from_device], ts: req[:ts], cmi: req[:cmi], src: :fanout})
        end)
      end
    rescue
      _ -> :ok
    end

    :ok
  end

  defp on, do: if(ChatyyRouter.Flags.get(:store) == true, do: :ok, else: {:error, :disabled})

  # [sgu F4] recibo e apagar para todos só existem em conversa F4 (RT_F4=1 + body_store >= 3)
  defp f4_gate(%{kind: k, cid: cid}) when k in [:receipt, :delete],
    do: if(ChatyyRouter.F4.on?(cid), do: :ok, else: {:error, :not_f4})

  defp f4_gate(_), do: :ok

  defp route_store(req) do
    home = BodyHome.home(req.cid)
    target = BodyHome.acting(req.cid)
    req = Map.put(req, :home, home)

    res =
      if target == Net.me(),
        do: accept(req),
        else: Net.call(target, __MODULE__, {:accept, req}, Net.tmo(target, 8_000))

    case res do
      {:error, :unreachable} when target == home ->
        # a casa caiu entre o lookup e a chamada: a irmã em exercício guarda (o reparo leva à casa depois)
        Metrics.inc(:rt_store_home_down)
        alt = Enum.find(BodyHome.chain(home), &Net.alive?/1)

        cond do
          alt == nil -> {:error, :no_copy_target}
          alt == Net.me() -> accept(req)
          true -> Net.call(alt, __MODULE__, {:accept, req}, Net.tmo(alt, 8_000))
        end

      other ->
        other
    end
  end

  @doc "Por que o pedido é inválido (só o 1º motivo; rótulo da métrica)."
  def bad_why(req) when not is_map(req), do: :not_object

  def bad_why(req) do
    kind = to_string(req[:kind] || "msg")
    env = req[:env]

    cond do
      req[:cid] == nil -> :no_cid
      not is_integer(to_int(req[:cid])) -> :bad_cid
      kind in ["receipt", "delete"] and str(req[:from_uid]) == nil -> if(kind == "receipt", do: :rc_no_uid, else: :del_no_uid)
      kind == "receipt" and rc_type(req) == nil -> :rc_bad_type
      kind == "receipt" -> :rc_no_upto
      kind == "delete" -> :del_no_ref
      env == nil -> :no_env
      not is_binary(env) -> :bad_env
      env == "" -> :empty_env
      kind == "reaction" and not is_integer(to_int(req[:ref])) -> :rx_no_ref
      kind == "reaction" and canon(req[:from]) == "" -> :rx_no_from
      kind == "reaction" and rx_type(req) == nil -> :rx_bad_type
      req[:mid] == nil -> :no_mid
      true -> :bad_mid
    end
  end

  @doc false
  def normalize(req) do
    cid = to_int(req[:cid])
    kind = to_string(req[:kind] || "msg")
    env = req[:env]

    cond do
      # [sgu F4] recibo (✓✓/lida) e apagar para todos: o envelope é metadado gerado aqui (não vem do app)
      kind == "receipt" and is_integer(cid) ->
        uid = str(req[:from_uid])
        rt = rc_type(req)
        up = to_int(req[:upto_pts])
        um = to_int(req[:upto_mid])

        if uid != nil and rt != nil and ((is_integer(up) and up > 0) or (is_integer(um) and um > 0)) do
          e = ChatyyRouter.F4.receipt_env(uid, rt, up || 0, um)
          r = base(req, cid, {:rc, uid, rt}, :receipt, e)
          {:ok, Map.merge(r, %{from_uid: uid, rtype: rt, upto_pts: up, upto_mid: um, upto: up || 0})}
        else
          {:error, :bad_request}
        end

      kind == "delete" and is_integer(cid) ->
        uid = str(req[:from_uid])
        ref = to_int(req[:ref]) || to_int(req[:mid])

        if uid != nil and is_integer(ref) and ref > 0 do
          r = base(req, cid, {:del, ref}, :delete, ChatyyRouter.F4.delete_env(uid, ref))
          {:ok, Map.merge(r, %{from_uid: uid, ref: ref})}
        else
          {:error, :bad_request}
        end

      not is_integer(cid) or not is_binary(env) or env == "" -> {:error, :bad_request}
      kind == "reaction" ->
        ref = to_int(req[:ref])
        from = canon(req[:from])
        rt = rx_type(req)
        if is_integer(ref) and from != "" and rt != nil,
          do: {:ok, base(req, cid, {:rx, ref, from, rt}, :reaction, env) |> Map.put(:ref, ref)},
          else: {:error, :bad_request}

      kind == "edit" ->
        # edição E2EE NO LUGAR (chat_edit: mesmo mid, conteúdo novo): rev crescente decide (padrão = edited_at
        # em ms, senão ts). Sem a marca de edição, mesmo mid + sha diferente continua CONFLITO.
        case to_int(req[:mid]) do
          mid when is_integer(mid) and mid > 0 ->
            r = base(req, cid, mid, :msg, env)
            {:ok, Map.merge(r, %{edit: true, rev: to_int(req[:rev]) || to_int(req[:edited_at]) || r.ts})}

          _ ->
            {:error, :bad_request}
        end

      true ->
        case to_int(req[:mid]) do
          mid when is_integer(mid) and mid > 0 -> {:ok, base(req, cid, mid, :msg, env)}
          _ -> {:error, :bad_request}
        end
    end
  end

  @doc """
  S4: tipo da entrada na fila de reações — "r" (reação) ou "v" (estado: emoji começando com `v{`).
  Vem de `rx_type` (ou `meta.rx_kind`, como o sgu-f1.php manda); padrão "r". Outro valor = inválido (nil).
  """
  def rx_type(req) do
    meta = req[:meta] || %{}
    t = req[:rx_type] || meta["rx_kind"] || meta[:rx_kind] || "r"

    case to_string(t) do
      x when x in ["r", "v"] -> x
      _ -> nil
    end
  end

  @doc "[sgu F4] tipo do recibo: \"d\" (entregue), \"r\" (lida) ou \"p\" (lida PRIVADA: conta para mim, os outros veem só entregue)."
  def rc_type(req) do
    case to_string(req[:rtype] || req[:rc_type] || "") do
      x when x in ["d", "r", "p"] -> x
      _ -> nil
    end
  end

  defp base(req, cid, mid, kind, env) do
    %{
      cid: cid,
      mid: mid,
      kind: kind,
      ref: nil,
      from: req[:from] && to_string(req[:from]),
      from_device: req[:from_device] && to_string(req[:from_device]),
      ts: to_int(req[:ts]) || Clock.now_ms(),
      type: req[:type] && to_string(req[:type]),
      size: byte_size(env),
      sha: sha(env),
      env: env,
      devices: req[:devices],
      meta: req[:meta] || %{},
      src: req[:src] || :store,
      edit: false,
      rev: 0,
      # metadados p/ a F2 (o PHP passa no /store; o /pull devolve)
      cmi: str(req[:cmi]),
      from_uid: str(req[:from_uid]),
      reply_to_id: to_int(req[:reply_to_id]),
      edit_of: to_int(req[:edit_of]),
      mentions: req[:mentions],
      # [sgu F4 P-4] uids citados (o PHP resolve os e-mails) + @todos → contador de menções não lidas
      mention_uids: (case req[:mention_uids] do l when is_list(l) -> l |> Enum.map(&to_string/1) |> Enum.take(256); _ -> nil end),
      mention_all: req[:mention_all] in [true, 1, "1"]
    }
  end

  defp str(nil), do: nil
  defp str(""), do: nil
  defp str(v), do: to_string(v)

  def sha(env), do: Base.encode16(:crypto.hash(:sha256, env), case: :lower)
  def canon(nil), do: ""

  def canon(e) do
    e |> to_string() |> String.trim() |> String.downcase() |> String.replace(~r/@onemundo\.com\.br$/, "@chatyy.com.br")
  end

  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: trunc(v)

  defp to_int(v) when is_binary(v) do
    case Integer.parse(v) do
      {i, ""} -> i
      _ -> nil
    end
  end

  defp to_int(_), do: nil

  # ------------------------------------------------------------ aceite (casa em exercício)

  @doc """
  Aceite na casa em exercício. Idempotência também por (cid, from_uid, cmi) — F2: se o /store gravou e o
  esqueleto no PG falhou, o reenvio do app chega com OUTRO mid e o mesmo cmi → devolve o mid que já está
  guardado (`mid`, `dup: true, cmi_dup: true`) e não grava um 2º corpo. Toda resposta ok traz `mid`.
  """
  def accept(req) do
    case ChatyyRouter.F4.prepare(req) do
      {:ok, req} -> accept_f4(req)
      {:error, _} = e -> Metrics.inc({:rt_store, :f4_refused}) && e
    end
  end

  # [sgu F4] apagar para todos: grava o evento (fila de todos os aparelhos) e troca o corpo da mensagem pela
  # lápide (revisão máxima: vence em casa e nas cópias; o corpo some do roteador e quem já tinha recebe de novo)
  defp accept_f4(%{kind: :delete, ref: target} = req) do
    with {:ok, r} <- accept0(req) do
      case Store.get(:rt_body, {req.cid, target}) do
        %{kind: :msg} = old ->
          tomb = ChatyyRouter.F4.tomb_env(target)
          t = Map.merge(old, %{env: tomb, sha: sha(tomb), size: byte_size(tomb), edit: true, rev: ChatyyRouter.F4.tomb_rev(), ts: req.ts, src: :f4_delete})
          _ = accept_key(Map.put(t, :tomb, true))
          {:ok, Map.put(r, :tomb, true)}

        _ ->
          {:ok, Map.put(r, :tomb, false)}
      end
    end
  end

  defp accept_f4(req), do: accept0(req)

  defp accept0(req) do
    case cmi_key(req) do
      nil ->
        accept_key(req)

      ck ->
        lock(ck)

        try do
          case Store.get(:rt_body_cmi, ck) do
            %{mid: m} when m != req.mid ->
              if Store.member?(:rt_body, {req.cid, m}) do
                Metrics.inc(:rt_store_cmi_dup)
                {:ok, %{dup: true, cmi_dup: true, mid: m, copies: 1, wanted: 1 + Config.body_copies(), acting: Net.me()}}
              else
                accept_key(req)
              end

            _ ->
              accept_key(req)
          end
        after
          unlock(ck)
        end
    end
  end

  @doc false
  def cmi_key(%{kind: :msg, cmi: cmi} = r) when is_binary(cmi) and cmi != "" do
    if Map.get(r, :edit), do: nil, else: {r.cid, canon(r[:from_uid] || r[:from]), cmi}
  end

  def cmi_key(_), do: nil

  defp put_cmi(recs) do
    rows = for r <- recs, ck = cmi_key(r), ck != nil, do: {ck, %{mid: r.mid, ts: r.ts}}
    Store.put_many(:rt_body_cmi, rows)
  end

  defp accept_key(req) do
    with {:ok, r} <- accept_key0(req), do: {:ok, Map.put_new(r, :mid, req.mid)}
  end

  defp accept_key0(req) do
    key = {req.cid, req.mid}
    lock(key)

    try do
      case (if ChatyyRouter.BodyStore.Purge.purged?(req.cid, req.mid), do: :purged, else: Store.get(:rt_body, key)) do
        :purged ->
          # F3 já apagou (todos os aparelhos gravaram): reenvio tardio não ressuscita
          Metrics.inc(:rt_store_after_purge)
          {:ok, %{dup: true, purged: true, copies: 0, wanted: 1 + Config.body_copies(), acting: Net.me()}}

        %{sha: sha} = rec when sha == req.sha ->
          # duplicata: garante as cópias (idempotente; cura irmã que estava fora)
          copies = replicate([rec], BodyHome.copy_targets(rec.home || req.home, Net.me()))
          {:ok, %{dup: true, copies: 1 + copies, wanted: 1 + Config.body_copies(), acting: Net.me()}}

        %{kind: :reaction, ts: old_ts} when req.kind == :reaction and req.ts > old_ts ->
          # S4: reação nova do mesmo usuário na mesma mensagem substitui (e reabre as confirmações)
          clear_acks(key)
          write_new(req)

        %{kind: :receipt, upto: old_up} when req.kind == :receipt and req.upto > old_up ->
          # [sgu F4] recibo novo do mesmo usuário/tipo substitui (até onde leu só cresce) e reabre as confirmações
          clear_acks(key)
          write_new(req)

        %{kind: :receipt} when req.kind == :receipt ->
          Metrics.inc(:rt_store_receipt_stale)
          {:ok, %{dup: true, stale: true, copies: 1, wanted: 1 + Config.body_copies(), acting: Net.me()}}

        %{kind: :reaction} when req.kind == :reaction ->
          Metrics.inc(:rt_store_reaction_stale)
          {:ok, %{dup: true, stale: true, copies: 1, wanted: 1 + Config.body_copies(), acting: Net.me()}}

        %{kind: :msg} = old when req.edit ->
          if req.rev > Map.get(old, :rev, 0) do
            # edição no lugar: substitui o corpo, mantém os aparelhos congelados da mensagem e reabre as confirmações
            Metrics.inc(:rt_store_edit)
            clear_acks(key)
            write_new(%{req | devices: old.devices || req.devices})
          else
            Metrics.inc(:rt_store_edit_stale)
            {:ok, %{dup: true, stale: true, copies: 1, wanted: 1 + Config.body_copies(), acting: Net.me()}}
          end

        %{} = _other ->
          Metrics.inc(:rt_store_conflict_mid)
          Logger.warning("router f1: conflito de corpo cid=#{req.cid} mid=#{inspect(req.mid)} (fica o 1º)")
          {:ok, %{conflict: true, copies: 1, wanted: 1 + Config.body_copies(), acting: Net.me()}}

        nil ->
          write_new(req)
      end
    after
      unlock(key)
    end
  end

  defp write_new(req), do: with({:ok, r} <- write_new0(req), do: {:ok, Map.put(r, :mid, req.mid)})

  defp write_new0(req) do
    devices =
      case req.devices do
        l when is_list(l) -> Enum.map(l, &to_string/1) |> Enum.uniq()
        _ ->
          case Directory.recipient_ids_result(req.cid, req.from_device) do
            {:ok, l} -> l
            {:error, _} -> Metrics.inc(:rt_store_devices_unknown) && nil
          end
      end

    rec = req |> Map.put(:devices, devices) |> Map.put(:stored_ms, Clock.now_ms()) |> Map.put(:src, req.src)
    # [sgu F4] fora da casa: alinha a marca d'água com as réplicas vivas; nó que não é réplica recusa (E2E 24/10)
    with :ok <- ChatyyRouter.F4.ready(rec.cid), do: write_rec(req, rec)
  end

  defp write_rec(req, rec) do
    # [sgu F4] conv_pts dado pela casa em exercício (inerte sem RT_F4=1 + body_store >= 3)
    rec = ChatyyRouter.F4.stamp(rec)
    targets = BodyHome.copy_targets(req.home, Net.me())
    # cópias EM PARALELO com o fsync local; responde só depois dos dois
    task = Task.async(fn -> replicate([rec], targets) end)

    case Store.put(:rt_body, {rec.cid, rec.mid}, rec) do
      :ok ->
        put_cmi([rec])
        f4 = ChatyyRouter.F4.log_recs([rec])
        copies = Task.await(task, 35_000)
        if f4 != :ok, do: Metrics.inc(:rt_f4_log_short)
        if copies < Config.body_copies(), do: Metrics.inc(:rt_store_copies_short)
        {:ok, %{copies: 1 + copies, wanted: 1 + Config.body_copies(), acting: Net.me()} |> put_pts(rec)}

      {:error, e} ->
        Task.shutdown(task, :brutal_kill)
        {:error, {:store, e}}
    end
  end

  defp put_pts(r, %{pts: p}) when is_integer(p), do: Map.put(r, :pts, p)
  defp put_pts(r, _), do: r

  defp lock(key, n \\ 400) do
    cond do
      :ets.insert_new(@inflight, {key, self()}) -> :ok
      n == 0 -> :ok
      true -> Process.sleep(5) && lock(key, n - 1)
    end
  end

  defp unlock(key), do: :ets.delete(@inflight, key)

  @doc "Cópia em cada alvo (fsync lá). Devolve quantos confirmaram."
  def replicate(_recs, []), do: 0

  def replicate(recs, targets) do
    targets
    |> Task.async_stream(fn t -> Net.call(t, __MODULE__, {:copy, recs}, Net.tmo(t, Config.get(:replica_timeout_ms, 3_000))) end,
      timeout: 32_000, on_timeout: :kill_task, max_concurrency: 4)
    |> Enum.count(&(&1 == {:ok, :ok}))
  end

  @doc false
  def put_copies(recs) do
    fresh =
      for rec <- recs, not ChatyyRouter.BodyStore.Purge.purged?(rec.cid, rec.mid),
          keep?(Store.get(:rt_body, {rec.cid, rec.mid}), rec), do: {{rec.cid, rec.mid}, rec}

    recs = Enum.map(fresh, &elem(&1, 1))

    with :ok <- Store.put_many(:rt_body, fresh), :ok <- put_cmi(recs) do
      # [sgu F4] a cópia refaz a MESMA entrada (pts vem no registro): casa e irmãs com os mesmos contadores
      ChatyyRouter.F4.log_recs(recs)
    end
  end

  defp keep?(nil, _), do: true
  defp keep?(%{sha: s}, %{sha: s}), do: false
  defp keep?(%{kind: :reaction, ts: a}, %{kind: :reaction, ts: b}), do: b > a
  defp keep?(%{kind: :receipt} = a, %{kind: :receipt} = b), do: (b[:upto] || 0) > (a[:upto] || 0)
  # edição no lugar: a revisão maior vence (sem marca de edição, sha diferente = conflito, fica o que está)
  defp keep?(%{kind: :msg} = a, %{kind: :msg, edit: true} = b), do: Map.get(b, :rev, 0) > Map.get(a, :rev, 0)
  defp keep?(%{devices: nil}, %{devices: d}) when is_list(d), do: true
  defp keep?(_, _), do: false

  # ------------------------------------------------------------ leitura (pull)

  @doc """
  Pendências do aparelho (esperado e ainda sem `persisted`, + herdadas — A5).
  opts: cid (só essa conversa), since (mid: só mensagens acima), limit (500).
  %{messages: [rec] por mid, reactions: [rec] por ts}.
  """
  def pull(device, opts \\ []) do
    device = to_string(device)
    limit = opts[:limit] || 500

    q = %{since: opts[:since], limit: limit, mids: opts[:mids], all: opts[:all] == true, since_pts: opts[:since_pts]}

    parts =
      case opts[:cid] do
        nil ->
          Net.alive_regions()
          |> Task.async_stream(fn r -> ask(r, {:pull_q, device, nil, q}) end,
            timeout: 32_000, on_timeout: :kill_task, max_concurrency: 16, ordered: false)
          |> Enum.flat_map(fn
            {:ok, l} when is_list(l) -> l
            _ -> []
          end)

        cid ->
          # [sgu F4] since_pts só de uma réplica do log: um nó com cópias parciais faria o cursor do aparelho pular pts
          if q.since_pts != nil and ChatyyRouter.F4.conv?(cid) and not ChatyyRouter.F4.replica_acting?(cid) do
            :unavailable
          else
            case ask(BodyHome.acting(cid), {:pull_q, device, [cid], q}) do
              l when is_list(l) -> l
              _ -> []
            end
          end
      end

    Metrics.inc(:rt_pull)
    if parts == :unavailable, do: throw(:f4_no_replica)
    {rx, msgs} = Enum.split_with(parts, &(&1.kind == :reaction))
    {ev, msgs} = Enum.split_with(msgs, &(&1.kind in [:receipt, :delete]))
    # [sgu F4] recibos e apagar para todos em `events` (ordem de pts); mensagens/reações como antes
    %{messages: msgs |> Enum.sort_by(&{&1.cid, &1.mid}) |> Enum.take(limit), reactions: Enum.sort_by(rx, &{&1.ts, &1.cid}),
      events: Enum.sort_by(ev, &{&1.cid, &1[:pts] || 0})}
  end

  defp ask(r, {:pull_q, d, c, q} = msg) do
    if r == Net.me(), do: pull_local(d, c, q), else: Net.call(r, __MODULE__, msg, Net.tmo(r, 5_000))
  end

  @doc false
  def pull_local(device, cids, since, limit), do: pull_local(device, cids, %{since: since, limit: limit})

  @doc """
  q: since, limit, mids (lista: só essas chaves, JÁ gravadas pelo aparelho ou não), all (true: também o que o
  aparelho já confirmou `persisted` — o aparelho tem que ser esperado/herdeiro, salvo com `mids`).
  """
  def pull_local(device, cids, q) do
    cids = cids || Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1)
    inh = inherited_from(device)
    since = q[:since]
    limit = q[:limit] || 500
    want = q[:mids] && MapSet.new(q[:mids])
    # [sgu F4] since_pts: tudo o que mudou na conversa depois do pts (aparelho esperado/herdeiro), gravado ou não
    spts = q[:since_pts]

    for cid <- cids,
        {sub, {ts, _sha, devs, kind}} <- aux(cid),
        want == nil or MapSet.member?(want, sub),
        spts == nil or want != nil or ((ChatyyRouter.F4.sub_pts(cid, sub) || 0) > spts),
        want != nil or spts != nil or kind in [:reaction, :receipt, :delete] or since == nil or (is_integer(sub) and sub > since),
        want != nil or (if q[:all] or spts != nil, do: expected_for?(sub, devs, device, inh, ts), else: pending_for?(cid, sub, ts, devs, device, inh)) do
      Store.get(:rt_body, {cid, sub})
    end
    |> Enum.reject(&is_nil/1)
    # [sgu F4] com since_pts o corte por limite é pelo MENOR pts (o cursor do aparelho = maior pts recebido não pula nada)
    |> then(fn l -> if spts != nil, do: Enum.sort_by(l, &(ChatyyRouter.F4.sub_pts(&1.cid, &1.mid) || 0)), else: l end)
    |> Enum.take(limit)
  end

  @doc "[{sub, {ts, sha, devices, kind}}] da conversa, sem ler corpo."
  def aux(cid) do
    :ets.select(Seglog.idx(:rt_body), [{{{cid, :"$1"}, :_, :_, :_, :_, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  defp expected_for?(_sub, devs, device, inh, ts) do
    devs = devs || []
    device in devs or Enum.any?(inh, fn {from, its} -> from in devs and ts <= its end)
  end

  defp pending_for?(cid, sub, ts, devs, device, inh) do
    devs = devs || []

    direct = device in devs and not persisted?(cid, sub, device)

    inherited =
      not direct and not persisted?(cid, sub, device) and
        Enum.any?(inh, fn {from, its} -> from in devs and ts <= its and not persisted?(cid, sub, from) end)

    direct or inherited
  end

  # ------------------------------------------------------------ confirmações

  @doc "Ack por aparelho (explícito: POST /ack_store). Vai a todos os nós vivos (cada um aplica se tiver o corpo)."
  def ack(device, cid, mids, persisted?) do
    now = Clock.now_ms()
    rows = for m <- List.wrap(mids), do: {to_string(device), cid, m, now, if(persisted?, do: now)}
    for r <- Net.alive_regions(), do: (if r == Net.me(), do: apply_acks(rows), else: Net.cast(r, __MODULE__, {:acks, rows}))
    :ok
  end

  @doc false
  def apply_acks(rows) do
    for {dev, cid, mid, acked, per} <- rows, Store.member?(:rt_body, {cid, mid}) do
      k = {cid, mid, dev}
      {a0, p0} = Store.get(:rt_body_ack, k) || {nil, nil}
      new = {a0 || acked, p0 || per}
      if new != {a0, p0}, do: Store.put(:rt_body_ack, k, new)
      if per != nil and p0 == nil, do: check_all_persisted(cid, mid)
    end

    :ok
  end

  defp persisted?(cid, sub, dev) do
    case Store.get(:rt_body_ack, {cid, sub, dev}) do
      {_, p} when p != nil -> true
      _ -> false
    end
  end

  defp clear_acks(key = {cid, sub}) do
    for k <- :mnesia.dirty_select(:rt_body_ack, [{{:rt_body_ack, {cid, sub, :_}, :_}, [], [{:element, 2, :"$_"}]}]),
        do: Store.delete(:rt_body_ack, k)

    if :ets.whereis(@purged) != :undefined, do: :ets.delete(@purged, key)
  end

  defp check_all_persisted(cid, sub) do
    with true <- BodyHome.acting?(cid),
         %{devices: devs} = rec when is_list(devs) and devs != [] <- Store.get(:rt_body, {cid, sub}),
         true <- Enum.all?(devs, &persisted?(cid, sub, &1)),
         true <- :ets.insert_new(@purged, {{cid, sub}}) do
      ChatyyRouter.BodyStore.Purge.impl().all_persisted({cid, sub}, rec)
    end

    :ok
  end

  # ------------------------------------------------------------ herança (A5)

  @doc "O aparelho `to` (mesmo uid) herda as pendências de `from` até agora. Vai a todos os nós."
  def inherit(uid, from, to, src \\ :api) do
    rec = %{uid: to_string(uid), from: to_string(from), to: to_string(to), ts: Clock.now_ms(), src: src}

    if rec.from == rec.to or rec.from == "" or rec.to == "" do
      {:error, :bad_request}
    else
      for r <- Net.alive_regions(), do: (if r == Net.me(), do: put_inherit([rec]), else: Net.cast(r, __MODULE__, {:inherit, [rec]}))
      Metrics.inc(:rt_inherit)
      :ok
    end
  end

  @doc false
  def put_inherit(recs) do
    fresh = for r <- recs, :ets.lookup(@inherit, {r.uid, r.from, r.to}) == [], do: r
    Store.put_many(:rt_inherit, for(r <- fresh, do: {{r.uid, r.from, r.to}, r}))
    for r <- fresh, do: :ets.insert(@inherit, {{r.uid, r.from, r.to}, r})
    :ok
  end

  @doc "[{from, ts}] de quem `device` herdou (encadeado: herdeiro de herdeiro)."
  def inherited_from(device, depth \\ 3) do
    direct = for {{_u, f, ^device}, r} <- :ets.tab2list(@inherit), do: {f, r.ts}
    if depth == 0 or direct == [], do: direct, else: direct ++ Enum.flat_map(direct, fn {f, ts} -> for {g, t2} <- inherited_from(f, depth - 1), do: {g, min(ts, t2)} end)
  end

  def inherits, do: for({_, r} <- :ets.tab2list(@inherit), do: r)

  # ------------------------------------------------------------ reparo / anti-entropia

  @doc "Roda já o reparo das conversas em que este nó é a casa em exercício (testes/kit)."
  def repair_now, do: GenServer.call(__MODULE__, :repair_now, 120_000)

  @doc false
  def repair(cids) do
    me = Net.me()
    peers = Net.alive_regions() -- [me]

    Enum.reduce(cids, %{fetched: 0, pushed: 0, devices_fixed: 0}, fn cid, acc ->
      mine = Map.new(aux(cid), fn {sub, {_ts, sha, _d, _k}} -> {sub, sha} end)

      theirs =
        peers
        |> Task.async_stream(fn r -> {r, Net.call(r, __MODULE__, {:keys, cid}, Net.tmo(r, 5_000))} end,
          timeout: 32_000, on_timeout: :kill_task, max_concurrency: 16)
        |> Enum.flat_map(fn
          {:ok, {r, l}} when is_list(l) -> [{r, Map.new(l)}]
          _ -> []
        end)

      # 1) o que falta aqui e alguém tem
      missing =
        theirs
        |> Enum.flat_map(fn {r, m} -> for {sub, sha} <- m, need?(mine, sub, sha), do: {sub, r} end)
        |> Enum.uniq_by(&elem(&1, 0))
        |> Enum.group_by(&elem(&1, 1), &elem(&1, 0))

      fetched =
        Enum.reduce(missing, 0, fn {r, subs}, n ->
          case Net.call(r, __MODULE__, {:get, cid, subs}, Net.tmo(r, 10_000)) do
            recs when is_list(recs) ->
              :ok = put_copies(recs)

              # as confirmações que o outro nó já tinha (a dlv refaz de qualquer jeito; isto encurta a espera)
              case Net.call(r, __MODULE__, {:acks_of, cid, subs}, Net.tmo(r, 5_000)) do
                rows when is_list(rows) -> apply_acks(rows)
                _ -> :ok
              end

              n + length(recs)

            _ ->
              n
          end
        end)

      if fetched > 0, do: Metrics.inc(:rt_body_repair_fetched, fetched)

      # 2) aparelhos desconhecidos na hora (diretório fora): resolve agora (conta como "tarde")
      fixed =
        for {sub, {_ts, _sha, nil, :msg}} <- aux(cid), rec = Store.get(:rt_body, {cid, sub}), rec != nil,
            {:ok, devs} <- [Directory.recipient_ids_result(cid, rec.from_device)] do
          Store.put(:rt_body, {cid, sub}, %{rec | devices: devs})
          Metrics.inc(:rt_store_devices_late)
          1
        end
        |> length()

      # 3) as cópias que faltam nas irmãs (A4: 2 cópias fora da casa)
      mine = Map.new(aux(cid), fn {sub, {_ts, sha, _d, _k}} -> {sub, sha} end)
      held = Map.new(theirs)

      pushed =
        for t <- BodyHome.copy_targets(BodyHome.home(cid), me), reduce: 0 do
          n ->
            have = Map.get(held, t, %{})
            subs = for {sub, sha} <- mine, need?(have, sub, sha), do: sub

            if subs == [] do
              n
            else
              recs = for s <- subs, r = Store.get(:rt_body, {cid, s}), r != nil, do: r
              if Net.call(t, __MODULE__, {:copy, recs}, Net.tmo(t, 10_000)) == :ok, do: n + length(recs), else: n
            end
        end

      if pushed > 0, do: Metrics.inc(:rt_body_repair_pushed, pushed)
      %{acc | fetched: acc.fetched + fetched, pushed: acc.pushed + pushed, devices_fixed: acc.devices_fixed + fixed}
    end)
  end

  # falta de verdade (ou reação com versão diferente); corpo com sha diferente = conflito, não se troca
  defp need?(m, sub, sha) do
    case Map.fetch(m, sub) do
      :error -> true
      {:ok, ^sha} -> false
      # sha diferente: reação (mais nova) ou edição (rev maior) — quem recebe decide pelo keep?/2;
      # conflito de verdade é raro e só custa um reenvio por volta
      {:ok, _} -> true
    end
  end

  defp sync_inherits do
    for r <- Net.alive_regions() -- [Net.me()] do
      case Net.call(r, __MODULE__, :inherit_all, Net.tmo(r, 5_000)) do
        l when is_list(l) -> put_inherit(l)
        _ -> :ok
      end
    end
  end

  # ======================================================================== processo

  @impl true
  def init(_) do
    BodyHome.init_tables()
    ChatyyRouter.F4.rebuild()

    for t <- [@inflight, @inherit, @purged, @status], :ets.whereis(t) == :undefined do
      :ets.new(t, [:named_table, :public, :set, write_concurrency: true, read_concurrency: true])
    end

    for {k, r} <- Store.all(:rt_inherit), do: :ets.insert(@inherit, {k, r})

    pg = Config.pg_enabled?()
    if pg, do: send(self(), :conv_load)
    Process.send_after(self(), :repair, int_cfg(:body_repair_ms, 60_000))
    if pg, do: Process.send_after(self(), :ack_poll, 5_000)

    {:ok, %{pg: pg, col: nil, acting: MapSet.new(), conv_err: nil, conv_rows: 0, ack_rows: 0, ack_err: nil,
            last_repair: nil, inherit_wm: %{}} |> snap()}
  end

  @impl true
  def handle_call({:accept, req}, from, s) do
    spawn(fn -> GenServer.reply(from, try_(fn -> accept(req) end)) end)
    {:noreply, s}
  end

  def handle_call({:copy, recs}, from, s) do
    spawn(fn -> GenServer.reply(from, try_(fn -> put_copies(recs) end)) end)
    {:noreply, s}
  end

  def handle_call({:pull_q, device, cids, q}, from, s) do
    spawn(fn -> GenServer.reply(from, try_(fn -> pull_local(device, cids, q) end)) end)
    {:noreply, s}
  end

  def handle_call({:pull_local, device, cids, since, limit}, from, s) do
    spawn(fn -> GenServer.reply(from, try_(fn -> pull_local(device, cids, since, limit) end)) end)
    {:noreply, s}
  end

  # [23/10 mad] NENHUMA resposta a outro nó sai DESTE processo: com a porta de distribuição de um par ruim
  # cheia (busy_dist_port; mad↔sg "not responding"), o send da resposta SUSPENDE quem envia — o BodyStore
  # inteiro ficava parado (status suspended em gen:reply, fila 145, /f1/status sem resposta). Cada resposta
  # sai de um processo à parte; se travar, trava só ele.
  def handle_call({:keys, cid}, from, s), do: async_reply(from, fn -> for({sub, {_, sha, _, _}} <- aux(cid), do: {sub, sha}) end, s)

  def handle_call({:get, cid, subs}, from, s) do
    spawn(fn -> GenServer.reply(from, for(x <- subs, r = Store.get(:rt_body, {cid, x}), r != nil, do: r)) end)
    {:noreply, s}
  end

  def handle_call(:inherit_all, from, s), do: async_reply(from, fn -> inherits() end, s)
  def handle_call({:f4_hw, cid}, from, s), do: async_reply(from, fn -> ChatyyRouter.F4.hw(cid) end, s)
  def handle_call({:f4_locate, cids, mid}, from, s), do: async_reply(from, fn -> ChatyyRouter.F4.locate_local(cids, mid) end, s)
  def handle_call({:f4_sum, uid, cids}, from, s), do: async_reply(from, fn -> ChatyyRouter.F4.summaries_local(uid, cids) end, s)

  def handle_call({:acks_of, cid, subs}, from, s) do
    async_reply(from, fn ->
      for sub <- subs,
          {:rt_body_ack, {^cid, ^sub, dev}, {a, p}} <- :mnesia.dirty_select(:rt_body_ack, [{{:rt_body_ack, {cid, sub, :_}, :_}, [], [:"$_"]}]),
          do: {dev, cid, sub, a, p}
    end, s)
  end

  def handle_call({:put_conv, cid, c}, from, s) do
    async_reply(from, fn ->
      was = BodyHome.acting?(cid) and BodyHome.check(cid) == :ok
      :ok = BodyHome.put_local(cid, c)
      # virou a casa em exercício (A2 casa troca): completa já o que falta
      if not was and BodyHome.check(cid) == :ok and BodyHome.acting?(cid), do: spawn(fn -> repair([cid]) end)
      :ok
    end, s)
  end

  def handle_call(:repair_now, from, s) do
    spawn(fn ->
      GenServer.reply(from, try_(fn ->
        sync_inherits()
        repair(Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1))
      end))
    end)

    {:noreply, s}
  end

  def handle_call(:status, from, s), do: (snap(s); async_reply(from, fn -> status() end, s))

  defp async_reply(from, fun, s) do
    spawn(fn -> GenServer.reply(from, try_(fun)) end)
    {:noreply, s}
  end

  # foto do estado p/ o /f1/status, lida SEM passar pelo processo
  defp snap(s) do
    if :ets.whereis(@status) != :undefined, do: :ets.insert(@status, {:snap, Map.drop(s, [:acting, :inherit_wm]), System.monotonic_time(:millisecond)})
    s
  end

  defp try_(f) do
    try do
      f.()
    rescue
      e -> {:error, {:crash, Exception.message(e) |> String.slice(0, 200)}}
    catch
      k, e -> {:error, {k, inspect(e) |> String.slice(0, 200)}}
    end
  end

  @doc """
  /f1/status. NUNCA chama o processo (responde em ms mesmo com ele ocupado/suspenso): foto do estado (ETS,
  gravada a cada volta) + ETS/flags na hora. `warn` lista o que estiver estranho (processo suspenso, fila
  grande, foto velha); `proc` = estado do processo agora.
  """
  def status do
    {st, age} =
      case :ets.whereis(@status) != :undefined and :ets.lookup(@status, :snap) do
        [{:snap, m, t}] -> {m, System.monotonic_time(:millisecond) - t}
        _ -> {%{}, nil}
      end

    proc =
      case Process.whereis(__MODULE__) do
        nil -> %{alive: false}
        pid -> Map.new(Process.info(pid, [:status, :message_queue_len]) || [], fn {k, v} -> {k, v} end) |> Map.put(:alive, true)
      end

    warn =
      [
        proc[:alive] == false && "processo BodyStore fora",
        proc[:status] == :suspended && "processo BodyStore SUSPENSO (porta de distribuição de algum par cheia)",
        (proc[:message_queue_len] || 0) > 100 && "fila do BodyStore #{proc[:message_queue_len]}",
        (age == nil or age > 60_000) && "foto do estado com #{if age, do: div(age, 1000), else: "?"} s"
      ]
      |> Enum.filter(&is_binary/1)

    en = BodyHome.enabled_cids()

    Map.merge(st, %{
      store_on: ChatyyRouter.Flags.get(:store),
      enabled_cids: en,
      acting_cids: Enum.filter(en, &BodyHome.acting?/1),
      entries: Store.size(:rt_body),
      inherits: if(:ets.whereis(@inherit) == :undefined, do: 0, else: :ets.info(@inherit, :size)),
      snap_age_ms: age,
      proc: proc,
      warn: warn,
      partial: warn != []
    })
  end

  @impl true
  def handle_cast({:acks, rows}, s), do: (apply_acks(rows); {:noreply, s})
  def handle_cast({:inherit, recs}, s), do: (put_inherit(recs); {:noreply, s})

  @impl true
  def handle_info(:conv_load, s) do
    s = load_convs(s)
    # virou casa em exercício de alguma conversa (casa troca / casa caiu): reparo JÁ
    acting = MapSet.new(Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1))
    new = MapSet.difference(acting, s.acting) |> MapSet.to_list()
    if new != [], do: spawn(fn -> repair(new) end)
    Process.send_after(self(), :conv_load, int_cfg(:body_conv_ms, 10_000))
    {:noreply, snap(%{s | acting: acting})}
  end

  def handle_info(:repair, s) do
    me = self()

    spawn(fn ->
      r =
        try do
          # nada marcado (o normal até o --flag on): nenhuma chamada entre nós, nenhuma consulta
          if BodyHome.enabled_cids() != [] do
            sync_inherits()
            if ChatyyRouter.Flags.get(:inherit_auto) == true and Config.pg_enabled?(), do: auto_inherit()
            repair(Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1))
          end
        rescue
          e -> Logger.warning("router f1 reparo: #{inspect(e) |> String.slice(0, 200)}") && nil
        end

      send(me, {:repaired, r})
    end)

    {:noreply, s}
  end

  def handle_info({:repaired, r}, s) do
    Process.send_after(self(), :repair, int_cfg(:body_repair_ms, 60_000))
    {:noreply, snap(%{s | last_repair: r || s.last_repair})}
  end

  def handle_info(:ack_poll, s) do
    s =
      try do
        ack_poll(s)
      rescue
        e -> Metrics.inc(:rt_body_ack_poll_fail) && %{s | ack_err: inspect(e) |> String.slice(0, 200)}
      end

    Process.send_after(self(), :ack_poll, int_cfg(:body_ack_poll_ms, 10_000))
    {:noreply, snap(s)}
  end

  def handle_info(_, s), do: {:noreply, s}

  # ------------------------------------------------------------ PG (réplica local, só leitura)

  # O papel chatyy_router_ro NÃO lê chat_conversations/chat_messages: o kit F1 cria funções SECURITY
  # DEFINER (ddl/003-f1.sql) que só devolvem as conversas marcadas. Sem elas: lista vazia (inerte).
  defp load_convs(s) do
    n = Map.get(s, :conv_checks, 0)

    s =
      if s.col == true or (s.col == false and rem(n, 6) != 0) do
        s
      else
        case Conn.query(:replica, "SELECT (to_regprocedure('public.sgu_f1_convs()') IS NOT NULL)::text", [], 5_000) do
          {:ok, %{rows: [[v]]}} -> %{s | col: v in ["t", "true"]}
          _ -> s
        end
      end

    s = Map.put(s, :conv_checks, n + 1)

    if s.col != true do
      BodyHome.replace_pg([])
      s
    else
      sql = "SELECT id::text, coalesce(home_region, ''), body_store::text, since_ms::text, e2ee::text FROM sgu_f1_convs()"

      case Conn.query(:replica, sql, [], 5_000) do
        {:ok, %{rows: rows}} ->
          BodyHome.replace_pg(
            for [id, h, m, at, e] <- rows do
              {String.to_integer(id), %{home_raw: if(h == "", do: nil, else: h), mode: String.to_integer(m), since_ms: String.to_integer(at), e2ee: e == "1"}}
            end
          )

          %{s | conv_rows: length(rows), conv_err: nil}

        {:error, e} ->
          Metrics.inc(:rt_body_conv_fail)
          %{s | conv_err: inspect(e) |> String.slice(0, 200)}
      end
    end
  end

  # acks e persisted da fila sombra (a mesma que a AckSource lê) das conversas marcadas que este nó guarda
  defp ack_poll(s) do
    cids = Enum.filter(BodyHome.enabled_cids(), fn c -> aux(c) != [] end)

    s =
      if Map.get(s, :dlv_pcol) == nil do
        case Conn.query(:replica, "SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_msg_device_dlv' AND column_name = 'persisted_at'", [], 5_000) do
          {:ok, %{rows: r}} -> Map.put(s, :dlv_pcol, r != [])
          _ -> s
        end
      else
        s
      end

    if cids == [] or s[:dlv_pcol] == nil do
      s
    else
      per = if s[:dlv_pcol], do: "(EXTRACT(EPOCH FROM persisted_at)*1000)::bigint::text", else: "NULL::text"

      sql = """
      SELECT conversation_id::text, message_id::text, device_id, (EXTRACT(EPOCH FROM acked_at)*1000)::bigint::text, #{per}
        FROM chat_msg_device_dlv
       WHERE conversation_id = ANY($1::bigint[]) AND msg_at > now() - interval '31 days' AND device_id <> '?'
         AND (acked_at IS NOT NULL#{if s[:dlv_pcol], do: " OR persisted_at IS NOT NULL", else: ""})
       LIMIT 100000
      """

      case Conn.query(:replica, sql, ["{" <> Enum.map_join(cids, ",", &Integer.to_string/1) <> "}"], 15_000) do
        {:ok, %{rows: rows}} ->
          acks =
            for [c, m, d, a, p] <- rows do
              {d, String.to_integer(c), String.to_integer(m), a && String.to_integer(a), p && String.to_integer(p)}
            end

          apply_acks(acks)
          %{s | ack_rows: length(rows), ack_err: nil}

        {:error, e} ->
          Metrics.inc(:rt_body_ack_poll_fail)
          %{s | ack_err: inspect(e) |> String.slice(0, 200)}
      end
    end
  end

  # A5 automática: aparelho revogado com pendência aqui + aparelho novo do mesmo uid nascido ±24 h da revogação
  defp auto_inherit do
    cids = Enum.filter(BodyHome.enabled_cids(), &BodyHome.acting?/1)
    devs_with_pend = for c <- cids, {_s, {_t, _h, devs, _k}} <- aux(c), is_list(devs), d <- devs, into: MapSet.new(), do: d

    uids =
      cids
      |> Enum.flat_map(fn c -> case Directory.members_result(c), do: ({:ok, l} -> l; _ -> []) end)
      |> Enum.uniq()
      |> Enum.flat_map(fn u -> case Integer.parse(to_string(u)), do: ({i, ""} -> [i]; _ -> []) end)

    if uids != [] do
      sql = """
      SELECT uid::text, device_id, (EXTRACT(EPOCH FROM created_at)*1000)::bigint::text,
             (EXTRACT(EPOCH FROM revoked_at)*1000)::bigint::text
        FROM e2ee5_devices WHERE uid = ANY($1::bigint[]) AND (revoked_at IS NULL OR revoked_at > now() - interval '30 days')
      """

      case Conn.query(:replica, sql, ["{" <> Enum.map_join(uids, ",", &Integer.to_string/1) <> "}"], 5_000) do
        {:ok, %{rows: rows}} ->
          for {_uid, ds} <- Enum.group_by(rows, &hd/1),
              [u, old, _c0, rv] <- ds,
              rv != nil,
              MapSet.member?(devs_with_pend, old),
              [_, new, c1, nil] <- ds,
              new != old,
              abs(String.to_integer(c1) - String.to_integer(rv)) <= 86_400_000,
              :ets.lookup(@inherit, {u, old, new}) == [] do
            inherit(u, old, new, :auto)
          end

        _ ->
          :ok
      end
    end

    :ok
  end

  @doc "Linhas Prometheus (Metrics.gauges)."
  def prom_lines do
    b = fn x -> if x, do: 1, else: 0 end
    en = BodyHome.enabled_cids()

    [
      "chatyy_router_rt_store_enabled #{b.(ChatyyRouter.Flags.get(:store) == true)}\n",
      "chatyy_router_rt_body_entries #{Store.size(:rt_body)}\n",
      "chatyy_router_rt_body_enabled_cids #{length(en)}\n",
      "chatyy_router_rt_body_acting_cids #{Enum.count(en, &BodyHome.acting?/1)}\n",
      "chatyy_router_rt_body_inherits #{if :ets.whereis(@inherit) == :undefined, do: 0, else: :ets.info(@inherit, :size)}\n"
    ]
  end
end
