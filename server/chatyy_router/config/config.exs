import Config
# Tudo vem de variáveis de ambiente (ChatyyRouter.Config); nada de segredo aqui.
config :logger, level: :info
if config_env() == :test do
  config :chatyy_router, autostart: false
  config :logger, level: :warning
end
