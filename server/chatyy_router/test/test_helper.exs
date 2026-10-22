# O nó de teste precisa de distribuição só para o :peer nomear os filhos;
# a conexão de controle é por stdio (o nó de teste não entra na malha).
unless Node.alive?() do
  {:ok, _} = :net_kernel.start(:"rt_test_runner@127.0.0.1", %{name_domain: :longnames})
end

ExUnit.start(exclude: [:bench], timeout: 180_000)
