defmodule ChatyyRouter.PG do
  @moduledoc """
  Cliente MÍNIMO do protocolo PostgreSQL v3 sobre `:gen_tcp` (zero deps Hex).

  Suporta: startup (com GUCs no pacote: application_name, statement_timeout),
  autenticação trust / cleartext / md5 / SCRAM-SHA-256 (sem channel binding;
  o tráfego até o master já vai cifrado pela WG e a réplica é 127.0.0.1),
  protocolo estendido com parâmetros em TEXTO (Parse/Bind/Describe/Execute/Sync,
  statement sem nome) e resultados em texto (`nil` = NULL). Sem TLS, sem COPY,
  sem LISTEN. Conversão de tipos fica com o chamador (`int/1`, `bool/1`).

  Uso funcional (um socket) ou pelo `ChatyyRouter.PG.Conn` (GenServer nomeado,
  conexão preguiçosa, reconecta, 1 consulta por vez).
  """

  @proto 196_608

  defmodule Error do
    defexception [:message, :fields]
  end

  @type conn :: %{sock: port(), params: map()}

  @doc """
  opts: host (string), port, database, user, password | password_file,
  connect_timeout (ms), statement_timeout (ms), application_name.
  """
  def connect(opts) do
    host = opts |> Keyword.get(:host, "127.0.0.1") |> to_charlist()
    port = Keyword.get(opts, :port, 5432)
    ct = Keyword.get(opts, :connect_timeout, 5_000)

    with {:ok, pw} <- password(opts),
         {:ok, sock} <- :gen_tcp.connect(host, port, [:binary, active: false, nodelay: true, keepalive: true], ct) do
      user = Keyword.fetch!(opts, :user)

      kv =
        [
          {"user", user},
          {"database", Keyword.get(opts, :database, "chatyy")},
          {"application_name", Keyword.get(opts, :application_name, "chatyy-router")},
          {"client_encoding", "UTF8"}
        ] ++
          case Keyword.get(opts, :statement_timeout) do
            nil -> []
            ms -> [{"statement_timeout", Integer.to_string(ms)}]
          end

      body = [<<@proto::32>>, Enum.map(kv, fn {k, v} -> [k, 0, v, 0] end), 0]
      :ok = :gen_tcp.send(sock, [<<IO.iodata_length(body) + 4::32>>, body])

      case auth(sock, user, pw, ct) do
        :ok ->
          case await_ready(sock, %{}, ct) do
            {:ok, params} -> {:ok, %{sock: sock, params: params}}
            err -> close_err(sock, err)
          end

        err ->
          close_err(sock, err)
      end
    end
  end

  defp close_err(sock, err) do
    :gen_tcp.close(sock)
    err
  end

  def close(%{sock: s}), do: :gen_tcp.close(s)

  defp password(opts) do
    cond do
      pw = opts[:password] ->
        {:ok, pw}

      f = opts[:password_file] ->
        case File.read(f) do
          {:ok, b} -> {:ok, String.trim(b)}
          {:error, e} -> {:error, {:password_file, e}}
        end

      true ->
        {:ok, nil}
    end
  end

  # ---------------- autenticação ----------------

  defp auth(sock, user, pw, t) do
    case recv_msg(sock, t) do
      {:ok, ?R, <<0::32>>} ->
        :ok

      {:ok, ?R, <<3::32>>} ->
        send_msg(sock, ?p, [pw || "", 0])
        auth(sock, user, pw, t)

      {:ok, ?R, <<5::32, salt::binary-4>>} ->
        inner = md5hex([pw || "", user])
        send_msg(sock, ?p, ["md5", md5hex([inner, salt]), 0])
        auth(sock, user, pw, t)

      {:ok, ?R, <<10::32, mechs::binary>>} ->
        if "SCRAM-SHA-256" in String.split(mechs, <<0>>, trim: true),
          do: scram(sock, pw || "", t),
          else: {:error, {:auth_unsupported, mechs}}

      {:ok, ?E, b} ->
        {:error, pg_error(b)}

      {:ok, ?R, <<code::32, _::binary>>} ->
        {:error, {:auth_unsupported, code}}

      err ->
        err
    end
  end

  defp scram(sock, pw, t) do
    nonce = Base.encode64(:crypto.strong_rand_bytes(18))
    first_bare = "n=,r=" <> nonce
    first = "n,," <> first_bare
    send_msg(sock, ?p, ["SCRAM-SHA-256", 0, <<byte_size(first)::32>>, first])

    with {:ok, ?R, <<11::32, server_first::binary>>} <- recv_msg(sock, t),
         %{"r" => r, "s" => s, "i" => i} <- scram_attrs(server_first),
         true <- String.starts_with?(r, nonce) || {:error, :scram_nonce} do
      salt = Base.decode64!(s)
      salted = :crypto.pbkdf2_hmac(:sha256, pw, salt, String.to_integer(i), 32)
      client_key = hmac(salted, "Client Key")
      stored = :crypto.hash(:sha256, client_key)
      final_wo = "c=biws,r=" <> r
      auth_msg = Enum.join([first_bare, server_first, final_wo], ",")
      proof = :crypto.exor(client_key, hmac(stored, auth_msg))
      send_msg(sock, ?p, [final_wo, ",p=", Base.encode64(proof)])
      server_sig = hmac(hmac(salted, "Server Key"), auth_msg)

      case recv_msg(sock, t) do
        {:ok, ?R, <<12::32, sfinal::binary>>} ->
          case scram_attrs(sfinal) do
            %{"v" => v} ->
              if Base.decode64!(v) == server_sig, do: auth(sock, nil, nil, t), else: {:error, :scram_server_sig}

            _ ->
              {:error, :scram_final}
          end

        {:ok, ?E, b} ->
          {:error, pg_error(b)}

        other ->
          {:error, {:scram, other}}
      end
    else
      {:ok, ?E, b} -> {:error, pg_error(b)}
      {:error, _} = e -> e
      other -> {:error, {:scram, other}}
    end
  end

  defp scram_attrs(s) do
    s
    |> String.split(",")
    |> Map.new(fn kv ->
      case String.split(kv, "=", parts: 2) do
        [k, v] -> {k, v}
        [k] -> {k, ""}
      end
    end)
  end

  defp hmac(k, d), do: :crypto.mac(:hmac, :sha256, k, d)
  defp md5hex(d), do: Base.encode16(:crypto.hash(:md5, d), case: :lower)

  defp await_ready(sock, params, t) do
    case recv_msg(sock, t) do
      {:ok, ?S, b} ->
        [k, v | _] = String.split(b, <<0>>)
        await_ready(sock, Map.put(params, k, v), t)

      {:ok, ?K, _} ->
        await_ready(sock, params, t)

      {:ok, ?N, _} ->
        await_ready(sock, params, t)

      {:ok, ?Z, _} ->
        {:ok, params}

      {:ok, ?E, b} ->
        {:error, pg_error(b)}

      err ->
        err
    end
  end

  # ---------------- consulta ----------------

  @doc """
  Consulta com parâmetros ($1, $2…) em texto. Retorna
  {:ok, %{columns: [nome], rows: [[texto | nil]], tag: "SELECT 3"}} | {:error, motivo}.
  Parâmetros: binário, inteiro, booleano, float ou nil (NULL).
  """
  def query(%{sock: sock}, sql, params \\ [], timeout \\ 5_000) do
    ps = Enum.map(params, &encode_param/1)

    bind_params =
      Enum.map(ps, fn
        nil -> <<-1::signed-32>>
        v -> [<<byte_size(v)::32>>, v]
      end)

    msgs = [
      msg(?P, [0, sql, 0, <<0::16>>]),
      msg(?B, [0, 0, <<0::16>>, <<length(ps)::16>>, bind_params, <<0::16>>]),
      msg(?D, [?P, 0]),
      msg(?E, [0, <<0::32>>]),
      msg(?S, [])
    ]

    :ok = :gen_tcp.send(sock, msgs)
    collect(sock, timeout, %{columns: [], rows: [], tag: nil, error: nil})
  rescue
    e in MatchError -> {:error, {:send, e.term}}
  end

  defp collect(sock, t, acc) do
    case recv_msg(sock, t) do
      {:ok, ?T, <<n::16, rest::binary>>} -> collect(sock, t, %{acc | columns: columns(rest, n, [])})
      {:ok, ?D, <<n::16, rest::binary>>} -> collect(sock, t, %{acc | rows: [row(rest, n, []) | acc.rows]})
      {:ok, ?C, tag} -> collect(sock, t, %{acc | tag: String.trim_trailing(tag, <<0>>)})
      {:ok, ?E, b} -> collect(sock, t, %{acc | error: pg_error(b)})
      {:ok, ?Z, _} -> if acc.error, do: {:error, acc.error}, else: {:ok, %{acc | rows: Enum.reverse(acc.rows)} |> Map.delete(:error)}
      {:ok, c, _} when c in [?1, ?2, ?n, ?N, ?S, ?s, ?I, ?t] -> collect(sock, t, acc)
      {:ok, c, _} -> collect(sock, t, %{acc | error: acc.error || {:unexpected, c}})
      err -> err
    end
  end

  defp columns(_, 0, acc), do: Enum.reverse(acc)

  defp columns(b, n, acc) do
    [name, rest] = :binary.split(b, <<0>>)
    <<_tbl::32, _col::16, _typ::32, _sz::16, _mod::32, _fmt::16, rest::binary>> = rest
    columns(rest, n - 1, [name | acc])
  end

  defp row(_, 0, acc), do: Enum.reverse(acc)
  defp row(<<-1::signed-32, rest::binary>>, n, acc), do: row(rest, n - 1, [nil | acc])
  defp row(<<len::32, v::binary-size(len), rest::binary>>, n, acc), do: row(rest, n - 1, [v | acc])

  defp encode_param(nil), do: nil
  defp encode_param(true), do: "t"
  defp encode_param(false), do: "f"
  defp encode_param(v) when is_integer(v), do: Integer.to_string(v)
  defp encode_param(v) when is_float(v), do: Float.to_string(v)
  defp encode_param(v) when is_binary(v), do: v
  defp encode_param(v) when is_atom(v), do: Atom.to_string(v)

  # ---------------- fio ----------------

  defp msg(type, body) do
    [type, <<IO.iodata_length(body) + 4::32>>, body]
  end

  defp send_msg(sock, type, body), do: :gen_tcp.send(sock, msg(type, body))

  defp recv_msg(sock, t) do
    with {:ok, <<type, len::32>>} <- :gen_tcp.recv(sock, 5, t),
         {:ok, body} <- recv_body(sock, len - 4, t) do
      {:ok, type, body}
    else
      {:error, e} -> {:error, {:io, e}}
    end
  end

  defp recv_body(_sock, 0, _t), do: {:ok, ""}
  defp recv_body(sock, n, t), do: :gen_tcp.recv(sock, n, t)

  defp pg_error(b) do
    f =
      b
      |> :binary.split(<<0>>, [:global, :trim_all])
      |> Map.new(fn <<code, v::binary>> -> {<<code>>, v} end)

    %Error{message: "#{f["S"]} #{f["C"]}: #{f["M"]}", fields: f}
  end

  # ---------------- conversões ----------------

  def int(nil), do: nil
  def int(s), do: String.to_integer(s)
  def bool(v) when v in ["t", "true"], do: true
  def bool(_), do: false
