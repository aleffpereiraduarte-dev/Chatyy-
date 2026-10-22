defmodule ChatyyRouter.Store do
  @moduledoc """
  Armazenamento LOCAL do nó, em duas camadas (R0, 22/10):

  1. CORPOS (o que cresce com 30 dias de aparelho offline) → `ChatyyRouter.Seglog`
     (log de segmentos no disco, índice em RAM, fsync em grupo, expurgo por
     arquivo). Ver o moduledoc do Seglog para a justificativa contra Mnesia
     disc_copies/disc_only, RocksDB/SQLite e PG local.
       :rt_msg     {cid, seq}         -> msg   (na CASA, até ack de todos ou 30 d)
       :rt_replica {cid, seq}         -> msg   (cópia na IRMÃ, p/ failover)
       :rt_inbox   {device, cid, seq} -> {msg, exp} (região do aparelho; aux = casa)

  2. METADADOS pequenos → Mnesia LOCAL `disc_copies` (schema só deste nó,
     nunca clusterizado: evita o "inconsistent_database" do Mnesia em
     partição de WAN; a réplica para a irmã é feita pelo roteador, c/ epoch).
       :rt_pend    {cid, seq}  -> {devices_pendentes, regioes_nao_gravadas}
       :rt_dedupe  {cid, cmi}  -> {seq, ts}        (janela 7 d)
       :rt_meta    cid         -> %{last_seq, epoch}
       :rt_home    cid         -> {region, epoch}  (cache durável da casa, comprometida)
       :rt_home_acc cid        -> {region, epoch}  (aceite pendente da proposta de casa por maioria)
     Ficam em RAM (alguns bytes por mensagem pendente); o tamanho sai em
     /metrics (chatyy_router_store_entries) com alerta no monitor.
     Mnesia não faz fsync por escrita: numa queda de ENERGIA pode perder os
     últimos ~s de metadados. O que é crítico é refeito do Seglog (fsync):
     `last_seq` = max(meta, maior seq em :rt_msg) e o dedupe de quem ainda
     tem corpo é recriado do `aux` do :rt_msg no init do ConvServer.
  """
  require Logger
  alias ChatyyRouter.{Config, Seglog}

  @mnesia [:rt_pend, :rt_dedupe, :rt_meta, :rt_home, :rt_home_acc]
  @logs [:rt_msg, :rt_replica, :rt_inbox]

  def tables, do: @mnesia ++ @logs
  def log_tables, do: @logs
  def mnesia_tables, do: @mnesia
  def log?(t), do: t in @logs

  @doc "Filhos do supervisor (um escritor por tabela de log); sobem antes de tudo."
  def child_specs, do: for(t <- @logs, do: Seglog.child_spec(t))

  def init do
    mode = Config.store()
    :ok = ensure_mnesia()

    if mode == "disc" do
      case :mnesia.table_info(:schema, :storage_type) do
        :disc_copies -> :ok
        _ -> {:atomic, :ok} = :mnesia.change_table_copy_type(:schema, node(), :disc_copies)
      end
    end

    copy = if mode == "disc", do: :disc_copies, else: :ram_copies

    # protótipo antigo tinha os corpos no Mnesia: some com eles (só dados de bench)
    for t <- @logs, t in :mnesia.system_info(:tables) do
      Logger.warning("store: removendo tabela Mnesia antiga #{t} (corpos agora no Seglog)")
      :mnesia.delete_table(t)
    end

    for t <- @mnesia do
      case :mnesia.create_table(t, [{:type, :ordered_set}, {:attributes, [:k, :v]}, {copy, [node()]}]) do
        {:atomic, :ok} -> :ok
        {:aborted, {:already_exists, ^t}} -> :ok
      end
    end

    :ok = :mnesia.wait_for_tables(@mnesia, 60_000)
  end

  defp ensure_mnesia do
    case :mnesia.system_info(:is_running) do
      :yes -> :ok
      _ ->
        :mnesia.start()
        :ok
    end
  end

  # ---------- exp/aux por tabela de log ----------

  defp exp_aux(:rt_inbox, _k, {msg, exp}), do: {exp, msg[:home]}
  defp exp_aux(:rt_msg, _k, m), do: {m.ts + Config.retention_ms(), {m.ts, m[:cmi]}}
  defp exp_aux(:rt_replica, _k, m), do: {m.ts + Config.retention_ms(), {m.home, m.epoch, m.ts}}

  @doc "Grava. Tabelas de log devolvem :ok | {:error, motivo} (disco cheio/E/S)."
  def put(t, k, v) when t in @logs do
    {exp, aux} = exp_aux(t, k, v)
    Seglog.put(t, k, v, exp, aux)
  end

  def put(t, k, v), do: :mnesia.dirty_write({t, k, v})

  @doc "Várias linhas da mesma tabela de log com 1 fsync."
  def put_many(t, kvs) when t in @logs do
    Seglog.put_many(t, for({k, v} <- kvs, {exp, aux} = exp_aux(t, k, v), do: {k, v, exp, aux}))
  end

  def put_many(t, kvs), do: (for {k, v} <- kvs, do: put(t, k, v)) && :ok

  def delete(t, k) when t in @logs, do: Seglog.delete(t, k)
  def delete(t, k), do: :mnesia.dirty_delete({t, k})

  def get(t, k) when t in @logs, do: Seglog.get(t, k)

  def get(t, k) do
    case :mnesia.dirty_read(t, k) do
      [{^t, ^k, v}] -> v
      [] -> nil
    end
  end

  def member?(t, k) when t in @logs, do: Seglog.member?(t, k)
  def member?(t, k), do: get(t, k) != nil

  @doc "Linhas cuja chave é {prefix, _} (ordered_set: varredura só do prefixo)."
  def prefix(t, p) when t in @logs do
    for s <- prefix_keys(t, p), v = Seglog.get(t, {p, s}), v != nil, do: {s, v}
  end

  def prefix(t, p) do
    :mnesia.dirty_select(t, [{{t, {p, :"$1"}, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  @doc "Só as subchaves (sem ler corpo)."
  def prefix_keys(t, p) when t in @logs, do: Seglog.select_keys(t, {p, :"$1"}, [], :"$1")
  def prefix_keys(t, p), do: :mnesia.dirty_select(t, [{{t, {p, :"$1"}, :_}, [], [:"$1"]}])

  @doc "Linhas {prefix, seq} com seq <= upto."
  def prefix_upto(t, p, upto) when t in @logs do
    for s <- Seglog.select_keys(t, {p, :"$1"}, [{:"=<", :"$1", upto}], :"$1"),
        v = Seglog.get(t, {p, s}),
        v != nil,
        do: {s, v}
  end

  def prefix_upto(t, p, upto) do
    :mnesia.dirty_select(t, [{{t, {p, :"$1"}, :"$2"}, [{:"=<", :"$1", upto}], [{{:"$1", :"$2"}}]}])
  end

  @doc "aux do :rt_msg por conversa: [{seq, {ts, cmi}}] sem ler corpo."
  def msg_aux(cid) do
    :ets.select(Seglog.idx(:rt_msg), [{{{cid, :"$1"}, :_, :_, :_, :_, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  def inbox(device) do
    keys = Seglog.select_keys(:rt_inbox, {device, :"$1", :"$2"}, [], {{:"$1", :"$2"}})
    for {cid, seq} <- keys, v = Seglog.get(:rt_inbox, {device, cid, seq}), v != nil, do: {cid, seq, v}
  end

  def inbox_upto(device, cid, upto) do
    Seglog.select_keys(:rt_inbox, {device, cid, :"$1"}, [{:"=<", :"$1", upto}], :"$1")
  end

  @doc "[{seq, casa}] da inbox (casa vem do aux, sem ler corpo)."
  def inbox_upto_home(device, cid, upto) do
    :ets.select(Seglog.idx(:rt_inbox), [
      {{{device, cid, :"$1"}, :_, :_, :_, :_, :"$2"}, [{:"=<", :"$1", upto}], [{{:"$1", :"$2"}}]}
    ])
  end

  def all(t) when t in @logs do
    for {k, _exp, _aux} <- Seglog.meta_all(t), v = Seglog.get(t, k), v != nil, do: {k, v}
  end

  def all(t), do: :mnesia.dirty_select(t, [{{t, :"$1", :"$2"}, [], [{{:"$1", :"$2"}}]}])

  def size(t) when t in @logs, do: Seglog.size(t)
  def size(t), do: :mnesia.table_info(t, :size)

  def mnesia_bytes do
    Enum.reduce(@mnesia, 0, fn t, a -> a + :mnesia.table_info(t, :memory) * :erlang.system_info(:wordsize) end)
  end

  def clear_all do
    for t <- @mnesia, do: {:atomic, :ok} = :mnesia.clear_table(t)
    for t <- @logs, do: :ok = Seglog.clear(t)
    :ok
  end
end
