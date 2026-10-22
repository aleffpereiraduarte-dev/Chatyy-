defmodule ChatyyRouter.Delivery do
  @moduledoc """
  Lado da REGIÃO DO APARELHO: grava na inbox por aparelho (store-and-forward,
  expira em 30 d, corpo no Seglog com fsync), confirma a quem mandou que a
  região guardou e entrega ao hub. 8 shards por nó (hash do cid).

  Quem mandou pode ser:
    * a casa no cluster (ConvServer) → {:region_stored, seq, região};
    * R1 — casa EXTERNA (US): o `ChatyyRouter.Fanout` da região do remetente
      → {:ext_stored, cid, seq, região}. Aqui `seq` = message_id do US.
  Sem gravar (disco cheio/E/S) não confirma: quem mandou reentrega.
  """
  use GenServer
  alias ChatyyRouter.{Config, Net, Store, Telemetry}

  @shards 8
  def shards, do: @shards
  def name(cid), do: :"rt_delivery_#{rem(:erlang.phash2(cid), @shards)}"
  def name_i(i), do: :"rt_delivery_#{i}"

  def child_specs do
    for i <- 0..(@shards - 1) do
      Supervisor.child_spec({__MODULE__, name_i(i)}, id: {__MODULE__, i})
    end
  end

  def start_link(name), do: GenServer.start_link(__MODULE__, nil, name: name)

  @doc """
  Aparelho confirmou até `upto` na conversa: apaga da inbox local e, se a casa
  é uma região do cluster, avisa a casa (AckOutbox). Casa externa (R1): o US
  já sabe do ack pelo caminho de hoje (chat_delivery_ack → fila sombra dlv).
  """
  def ack(device, cid, upto) do
    rows = Store.inbox_upto_home(device, cid, upto)
    for {seq, _} <- rows, do: Store.delete(:rt_inbox, {device, cid, seq})
    regions = Config.region_names()

    # casa "us" do R1 é EXTERNA (master PG), não casa do cluster — mesmo com o 11º nó us no anel:
    # só vira casa do cluster se a HomeTable tiver registro explícito (senão o ack ia ao AckOutbox e
    # morria em no_home → ack_outbox_dropped)
    ext? = fn h -> h in Config.fanout_skip_regions() and not match?({^h, _, :explicit}, ChatyyRouter.HomeTable.lookup(cid)) end

    cluster_home? =
      case rows |> Enum.map(&elem(&1, 1)) |> Enum.uniq() do
        [] -> elem(ChatyyRouter.HomeTable.lookup(cid), 0) in regions
        homes -> Enum.any?(homes, &(&1 in regions and not ext?.(&1)))
      end

    if cluster_home?, do: ChatyyRouter.AckOutbox.add(cid, device, upto)

    Telemetry.execute([:chatyy_router, :ack], %{count: 1})
    :ok
  end

  def fetch(device) do
    for {cid, seq, {msg, _exp}} <- Store.inbox(device), do: %{msg | cid: cid, seq: seq}
  end

  @impl true
  def init(_), do: {:ok, %{}}

  @impl true
  def handle_cast({:deliver, msg, devs}, s) do
    exp = msg.ts + Config.retention_ms()
    fresh = Enum.reject(devs, fn d -> Store.member?(:rt_inbox, {d, msg.cid, msg.seq}) end)
    slim = Map.delete(msg, :home_pid)

    case Store.put_many(:rt_inbox, for(d <- fresh, do: {{d, msg.cid, msg.seq}, {slim, exp}})) do
      :ok ->
        confirm(msg)
        Telemetry.execute([:chatyy_router, :deliver, :stored], %{count: length(fresh)}, %{region: Net.me()})
        for d <- fresh, do: ChatyyRouter.Hub.push(d, msg)

      {:error, _} ->
        Telemetry.execute([:chatyy_router, :deliver, :store_error], %{count: length(fresh)})
    end

    {:noreply, s}
  end

  defp confirm(%{home_pid: pid, ext: true} = msg) when is_pid(pid),
    do: Net.cast_pid(pid, {:ext_stored, msg.cid, msg.seq, Net.me()})

  defp confirm(%{home_pid: pid} = msg) when is_pid(pid), do: Net.cast_pid(pid, {:region_stored, msg.seq, Net.me()})
  defp confirm(_), do: :ok
end

