defmodule ChatyyRouter.HomeSync do
  @moduledoc """
  Liga a `HomeTable` à tabela `conv_home` do PG (ROUTER_HOME_SOURCE=pg).

  LEITURA (este processo): carga inicial da RÉPLICA LOCAL (em blocos por cid) +
  poll incremental a cada ROUTER_PG_POLL_MS (2 s) por `updated_at >= marca`.
  Cada linha vira `HomeTable.merge/3` (maior epoch vence; empate = maior nome
  de região). Se o cluster tem algo MAIS NOVO que o PG (failover/migração feitos
  com o master fora), a linha volta para o outbox (reconciliação).

  ESCRITA (`HomeSync.Outbox`): toda `HomeTable.assign/3` em modo pg entra num
  outbox DURÁVEL (Mnesia local `:rt_home_cas`, mesmo tipo de cópia do Store) e
  é aplicada no MASTER por `conv_home_advance(cid, region, epoch, by)` — fence
  monotônico e idempotente, seguro de repetir. Master fora: fica no outbox e é
  repetido com recuo (máx. 30 s); o roteador NÃO espera o master para trocar de
  casa: quem manda em tempo de execução é o epoch do cluster com quórum.

  Regra de reconciliação (a mesma nos 3 lugares: HomeTable.do_merge,
  conv_home_advance, e aqui): (epoch maior) vence; empate => maior nome de
  região. Assim cluster e PG convergem para o mesmo par sem coordenação, e um
  nó antigo que volta só pode DESCER (vê epoch maior), nunca rebaixar o PG.
  Decisões de produto/operador usam `conv_home_cas` (só troca se o epoch atual
  for o esperado; sucesso => epoch+1); o roteador as recebe pelo poll e o dono
  antigo desce pelo epoch.

  Em modo pg os cids são inteiros (chat_conversations.id).
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, HomeTable}
  alias ChatyyRouter.PG.Conn

  @chunk 10_000
  @batch 5_000

  def child_specs do
    [
      Supervisor.child_spec({__MODULE__, nil}, id: __MODULE__),
      Supervisor.child_spec({__MODULE__.Outbox, nil}, id: __MODULE__.Outbox)
    ]
  end

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def enqueue(cid, region, epoch), do: __MODULE__.Outbox.enqueue(cid, region, epoch)
  def status, do: %{sync: GenServer.call(__MODULE__, :status), outbox: __MODULE__.Outbox.status()}

  @doc "Troca atômica no master (operador): {:ok, region, epoch} | {:conflict, region, epoch} | {:error, _}."
  def cas(cid, expected_epoch, region) do
    sql = "SELECT ok::text, region, epoch::text FROM conv_home_cas($1::bigint, $2::int, $3, $4)"

    case Conn.query(:master, sql, [cid, expected_epoch, region, "router:" <> Config.region()]) do
      {:ok, %{rows: [["true", r, e]]}} -> {:ok, r, String.to_integer(e)}
      {:ok, %{rows: [[_, r, e]]}} -> {:conflict, r, e && String.to_integer(e)}
      err -> err
    end
  end

  defp poll_ms do
    case Config.get(:pg_poll_ms, 2_000) do
      v when is_integer(v) -> v
      v -> String.to_integer(to_string(v))
    end
  end

  @impl true
  def init(_) do
    if HomeTable.pg?() do
      send(self(), :load)
      {:ok, %{wm: nil, overlap: 2, loaded: false, rows: 0, polls: 0, last_err: nil, reconciled: 0}}
    else
      :ignore
    end
  end

  @impl true
  def handle_call(:status, _f, s), do: {:reply, s, s}

  @impl true
  def handle_info(:load, s) do
    case load(0, 0, nil) do
      {:ok, n, wm} ->
        Logger.info("router: conv_home carregada da réplica: #{n} linhas")
        Process.send_after(self(), :poll, poll_ms())
        {:noreply, %{s | loaded: true, rows: s.rows + n, wm: wm || "-infinity", last_err: nil}}

      {:error, e} ->
        Process.send_after(self(), :load, 5_000)
        {:noreply, %{s | last_err: inspect(e)}}
    end
  end

  def handle_info(:poll, s) do
    # overlap 2 s quando a última leitura não veio cheia (commits fora de ordem por ms);
    # linhas repetidas são idempotentes (merge por epoch)
    sql =
      "SELECT cid::text, region, epoch::text, updated_at::text FROM conv_home " <>
        "WHERE updated_at >= ($1::timestamptz - make_interval(secs => $2::int)) ORDER BY updated_at LIMIT #{@batch}"

    s =
      case Conn.query(:replica, sql, [s.wm, s.overlap]) do
        {:ok, %{rows: rows}} ->
          rec = apply_rows(rows)
          full = length(rows) >= @batch
          wm = if rows == [], do: s.wm, else: rows |> List.last() |> Enum.at(3)
          %{s | wm: wm, overlap: if(full, do: 0, else: 2), rows: s.rows + length(rows), polls: s.polls + 1,
                reconciled: s.reconciled + rec, last_err: nil}

        {:error, e} ->
          %{s | last_err: inspect(e) |> String.slice(0, 200)}
      end

    Process.send_after(self(), :poll, poll_ms())
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  defp load(after_cid, n, wm) do
    sql =
      "SELECT cid::text, region, epoch::text, updated_at::text FROM conv_home " <>
        "WHERE cid > $1::bigint ORDER BY cid LIMIT #{@chunk}"

    case Conn.query(:replica, sql, [after_cid]) do
      {:ok, %{rows: []}} ->
        {:ok, n, wm}

      {:ok, %{rows: rows}} ->
        apply_rows(rows)
        wm = Enum.reduce(rows, wm, fn [_, _, _, u], acc -> if acc == nil or u > acc, do: u, else: acc end)
        last = rows |> List.last() |> hd() |> String.to_integer()
        if length(rows) < @chunk, do: {:ok, n + length(rows), wm}, else: load(last, n + length(rows), wm)

      err ->
        err
    end
  end

  # devolve quantas linhas o cluster tinha mais novas (foram p/ o outbox)
  defp apply_rows(rows), do: Enum.reduce(rows, 0, fn [c, r, e | _], acc -> apply_row(c, r, e, acc) end)

  defp apply_row(c, r, e, acc) do
    cid = String.to_integer(c)
    epoch = String.to_integer(e)

    case HomeTable.merge(cid, r, epoch) do
      :updated ->
        acc

      :stale ->
        # o cluster sabe algo mais novo (ou igual): se mais novo, leva ao master
        case :ets.lookup(:rt_home_cache, cid) do
          [{_, lr, le}] when le > epoch or (le == epoch and lr > r) ->
            __MODULE__.Outbox.enqueue(cid, lr, le)
            acc + 1

          _ ->
            acc
        end
    end
  end
end

defmodule ChatyyRouter.HomeSync.Outbox do
  @moduledoc "Outbox durável das trocas de casa para o master (ver HomeSync)."
  use GenServer
  require Logger
  alias ChatyyRouter.{Config, HomeTable}
  alias ChatyyRouter.PG.Conn

  @tab :rt_home_cas

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def enqueue(cid, region, epoch) do
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, {:enq, cid, region, epoch})
    :ok
  end

  def status do
    try do
      GenServer.call(__MODULE__, :status, 2_000)
    catch
      :exit, _ -> :unavailable
    end
  end

  @impl true
  def init(_) do
    if HomeTable.pg?() do
      copy = if Config.store() == "disc", do: :disc_copies, else: :ram_copies

      case :mnesia.create_table(@tab, [{:type, :set}, {:attributes, [:k, :v]}, {copy, [node()]}]) do
        {:atomic, :ok} -> :ok
        {:aborted, {:already_exists, @tab}} -> :ok
      end

      :ok = :mnesia.wait_for_tables([@tab], 30_000)
      send(self(), :flush)
      {:ok, %{backoff: 0, ok: 0, fail: 0, adopted: 0, last_err: nil}}
    else
      :ignore
    end
  end

  @impl true
  def handle_call(:status, _f, s), do: {:reply, Map.put(s, :pending, :mnesia.table_info(@tab, :size)), s}

  @impl true
  def handle_cast({:enq, cid, region, epoch}, s) do
    # fica só o mais novo por conversa
    case :mnesia.dirty_read(@tab, cid) do
      [{_, _, {r0, e0}}] when e0 > epoch or (e0 == epoch and r0 >= region) -> :ok
      _ -> :mnesia.dirty_write({@tab, cid, {region, epoch}})
    end

    {:noreply, s}
  end

  @impl true
  def handle_info(:flush, s) do
    rows = :mnesia.dirty_select(@tab, [{{@tab, :"$1", :"$2"}, [], [{{:"$1", :"$2"}}]}]) |> Enum.take(500)
    by = "router:" <> Config.region()
    sql = "SELECT ok::text, region, epoch::text FROM conv_home_advance($1::bigint, $2, $3::int, $4)"

    s =
      Enum.reduce_while(rows, s, fn {cid, {r, e}}, s ->
        case Conn.query(:master, sql, [cid, r, e, by]) do
          {:ok, %{rows: [[_ok, mr, me]]}} ->
            me = String.to_integer(me)
            # apaga só se ninguém enfileirou algo mais novo nesse meio tempo
            case :mnesia.dirty_read(@tab, cid) do
              [{_, _, {^r, ^e}}] -> :mnesia.dirty_delete(@tab, cid)
              _ -> :ok
            end

            adopted =
              if {mr, me} != {r, e} do
                # o master tinha algo mais novo (CAS de operador): o cluster adota
                HomeTable.merge(cid, mr, me)
                1
              else
                0
              end

            ChatyyRouter.Metrics.inc(:home_cas_ok)
            {:cont, %{s | ok: s.ok + 1, adopted: s.adopted + adopted, backoff: 0, last_err: nil}}

          {:error, %ChatyyRouter.PG.Error{} = e} ->
            # erro SQL (ex.: região inválida no CHECK): não adianta repetir para sempre
            Logger.warning("router: conv_home_advance #{cid} recusado: #{e.message}")
            :mnesia.dirty_delete(@tab, cid)
            ChatyyRouter.Metrics.inc(:home_cas_rejected)
            {:cont, %{s | fail: s.fail + 1, last_err: e.message}}

          {:error, e} ->
            ChatyyRouter.Metrics.inc(:home_cas_fail)
            {:halt, %{s | fail: s.fail + 1, backoff: min(max(s.backoff * 2, 1_000), 30_000), last_err: inspect(e) |> String.slice(0, 200)}}
        end
      end)

    Process.send_after(self(), :flush, if(s.backoff > 0, do: s.backoff, else: 1_000))
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}
end
