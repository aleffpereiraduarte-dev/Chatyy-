defmodule ChatyyRouter.TestFakeF3 do
  @moduledoc "[sgu F1] F3 de mentira p/ testar o ponto de extensão ChatyyRouter.BodyStore.Purge (lápide da chave {111, 11_002})."
  @behaviour ChatyyRouter.BodyStore.Purge
  @impl true
  def all_persisted(_k, _r), do: :ok
  @impl true
  def purged?(cid, sub), do: {cid, sub} == {111, 11_002}
end