end

defmodule ChatyyRouter.PG.Conn do
  @moduledoc """
  Conexão nomeada (uma por papel: `:rt_pg_replica`, `:rt_pg_master`), preguiçosa,
  com reconexão e recuo exponencial (máx. 30 s). Uma consulta por vez — o
  roteador faz poucas consultas (poll de casa/acks e cache-miss do diretório).

  Config (env ROUTER_*; prefixo = `pg` p/ réplica, `pg_master` p/ master):
    ROUTER_PG_HOST (127.0.0.1)  ROUTER_PG_PORT (55432)  ROUTER_PG_USER (chatyy_router_ro)
    ROUTER_PG_PASS_FILE (/etc/chatyy-router/pg-ro.pass)  ROUTER_PG_DB (chatyy)
    ROUTER_PG_MASTER_HOST (10.8.0.1)  ROUTER_PG_MASTER_PORT (5432)
    ROUTER_PG_MASTER_USER (chatyy_router_cas)  ROUTER_PG_MASTER_PASS_FILE (/etc/chatyy-router/pg-cas.pass)
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, PG}

  def child_spec(role) do
    %{id: {__MODULE__, role}, start: {__MODULE__, :start_link, [role]}}
  end

  def start_link(role), do: GenServer.start_link(__MODULE__, role, name: name(role))
  def name(:replica), do: :rt_pg_replica
  def name(:master), do: :rt_pg_master

  @doc "Consulta pelo papel (:replica | :master). Nunca levanta exit: {:error, _}."
  def query(role, sql, params \\ [], timeout \\ 5_000) do
    try do
      GenServer.call(name(role), {:q, sql, params, timeout}, timeout + 6_000)
    catch
      :exit, e -> {:error, {:exit, e}}
    end
  end

  def opts(:replica) do
    [
      host: cfg(:pg_host, "127.0.0.1"),
      port: int(cfg(:pg_port, "55432")),
      database: cfg(:pg_db, "chatyy"),
      user: cfg(:pg_user, "chatyy_router_ro"),
      password_file: cfg(:pg_pass_file, "/etc/chatyy-router/pg-ro.pass"),
      statement_timeout: 5_000,
      application_name: "chatyy-router-#{Config.region()}"
    ]
  end

  def opts(:master) do
    [
      host: cfg(:pg_master_host, "10.8.0.1"),
      port: int(cfg(:pg_master_port, "5432")),
      database: cfg(:pg_db, "chatyy"),
      user: cfg(:pg_master_user, "chatyy_router_cas"),
      password_file: cfg(:pg_master_pass_file, "/etc/chatyy-router/pg-cas.pass"),
      statement_timeout: 5_000,
      connect_timeout: 8_000,
      application_name: "chatyy-router-#{Config.region()}"
    ]
  end

  defp cfg(k, d), do: to_string(Config.get(k, d))
  defp int(v) when is_integer(v), do: v
  defp int(v), do: String.to_integer(v)

  @impl true
  def init(role), do: {:ok, %{role: role, conn: nil, backoff: 0, retry_at: nil}}

  @impl true
  def handle_call({:q, sql, params, t}, _from, s) do
    case ensure(s) do
      {:ok, s} ->
        case PG.query(s.conn, sql, params, t) do
          {:ok, _} = ok ->
            {:reply, ok, s}

          {:error, %PG.Error{}} = e ->
            # erro SQL: a conexão continua boa
            ChatyyRouter.Metrics.inc({:pg_error, s.role})
            {:reply, e, s}

          {:error, _} = e ->
            PG.close(s.conn)
            ChatyyRouter.Metrics.inc({:pg_io_error, s.role})
            {:reply, e, fail(%{s | conn: nil})}
        end

      {:error, e, s} ->
        {:reply, {:error, e}, s}
    end
  end

  defp ensure(%{conn: c} = s) when c != nil, do: {:ok, s}

  defp ensure(s) do
    now = System.monotonic_time(:millisecond)

    # (monotonic_time pode ser negativo: nil = sem recuo)
    if s.retry_at != nil and now < s.retry_at do
      {:error, :backoff, s}
    else
      case PG.connect(opts(s.role)) do
        {:ok, c} ->
          {:ok, %{s | conn: c, backoff: 0, retry_at: nil}}

        {:error, e} ->
          Logger.warning("router: pg #{s.role} conexão falhou: #{inspect(e) |> String.slice(0, 200)}")
          ChatyyRouter.Metrics.inc({:pg_connect_fail, s.role})
          {:error, e, fail(s)}
      end
    end
  end

  defp fail(s) do
    b = min(max(s.backoff * 2, 500), 30_000)
    %{s | backoff: b, retry_at: System.monotonic_time(:millisecond) + b}
  end
end