defmodule ChatyyRouter.Fanout do
  @moduledoc """
  R1 — entrega de mensagem cuja CASA É EXTERNA (hoje o master US). A mensagem
  já foi gravada no US pelo caminho de hoje (leaf/PHP); o leaf da região do
  remetente chama `POST 127.0.0.1:4790/fanout` e este módulo:
    1. resolve os aparelhos destino (Directory, ou a lista que veio);
    2. agrupa por região e manda à `Delivery` de cada região (inbox local com
       fsync + entrega pelo hub de lá) — sem passar pelo US;
    3. guarda em RAM o que ainda não foi confirmado por região e reentrega a
       cada ROUTER_REDELIVER_MS até ROUTER_FANOUT_TTL_MS (10 min).
  Não é fonte da verdade: se este nó cair, o app recupera pelo caminho de
  hoje (sync do US). Por isso a fila de pendências é só RAM.
  Kill: RT_FANOUT=0 no arquivo de flags (ou POST /flags?fanout=0) → `disabled`
  e o leaf usa o broadcast de hoje.
  """
  use GenServer
  alias ChatyyRouter.{Config, Directory, Net, Telemetry}

  @shards 4
  def name(cid), do: :"rt_fanout_#{rem(:erlang.phash2(cid), @shards)}"

  def child_specs do
    for i <- 0..(@shards - 1),
        do: Supervisor.child_spec({__MODULE__, :"rt_fanout_#{i}"}, id: {__MODULE__, i})
  end

  def start_link(name), do: GenServer.start_link(__MODULE__, nil, name: name)

  @doc """
  req: %{cid, seq (message_id do US), home ("us"), from, from_device, body,
         ts?, meta?, devices? [{device, região}]}
  → {:ok, %{regions: n, devices: n}} | {:error, :disabled | :no_recipients}
  """
  def fanout(req) do
    if ChatyyRouter.Flags.fanout?() do
      GenServer.call(name(req.cid), {:fanout, req}, 10_000)
    else
      {:error, :disabled}
    end
  end

  @doc """
  Igual a `fanout/1`, mas não espera: o leaf e o hub chamam o /fanout com timeout de 300 ms e a resolução
  de destinos (diretório + presença perguntada ao cluster, ~8×RTT no pior caso) passava disso → eles
  contavam "fail" com a entrega feita. Ordem por conversa preservada (mesmo shard, fila do GenServer).
  """
  def fanout_async(req) do
    if ChatyyRouter.Flags.fanout?() do
      GenServer.cast(name(req.cid), {:fanout, req})
      {:ok, %{queued: true}}
    else
      {:error, :disabled}
    end
  end

  def pending, do: Enum.sum(for i <- 0..(@shards - 1), do: GenServer.call(:"rt_fanout_#{i}", :pending))

  @impl true
  def init(_) do
    Process.send_after(self(), :redeliver, Config.redeliver_ms())
    {:ok, %{pend: %{}}}
  end

  @impl true
  def handle_call(:pending, _f, s), do: {:reply, map_size(s.pend), s}

  def handle_call({:fanout, req}, _f, s), do: run(req, s)

  defp run(req, s) do
    t0 = System.monotonic_time(:microsecond)
    devs =
      case req[:devices] do
        nil -> Directory.recipients_result(req.cid, req[:from_device])
        l -> {:ok, l}
      end

    case devs do
      {:error, _} -> {:reply, {:error, :directory_unavailable}, s}
      {:ok, []} -> {:reply, {:error, :no_recipients}, s}
      {:ok, devs} -> do_fanout(req, devs, t0, s)
    end
  end

  defp do_fanout(req, devs, t0, s) do
      msg = %{
        cid: req.cid,
        seq: req.seq,
        epoch: req[:epoch] || 0,
        home: req[:home] || "us",
        ext: true,
        home_pid: self(),
        from: req[:from],
        from_device: req[:from_device],
        cmi: req[:cmi],
        body: req[:body],
        frame: req[:frame],
        msg_id: req.seq,
        ts: req[:ts] || ChatyyRouter.Clock.now_ms(),
        meta: req[:meta] || %{}
      }

      regions = Config.region_names() -- Config.fanout_skip_regions()
      # RT_OFFLINE=skip: aparelho sem presença em NENHUMA região (região = fallback deste nó) não é guardado
      # aqui — ele vai reconectar noutro edge e esta inbox nunca seria lida; fica no caminho de hoje (root+push)
      skip_off? = ChatyyRouter.Flags.get(:offline_skip) == true and req[:devices] == nil
      {inside, outside} =
        Enum.split_with(devs, fn {d, r} -> r in regions and not (skip_off? and Directory.fallback?(d)) end)
      if skip_off? and outside != [], do: ChatyyRouter.Metrics.inc(:fanout_offline_skip, Enum.count(outside, fn {d, _} -> Directory.fallback?(d) end))
      # aparelho fora do cluster ou em região pulada (WS direto no hub US) fica no caminho de hoje
      if outside != [], do: Telemetry.execute([:chatyy_router, :fanout, :outside], %{count: length(outside)})
      by_region = Enum.group_by(inside, &elem(&1, 1), &elem(&1, 0))
      for {r, ds} <- by_region, do: Net.cast(r, ChatyyRouter.Delivery.name(msg.cid), {:deliver, msg, ds})
      key = {msg.cid, msg.seq}
      dl = System.monotonic_time(:millisecond) + Config.get(:fanout_ttl_ms, 600_000)
      s = %{s | pend: Map.put(s.pend, key, {msg, by_region, dl})}
      Telemetry.execute([:chatyy_router, :fanout, :stop], %{duration_us: System.monotonic_time(:microsecond) - t0})
      s = if by_region == %{}, do: %{s | pend: Map.delete(s.pend, key)}, else: s
      {:reply, {:ok, %{regions: map_size(by_region), devices: length(inside), outside: length(outside)}}, s}
  end

  @impl true
  def handle_cast({:fanout, req}, s) do
    {:reply, res, s} =
      try do
        run(req, s)
      rescue
        _ -> {:reply, {:error, :crash}, s}
      end

    case res do
      {:error, e} -> Telemetry.execute([:chatyy_router, :fanout, :async_error], %{count: 1}, %{error: e})
      _ -> :ok
    end

    {:noreply, s}
  end

  def handle_cast({:ext_stored, cid, seq, region}, s) do
    key = {cid, seq}

    pend =
      case Map.get(s.pend, key) do
        nil ->
          s.pend

        {msg, by_region, dl} ->
          left = Map.delete(by_region, region)
          if left == %{}, do: Map.delete(s.pend, key), else: Map.put(s.pend, key, {msg, left, dl})
      end

    {:noreply, %{s | pend: pend}}
  end

  @impl true
  def handle_info(:redeliver, s) do
    now = System.monotonic_time(:millisecond)

    pend =
      for {key, {msg, by_region, dl} = v} <- s.pend, reduce: %{} do
        acc ->
          if now > dl do
            Telemetry.execute([:chatyy_router, :fanout, :expired], %{count: map_size(by_region)})
            acc
          else
            for {r, ds} <- by_region, Net.alive?(r) do
              Net.cast(r, ChatyyRouter.Delivery.name(msg.cid), {:deliver, msg, ds})
              Telemetry.execute([:chatyy_router, :fanout, :redeliver], %{count: 1})
            end

            Map.put(acc, key, v)
          end
      end

    Process.send_after(self(), :redeliver, Config.redeliver_ms())
    {:noreply, %{s | pend: pend}}
  end
