defmodule ChatyyRouter.HubHttpTest do
  # Hub Go falso em :gen_tcp (127.0.0.1, porta efêmera): confere o contrato /rt/deliver e /rt/presence
  # do ChatyyRouter.Hub.Http sem precisar do hub de verdade.
  use ExUnit.Case, async: false
  alias ChatyyRouter.Hub.Http

  setup do
    ChatyyRouter.Metrics.init()
    {:ok, ls} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(ls)
    me = self()
    srv = spawn_link(fn -> loop(ls, me) end)
    dir = System.tmp_dir!() |> Path.join("rt-hubhttp-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    kf = Path.join(dir, "hub.key")
    File.write!(kf, "k0123456789abcdef0123456789abcdef\n")
    Application.put_env(:chatyy_router, :hub_url, "http://127.0.0.1:#{port}")
    Application.put_env(:chatyy_router, :hub_key_file, kf)
    :persistent_term.erase({Http, :key})
    Process.flag(:trap_exit, true)

    on_exit(fn ->
      Process.exit(srv, :kill)
      Application.delete_env(:chatyy_router, :hub_url)
      Application.delete_env(:chatyy_router, :hub_key_file)
      File.rm_rf!(dir)
    end)

    :ok
  end

  defp loop(ls, owner) do
    {:ok, s} = :gen_tcp.accept(ls)
    {:ok, req} = recv_all(s, "")
    send(owner, {:req, req})
    [head, body] = :binary.split(req, "\r\n\r\n")

    resp =
      cond do
        not String.contains?(head, "X-Rt-Key: k0123456789abcdef0123456789abcdef") -> {401, ~s({"ok":false})}
        String.starts_with?(head, "POST /rt/deliver") -> {200, ~s({"ok":true,"online":true,"delivered":1,"push":"none","echo":#{body}})}
        String.starts_with?(head, "GET /rt/presence?device=PONLINE") -> {200, ~s({"ok":true,"devices":[{"device":"PONLINE","online":true,"region":"mia"}]})}
        String.starts_with?(head, "GET /rt/presence") -> {200, ~s({"ok":true,"devices":[{"device":"X","online":false,"region":""}]})}
        true -> {404, "{}"}
      end

    {code, b} = resp
    :gen_tcp.send(s, "HTTP/1.1 #{code} OK\r\nContent-Type: application/json\r\nContent-Length: #{byte_size(b)}\r\n\r\n" <> b)
    :gen_tcp.close(s)
    loop(ls, owner)
  end

  defp recv_all(s, acc) do
    case :binary.split(acc, "\r\n\r\n") do
      [head, body] ->
        len =
          case Regex.run(~r/Content-Length: (\d+)/i, head) do
            [_, n] -> String.to_integer(n)
            _ -> 0
          end

        if byte_size(body) >= len, do: {:ok, acc}, else: more(s, acc)

      _ ->
        more(s, acc)
    end
  end

  defp more(s, acc) do
    {:ok, d} = :gen_tcp.recv(s, 0, 2_000)
    recv_all(s, acc <> d)
  end

  test "push/2 manda o contrato /rt/deliver e nunca bloqueia" do
    msg = %{cid: 10, seq: 5, epoch: 1, ts: 123, body: <<1, 2, 3>>, meta: %{msg_id: 900, frame: ~s({"type":"chat_message"})}}
    assert :ok = Http.push("PAAAAAAAAAAAA", msg)
    assert_receive {:req, req}, 3_000
    [head, body] = :binary.split(req, "\r\n\r\n")
    assert head =~ "POST /rt/deliver HTTP/1.1"
    j = :json.decode(body)
    assert j["device"] == "PAAAAAAAAAAAA" and j["cid"] == 10 and j["seq"] == 5 and j["msg_id"] == 900
    assert Base.decode64!(j["body_b64"]) == <<1, 2, 3>>
    assert Base.decode64!(j["frame_b64"]) == ~s({"type":"chat_message"})
    assert j["push"] == false
  end

  test "region_of/1 lê a presença e guarda 5 s em cache" do
    assert {:ok, "mia"} = Http.region_of("PONLINE")
    assert_receive {:req, _}, 1_000
    assert {:ok, "mia"} = Http.region_of("PONLINE")
    refute_receive {:req, _}, 200
    assert {:error, :offline} = Http.region_of("POFFLINE")
  end

  test "hub fora do ar: erro vira resultado, sem exceção no chamador" do
    Application.put_env(:chatyy_router, :hub_url, "http://127.0.0.1:1")
    assert :ok = Http.push("PX", %{cid: 1, seq: 1})
    assert {:error, _} = Http.region_of("PNOVO_FORA")
    # o push em voo termina (erro contado) antes de o teste acabar
    Process.sleep(300)
    assert ChatyyRouter.Metrics.counter(:hub_push_error) >= 1
  end
end
