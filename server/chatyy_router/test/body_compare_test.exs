defmodule ChatyyRouter.BodyCompareTest do
  @moduledoc "[sgu F1] comparador roteador × PG (lógica pura) + casa (A2) normalizada."
  use ExUnit.Case, async: false
  alias ChatyyRouter.{BodyCompare, BodyHome, BodyStore}

  @now 1_790_000_000_000
  defp mid(ms_ago, n \\ 0), do: BodyCompare.mid_floor(@now - ms_ago) + n
  defp sha(x), do: BodyStore.sha(x)

  defp run(pg, local, peers, dlv, rx \\ []),
    do: BodyCompare.compare(pg, rx, local, peers, dlv, now_ms: @now, grace_ms: 120_000, wanted: 2, since_mid: mid(86_400_000))

  test "mid Snowflake ↔ ms" do
    m = mid(10_000, 7)
    assert BodyCompare.mid_ms(m) == @now - 10_000
  end

  test "tudo certo = 0 em todos os kinds" do
    m = mid(600_000)
    pg = [%{mid: m, sha: sha("x"), type: "text", deleted: false}]
    local = %{m => {@now - 600_000, sha("x"), ["d1", "d2"], :msg}}
    peers = %{"b" => %{m => sha("x")}, "c" => %{m => sha("x")}}
    r = run(pg, local, peers, %{m => MapSet.new(["d1", "d2"])})
    assert Enum.all?(r.gauges, fn {_, n} -> n == 0 end)
    assert r.compared == 1
  end

  test "faltando na casa, hash diferente, irmã faltando/diferente, inbox faltando/sobrando" do
    [m1, m2, m3, m4] = for i <- 1..4, do: mid(600_000, i)
    pg = for {m, x} <- [{m1, "a"}, {m2, "b"}, {m3, "c"}, {m4, "d"}], do: %{mid: m, sha: sha(x), type: "text", deleted: false}

    local = %{
      m2 => {0, sha("ERRADO"), ["d1"], :msg},
      m3 => {0, sha("c"), ["d1"], :msg},
      m4 => {0, sha("d"), ["d1", "d9"], :msg}
    }

    peers = %{"b" => %{m3 => sha("c"), m4 => sha("d")}, "c" => %{m3 => sha("OUTRO"), m4 => sha("d")}}
    dlv = %{m3 => MapSet.new(["d1", "d2"]), m4 => MapSet.new(["d1"])}
    r = run(pg, local, peers, dlv)
    assert r.samples[:faltando_casa] == [m1]
    assert r.samples[:hash_diferente] == [m2]
    assert r.samples[:faltando_irma] == [m3]
    assert r.samples[:hash_diferente_irma] == [m3]
    assert r.samples[:inbox_faltando] == [m3]
    assert r.samples[:inbox_sobrando] == [m4]
    assert r.missing_by_type == %{"text" => 1}
  end

  test "em voo (graça), apagada no PG, só no roteador, aparelhos desconhecidos, reações" do
    fresh = mid(5_000)
    gone = mid(600_000, 1)
    only = mid(600_000, 2)
    unk = mid(600_000, 3)

    pg = [
      %{mid: fresh, sha: sha("f"), type: "text", deleted: false},
      %{mid: gone, sha: sha(""), type: "text", deleted: true},
      %{mid: unk, sha: sha("u"), type: "text", deleted: false}
    ]

    local = %{
      gone => {@now - 600_000, sha("orig"), ["d1"], :msg},
      only => {@now - 600_000, sha("o"), ["d1"], :msg},
      unk => {@now - 600_000, sha("u"), nil, :msg},
      {:rx, unk, "u2@chatyy.com.br", "r"} => {@now, sha("r-velha"), ["d1"], :reaction},
      # estado (v) do MESMO usuário na MESMA mensagem é outra chave: não colide com a reação
      {:rx, unk, "u2@chatyy.com.br", "v"} => {@now, sha("v-estado"), ["d1"], :reaction}
    }

    peers = %{"b" => %{unk => sha("u")}, "c" => %{unk => sha("u")}}

    rx = [
      %{ref: unk, email: "u2@chatyy.com.br", sha: sha("r-nova"), type: "r"},
      %{ref: unk, email: "u2@chatyy.com.br", sha: sha("v-estado"), type: "v"},
      %{ref: unk, email: "u3@chatyy.com.br", sha: sha("r3"), type: "r"}
    ]

    r = run(pg, local, peers, %{}, rx)
    assert r.gauges.faltando_casa == 0
    assert r.samples[:apagada_no_pg] == [gone]
    assert r.samples[:so_no_roteador] == [only]
    assert r.samples[:aparelhos_desconhecidos] == [unk]
    assert r.samples[:reacao_hash_diferente] == [{:rx, unk, "u2@chatyy.com.br", "r"}]
    assert r.samples[:reacao_faltando] == [{:rx, unk, "u3@chatyy.com.br", "r"}]
    assert r.compared == 2
  end

  test "parse das linhas do PG" do
    assert [%{mid: 5, sha: "ab", type: "text", deleted: true}] = BodyCompare.parse_pg([["5", "ab", "text", "true"]])
    assert [%{ref: 5, email: "x@chatyy.com.br", type: "v"}] = BodyCompare.parse_rx([["5", "X@onemundo.com.br", "s", "v"]])
    assert BodyCompare.parse_dlv([["5", "d1"], ["5", "d2"]]) == %{5 => MapSet.new(["d1", "d2"])}
  end

  test "casa (A2): home_region normalizado; 'us'/vazio/desconhecido → HRW igual em todo nó" do
    old = Application.get_all_env(:chatyy_router)

    try do
      Application.put_env(:chatyy_router, :regions, for(r <- ~w(br br2 scl mia usw us), do: {r, :"router@#{r}"}))
      Application.put_env(:chatyy_router, :never_sister, ["us"])
      Application.put_env(:chatyy_router, :sisters, %{"br" => ["br2", "scl"], "mia" => ["usw"]})
      assert BodyHome.normalize("usw-qa") == "usw"
      assert BodyHome.normalize(" SCL ") == "scl"
      assert BodyHome.normalize("us") == nil
      assert BodyHome.normalize("xx") == nil
      h = BodyHome.fallback_home(959)
      assert h in ~w(br br2 scl mia usw) and h == BodyHome.fallback_home(959)
      # A4: o BR deixa de ter o BR2 como irmã preferida (outro provedor/país)
      assert ChatyyRouter.Config.body_sisters()["br"] == ["scl", "mia"]
      assert Enum.take(BodyHome.chain("br"), 2) == ["scl", "mia"]
      refute "us" in BodyHome.chain("mia")
    after
      for {k, _} <- Application.get_all_env(:chatyy_router), not Keyword.has_key?(old, k), do: Application.delete_env(:chatyy_router, k)
      for {k, v} <- old, do: Application.put_env(:chatyy_router, k, v)
    end
  end
end
