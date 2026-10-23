defmodule ChatyyRouter.SeglogCompact do
  @moduledoc """
  [sgu F3 2026-10-23] Compactação física do `ChatyyRouter.Seglog` (plano §6.1 b).

  Problema: o Seglog só apaga um arquivo de segmento quando ele é o MAIS VELHO e não tem item vivo
  (ou está todo vencido). Uma mensagem pendente de 30 d segura o segmento do dia inteiro, e os corpos
  já confirmados (apagados do índice, mas ainda no arquivo) ficam no disco até 30 d.

  Solução (sem cripto nova): reescrever os registros VIVOS dos segmentos velhos num segmento NOVO e
  deixar o GC normal do Seglog (30 s) apagar os arquivos antigos, em ordem. Política: "até ~24 h no
  disco depois do ack" (ROUTER_COMPACT_MS = 24 h, ROUTER_COMPACT_MIN_AGE_MS = 20 h).

  Como roda: DENTRO do processo escritor do Seglog (`Seglog.compact/2` do diff de integração; sem o
  diff, `:sys.replace_state/2`, que executa a função no próprio escritor). Assim nenhuma escrita (put,
  tombstone) corre em paralelo: o escritor é serial. Passos, por chamada (até `max_bytes`):
    1. candidatos = prefixo CONSECUTIVO dos segmentos mais velhos (exceto o ativo) com mtime mais
       velho que `min_age_ms` (o GC só apaga em ordem: compactar o 3º sem o 1º não libera nada);
    2. para cada item vivo do índice nesses segmentos (exp > agora + 1 h, para não disputar com o
       `Seglog.expire` do Janitor): lê o REGISTRO BRUTO (len+crc+termo) com pread e confere o CRC;
    3. abre um segmento novo (seg+1, vira o ativo), escreve tudo e faz `datasync`;
    4. só então troca o ponteiro no índice com `:ets.select_replace` CONDICIONAL (a entrada ainda
       aponta para {seg, off} antigo). Se um `Seglog.delete` (que roda no processo de quem chama,
       com `:ets.take`) levou a chave antes, a troca não acontece e o registro copiado fica morto
       (conta `races`); o tombstone desse delete é escrito pelo escritor DEPOIS deste lote, então a
       releitura também o vê apagado. Se o delete vier depois da troca, ele decrementa o segmento
       novo (o `take` devolve o ponteiro novo).
    5. contadores de vivos: -1 no antigo, +1 no novo; `seg_meta`/`bytes` do escritor atualizados.

  Invariante do Seglog preservada: um tombstone nunca some antes do put que ele anula — os
  segmentos são apagados em ordem e os puts vivos movidos ficam num segmento mais novo que qualquer
  tombstone antigo. Queda no meio: antes do passo 4 a releitura acha os dois puts iguais (o mais novo
  vence, mesmo valor); depois, só o novo é apontado.

  Corrida aceita: um leitor que pegou o ponteiro antigo logo antes da troca e abre o arquivo depois
  de o GC apagá-lo (≥ 30 s depois) recebe nil + `seglog_read_error` (janela de microssegundos).

  `dry_run: true` (padrão do PurgeGc): só mede (vivos/mortos, quanto moveria) e não escreve nada.
  """
  require Logger
  alias ChatyyRouter.{Clock, Seglog}

  @margin_ms 3_600_000

  @doc """
  Compacta a tabela `t`. opts: dry_run (true), min_age_ms (20 h), max_bytes (64 MB por chamada).
  Devolve %{moved, bytes, segments, races, expired_skip, live_bytes, dead_bytes, candidates}.
  """
  def compact(t, opts \\ []) do
    w = Process.whereis(:"#{t}_w") || raise "seglog #{t} não está rodando"

    if function_exported?(Seglog, :compact, 2) and not Keyword.get(opts, :force_sys, false) do
      # Seglog.compact/2 vem do diff de integração (apply/3: compila sem ele)
      apply(Seglog, :compact, [t, opts])
    else
      me = self()
      ref = make_ref()

      :sys.replace_state(
        w,
        fn s ->
          {r, s2} =
            try do
              run(s, opts)
            rescue
              e -> {%{error: inspect(e) |> String.slice(0, 200)}, s}
            end

          send(me, {ref, r})
          s2
        end,
        600_000
      )

      receive do
        {^ref, r} -> r
      after
        5_000 -> %{error: :sem_resposta}
      end
    end
  end

  @doc "Executa com o ESTADO do escritor (chamar só de dentro do processo escritor). → {resumo, estado}"
  def run(%{mode: :ram} = s, _opts), do: {%{mode: :ram, moved: 0, bytes: 0, segments: 0, races: 0}, s}

  def run(s, opts) do
    dry = Keyword.get(opts, :dry_run, true)
    min_age = Keyword.get(opts, :min_age_ms, 20 * 3_600_000)
    max_bytes = Keyword.get(opts, :max_bytes, 64 * 1_048_576)
    now = Clock.now_ms()
    t = s.t
    idx = Seglog.idx(t)

    segs = :ets.tab2list(Seglog.segs(t)) |> Enum.map(&elem(&1, 0)) |> Enum.sort() |> Enum.reject(&(&1 == s.seg))
    sizes = Map.new(segs, fn seg -> {seg, file_info(seg_path(s.dir, seg))} end)

    # vivos por segmento, em bytes (índice: {key, seg, off, len, exp, aux})
    live_by_seg =
      :ets.foldl(fn {_k, seg, _off, len, _exp, _aux}, acc -> Map.update(acc, seg, len, &(&1 + len)) end, %{}, idx)

    total = s.bytes
    live_bytes = live_by_seg |> Map.values() |> Enum.sum()

    cut = System.os_time(:second) - div(min_age, 1000)

    candidates =
      segs
      |> Enum.take_while(fn seg ->
        case sizes[seg] do
          {_, mtime} -> mtime <= cut
          nil -> true
        end
      end)

    # só o que o GC vai poder apagar (prefixo) e com algo vivo dentro; segmento sem vivo o GC já apaga
    work = Enum.filter(candidates, &(Map.get(live_by_seg, &1, 0) > 0))

    base = %{
      dry_run: dry,
      candidates: length(candidates),
      live_bytes: live_bytes,
      dead_bytes: max(total - live_bytes, 0),
      moved: 0,
      bytes: 0,
      segments: 0,
      races: 0,
      expired_skip: 0
    }

    if work == [] do
      {base, s}
    else
      {items, skipped, used} = collect(work, idx, now, max_bytes)

      cond do
        dry ->
          {%{base | moved: length(items), bytes: used, segments: count_segs(items), expired_skip: skipped}, s}

        items == [] ->
          {%{base | expired_skip: skipped}, s}

        true ->
          write_and_swap(items, s, %{base | expired_skip: skipped})
      end
    end
  end

  defp count_segs(items), do: items |> Enum.map(& &1.seg) |> Enum.uniq() |> length()

  # itens vivos (ordem de segmento/offset) até o teto de bytes
  defp collect(work, idx, now, max_bytes) do
    Enum.reduce_while(work, {[], 0, 0}, fn seg, {acc, sk, used} ->
      rows = :ets.select(idx, [{{:"$1", seg, :"$2", :"$3", :"$4", :"$5"}, [], [{{:"$1", :"$2", :"$3", :"$4", :"$5"}}]}])
      rows = Enum.sort_by(rows, &elem(&1, 1))

      {acc, sk, used} =
        Enum.reduce(rows, {acc, sk, used}, fn {k, off, len, exp, aux}, {a, sk, u} ->
          if exp < now + @margin_ms,
            do: {a, sk + 1, u},
            else: {[%{k: k, seg: seg, off: off, len: len, exp: exp, aux: aux} | a], sk, u + len}
        end)

      if used >= max_bytes, do: {:halt, {acc, sk, used}}, else: {:cont, {acc, sk, used}}
    end)
    |> then(fn {a, sk, u} -> {Enum.reverse(a), sk, u} end)
  end

  defp write_and_swap(items, s, res) do
    t = s.t
    # lê os registros brutos (CRC conferido); os que falharem ficam onde estão
    {raw, bad} =
      items
      |> Enum.group_by(& &1.seg)
      |> Enum.reduce({[], 0}, fn {seg, its}, {acc, bad} ->
        case :file.open(seg_path(s.dir, seg), [:raw, :read, :binary]) do
          {:ok, fd} ->
            {acc, bad} =
              Enum.reduce(its, {acc, bad}, fn it, {a, b} ->
                case :file.pread(fd, it.off, it.len) do
                  {:ok, <<_l::32, crc::32, bin::binary>> = rec} when byte_size(rec) == it.len ->
                    if :erlang.crc32(bin) == crc, do: {[{it, rec} | a], b}, else: {a, b + 1}

                  _ ->
                    {a, b + 1}
                end
              end)

            :file.close(fd)
            {acc, bad}

          _ ->
            {acc, bad + length(its)}
        end
      end)

    raw = Enum.reverse(raw)
    if bad > 0, do: ChatyyRouter.Metrics.inc(:seglog_compact_read_error, bad)

    if raw == [] do
      {res, s}
    else
      # segmento novo (vira o ativo; as escritas normais seguem nele)
      if s.fd, do: (:file.datasync(s.fd); :file.close(s.fd))
      seg = s.seg + 1
      {:ok, fd} = :file.open(seg_path(s.dir, seg), [:raw, :append, :binary])
      :ets.insert_new(Seglog.segs(t), {seg, 0})

      {placed, iol, off} =
        Enum.reduce(raw, {[], [], 0}, fn {it, rec}, {p, io, off} -> {[{it, off} | p], [io, rec], off + byte_size(rec)} end)

      case :file.write(fd, iol) do
        :ok ->
          :ok = :file.datasync(fd)
          idx = Seglog.idx(t)

          {moved, races} =
            Enum.reduce(placed, {0, 0}, fn {it, noff}, {m, r} ->
              ms = [
                {{:"$1", it.seg, it.off, :"$2", :"$3", :"$4"}, [{:"=:=", :"$1", {:const, it.k}}],
                 [{{:"$1", seg, noff, :"$2", :"$3", :"$4"}}]}
              ]

              case :ets.select_replace(idx, ms) do
                1 ->
                  bump(t, it.seg, -1)
                  bump(t, seg, 1)
                  {m + 1, r}

                _ ->
                  {m, r + 1}
              end
            end)

          # contador de vivos dos segmentos de origem = o que o índice ainda aponta (corrige deriva
          # antiga, ex. expire × delete): com 0, o GC do Seglog apaga o arquivo na próxima volta
          for oseg <- raw |> Enum.map(fn {it, _} -> it.seg end) |> Enum.uniq() do
            n = :ets.select_count(idx, [{{:_, oseg, :_, :_, :_, :_}, [], [true]}])
            :ets.insert(Seglog.segs(t), {oseg, n})
          end

          max_exp = raw |> Enum.map(fn {it, _} -> it.exp end) |> Enum.max()
          meta = Map.update(s.seg_meta, seg, max_exp, &max(&1, max_exp))
          s = %{s | fd: fd, seg: seg, off: off, day: div(Clock.now_ms(), 86_400_000), bytes: s.bytes + off, seg_meta: meta}

          Logger.info("seglog #{t}: compactação moveu #{moved} itens (#{div(off, 1024)} KB) p/ o segmento #{seg}; corridas #{races}")
          {%{res | moved: moved, bytes: off, segments: count_segs(Enum.map(raw, &elem(&1, 0))), races: races}, s}

        e ->
          :file.close(fd)
          File.rm(seg_path(s.dir, seg))
          :ets.delete(Seglog.segs(t), seg)
          Logger.error("seglog #{t}: compactação falhou na escrita #{inspect(e)} — nada trocado")
          # fd antigo foi fechado: o próximo put abre segmento novo (day: nil força ensure_seg)
          {Map.put(res, :error, :io), %{s | fd: nil, day: nil, seg: seg}}
      end
    end
  end

  defp bump(t, seg, by) do
    try do
      :ets.update_counter(Seglog.segs(t), seg, {2, by}, {seg, 0})
    catch
      :error, :badarg -> :ok
    end
  end

  defp file_info(path) do
    case File.stat(path, time: :posix) do
      {:ok, %{size: z, mtime: m}} -> {z, m}
      _ -> nil
    end
  end

  # mesmo formato do Seglog (`<dir>/<id 10 dígitos>.seg`)
  defp seg_path(d, seg), do: Path.join(d, :io_lib.format("~10..0B.seg", [seg]) |> IO.iodata_to_binary())
end
