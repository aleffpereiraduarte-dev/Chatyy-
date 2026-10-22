defmodule ChatyyRouter.MixProject do
  use Mix.Project

  # Protótipo do roteador de mensagens por região-casa (PLANO §8).
  # Zero dependências Hex de propósito: compila offline nos edges e o
  # release (com ERTS) roda sem instalar Erlang no host.
  def project do
    [
      app: :chatyy_router,
      version: "0.1.0",
      elixir: "~> 1.17",
      elixirc_paths: if(Mix.env() == :test, do: ["lib", "test/support"], else: ["lib"]),
      start_permanent: Mix.env() == :prod,
      deps: [],
      releases: [
        chatyy_router: [
          include_erts: true,
          include_executables_for: [:unix],
          applications: [runtime_tools: :permanent],
          steps: [:assemble]
        ]
      ]
    ]
  end

  def application do
    [
      mod: {ChatyyRouter.Application, []},
      extra_applications: [:logger, :crypto, :ssl, :public_key, :mnesia]
    ]
  end
end
