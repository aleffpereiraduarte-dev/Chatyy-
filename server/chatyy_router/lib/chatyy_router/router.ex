defmodule ChatyyRouter.Router do
  @moduledoc """
  API pública, chamada no nó da REGIÃO DO REMETENTE (o leaf/PHP local fala
  com ele por 127.0.0.1). Descobre a casa, chama o dono (pid em cache), e
  trata `moved` (migração/failover) refazendo com o mesmo cmi.
  """
  alias ChatyyRouter.{Directory, Home, HomeTable, Net, Telemetry}

  @cache :rt_pid_cache

  def init_cache do
    if :ets.whereis(@cache) == :undefined do
      :ets.new(@cache, [:named_table, :public, :set, read_concurrency: true, write_concurrency: true])
    end
  end

  @doc """
  Envia. `opts`: :devices (lista {device, região}; padrão = Directory),
  :meta (mapa opaco, ex.: bench), :timeout.
  Retorna {:ok, seq, epoch} | {:error, motivo}. Erro => o chamador reenvia
  com o MESMO cmi (a casa deduplica) ou cai no caminho de hoje (kill switch).
  """
  def send_msg(cid, from, from_device, cmi, body, opts \\ []) do
    t0 = System.monotonic_time(:microsecond)

    devices =
      case opts[:devices] do
        nil -> Directory.recipients_result(cid, from_device)
        l -> {:ok, l}
      end

    res =
      cond do
        not ChatyyRouter.Flags.route?() ->
          {:error, :disabled}

        # falha do PG/diretório NUNCA vira "sem destinatários" (senão a casa apagaria a msg)
        match?({:error, _}, devices) ->
          {:error, :directory_unavailable}

        true ->
          {:ok, devs} = devices
          req = %{from: from, from_device: from_device, cmi: cmi, body: body, meta: opts[:meta] || %{}, devices: devs}
          attempt(cid, {:send, req}, opts[:timeout] || 5_000, 4)
      end

    result =
      case res do
        {:ok, _, _} -> :ok
        {:error, e} -> e
        _ -> :other
      end

    Telemetry.execute([:chatyy_router, :send, :stop], %{duration_us: System.monotonic_time(:microsecond) - t0}, %{result: result, cid: cid})
    res
  end

  def ack(device, cid, upto), do: ChatyyRouter.Delivery.ack(device, cid, upto)
  def fetch(device), do: ChatyyRouter.Delivery.fetch(device)

  @doc "Migra a casa da conversa para `to` (drena, copia, CAS epoch+1)."
  def migrate(cid, to), do: attempt(cid, {:migrate, to}, 20_000, 2, false)

  @doc false
  def home_cast_ack(cid, device, upto) do
    # ack NUNCA cria casa (bug da carga r4: o ack no SG criou uma 2ª casa)
    case attempt(cid, {:acked, device, upto}, 3_000, 2, false) do
      :ok -> :ok
      other -> other
    end
  end

  defp attempt(cid, msg, timeout, n, create \\ true)
  defp attempt(_cid, _msg, _timeout, 0, _create), do: {:error, :retries}

  defp attempt(cid, msg, timeout, n, create) do
    case conv_pid(cid, create) do
      {:ok, pid} ->
        case Net.call_pid(pid, msg, timeout) do
          {:moved, r, e} ->
            HomeTable.merge(cid, r, e)
            :ets.delete(@cache, cid)
            attempt(cid, msg, timeout, n - 1, create)

          {:error, err} when err in [:noproc, :retry] ->
            :ets.delete(@cache, cid)
            Process.sleep(10)
            attempt(cid, msg, timeout, n - 1, create)

          {:error, :unreachable} ->
            :ets.delete(@cache, cid)
            {:error, :home_unreachable}

          other ->
            other
        end

      {:moved, r, e} ->
        HomeTable.merge(cid, r, e)
        attempt(cid, msg, timeout, n - 1, create)

      {:error, _} = err ->
        err
    end
  end

  defp conv_pid(cid, create) do
    case :ets.lookup(@cache, cid) do
      [{_, pid}] ->
        if Net.pid_alive?(pid), do: {:ok, pid}, else: (:ets.delete(@cache, cid); conv_pid(cid, create))

      [] ->
        region =
          case HomeTable.lookup(cid) do
            {r, _, :explicit} ->
              r

            {proposer, _, :default} ->
              # sem registro local: pergunta à maioria antes de qualquer coisa
              case HomeTable.resolve(cid) do
                {:ok, r, _} -> r
                :none -> if create, do: proposer, else: :no_home
                {:error, _} -> :unknown
              end
          end

        res =
          cond do
            region == :no_home ->
              {:error, :no_home}

            region == :unknown ->
              {:error, :home_unknown}

            # casa fora do cluster (R1: "us"): escrita continua pelo caminho de hoje
            region not in ChatyyRouter.Config.region_names() ->
              {:error, :external_home}

            region == Net.me() ->
              Home.ensure(cid, create: create)

            true ->
              case Net.call(region, Home, {:ensure_remote, cid, create}, 10_000) do
                {:error, :unreachable} -> {:error, :home_unreachable}
                r -> r
              end
          end

        with {:ok, pid} <- res, do: :ets.insert(@cache, {cid, pid})
        res
    end
  end
end
