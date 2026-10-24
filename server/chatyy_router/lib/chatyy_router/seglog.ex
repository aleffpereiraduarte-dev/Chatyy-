defmodule ChatyyRouter.Seglog do
  @moduledoc """
  Armazenamento DURÁVEL de corpos (fila de 30 dias) em log de segmentos no
  disco, com índice em RAM. É o desenho "Bitcask" (Riak): só acrescenta,
  nunca reescreve no lugar.

  Por que isto, e não as alternativas (decisão R0, 22/10):
    * Mnesia `disc_copies` (o protótipo) guarda a tabela INTEIRA em RAM:
      30 d × aparelhos offline estoura o MemoryMax de 768 MB do serviço.
    * Mnesia `disc_only_copies` = DETS: só `set`/`bag` (sem `ordered_set`,
      então sem varredura por prefixo {cid, seq}), limite de 2 GB por
      tabela e reparo lento depois de queda.
    * RocksDB/SQLite precisam de NIF ou de porta para binário externo: dep
      nativa compilada por edge (glibc 2.39–2.44), crash da NIF derruba a
      VM, e o release deixa de ser "um tar com ERTS".
    * PG local gravável: 2ª instância por edge (backup, upgrade, porta) —
      fica para o R2 se o histórico morar na casa.
    * Este log: zero deps, escrita sequencial com `datasync` em grupo
      (group commit: N escritas concorrentes = 1 fsync), e a retenção de
      30 dias vira apagar ARQUIVO (segmentos por dia UTC): o custo do
      expurgo é O(1) por dia, não O(linhas).

  Formato: `<dir>/<tabela>/<id 10 dígitos>.seg`, registros
  `<<len::32, crc32::32, term_to_binary(payload)>>`:
      {:put, key, exp_ms, aux, value}   |   {:del, key}
  Índice ETS `ordered_set` {key, seg, off, len, exp, aux} (≈100–150 B por
  item: 1 milhão de mensagens pendentes ≈ 150 MB de RAM, corpos no disco).
  `aux` = campos pequenos que as varreduras precisam sem ler o corpo.
  Cache quente {key, value, t} das escritas recentes (ROUTER_HOT_MS, 60 s):
  o fan-out, a reentrega e o purge leem da RAM; o `fetch` de um aparelho que
  voltou depois de dias lê do disco (open+pread+close).

  Reinício: relê os segmentos em ordem (pula `exp < agora`), recria o
  índice e, se o ÚLTIMO segmento tiver cauda rasgada (queda no meio da
  escrita), trunca no último registro íntegro (CRC).

  Apagar segmentos: só em ordem, do mais velho para o mais novo, enquanto o
  mais velho estiver sem itens vivos OU todo vencido. Assim um tombstone
  {:del} nunca some antes do {:put} que ele anula (sem "ressuscitar" item
  confirmado depois de reiniciar).

  Durabilidade (ROUTER_FSYNC): "always" (padrão) = quem chama `put` só
  recebe :ok depois do `datasync`; "none" = sem fsync (só p/ bench).
  Limite de disco (ROUTER_LOG_MAX_MB, por tabela): acima dele `put` devolve
  {:error, :disk_full} (a casa/irmã/região não confirma e o chamador reenvia
  depois) e o alerta sobe por /metrics.

  Corrida conhecida e aceita: `delete` de uma chave concorrente com `put`
  da MESMA chave vindo de outro processo pode divergir só depois de um
  reinício. No roteador cada chave tem um único dono (ConvServer da
  conversa, shard da Delivery, Replica), então não acontece.

  Modo "ram" (testes): mesmo índice, sem arquivos.
  """
  use GenServer
  require Logger
  alias ChatyyRouter.{Clock, Config}

  @hot_ms_default 60_000
  @seg_max_default 32 * 1_048_576
  @batch_max 2_000

  # ------------------------------------------------------------ API

  def child_spec(table) do
    %{id: {__MODULE__, table}, start: {__MODULE__, :start_link, [table]}}
  end

  def start_link(table), do: GenServer.start_link(__MODULE__, table, name: wname(table))

  defp wname(t), do: :"#{t}_w"
  def idx(t), do: :"#{t}_idx"
  def hot(t), do: :"#{t}_hot"
  def segs(t), do: :"#{t}_segs"

  @doc "Grava (síncrono; com fsync no modo always). exp em ms (epoch)."
  def put(t, k, v, exp, aux \\ nil) do
    bin = record({:put, k, exp, aux, v})
    GenServer.call(wname(t), {:put, k, exp, aux, v, bin}, 30_000)
  end

  @doc "Grava várias chaves da mesma tabela num registro só de fsync."
  def put_many(_t, []), do: :ok

  def put_many(t, items) do
    rows = for {k, v, exp, aux} <- items, do: {k, exp, aux, v, record({:put, k, exp, aux, v})}
    GenServer.call(wname(t), {:put_many, rows}, 30_000)
  end

  def delete(t, k) do
    case :ets.take(idx(t), k) do
      [{^k, seg, _off, _len, _exp, _aux}] ->
        :ets.delete(hot(t), k)
        dec_live(t, seg)
        GenServer.cast(wname(t), {:del, k})

      [] ->
        :ets.delete(hot(t), k)
    end

    :ok
  end

  def get(t, k) do
    case :ets.lookup(hot(t), k) do
      [{^k, v, _}] ->
        v

      [] ->
        case :ets.lookup(idx(t), k) do
          [{^k, seg, off, len, _exp, _aux}] -> read_at(t, seg, off, len, k)
          [] -> nil
        end
    end
  end

  def member?(t, k), do: :ets.member(idx(t), k)

  @doc "Chaves (sem ler corpo) que casam com o padrão de chave + guardas."
  def select_keys(t, key_pat, guards, ret) do
    :ets.select(idx(t), [{{key_pat, :_, :_, :_, :_, :_}, guards, [ret]}])
  end

  @doc "Linhas {key, exp, aux} (sem corpo)."
  def meta_all(t), do: :ets.select(idx(t), [{{:"$1", :_, :_, :_, :"$2", :"$3"}, [], [{{:"$1", :"$2", :"$3"}}]}])

  def size(t), do: :ets.info(idx(t), :size)

  @doc "Remove do índice tudo com exp < now (sem tombstone: a releitura já pula vencidos)."
  def expire(t, now) do
    rows = :ets.select(idx(t), [{{:"$1", :"$2", :_, :_, :"$3", :_}, [{:<, :"$3", now}], [{{:"$1", :"$2"}}]}])

    for {k, seg} <- rows do
      :ets.delete(idx(t), k)
      :ets.delete(hot(t), k)
      dec_live(t, seg)
    end

    length(rows)
  end

  def stats(t), do: GenServer.call(wname(t), :stats, 10_000)

  # [sgu F3 2026-10-23] compactação no escritor (ChatyyRouter.SeglogCompact)
  def compact(t, opts \\ []), do: GenServer.call(wname(t), {:compact, opts}, 600_000)

  def clear(t), do: GenServer.call(wname(t), :clear, 60_000)

  # ------------------------------------------------------------ registro

  defp record(payload) do
    bin = :erlang.term_to_binary(payload)
    <<byte_size(bin)::32, :erlang.crc32(bin)::32, bin::binary>>
  end

  defp read_at(t, seg, off, len, k) do
    path = seg_path(dir(t), seg)

    with {:ok, fd} <- :file.open(path, [:raw, :read, :binary]),
         res <- :file.pread(fd, off, len),
         :ok <- :file.close(fd),
         {:ok, <<_l::32, crc::32, bin::binary>>} <- res,
         true <- :erlang.crc32(bin) == crc,
         {:put, ^k, _exp, _aux, v} <- :erlang.binary_to_term(bin) do
      v
    else
      other ->
        ChatyyRouter.Metrics.inc(:seglog_read_error)
        Logger.error("seglog #{t}: leitura falhou seg=#{seg} off=#{off}: #{inspect(other) |> String.slice(0, 200)}")
        nil
    end
  end

  defp dec_live(t, seg) do
    try do
      :ets.update_counter(segs(t), seg, {2, -1})
    catch
      :error, :badarg -> :ok
    end
  end

  defp dir(t), do: Path.join(Config.get(:log_dir, "/var/lib/chatyy-router/log"), Atom.to_string(t))
  defp seg_path(d, seg), do: Path.join(d, :io_lib.format("~10..0B.seg", [seg]) |> IO.iodata_to_binary())

  defp mode, do: if(Config.store() == "disc", do: :disc, else: :ram)
  defp fsync?, do: to_string(Config.get(:fsync, "always")) == "always"
  defp hot_ms, do: int(Config.get(:hot_ms, @hot_ms_default))
  defp seg_max, do: int(Config.get(:seg_max_bytes, @seg_max_default))
  defp max_bytes, do: int(Config.get(:log_max_mb, 20_480)) * 1_048_576
  defp int(v) when is_integer(v), do: v
  defp int(v) when is_binary(v), do: String.to_integer(v)

  defp utc_day(ms), do: div(ms, 86_400_000)

  # ------------------------------------------------------------ GenServer

  @impl true
  def init(t) do
    for {name, type} <- [{idx(t), :ordered_set}, {hot(t), :set}, {segs(t), :set}] do
      if :ets.whereis(name) != :undefined, do: :ets.delete(name)
      :ets.new(name, [:named_table, :public, type, read_concurrency: true, write_concurrency: true])
    end

    s = %{t: t, mode: mode(), dir: dir(t), fd: nil, seg: 0, off: 0, day: nil, bytes: 0, seg_meta: %{}}

    s =
      if s.mode == :disc do
        File.mkdir_p!(s.dir)
        replay(s)
      else
        s
      end

    Process.send_after(self(), :cool, 5_000)
    Process.send_after(self(), :gc, 30_000)
    {:ok, s}
  end

  @impl true
  def handle_call({:put, k, exp, aux, v, bin}, from, s) do
    batch(s, [{from, [{k, exp, aux, v, bin}]}])
  end

  def handle_call({:put_many, rows}, from, s), do: batch(s, [{from, rows}])

  def handle_call(:stats, _f, s) do
    segs = :ets.tab2list(segs(s.t)) |> Enum.sort()

    {:reply,
     %{
       entries: :ets.info(idx(s.t), :size),
       hot: :ets.info(hot(s.t), :size),
       bytes: s.bytes,
       segments: length(segs),
       live: Enum.reduce(segs, 0, fn {_, l}, a -> a + max(l, 0) end),
       index_mem_bytes: :ets.info(idx(s.t), :memory) * :erlang.system_info(:wordsize),
       oldest_seg: segs |> List.first() |> then(&(&1 && elem(&1, 0))),
       active_seg: s.seg
     }, s}
  end

  # [sgu F3 2026-10-23]
  def handle_call({:compact, opts}, _f, s) do
    {r, s} = ChatyyRouter.SeglogCompact.run(s, opts)
    {:reply, r, s}
  end

  def handle_call(:clear, _f, s) do
    if s.fd, do: :file.close(s.fd)
    for n <- [idx(s.t), hot(s.t), segs(s.t)], do: :ets.delete_all_objects(n)
    if s.mode == :disc, do: File.rm_rf!(s.dir) && File.mkdir_p!(s.dir)
    {:reply, :ok, %{s | fd: nil, seg: s.seg + 1, off: 0, day: nil, bytes: 0, seg_meta: %{}}}
  end

  @impl true
  def handle_cast({:del, k}, s) do
    {dels, s} = drain_dels([{k}], s)
    {:noreply, write_dels(dels, s)}
  end

  @impl true
  def handle_info(:cool, s) do
    if s.mode == :disc do
      cut = System.monotonic_time(:millisecond) - hot_ms()
      :ets.select_delete(hot(s.t), [{{:_, :_, :"$1"}, [{:<, :"$1", cut}], [true]}])
    end

    Process.send_after(self(), :cool, 5_000)
    {:noreply, s}
  end

  def handle_info(:gc, s) do
    s = gc(s)
    Process.send_after(self(), :gc, 30_000)
    {:noreply, s}
  end

  def handle_info(_, s), do: {:noreply, s}

  @impl true
  def terminate(_r, s) do
    if s.fd, do: (:file.datasync(s.fd); :file.close(s.fd))
    :ok
  end

  # ------------------------------------------------------------ escrita em grupo

  defp batch(s, acc) do
    acc = collect(acc, length(acc))
    reqs = Enum.reverse(acc)
    rows = Enum.flat_map(reqs, &elem(&1, 1))

    cond do
      s.mode == :disc and s.bytes + rows_bytes(rows) > max_bytes() ->
        ChatyyRouter.Metrics.inc(:seglog_disk_full, length(rows))
        for {from, _} <- reqs, do: GenServer.reply(from, {:error, :disk_full})
        {:noreply, s}

      true ->
        case write_rows(rows, s) do
          {:ok, s, placed} ->
            now = System.monotonic_time(:millisecond)

            for {k, seg, off, len, exp, aux, v} <- placed do
              case :ets.lookup(idx(s.t), k) do
                [{^k, oseg, _, _, _, _}] -> dec_live(s.t, oseg)
                [] -> :ok
              end

              :ets.insert(idx(s.t), {k, seg, off, len, exp, aux})
              :ets.insert(hot(s.t), {k, v, now})
              :ets.update_counter(segs(s.t), seg, {2, 1}, {seg, 0})
            end

            for {from, _} <- reqs, do: GenServer.reply(from, :ok)
            ChatyyRouter.Metrics.inc(:seglog_batches)
            ChatyyRouter.Metrics.inc(:seglog_rows, length(rows))
            {:noreply, s}

          {:error, e, s} ->
            ChatyyRouter.Metrics.inc(:seglog_write_error)
            Logger.error("seglog #{s.t}: escrita falhou: #{inspect(e)}")
            for {from, _} <- reqs, do: GenServer.reply(from, {:error, :io})
            {:noreply, s}
        end
    end
  end

  # junta outras escritas que já estão na caixa (group commit)
  defp collect(acc, n) when n >= @batch_max, do: acc

  defp collect(acc, n) do
    receive do
      {:"$gen_call", from, {:put, k, exp, aux, v, bin}} -> collect([{from, [{k, exp, aux, v, bin}]} | acc], n + 1)
      {:"$gen_call", from, {:put_many, rows}} -> collect([{from, rows} | acc], n + length(rows))
    after
      0 -> acc
    end
  end

  defp rows_bytes(rows), do: Enum.reduce(rows, 0, fn {_, _, _, _, b}, a -> a + byte_size(b) end)

  defp write_rows(rows, %{mode: :ram} = s) do
    {:ok, s, for({k, exp, aux, v, bin} <- rows, do: {k, 0, 0, byte_size(bin), exp, aux, v})}
  end

  defp write_rows(rows, s) do
    s = ensure_seg(s, Clock.now_ms())

    {placed, iol, off} =
      Enum.reduce(rows, {[], [], s.off}, fn {k, exp, aux, v, bin}, {p, io, off} ->
        {[{k, s.seg, off, byte_size(bin), exp, aux, v} | p], [io, bin], off + byte_size(bin)}
      end)

    with :ok <- :file.write(s.fd, iol),
         :ok <- if(fsync?(), do: :file.datasync(s.fd), else: :ok) do
      max_exp = rows |> Enum.map(&elem(&1, 1)) |> Enum.max()
      meta = Map.update(s.seg_meta, s.seg, max_exp, &max(&1, max_exp))
      {:ok, %{s | off: off, bytes: s.bytes + (off - s.off), seg_meta: meta}, Enum.reverse(placed)}
    else
      e -> {:error, e, s}
    end
  end

  defp drain_dels(acc, s) do
    receive do
      {:"$gen_cast", {:del, k}} -> drain_dels([{k} | acc], s)
    after
      0 -> {acc, s}
    end
  end

  defp write_dels(_dels, %{mode: :ram} = s), do: s

  defp write_dels(dels, s) do
    s = ensure_seg(s, Clock.now_ms())
    iol = for {k} <- dels, do: record({:del, k})
    sz = IO.iodata_length(iol)

    case :file.write(s.fd, iol) do
      :ok -> %{s | off: s.off + sz, bytes: s.bytes + sz}
      e -> Logger.error("seglog #{s.t}: tombstone falhou #{inspect(e)}") && s
    end
  end

  defp ensure_seg(s, now) do
    day = utc_day(now)

    if s.fd != nil and s.day == day and s.off < seg_max() do
      s
    else
      if s.fd, do: (:file.datasync(s.fd); :file.close(s.fd))
      seg = s.seg + 1
      {:ok, fd} = :file.open(seg_path(s.dir, seg), [:raw, :append, :binary])
      :ets.insert_new(segs(s.t), {seg, 0})
      %{s | fd: fd, seg: seg, off: 0, day: day}
    end
  end

  # ------------------------------------------------------------ releitura

  defp replay(s) do
    t0 = System.monotonic_time(:millisecond)
    now = Clock.now_ms()

    files =
      s.dir
      |> File.ls!()
      |> Enum.filter(&String.ends_with?(&1, ".seg"))
      |> Enum.map(&(&1 |> String.trim_trailing(".seg") |> String.to_integer()))
      |> Enum.sort()

    last = List.last(files)

    {bytes, meta, n} =
      Enum.reduce(files, {0, %{}, 0}, fn seg, {b, meta, n} ->
        path = seg_path(s.dir, seg)
        bin = File.read!(path)
        {good, max_exp, cnt} = scan(s.t, seg, bin, 0, now, 0, 0)

        if good < byte_size(bin) do
          if seg == last do
            Logger.warning("seglog #{s.t}: cauda rasgada em #{seg} (#{byte_size(bin) - good} B) — truncando")
            {:ok, fd} = :file.open(path, [:raw, :read, :write, :binary])
            {:ok, _} = :file.position(fd, good)
            :ok = :file.truncate(fd)
            :file.close(fd)
          else
            ChatyyRouter.Metrics.inc(:seglog_corrupt)
            Logger.error("seglog #{s.t}: registro inválido no meio do segmento #{seg} @#{good}")
          end
        end

        :ets.insert_new(segs(s.t), {seg, 0})
        {b + good, Map.put(meta, seg, max_exp), n + cnt}
      end)

    # vivos por segmento = itens do índice que apontam para ele
    for seg <- files, do: :ets.insert(segs(s.t), {seg, 0})

    :ets.foldl(fn {_k, seg, _, _, _, _}, _ -> :ets.update_counter(segs(s.t), seg, {2, 1}, {seg, 0}) end, :ok, idx(s.t))

    Logger.info(
      "seglog #{s.t}: #{length(files)} segmentos, #{n} registros, #{:ets.info(idx(s.t), :size)} vivos, #{div(bytes, 1024)} KB em #{System.monotonic_time(:millisecond) - t0} ms"
    )

    %{s | seg: last || 0, bytes: bytes, seg_meta: meta}
  end

  defp scan(t, seg, bin, off, now, max_exp, cnt) do
    case bin do
      <<len::32, crc::32, payload::binary-size(len), _::binary>> ->
        if :erlang.crc32(payload) == crc do
          total = 8 + len

          case :erlang.binary_to_term(payload) do
            {:put, k, exp, aux, _v} ->
              if exp >= now do
                :ets.insert(idx(t), {k, seg, off, total, exp, aux})
              else
                :ets.delete(idx(t), k)
              end

              scan(t, seg, binary_part(bin, total, byte_size(bin) - total), off + total, now, max(max_exp, exp), cnt + 1)

            {:del, k} ->
              :ets.delete(idx(t), k)
              scan(t, seg, binary_part(bin, total, byte_size(bin) - total), off + total, now, max_exp, cnt + 1)
          end
        else
          {off, max_exp, cnt}
        end

      _ ->
        {off, max_exp, cnt}
    end
  end

  # ------------------------------------------------------------ coleta de segmentos

  defp gc(%{mode: :ram} = s), do: s

  defp gc(s) do
    now = Clock.now_ms()
    segs = :ets.tab2list(segs(s.t)) |> Enum.sort() |> Enum.reject(fn {seg, _} -> seg == s.seg end)
    do_gc(segs, now, s)
  end

  defp do_gc([], _now, s), do: s

  defp do_gc([{seg, live} | rest], now, s) do
    max_exp = Map.get(s.seg_meta, seg, 0)

    if live <= 0 or max_exp < now do
      if live > 0 do
        n = :ets.select_delete(idx(s.t), [{{:_, seg, :_, :_, :_, :_}, [], [true]}])
        ChatyyRouter.Metrics.inc(:seglog_expired_on_gc, n)
      end

      path = seg_path(s.dir, seg)
      sz = case File.stat(path), do: ({:ok, %{size: z}} -> z; _ -> 0)
      File.rm(path)
      :ets.delete(segs(s.t), seg)
      ChatyyRouter.Metrics.inc(:seglog_segments_deleted)
      do_gc(rest, now, %{s | bytes: max(s.bytes - sz, 0), seg_meta: Map.delete(s.seg_meta, seg)})
    else
      s
    end
  end
end
