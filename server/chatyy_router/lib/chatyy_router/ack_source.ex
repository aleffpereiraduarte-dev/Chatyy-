defmodule ChatyyRouter.AckSource do
  @moduledoc """
  Acks de entrega POR APARELHO vindos da fila sombra `chat_msg_device_dlv`
  (kit /root/apagar-ao-entregar-2026-10-22 — a tabela é de outro fluxo: aqui só
  LEITURA, na réplica local, sem duplicar fila). ROUTER_ACK_SOURCE=dlv|off (padrão off).

  Caminho do ack no R1: app d_ack (WS/HTTP/push, com device_id) -> hub/PHP
  `chat_delivery_ack` -> dlv-shadow grava acked_at no master -> WAL -> réplica
  local -> este poll -> `ChatyyRouter.Delivery.ack(device, cid, upto)`.
  No R1 o `seq` da inbox é o message_id do US.

  Duas varreduras (a tabela só tem índice em msg_at e em (uid, device_id)):
    * rápida: a cada ROUTER_ACK_POLL_MS (1 s), mensagens com msg_at nas
      últimas ROUTER_ACK_FAST_WINDOW_S (2 h);
    * lenta: a cada 5 min, janela de 31 d (aparelho que volta depois de dias).
  Cada uma com marca d'água própria em acked_at (overlap 2 s; repetição é inofensiva).
  Ack sem aparelho (device_id '?', cliente/hub antigo) é ignorado: não dá para
  saber qual inbox apagar.

  O ack da fila sombra é POR MENSAGEM, e o `Delivery.ack/3` é CUMULATIVO (apaga
  tudo <= upto). Para nunca apagar uma mensagem que o aparelho não confirmou,
  `upto` = maior seq tal que TODAS as entradas da inbox local <= ele estão
  confirmadas; ids acima de um buraco esperam (no máx. 15 min) o buraco ser
  confirmado. Só aparelhos com inbox NESTE nó geram ack (nada de tráfego entre
  regiões por aparelhos de outras regiões).
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, Delivery, Store}
  alias ChatyyRouter.PG.Conn

  @pending :rt_ack_src_pending
  @limit 5_000
  @pending_ttl_ms 15 * 60_000

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  def on?, do: to_string(Config.get(:ack_source, "off")) == "dlv"
  def status, do: GenServer.call(__MODULE__, :status)

  defp int_cfg(k, d) do
    case Config.get(k, d) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  @impl true
  def init(_) do
    if on?() do
      if :ets.whereis(@pending) == :undefined,
        do: :ets.new(@pending, [:named_table, :public, :set])

      send(self(), {:scan, :fast})
      Process.send_after(self(), {:scan, :slow}, 30_000)

      {:ok,
       %{
         wm: %{fast: "-infinity", slow: "-infinity"},
         overlap: %{fast: 2, slow: 2},
         rows: 0,
         acked_calls: 0,
         waiting: 0,
         last_err: nil
       }}
    else
      :ignore
    end
  end

  @impl true
  def handle_call(:status, _f, s), do: {:reply, Map.put(s, :pending_keys, :ets.info(@pending, :size)), s}

  @impl true
  def handle_info({:scan, kind}, s) do
    window = if kind == :fast, do: int_cfg(:ack_fast_window_s, 7_200), else: 31 * 86_400

    sql = """
    SELECT conversation_id::text, message_id::text, device_id, acked_at::text
      FROM chat_msg_device_dlv
     WHERE msg_at > now() - make_interval(secs => $1::int)
       AND acked_at >= ($2::timestamptz - make_interval(secs => $3::int))
       AND device_id <> '?'
     ORDER BY acked_at
     LIMIT #{@limit}
    """

    s =
      case Conn.query(:replica, sql, [window, s.wm[kind], s.overlap[kind]], 10_000) do
        {:ok, %{rows: rows}} ->
          now = System.monotonic_time(:millisecond)

          for [c, m, d, _] <- rows do
            key = {d, String.to_integer(c)}
            id = String.to_integer(m)

            set =
              case :ets.lookup(@pending, key) do
                [{_, set, _}] -> set
                [] -> MapSet.new()
              end

            :ets.insert(@pending, {key, MapSet.put(set, id), now})
          end

          {calls, waiting} = settle(now)
          full = length(rows) >= @limit
          wm = if rows == [], do: s.wm[kind], else: rows |> List.last() |> Enum.at(3)
          ChatyyRouter.Metrics.inc(:ack_src_rows, length(rows))

          %{
            s
            | wm: Map.put(s.wm, kind, wm),
              overlap: Map.put(s.overlap, kind, if(full, do: 0, else: 2)),
              rows: s.rows + length(rows),
              acked_calls: s.acked_calls + calls,
              waiting: waiting,
              last_err: nil
          }

        {:error, e} ->
          ChatyyRouter.Metrics.inc(:ack_src_fail)
          %{s | last_err: inspect(e) |> String.slice(0, 200)}
      end

    next = if kind == :fast, do: int_cfg(:ack_poll_ms, 1_000), else: 300_000
    Process.send_after(self(), {:scan, kind}, next)
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  # Para cada {device, cid} com acks pendentes: acha o maior upto contíguo na inbox local.
  defp settle(now) do
    Enum.reduce(:ets.tab2list(@pending), {0, 0}, fn {{dev, cid} = key, set, ts}, {calls, waiting} ->
      max_id = Enum.max(set)
      seqs = Store.inbox_upto(dev, cid, max_id) |> Enum.sort()

      upto =
        Enum.reduce_while(seqs, nil, fn seq, acc ->
          if MapSet.member?(set, seq), do: {:cont, seq}, else: {:halt, acc}
        end)

      calls =
        if upto do
          Delivery.ack(dev, cid, upto)
          calls + 1
        else
          calls
        end

      # restante: ids acima de um buraco que AINDA estão na inbox
      left = if upto, do: MapSet.filter(set, &(&1 > upto)), else: set
      still = Enum.filter(seqs, &(&1 > (upto || -1)))
      left = MapSet.filter(left, &(&1 in still))

      cond do
        MapSet.size(left) == 0 and seqs == [] and now - ts < 60_000 ->
          # nada na inbox ainda: pode ser corrida (ack antes do fan-out); guarda 1 min
          {calls, waiting + 1}

        MapSet.size(left) == 0 ->
          :ets.delete(@pending, key)
          {calls, waiting}

        now - ts > @pending_ttl_ms ->
          :ets.delete(@pending, key)
          ChatyyRouter.Metrics.inc(:ack_src_gap_expired)
          {calls, waiting}

        true ->
          :ets.insert(@pending, {key, left, ts})
          {calls, waiting + 1}
      end
    end)
  end
end
