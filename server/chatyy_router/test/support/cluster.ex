defmodule ChatyyRouter.TestCluster do
  @moduledoc """
  Cluster local de N nós com :peer (conexão de controle por stdio: o nó de
  teste NÃO entra na malha, então partições são reais entre os peers).
  """

  def start(regions, opts \\ []) do
    uniq = System.unique_integer([:positive])
    names = for r <- regions, do: {r, :"#{r}#{uniq}@127.0.0.1"}

    paths = Enum.flat_map(:code.get_path(), fn p -> [~c"-pa", p] end)

    peers =
      for {r, n} <- names do
        [short, _] = n |> Atom.to_string() |> String.split("@")

        {:ok, pid, ^n} =
          :peer.start(%{
            name: String.to_atom(short),
            host: ~c"127.0.0.1",
            longnames: true,
            connection: :standard_io,
            args:
              paths ++
                [~c"-setcookie", ~c"rt_test_cookie", ~c"-connect_all", ~c"false", ~c"-kernel", ~c"dist_auto_connect", ~c"once"]
          })

        {r, %{pid: pid, node: n}}
      end
      |> Map.new()

    env =
      [
        regions: names,
        quorum: opts[:quorum],
        failover_ms: opts[:failover_ms] || 600,
        tick_ms: opts[:tick_ms] || 100,
        redeliver_ms: opts[:redeliver_ms] || 200,
        idle_ms: 60_000,
        janitor_ms: 3_600_000,
        store: "ram",
        ctl_port: 0,
        autostart: true,
        ack_mode: opts[:ack_mode] || "local",
        flags_file: "/nonexistent/chatyy-router-flags",
        sisters: opts[:sisters] || %{}
      ]
      # [sgu F1] env extra por teste (ex.: PG de ensaio)
      |> Kernel.++(opts[:env] || [])
      |> Enum.reject(fn {_, v} -> v == nil end)

    for {r, p} <- peers do
      rpc(p, :application, :ensure_all_started, [:elixir])
      rpc(p, :application, :load, [:chatyy_router])
      for {k, v} <- [{:region, r} | env], do: rpc(p, :application, :set_env, [:chatyy_router, k, v])
      # [sgu TODOS carga] env por região (ex.: log_dir próprio com store "disc")
      for {k, v} <- (opts[:env_by_region] || fn _ -> [] end).(r), do: rpc(p, :application, :set_env, [:chatyy_router, k, v])
      rpc(p, :logger, :set_primary_config, [:level, :warning])
      rpc(p, :application, :set_env, [:logger, :level, :warning])
      {:ok, _} = rpc(p, :application, :ensure_all_started, [:chatyy_router])
    end

    c = %{peers: peers, regions: regions}
    wait_full_mesh(c)
    c
  end

  def stop(c), do: for({_, p} <- c.peers, do: safe_stop(p.pid))
  def kill(c, r), do: safe_stop(c.peers[r].pid)

  defp safe_stop(pid) do
    try do
      :peer.stop(pid)
    catch
      _, _ -> :ok
    end
  end

  def rpc(%{pid: pid}, m, f, a, t \\ 15_000), do: :peer.call(pid, m, f, a, t)
  def on(c, r, m, f, a, t \\ 15_000), do: rpc(c.peers[r], m, f, a, t)

  def wait_full_mesh(c) do
    eventually(fn ->
      Enum.all?(c.peers, fn {r, _} ->
        length(on(c, r, ChatyyRouter.Net, :alive_regions, [])) == map_size(c.peers)
      end)
    end)
  end

  @doc "Particiona: cada lado bloqueia o outro."
  def partition(c, side_a, side_b) do
    for r <- side_a, do: on(c, r, ChatyyRouter.Net, :block, [side_b])
    for r <- side_b, do: on(c, r, ChatyyRouter.Net, :block, [side_a])
    :ok
  end

  def heal(c, side_a, side_b) do
    for r <- side_a, do: on(c, r, ChatyyRouter.Net, :unblock, [side_b])
    for r <- side_b, do: on(c, r, ChatyyRouter.Net, :unblock, [side_a])
    :ok
  end

  def eventually(fun, timeout \\ 10_000, step \\ 50) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_eventually(fun, deadline, step)
  end

  defp do_eventually(fun, deadline, step) do
    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) > deadline do
        raise "eventually: condição não satisfeita"
      else
        Process.sleep(step)
        do_eventually(fun, deadline, step)
      end
    end
  end
end

defmodule ChatyyRouter.TestProbe do
  @moduledoc "Aparelho falso dentro de um peer: guarda os frames recebidos."
  def start(device, auto_ack) do
    name = name(device)
    {:ok, _} = Agent.start(fn -> [] end, name: name)
    pid = spawn(fn -> loop(name) end)
    ChatyyRouter.Hub.Stub.subscribe(device, pid: pid, auto_ack: auto_ack)
  end

  def frames(device), do: Agent.get(name(device), &Enum.reverse/1)
  def seqs(device), do: for(m <- frames(device), do: m.seq)

  defp name(d), do: :"probe_#{d}"

  defp loop(name) do
    receive do
      {:rt_frame, _d, msg} -> Agent.update(name, &[msg | &1])
    end

    loop(name)
  end
end
