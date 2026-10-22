defmodule ChatyyRouter.Application do
  @moduledoc false
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    if ChatyyRouter.Config.autostart?() do
      start_full()
    else
      Supervisor.start_link([], strategy: :one_for_one, name: ChatyyRouter.Supervisor)
    end
  end

  defp start_full do
    ChatyyRouter.Metrics.init()
    ChatyyRouter.Router.init_cache()
    :ok = ChatyyRouter.Store.init()

    Logger.info(
      "router: região=#{ChatyyRouter.Config.region()} nó=#{node()} regiões=#{inspect(ChatyyRouter.Config.region_names())} quórum=#{ChatyyRouter.Config.quorum()}"
    )

    ctl = if ChatyyRouter.Config.ctl_port() > 0, do: [ChatyyRouter.Control], else: []

    children =
      [
        %{id: :pg, start: {:pg, :start_link, [:chatyy_router]}},
        {Registry, keys: :unique, name: ChatyyRouter.ConvRegistry},
        ChatyyRouter.Flags,
        ChatyyRouter.HomeTable,
        ChatyyRouter.Directory,
        ChatyyRouter.Hub.Stub,
        ChatyyRouter.Replica,
        {DynamicSupervisor, name: ChatyyRouter.ConvSup, strategy: :one_for_one, max_restarts: 1000, max_seconds: 1},
        ChatyyRouter.Home
      ] ++
        ChatyyRouter.Delivery.child_specs() ++
        [
          ChatyyRouter.AckOutbox,
          ChatyyRouter.Net.Cluster,
          ChatyyRouter.Failover,
          ChatyyRouter.Janitor
        ] ++ ctl

    Supervisor.start_link(children, strategy: :one_for_one, name: ChatyyRouter.Supervisor, max_restarts: 20, max_seconds: 10)
  end
end