end

defmodule ChatyyRouter.AckOutbox do
  @moduledoc """
  Acks a caminho da casa. Coalesce por {cid, device} (fica o maior seq) e
  reenvia até a casa (ou a nova casa após failover) confirmar.

  Backoff por linha (correção 22/10: antes reenviava TUDO a cada 20 ms para
  sempre — 61–70 linhas presas custavam 11–14 % de 1 núcleo em repouso):
    * falha → próxima tentativa em min(200 ms · 2^tentativas, 60 s) (+ jitter);
    * `{:error, :no_home}` (ninguém no cluster tem casa p/ o cid: nada a
      confirmar) → descarta na 3ª vez;
    * linha com mais de ROUTER_ACK_TTL_MS (24 h) → descarta (o corpo na casa
      expira pelo Janitor em 30 d de qualquer jeito);
    * métricas: ack_outbox (gauge), ack_outbox_stuck (≥ 5 tentativas, alerta
      no monitor), ack_outbox_dropped_total.
  """
  use GenServer
  alias ChatyyRouter.{Config, Router}

  @ets :rt_ack_outbox
  @max_backoff 60_000

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # linha: {{cid, dev}, upto, tentativas, próxima_ms, criada_ms}
  def add(cid, device, upto) do
    key = {cid, device}
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@ets, key) do
      [{_, u, _, _, _}] when u >= upto -> :ok
      [{_, _u, _n, _nx, t0}] -> :ets.insert(@ets, {key, upto, 0, now, t0})
      [] -> :ets.insert(@ets, {key, upto, 0, now, now})
    end

    :ok
  end

  def pending, do: :ets.info(@ets, :size)
  def stuck, do: :ets.select_count(@ets, [{{:_, :_, :"$1", :_, :_}, [{:>=, :"$1", 5}], [true]}])

  @impl true
  def init(_) do
    if :ets.whereis(@ets) == :undefined do
      :ets.new(@ets, [:named_table, :public, :set, write_concurrency: true])
    end

    send(self(), :flush)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:flush, s) do
    now = System.monotonic_time(:millisecond)
    ttl = Config.get(:ack_ttl_ms, 86_400_000)
    due = :ets.select(@ets, [{{:_, :_, :_, :"$1", :_}, [{:"=<", :"$1", now}], [:"$_"]}])

    due
    |> Task.async_stream(
      fn {key = {cid, dev}, upto, n, _nx, t0} = row ->
        case Router.home_cast_ack(cid, dev, upto) do
          :ok ->
            :ets.delete_object(@ets, row)

          other ->
            cond do
              now - t0 > ttl or (other == {:error, :no_home} and n >= 2) ->
                :ets.delete_object(@ets, row)
                ChatyyRouter.Metrics.inc(:ack_outbox_dropped)

              true ->
                back = min(200 * Integer.pow(2, min(n, 12)), @max_backoff)
                # só reagenda se ninguém mexeu na linha nesse meio tempo
                :ets.select_replace(@ets, [
                  {{key, upto, n, :_, t0}, [], [{{{:const, key}, upto, n + 1, now + back + :rand.uniform(div(back, 4) + 1), t0}}]}
                ])
            end
        end
      end,
      max_concurrency: 64,
      timeout: 10_000,
      on_timeout: :kill_task
    )
    |> Stream.run()

    Process.send_after(self(), :flush, if(due == [], do: 200, else: 50))
    {:noreply, s}
  end
end
