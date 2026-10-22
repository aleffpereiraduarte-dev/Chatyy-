defmodule ChatyyRouter.Store do
  @moduledoc """
  Armazenamento LOCAL do nó (Mnesia com schema só deste nó; nunca clusterizado).

  Por que Mnesia local (e não PG do edge nem ETS puro):
    * o PG dos edges é RÉPLICA read-only do US; gravar ali exigiria uma 2ª
      instância PG por edge (operação, backup, porta, upgrade) — fica p/ R2;
    * ETS puro perde a fila num restart; Mnesia `disc_copies` = ETS em RAM
      + log de transações em disco (LATEST.LOG + .DCD), mesma velocidade de
      leitura e sobrevive a restart;
    * schema só local evita o calcanhar de Aquiles do Mnesia em WAN
      (partição → "inconsistent_database"): replicação para a irmã é feita
      pelo próprio roteador (mensagens Erlang), com epoch.
  Limite conhecido: disc_copies mantém tudo em RAM. 30 dias × aparelhos
  offline em produção pede `disc_only_copies`/RocksDB ou PG local — ver README.

  Tabelas (registro {tab, k, v}, ordered_set):
    :rt_msg     {cid, seq}        -> msg (na CASA, até ack de todos ou 30 d)
    :rt_pend    {cid, seq}        -> {devices_pendentes, regioes_nao_gravadas}
    :rt_dedupe  {cid, cmi}        -> {seq, ts}            (janela 7 d)
    :rt_meta    cid               -> %{last_seq, epoch}
    :rt_replica {cid, seq}        -> msg (cópia na IRMÃ, p/ failover)
    :rt_inbox   {device, cid, seq}-> {msg, exp}           (região do aparelho)
    :rt_home    cid               -> {region, epoch}      (cache durável da tabela de casa)
  """
  require Logger

  @tables [:rt_msg, :rt_pend, :rt_dedupe, :rt_meta, :rt_replica, :rt_inbox, :rt_home]

  def tables, do: @tables

  def init do
    mode = ChatyyRouter.Config.store()
    :ok = ensure_mnesia()

    if mode == "disc" do
      case :mnesia.table_info(:schema, :storage_type) do
        :disc_copies -> :ok
        _ -> {:atomic, :ok} = :mnesia.change_table_copy_type(:schema, node(), :disc_copies)
      end
    end

    copy = if mode == "disc", do: :disc_copies, else: :ram_copies

    for t <- @tables do
      case :mnesia.create_table(t, [{:type, :ordered_set}, {:attributes, [:k, :v]}, {copy, [node()]}]) do
        {:atomic, :ok} -> :ok
        {:aborted, {:already_exists, ^t}} -> :ok
      end
    end

    :ok = :mnesia.wait_for_tables(@tables, 60_000)
  end

  defp ensure_mnesia do
    case :mnesia.system_info(:is_running) do
      :yes -> :ok
      _ ->
        :mnesia.start()
        :ok
    end
  end

  def put(t, k, v), do: :mnesia.dirty_write({t, k, v})
  def delete(t, k), do: :mnesia.dirty_delete({t, k})

  def get(t, k) do
    case :mnesia.dirty_read(t, k) do
      [{^t, ^k, v}] -> v
      [] -> nil
    end
  end

  @doc "Linhas cuja chave é {prefix, _} (ordered_set: varredura só do prefixo)."
  def prefix(t, p) do
    :mnesia.dirty_select(t, [{{t, {p, :"$1"}, :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  @doc "Linhas {prefix, seq} com seq <= upto."
  def prefix_upto(t, p, upto) do
    :mnesia.dirty_select(t, [{{t, {p, :"$1"}, :"$2"}, [{:"=<", :"$1", upto}], [{{:"$1", :"$2"}}]}])
  end

  def inbox(device) do
    :mnesia.dirty_select(:rt_inbox, [{{:rt_inbox, {device, :"$1", :"$2"}, :"$3"}, [], [{{:"$1", :"$2", :"$3"}}]}])
  end

  def inbox_upto(device, cid, upto) do
    :mnesia.dirty_select(:rt_inbox, [
      {{:rt_inbox, {device, cid, :"$1"}, :_}, [{:"=<", :"$1", upto}], [:"$1"]}
    ])
  end

  def all(t), do: :mnesia.dirty_select(t, [{{t, :"$1", :"$2"}, [], [{{:"$1", :"$2"}}]}])
  def size(t), do: :mnesia.table_info(t, :size)

  def clear_all do
    for t <- @tables, do: {:atomic, :ok} = :mnesia.clear_table(t)
    :ok
  end
end
