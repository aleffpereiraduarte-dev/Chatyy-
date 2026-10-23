defmodule ChatyyRouter.Directory do
  @moduledoc """
  Quem recebe: membros por conversa e aparelhos por usuário (com a região do
  edge onde o aparelho está).

  Dois modos (ROUTER_DIR_SOURCE):
    * `local` (padrão; testes/bench): ETS difundido entre os nós (`put_members/2`,
      `put_devices/2`), como no protótipo.
    * `pg`: lê a RÉPLICA LOCAL do PG (`ChatyyRouter.PG.Conn` :replica), com cache ETS:
        - membros  = `chat_conversation_members` com `left_at` vazio, email
          canonizado (minúsculas, @onemundo.com.br -> @chatyy.com.br — igual ao
          `_dlvCanon` do dlv-shadow.php) -> `e2ee5_uid.uid`; TTL ROUTER_DIR_TTL_MS (30 s);
        - aparelhos = `e2ee5_devices` não revogados (vistos < ROUTER_DEVICE_MAX_AGE_DAYS,
          padrão 30) ∪ `e2ee5_bearer_device` sem registro e2ee5 (cliente antigo) —
          o mesmo conjunto que a fila sombra dlv considera "esperado"; TTL igual e
          invalidação por `e2ee5_device_changes` (poll 2 s, id > marca d'água);
        - região do aparelho = `ChatyyRouter.Hub.region_of/1` (presença do hub),
          cache ROUTER_PRESENCE_TTL_MS (5 s); sem presença -> última região conhecida
          -> região deste nó.
      Falha do PG: devolve a cópia vencida do cache se houver; sem cópia,
      `recipients_result/2` dá {:error, :directory_unavailable} (o chamador NÃO
      deve tratar como "sem destinatários" e apagar a mensagem).
    Entradas postas à mão (`put_members/2`, `put_devices/2`) valem nos dois modos
    e têm precedência (ensaios).
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, Net}
  alias ChatyyRouter.PG.Conn

  @members :rt_members
  @devices :rt_devices
  @mcache :rt_dir_members
  @dcache :rt_dir_devices
  @rcache :rt_dir_region
  @uemail :rt_dir_uid_email
  @devuid :rt_dir_dev_uid

  @doc "E-mail (canônico) do dono do aparelho, se o diretório já o viu."
  def email_of_device(d) do
    with [{_, u}] <- safe_lookup(@devuid, to_string(d)), [{_, e}] <- safe_lookup(@uemail, u) do
      e
    else
      _ -> nil
    end
  end

  defp safe_lookup(t, k), do: if(:ets.whereis(t) == :undefined, do: [], else: :ets.lookup(t, k))

  @q_members """
  SELECT DISTINCT u.uid::text, u.email_canon
    FROM chat_conversation_members cm
    JOIN e2ee5_uid u
      ON u.email_canon = regexp_replace(lower(btrim(cm.email)), '@onemundo\\.com\\.br$', '@chatyy.com.br')
   WHERE cm.conversation_id = $1::bigint AND NULLIF(cm.left_at, '') IS NULL
  """

  @q_devices """
  SELECT x.device_id FROM e2ee5_devices x
   WHERE x.uid = $1::bigint AND x.revoked_at IS NULL
     AND x.last_seen_at > now() - make_interval(days => $2::int)
  UNION
  SELECT b.device_id FROM e2ee5_bearer_device b
   WHERE b.uid = $1::bigint
     AND NOT EXISTS (SELECT 1 FROM e2ee5_devices y WHERE y.uid = b.uid AND y.device_id = b.device_id)
  """

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def pg?, do: to_string(Config.get(:dir_source, "local")) == "pg"
  defp ttl, do: int_cfg(:dir_ttl_ms, 30_000)
  defp presence_ttl, do: int_cfg(:presence_ttl_ms, 5_000)
  defp max_age_days, do: int_cfg(:device_max_age_days, 30)

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  # ---------------- leitura ----------------

  def members(cid) do
    case members_result(cid) do
      {:ok, uids} -> uids
      _ -> []
    end
  end

  def members_result(cid) do
    case :ets.lookup(@members, cid) do
      [{_, uids}] -> {:ok, uids}
      [] -> if pg?(), do: cached(@mcache, cid, fn -> pg_members(cid) end), else: {:ok, []}
    end
  end

  @doc "Aparelhos do usuário: [{device, região}]."
  def devices(uid) do
    case devices_result(uid) do
      {:ok, devs} -> devs
      _ -> []
    end
  end

  def devices_result(uid) do
    case :ets.lookup(@devices, uid) do
      [{_, devs}] ->
        {:ok, devs}

      [] ->
        if pg?() do
          with {:ok, ids} <- cached(@dcache, uid, fn -> pg_devices(uid) end) do
            {:ok, for(d <- ids, do: {d, region(d)})}
          end
        else
          {:ok, []}
        end
    end
  end

  @doc "Aparelhos destino ({device, região}), inclusive os OUTROS aparelhos do remetente."
  def recipients(cid, sender_device) do
    case recipients_result(cid, sender_device) do
      {:ok, l} -> l
      _ -> []
    end
  end

  def recipients_result(cid, sender_device) do
    with {:ok, uids} <- members_result(cid) do
      Enum.reduce_while(uids, {:ok, []}, fn uid, {:ok, acc} ->
        case devices_result(uid) do
          {:ok, devs} -> {:cont, {:ok, acc ++ for({d, r} <- devs, d != sender_device, do: {d, r})}}
          err -> {:halt, err}
        end
      end)
    end
  end

  @doc """
  [sgu F1] Só os ids dos aparelhos destino (destinatários + OUTROS aparelhos do remetente), SEM
  perguntar a região/presença de ninguém (o armazenamento durável da casa não depende de onde o
  aparelho está). Mesmo conjunto que `recipients_result/2`. {:ok, [device]} | {:error, _}.
  """
  def recipient_ids_result(cid, sender_device) do
    with {:ok, uids} <- members_result(cid) do
      Enum.reduce_while(uids, {:ok, []}, fn uid, {:ok, acc} ->
        case device_ids_result(uid) do
          {:ok, ids} -> {:cont, {:ok, acc ++ for(d <- ids, d != sender_device, do: d)}}
          err -> {:halt, err}
        end
      end)
    end
    |> case do
      {:ok, l} -> {:ok, Enum.uniq(l)}
      err -> err
    end
  end

  defp device_ids_result(uid) do
    case :ets.lookup(@devices, uid) do
      [{_, devs}] -> {:ok, for({d, _} <- devs, do: d)}
      [] -> if pg?(), do: cached(@dcache, uid, fn -> pg_devices(uid) end), else: {:ok, []}
    end
  end

  @doc "Região atual do aparelho (presença do hub, com cache curto e fallback)."
  def region(device), do: elem(region_info(device), 0)

  @doc """
  {região, origem}: origem `:live` (presença agora), `:last` (última região REAL vista) ou
  `:fallback` (nunca visto online: região deste nó). Correção 22/10: o fallback não vira
  "última região conhecida" (antes, 1 consulta offline grudava o aparelho no nó do remetente).
  """
  def region_info(device) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@rcache, device) do
      [{_, r, exp, src}] when exp > now ->
        {r, src}

      cached ->
        live =
          case safe_region_of(device) do
            {:ok, r} when is_binary(r) -> if r in Config.region_names(), do: r, else: nil
            _ -> nil
          end

        last =
          case cached do
            [{_, r, _, src}] when src != :fallback and is_binary(r) -> r
            _ -> nil
          end

        {r, src} =
          cond do
            live -> {live, :live}
            last -> {last, :last}
            true -> {Net.me(), :fallback}
          end

        :ets.insert(@rcache, {device, r, now + presence_ttl(), src})
        {r, src}
    end
  end

  @doc "true se a região do aparelho no cache é só o fallback (sem presença em lugar nenhum)."
  def fallback?(device) do
    case safe_lookup(@rcache, device) do
      [{_, _, _, :fallback}] -> true
      _ -> false
    end
  end

  defp safe_region_of(device) do
    try do
      ChatyyRouter.Hub.region_of(device)
    rescue
      _ -> {:error, :hub}
    catch
      _, _ -> {:error, :hub}
    end
  end

  def invalidate_conv(cid), do: :ets.delete(@mcache, cid)
  def invalidate_user(uid), do: :ets.delete(@dcache, uid)

  # cache com TTL; falha do PG -> cópia vencida, se houver
  defp cached(tab, key, fun) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(tab, key) do
      [{_, v, exp}] when exp > now ->
        {:ok, v}

      old ->
        case fun.() do
          {:ok, v} ->
            :ets.insert(tab, {key, v, now + ttl()})
            {:ok, v}

          {:error, e} ->
            ChatyyRouter.Metrics.inc(:dir_pg_fail)

            case old do
              [{_, v, _}] -> {:ok, v}
              _ -> {:error, {:directory_unavailable, e}}
            end
        end
    end
  end

  defp to_bigint(v) when is_integer(v), do: {:ok, v}

  defp to_bigint(v) when is_binary(v) do
    case Integer.parse(v) do
      {i, ""} -> {:ok, i}
      _ -> :error
    end
  end

  defp to_bigint(_), do: :error

  defp pg_members(cid) do
    case to_bigint(cid) do
      {:ok, i} ->
        with {:ok, %{rows: rows}} <- Conn.query(:replica, @q_members, [i]) do
          # uid → e-mail: o leaf entrega por e-mail ao socket de app que não manda e2ee5_device no auth
          for [u, e | _] <- rows, e != nil, do: :ets.insert(@uemail, {u, e})
          {:ok, Enum.map(rows, &hd/1)}
        end

      :error ->
        {:ok, []}
    end
  end

  defp pg_devices(uid) do
    case to_bigint(uid) do
      {:ok, i} ->
        with {:ok, %{rows: rows}} <- Conn.query(:replica, @q_devices, [i, max_age_days()]) do
          ids = Enum.map(rows, &hd/1)
          for d <- ids, do: :ets.insert(@devuid, {d, to_string(uid)})
          {:ok, ids}
        end

      :error ->
        {:ok, []}
    end
  end

  # ---------------- escrita (ensaio / modo local) ----------------

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

  # ---------------- GenServer ----------------

  @impl true
  def init(_) do
    for t <- [@members, @devices, @mcache, @dcache, @rcache, @uemail, @devuid], :ets.whereis(t) == :undefined do
      :ets.new(t, [:named_table, :public, :set, read_concurrency: true, write_concurrency: true])
    end

    if pg?(), do: send(self(), :devchg)
    {:ok, %{devchg_wm: nil}}
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

  # invalidação incremental dos aparelhos por e2ee5_device_changes (id crescente)
  @impl true
  def handle_info(:devchg, s) do
    s =
      case s.devchg_wm do
        nil ->
          case Conn.query(:replica, "SELECT coalesce(max(id), 0)::text FROM e2ee5_device_changes") do
            {:ok, %{rows: [[m]]}} -> %{s | devchg_wm: String.to_integer(m)}
            _ -> s
          end

        wm ->
          case Conn.query(
                 :replica,
                 "SELECT id::text, uid::text FROM e2ee5_device_changes WHERE id > $1::bigint ORDER BY id LIMIT 2000",
                 [wm]
               ) do
            {:ok, %{rows: rows}} ->
              for [_, uid] <- rows, do: :ets.delete(@dcache, uid)
              if rows != [], do: ChatyyRouter.Metrics.inc(:dir_dev_invalidated, length(rows))
              last = Enum.reduce(rows, wm, fn [id, _], acc -> max(acc, String.to_integer(id)) end)
              %{s | devchg_wm: last}

            _ ->
              s
          end
      end

    Process.send_after(self(), :devchg, 2_000)
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

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

  # RT_HUB=http no arquivo de flags (sem restart) liga o adaptador real; aparelhos
  # sintéticos inscritos no Stub (bench/testes) continuam no Stub.
  def impl do
    if ChatyyRouter.Flags.get(:hub_http), do: ChatyyRouter.Hub.Http, else: ChatyyRouter.Config.hub_module()
  end

  def push(device, msg) do
    if ChatyyRouter.Hub.Stub.subscribed?(device), do: ChatyyRouter.Hub.Stub.push(device, msg), else: impl().push(device, msg)
  end

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
  def subscribed?(device), do: :ets.whereis(@subs) != :undefined and :ets.member(@subs, device)
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

# ChatyyRouter.Hub.Http (adaptador real, hub Go /rt/*) → lib/chatyy_router/hub_http.ex
