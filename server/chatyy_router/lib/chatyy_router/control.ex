defmodule ChatyyRouter.Control do
  @moduledoc """
  HTTP de controle SÓ em 127.0.0.1 (ROUTER_CTL_PORT, padrão 4790). É também
  a interface prevista para o leaf Go / PHP falarem com o nó local.

    GET  /health                 -> {"ok":true,"region","alive":[...],"route":bool}
    GET  /status                 -> tabela de casa, filas, failover, contadores
    GET  /metrics                -> Prometheus
    POST /flags?route=0|1&fanout=0|1 -> kill switch em memória (arquivo vale após restart)
    POST /fanout  {"cid","msg_id","home":"us","from","device","cmi","ts","body_b64","devices":[[d,r]]?}  (R1)
    POST /send    {"cid","from","device","cmi","body_b64","devices":[[d,r]]?}
    POST /ack     {"device","cid","upto"}
    GET  /fetch?device=D
    POST /members {"cid","uids":[...]}      POST /devices {"uid","devices":[[d,r]]}
    POST /assign  {"cid","region"}          POST /migrate {"cid","to"}
    POST /bench?n=&conc=&convs=&home=&target=&bytes=
    POST /partition?regions=a,b  /heal?regions=a,b   (isolar região: só p/ ensaio)
  [sgu F1] corpo durável (ChatyyRouter.BodyStore; inerte com RT_STORE=0):
    POST /store   {"cid","mid","env_b64"(= bytes exatos de chat_messages.content),"from","device","ts","type",
                   "kind":"msg"|"reaction","ref"(mid alvo da reação),"devices":[d]?,"meta"?}
                  -> 200 {"ok":true,"copies":3,"wanted":3,"dup"?,"conflict"?} | 503 {"ok":false,"error"}
    GET  /pull?device=D[&cid=C][&since=MID][&limit=N] -> {"messages":[...],"reactions":[...]} (pendentes do aparelho)
    POST /ack_store {"device","cid","mids":[...],"persisted":1}
    POST /inherit {"uid","from","to"}            (A5: aparelho novo herda as pendências do antigo)
    GET  /f1/report  (comparador roteador × PG deste nó)   GET /f1/status   POST /f1/repair
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, HomeTable, Net, Router, Store}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(_) do
    port = Config.ctl_port()

    {:ok, ls} =
      :gen_tcp.listen(port, [:binary, {:ip, {127, 0, 0, 1}}, {:packet, :http_bin}, {:active, false}, {:reuseaddr, true}, {:backlog, 256}])

    Logger.info("router: controle em 127.0.0.1:#{port}")
    me = self()
    spawn_link(fn -> accept(ls, me) end)
    {:ok, ls}
  end

  defp accept(ls, owner) do
    case :gen_tcp.accept(ls) do
      {:ok, sock} ->
        pid = spawn(fn -> receive(do: (:go -> serve(sock))) end)
        :gen_tcp.controlling_process(sock, pid)
        send(pid, :go)
        accept(ls, owner)

      {:error, :closed} ->
        :ok
    end
  end

  defp serve(sock) do
    with {:ok, {:http_request, method, {:abs_path, full}, _}} <- :gen_tcp.recv(sock, 0, 10_000),
         {:ok, headers} <- headers(sock, %{}) do
      len = String.to_integer(Map.get(headers, "content-length", "0"))
      :inet.setopts(sock, packet: :raw)
      body = if len > 0, do: elem(:gen_tcp.recv(sock, len, 30_000), 1), else: ""
      [path | q] = String.split(full, "?", parts: 2)
      qs = URI.decode_query(List.first(q) || "")

      {code, ctype, resp} =
        try do
          route(method, path, qs, body)
        rescue
          e -> {500, "application/json", json(%{error: Exception.message(e)})}
        end

      :gen_tcp.send(sock, [
        "HTTP/1.1 #{code} OK\r\ncontent-type: #{ctype}\r\ncontent-length: #{IO.iodata_length(resp)}\r\nconnection: close\r\n\r\n",
        resp
      ])
    end

    :gen_tcp.close(sock)
  end

  defp headers(sock, acc) do
    case :gen_tcp.recv(sock, 0, 10_000) do
      {:ok, {:http_header, _, k, _, v}} -> headers(sock, Map.put(acc, String.downcase(to_string(k)), v))
      {:ok, :http_eoh} -> {:ok, acc}
      other -> other
    end
  end

  defp json(t), do: :json.encode(jsonable(t))

  defp jsonable(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string_key(k), jsonable(v)} end)
  defp jsonable(l) when is_list(l), do: Enum.map(l, &jsonable/1)
  defp jsonable(t) when is_tuple(t), do: t |> Tuple.to_list() |> jsonable()
  defp jsonable(p) when is_pid(p) or is_reference(p), do: inspect(p)
  defp jsonable(a) when is_atom(a) and a not in [true, false, nil], do: Atom.to_string(a)
  defp jsonable(nil), do: :null
  defp jsonable(v), do: v

  defp to_string_key(k) when is_binary(k), do: k
  defp to_string_key(k) when is_atom(k), do: Atom.to_string(k)
  defp to_string_key(k), do: inspect(k)

  defp ok(t), do: {200, "application/json", json(t)}
  defp body(b), do: if(b == "", do: %{}, else: :json.decode(b))

  defp route(:GET, "/health", _, _) do
    alive = Net.alive_regions()

    ok(%{
      ok: true,
      region: Net.me(),
      node: node(),
      alive: alive,
      down: Config.region_names() -- alive,
      quorum: Net.quorum?(),
      route: ChatyyRouter.Flags.route?(),
      fanout: ChatyyRouter.Flags.fanout?(),
      hub: inspect(ChatyyRouter.Hub.impl())
    })
  end

  defp route(:GET, "/metrics", _, _), do: {200, "text/plain; version=0.0.4", ChatyyRouter.Metrics.prometheus()}

  defp route(:GET, "/status", _, _) do
    ok(%{
      region: Net.me(),
      alive: Net.alive_regions(),
      blocked: MapSet.to_list(Net.blocked()),
      failed: MapSet.to_list(HomeTable.failed()),
      home_entries: length(HomeTable.entries()),
      convs_running: DynamicSupervisor.count_children(ChatyyRouter.ConvSup).active,
      tables: Map.new(Store.tables(), &{&1, Store.size(&1)}),
      ack_outbox: ChatyyRouter.AckOutbox.pending(),
      route: ChatyyRouter.Flags.route?(),
      fanout: ChatyyRouter.Flags.fanout?(),
      ack_mode: Config.ack_mode(),
      quorum: Config.quorum(),
      rtt_ms: for({r, {us, _}} <- ChatyyRouter.Net.Cluster.rtts(), into: %{}, do: {r, Float.round(us / 1000, 1)}),
      log: Map.new(Store.log_tables(), &{&1, ChatyyRouter.Seglog.stats(&1)}),
      fanout_pending: ChatyyRouter.Fanout.pending(),
      home_sync: if(Process.whereis(ChatyyRouter.HomeSync), do: ChatyyRouter.HomeSync.status()),
      ack_source: if(Process.whereis(ChatyyRouter.AckSource), do: ChatyyRouter.AckSource.status()),
      hub: inspect(ChatyyRouter.Config.hub_module()),
      counters: for({{:c, n}, v} <- ChatyyRouter.Metrics.snapshot(), into: %{}, do: {inspect(n), v}),
      memory_mb: div(:erlang.memory(:total), 1_048_576)
    })
  end

  defp route(:POST, "/flags", q, _) do
    for {k, key} <- [{"route", :route}, {"fanout", :fanout}], v = q[k], v != nil do
      ChatyyRouter.Flags.override(key, v == "1")
    end

    ok(%{route: ChatyyRouter.Flags.route?(), fanout: ChatyyRouter.Flags.fanout?()})
  end

  # R1: mensagem já gravada no US (casa externa); só entrega + fila por aparelho
  defp route(:POST, "/fanout", _, b) do
    p = body(b)

    req = %{
      cid: p["cid"],
      seq: p["msg_id"] || p["seq"],
      epoch: p["epoch"] || 0,
      home: p["home"] || "us",
      from: p["from"],
      from_device: p["device"],
      cmi: p["cmi"],
      ts: p["ts"],
      body: Base.decode64!(p["body_b64"] || ""),
      # frame WS pronto (montado pelo leaf de origem, sem conv_pts) → /rt/deliver do leaf de destino
      frame: p["frame_b64"] && Base.decode64!(p["frame_b64"]),
      devices: p["devices"] && Enum.map(p["devices"], fn [d, r] -> {d, r} end)
    }

    # [sgu F1] conversa marcada: cópia durável do corpo na casa + 2 irmãs (assíncrona; RT_STORE=1)
    ChatyyRouter.BodyStore.from_fanout(req)

    case ChatyyRouter.Fanout.fanout_async(req) do
      {:ok, r} -> ok(Map.put(r, :ok, true))
      {:error, e} -> {503, "application/json", json(%{ok: false, error: e})}
    end
  end

  defp route(:POST, "/store", _, b) do
    p = body(b)
    env = p["env_b64"] || p["envelope_b64"] || p["body_b64"]

    req = %{
      cid: p["cid"], mid: p["mid"] || p["msg_id"], kind: p["kind"], ref: p["ref"], from: p["from"] || p["from_uid"],
      from_device: p["device"] || p["from_device"], ts: p["ts"], type: p["type"], devices: p["devices"],
      meta: p["meta"], src: :store,
      env: env && Base.decode64!(env)
    }

    case ChatyyRouter.BodyStore.store(req) do
      {:ok, r} -> ok(Map.put(r, :ok, true))
      {:error, e} -> {503, "application/json", json(%{ok: false, error: inspect_err(e)})}
    end
  end

  defp route(:GET, "/pull", %{"device" => d} = q, _) do
    int = fn k -> case Integer.parse(q[k] || "") do {i, ""} -> i; _ -> nil end end
    r = ChatyyRouter.BodyStore.pull(d, cid: int.("cid"), since: int.("since"), limit: int.("limit") || 500)
    j = fn m -> %{cid: m.cid, mid: sub_json(m.mid), kind: m.kind, ref: m.ref, ts: m.ts, from: m.from, type: m.type, sha: m.sha, env_b64: Base.encode64(m.env)} end
    ok(%{messages: Enum.map(r.messages, j), reactions: Enum.map(r.reactions, j)})
  end

  defp route(:POST, "/ack_store", _, b) do
    p = body(b)
    ChatyyRouter.BodyStore.ack(p["device"], p["cid"], p["mids"] || [p["mid"]], p["persisted"] in [1, true, "1"])
    ok(%{ok: true})
  end

  defp route(:POST, "/inherit", _, b) do
    p = body(b)

    case ChatyyRouter.BodyStore.inherit(p["uid"], p["from"], p["to"]) do
      :ok -> ok(%{ok: true})
      {:error, e} -> {400, "application/json", json(%{ok: false, error: e})}
    end
  end

  defp route(:GET, "/f1/report", _, _), do: ok(ChatyyRouter.BodyCompare.report())
  defp route(:GET, "/f1/status", _, _), do: ok(ChatyyRouter.BodyStore.status())
  defp route(:POST, "/f1/repair", _, _), do: ok(ChatyyRouter.BodyStore.repair_now())

  defp route(:POST, "/send", _, b) do
    p = body(b)
    devs = p["devices"] && Enum.map(p["devices"], fn [d, r] -> {d, r} end)
    opts = if devs, do: [devices: devs], else: []
    body = Base.decode64!(p["body_b64"] || "")

    case Router.send_msg(p["cid"], p["from"], p["device"], p["cmi"], body, opts) do
      {:ok, seq, epoch} -> ok(%{ok: true, seq: seq, epoch: epoch})
      {:error, e} -> {503, "application/json", json(%{ok: false, error: e})}
    end
  end

  defp route(:POST, "/ack", _, b) do
    p = body(b)
    Router.ack(p["device"], p["cid"], p["upto"])
    ok(%{ok: true})
  end

  defp route(:GET, "/fetch", %{"device" => d}, _) do
    msgs = for m <- Router.fetch(d), do: %{cid: m.cid, seq: m.seq, epoch: m.epoch, ts: m.ts, body_b64: Base.encode64(m.body || "")}
    ok(%{messages: msgs})
  end

  defp route(:POST, "/members", _, b) do
    p = body(b)
    ChatyyRouter.Directory.put_members(p["cid"], p["uids"])
    ok(%{ok: true})
  end

  defp route(:POST, "/devices", _, b) do
    p = body(b)
    ChatyyRouter.Directory.put_devices(p["uid"], Enum.map(p["devices"], fn [d, r] -> {d, r} end))
    ok(%{ok: true})
  end

  defp route(:POST, "/assign", _, b) do
    p = body(b)
    {_, e, _} = HomeTable.lookup(p["cid"])
    HomeTable.assign(p["cid"], p["region"], e + 1)
    ok(%{ok: true, epoch: e + 1})
  end

  # troca de casa por decisão de operador/produto: CAS no master (conv_home_cas)
  defp route(:POST, "/home_cas", _, b) do
    p = body(b)
    ok(%{result: ChatyyRouter.HomeSync.cas(p["cid"], p["expected"], p["region"])})
  end

  defp route(:POST, "/migrate", _, b) do
    p = body(b)
    ok(%{result: Router.migrate(p["cid"], p["to"])})
  end

  defp route(:POST, "/bench", q, _) do
    int = fn k, d -> String.to_integer(Map.get(q, k, Integer.to_string(d))) end

    ok(
      ChatyyRouter.Bench.run(
        n: int.("n", 10_000),
        conc: int.("conc", 32),
        convs: int.("convs", 64),
        bytes: int.("bytes", 200),
        home: Map.get(q, "home", Net.me()),
        target: Map.get(q, "target", Net.me())
      )
    )
  end

  defp route(:POST, "/partition", %{"regions" => rs}, _) do
    Net.block(String.split(rs, ",", trim: true))
    ok(%{blocked: MapSet.to_list(Net.blocked())})
  end

  defp route(:POST, "/heal", %{"regions" => rs}, _) do
    Net.unblock(String.split(rs, ",", trim: true))
    ok(%{blocked: MapSet.to_list(Net.blocked())})
  end

  defp route(_, _, _, _), do: {404, "application/json", json(%{error: "not_found"})}

  defp sub_json({:rx, m, e}), do: "rx:#{m}:#{e}"
  defp sub_json(m), do: m
  defp inspect_err(e) when is_atom(e), do: e
  defp inspect_err(e), do: inspect(e)
end
