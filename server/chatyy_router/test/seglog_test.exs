defmodule ChatyyRouter.SeglogTest do
  @moduledoc "Seglog em modo DISCO (um nó, sem cluster): durabilidade, releitura, cauda rasgada, GC em ordem."
  use ExUnit.Case, async: false
  alias ChatyyRouter.{Clock, Seglog}

  @t :rt_seg_test
  @far 4_102_444_800_000

  setup do
    dir = Path.join(System.tmp_dir!(), "seglog-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    ChatyyRouter.Metrics.init()
    for {k, v} <- [store: "disc", log_dir: dir, fsync: "always", seg_max_bytes: 32 * 1_048_576, log_max_mb: 20_480] do
      Application.put_env(:chatyy_router, k, v)
    end

    on_exit(fn ->
      stop()
      for k <- [:store, :log_dir, :fsync, :seg_max_bytes, :log_max_mb], do: Application.delete_env(:chatyy_router, k)
      File.rm_rf!(dir)
    end)

    start()
    {:ok, dir: Path.join(dir, Atom.to_string(@t))}
  end

  defp start do
    {:ok, pid} = Seglog.start_link(@t)
    Process.unlink(pid)
    pid
  end

  defp stop do
    case Process.whereis(:"#{@t}_w") do
      nil -> :ok
      pid -> GenServer.stop(pid)
    end
  end

  defp restart, do: (stop(); start())

  test "put/get/delete sobrevivem a reinício; delete não ressuscita" do
    for i <- 1..100, do: :ok = Seglog.put(@t, {"c1", i}, %{body: "m#{i}"}, @far, {i})
    for i <- 1..50, do: Seglog.delete(@t, {"c1", i})
    restart()
    assert Seglog.size(@t) == 50
    assert Seglog.get(@t, {"c1", 10}) == nil
    assert Seglog.get(@t, {"c1", 77}) == %{body: "m77"}
    # leitura fria (cache quente vazio após reinício) vem do disco
    assert :ets.info(Seglog.hot(@t), :size) == 0
    assert Seglog.select_keys(@t, {"c1", :"$1"}, [{:"=<", :"$1", 60}], :"$1") == Enum.to_list(51..60)
  end

  test "cauda rasgada no último segmento é truncada no último registro íntegro", %{dir: dir} do
    for i <- 1..10, do: :ok = Seglog.put(@t, {"c", i}, i, @far)
    stop()
    [seg] = File.ls!(dir)
    File.write!(Path.join(dir, seg), <<0, 0, 1, 0, 9, 9, 9>>, [:append])
    start()
    assert Seglog.size(@t) == 10
    assert Seglog.get(@t, {"c", 10}) == 10
    :ok = Seglog.put(@t, {"c", 11}, 11, @far)
    restart()
    assert Seglog.get(@t, {"c", 11}) == 11
  end

  test "vencidos somem na releitura e no expire" do
    now = Clock.now_ms()
    :ok = Seglog.put(@t, {"x", 1}, :velho, now + 50)
    :ok = Seglog.put(@t, {"x", 2}, :novo, @far)
    Process.sleep(80)
    assert Seglog.expire(@t, Clock.now_ms()) == 1
    assert Seglog.get(@t, {"x", 1}) == nil
    :ok = Seglog.put(@t, {"x", 3}, :vence, Clock.now_ms() + 50)
    Process.sleep(80)
    restart()
    assert Seglog.get(@t, {"x", 3}) == nil
    assert Seglog.get(@t, {"x", 2}) == :novo
  end

  test "GC só apaga segmentos em ordem (tombstone nunca some antes do put)", %{dir: dir} do
    Application.put_env(:chatyy_router, :seg_max_bytes, 1)
    restart()
    # 1 registro por segmento: s1 = put k1, s2 = put k3, s3 = del k1 (tombstone), s4 = put k4
    :ok = Seglog.put(@t, :k1, 1, @far)
    :ok = Seglog.put(@t, :k3, 3, @far)
    Seglog.delete(@t, :k1)
    :sys.get_state(:"#{@t}_w")
    :ok = Seglog.put(@t, :k4, 4, @far)
    send(Process.whereis(:"#{@t}_w"), :gc)
    :sys.get_state(:"#{@t}_w")
    # s1 ficou sem vivos e é o mais velho → apagado; s2 tem k3 vivo → para aí (s3 com o tombstone fica)
    segs = File.ls!(dir) |> Enum.sort()
    assert length(segs) == 3
    restart()
    assert Seglog.get(@t, :k1) == nil
    assert Seglog.get(@t, :k3) == 3
    Seglog.delete(@t, :k3)
    :sys.get_state(:"#{@t}_w")
    send(Process.whereis(:"#{@t}_w"), :gc)
    :sys.get_state(:"#{@t}_w")
    restart()
    assert Seglog.get(@t, :k1) == nil and Seglog.get(@t, :k3) == nil
    assert Seglog.get(@t, :k4) == 4
  end

  test "group commit: 500 escritas concorrentes, todas duráveis, menos fsyncs que escritas" do
    b0 = ChatyyRouter.Metrics.counter(:seglog_batches)

    1..500
    |> Task.async_stream(fn i -> Seglog.put(@t, {"g", i}, :crypto.strong_rand_bytes(200), @far) end, max_concurrency: 64)
    |> Enum.each(fn {:ok, r} -> assert r == :ok end)

    batches = ChatyyRouter.Metrics.counter(:seglog_batches) - b0
    assert batches < 500
    restart()
    assert Seglog.size(@t) == 500
    IO.puts("\n  group commit: 500 escritas em #{batches} fsyncs")
  end

  test "teto de disco devolve disk_full (o chamador não confirma)" do
    Application.put_env(:chatyy_router, :log_max_mb, 0)
    assert Seglog.put(@t, :a, 1, @far) == {:error, :disk_full}
    assert Seglog.get(@t, :a) == nil
  end

  test "put_many grava tudo com 1 fsync" do
    b0 = ChatyyRouter.Metrics.counter(:seglog_batches)
    :ok = Seglog.put_many(@t, for(i <- 1..50, do: {{"pm", i}, i, @far, nil}))
    assert ChatyyRouter.Metrics.counter(:seglog_batches) - b0 == 1
    restart()
    assert Seglog.size(@t) == 50
  end
end
