defmodule ChatyyRouter.Hub.Http do
  @moduledoc """
  Adaptador real com o hub Go (contrato em /root/roteador-2026-10-22/r1/HUB-RT.md):

    POST {hub}/rt/deliver   {"device","uid","email","cid","seq","msg_id","epoch","ts","frame_b64","body_b64","push"}
                            -> 200 {"ok":true,"online":bool,"delivered":N,"push":"sent|skipped|none","dup":bool}
    GET  {hub}/rt/presence?device=D -> {"ok":true,"devices":[{"device","online","region","since",...}]}

  `{hub}` = `Config.hub_url()` (padrão http://127.0.0.1:8084; no edge, o leaf = http://127.0.0.1:8086).
  Chave: header X-Rt-Key = conteúdo de ROUTER_HUB_KEY_FILE (padrão /etc/chatyy-router/hub.key),
  a mesma do /etc/chatyy-hub-rt.key do hub. Sem chave o hub responde 503 (falha fechado).

  Nunca derruba nem trava o chamador (`Delivery` chama `push/2` dentro do shard):
    * `push/2` dispara um processo curto (fire-and-forget) e devolve :ok na hora;
    * no máximo `@max_inflight` requisições em voo; acima disso conta `hub_push_dropped`
      (a mensagem continua na inbox do aparelho e sai no próximo fetch/reconexão);
    * timeouts curtos (conexão 1 s, resposta 3 s), qualquer erro vira métrica.

  `region_of/1`: GET /rt/presence com cache ETS de 5 s (online → {:ok, região};
  offline com última região conhecida → {:ok, região}; senão {:error, motivo}).

  Cliente HTTP/1.1 mínimo em :gen_tcp (o app não carrega :inets; zero deps).
  """
  @behaviour ChatyyRouter.Hub
  alias ChatyyRouter.{Config, Telemetry}

  @cache :rt_hub_http_cache
  @inflight :rt_hub_http_inflight
  @owner :rt_hub_http_owner
  @ttl_ms 5_000
  @max_inflight 256
  @connect_ms 1_000
  @recv_ms 3_000

  # ---------------- push ----------------

  @impl true
  def push(device, msg) do
    try do
      ensure_tables()
      push_async(device, msg)
    rescue
      _ -> Telemetry.execute([:chatyy_router, :hub, :push_error], %{count: 1})
    end

    :ok
  end

  defp push_async(device, msg) do
    if :ets.update_counter(@inflight, :n, 1, {:n, 0}) > @max_inflight do
      :ets.update_counter(@inflight, :n, -1)
      Telemetry.execute([:chatyy_router, :hub, :push_dropped], %{count: 1})
    else
      spawn(fn ->
        try do
          do_push(device, msg)
        rescue
          _ -> Telemetry.execute([:chatyy_router, :hub, :push_error], %{count: 1})
        catch
          _, _ -> Telemetry.execute([:chatyy_router, :hub, :push_error], %{count: 1})
        after
          :ets.update_counter(@inflight, :n, -1)
        end
      end)
    end
  end

  @doc false
  def deliver_body(device, msg) do
    meta = Map.get(msg, :meta) || %{}

    %{
      "device" => to_string(device),
      "uid" => Map.get(msg, :uid) || Map.get(meta, :uid),
      "email" => Map.get(msg, :email) || Map.get(meta, :email),
      "cid" => Map.get(msg, :cid),
      "seq" => Map.get(msg, :seq),
      "msg_id" => Map.get(msg, :msg_id) || Map.get(meta, :msg_id) || Map.get(msg, :seq),
      "epoch" => Map.get(msg, :epoch),
      "ts" => Map.get(msg, :ts),
      "frame_b64" => b64(Map.get(msg, :frame) || Map.get(meta, :frame)),
      "body_b64" => b64(Map.get(msg, :body)),
      "push" => Map.get(meta, :push, Config.get(:hub_push, "0") in ["1", true])
    }
    |> Enum.reject(fn {_k, v} -> v == nil end)
    |> Map.new()
  end

  defp b64(nil), do: nil
  defp b64(b) when is_binary(b), do: Base.encode64(b)
  defp b64(_), do: nil

  defp do_push(device, msg) do
    t0 = System.monotonic_time(:microsecond)
    body = :json.encode(deliver_body(device, msg)) |> IO.iodata_to_binary()

    case request("POST", "/rt/deliver", body) do
      {:ok, 200, resp} ->
        ev =
          case decode(resp) do
            %{"dup" => true} -> :push_dup
            %{"online" => true} -> :push_ok
            %{"ok" => true} -> :push_offline
            _ -> :push_error
          end

        Telemetry.execute([:chatyy_router, :hub, ev], %{count: 1, duration_us: System.monotonic_time(:microsecond) - t0})

      {:ok, code, _} ->
        Telemetry.execute([:chatyy_router, :hub, :push_error], %{count: 1}, %{http: code})

      {:error, _} ->
        Telemetry.execute([:chatyy_router, :hub, :push_error], %{count: 1})
    end
  end

  # ---------------- presença ----------------

  @impl true
  def region_of(device) do
    try do
      cached_region(device)
    rescue
      _ -> {:error, :not_ready}
    end
  end

  defp cached_region(device) do
    ensure_tables()
    now = System.monotonic_time(:millisecond)
    d = to_string(device)

    case :ets.lookup(@cache, d) do
      [{_, res, at}] when now - at < @ttl_ms ->
        res

      _ ->
        res = fetch_region(d)
        :ets.insert(@cache, {d, res, now})
        if :ets.info(@cache, :size) > 200_000, do: prune(now)
        res
    end
  end

  # presença é por LEAF (cada leaf só conhece os próprios sockets): online aqui = esta região;
  # senão pergunta aos roteadores das outras regiões (ChatyyRouter.Presence), sem passar pelo US.
  defp fetch_region(d) do
    case local_online(d) do
      true -> {:ok, ChatyyRouter.Net.me()}
      false -> ChatyyRouter.Presence.ask_cluster(d)
      err -> err
    end
  end

  @doc "O aparelho tem socket no leaf DESTE edge? true | false | {:error, _}"
  def local_online(d) do
    case request("GET", "/rt/presence?device=" <> URI.encode_www_form(to_string(d)), "") do
      {:ok, 200, resp} ->
        devs = Map.get(decode(resp) || %{}, "devices", [])
        Enum.any?(devs, &(&1["online"] == true))

      {:ok, code, _} ->
        Telemetry.execute([:chatyy_router, :hub, :presence_error], %{count: 1}, %{http: code})
        {:error, {:http, code}}

      {:error, e} ->
        Telemetry.execute([:chatyy_router, :hub, :presence_error], %{count: 1})
        {:error, e}
    end
  end

  defp prune(now) do
    :ets.select_delete(@cache, [{{:_, :_, :"$1"}, [{:<, :"$1", now - @ttl_ms}], [true]}])
  end

  # ---------------- HTTP/1.1 mínimo ----------------

  @doc false
  def request(method, path, body) do
    with {:ok, host, port} <- parse_url(Config.hub_url()),
         {:ok, sock} <- :gen_tcp.connect(String.to_charlist(host), port, [:binary, active: false, packet: :raw, nodelay: true], @connect_ms) do
      try do
        req = [
          method, " ", path, " HTTP/1.1\r\nHost: ", host, "\r\nConnection: close\r\n",
          "Content-Type: application/json\r\nX-Rt-Key: ", key(), "\r\n",
          "Content-Length: ", Integer.to_string(byte_size(body)), "\r\n\r\n", body
        ]

        :ok = :gen_tcp.send(sock, req)
        read_response(sock, "", System.monotonic_time(:millisecond) + @recv_ms)
      after
        :gen_tcp.close(sock)
      end
    else
      {:error, _} = e -> e
      other -> {:error, other}
    end
  end

  defp read_response(sock, acc, deadline) do
    left = deadline - System.monotonic_time(:millisecond)

    if left <= 0 do
      {:error, :timeout}
    else
      case :gen_tcp.recv(sock, 0, left) do
        {:ok, data} ->
          acc = acc <> data

          case parse_response(acc) do
            {:ok, _, _} = ok -> ok
            :more -> read_response(sock, acc, deadline)
          end

        {:error, :closed} ->
          case parse_response(acc, true) do
            {:ok, _, _} = ok -> ok
            :more -> {:error, :closed}
          end

        {:error, e} ->
          {:error, e}
      end
    end
  end

  defp parse_response(buf, closed \\ false) do
    case :binary.split(buf, "\r\n\r\n") do
      [head, rest] ->
        [status | hdrs] = String.split(head, "\r\n")
        code = status |> String.split(" ") |> Enum.at(1, "0") |> Integer.parse() |> elem(0)

        len =
          Enum.find_value(hdrs, fn h ->
            case String.split(h, ":", parts: 2) do
              [k, v] -> if String.downcase(k) == "content-length", do: v |> String.trim() |> String.to_integer()
              _ -> nil
            end
          end)

        cond do
          len != nil and byte_size(rest) >= len -> {:ok, code, binary_part(rest, 0, len)}
          len == nil and closed -> {:ok, code, rest}
          true -> :more
        end

      _ ->
        :more
    end
  end

  defp parse_url(url) do
    case URI.parse(url) do
      %URI{scheme: "http", host: h, port: p} when is_binary(h) -> {:ok, h, p || 80}
      _ -> {:error, :bad_hub_url}
    end
  end

  defp key do
    case :persistent_term.get({__MODULE__, :key}, nil) do
      {k, at} ->
        if System.monotonic_time(:millisecond) - at < 15_000, do: k, else: load_key()

      nil ->
        load_key()
    end
  end

  defp load_key do
    k =
      case File.read(Config.get(:hub_key_file, "/etc/chatyy-router/hub.key")) do
        {:ok, b} -> String.trim(b)
        _ -> ""
      end

    :persistent_term.put({__MODULE__, :key}, {k, System.monotonic_time(:millisecond)})
    k
  end

  defp decode(b) do
    try do
      :json.decode(b)
    rescue
      _ -> nil
    end
  end

  # ETS com dono próprio (processo de vida longa registrado), criado na 1ª chamada:
  # assim o cache sobrevive ao processo que chamou e não precisa mexer na árvore de supervisão.
  defp ensure_tables do
    if :ets.whereis(@cache) == :undefined do
      parent = self()

      spawn(fn ->
        try do
          Process.register(self(), @owner)
          :ets.new(@cache, [:named_table, :public, :set, read_concurrency: true, write_concurrency: true])
          :ets.new(@inflight, [:named_table, :public, :set, write_concurrency: true])
          send(parent, {@owner, :ready})
          Process.sleep(:infinity)
        rescue
          _ -> send(parent, {@owner, :ready})
        end
      end)

      receive do
        {@owner, :ready} -> :ok
      after
        1_000 -> :ok
      end
    end

    :ok
  end
end
