defmodule ChatyyRouter.Presence do
  @moduledoc """
  Onde o aparelho está conectado AGORA, perguntando aos roteadores do cluster
  (cada um consulta o /rt/presence do seu leaf local). Sem US no caminho.
  Cache curto fica no Hub.Http (5 s). Resposta da 1ª região que diz "online".
  """
  use GenServer
  alias ChatyyRouter.Net

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # {:local, {device, email}}: nó antigo (rolante) recebe a tupla em {:local, device} → local_online
  # levanta no to_string → try → false (nunca derruba o GenServer de lá).
  def ask_cluster(device, email \\ nil) do
    others = Net.alive_regions() -- [Net.me()]

    others
    |> Task.async_stream(fn r -> {r, Net.call(r, __MODULE__, {:local, {device, email}}, Net.tmo(r, 3_000))} end,
      timeout: 31_000, on_timeout: :kill_task, max_concurrency: 16, ordered: false)
    |> Enum.find_value({:error, :offline}, fn
      {:ok, {r, true}} -> {:ok, r}
      _ -> nil
    end)
  end

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_call({:local, q}, from, s) do
    {device, email} =
      case q do
        {d, e} -> {d, e}
        d -> {d, nil}
      end

    spawn(fn ->
      r =
        try do
          ChatyyRouter.Hub.Http.local_online(device, email) == true
        catch
          _, _ -> false
        end

      GenServer.reply(from, r)
    end)

    {:noreply, s}
  end
end
