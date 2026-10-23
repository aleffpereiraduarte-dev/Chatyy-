defmodule ChatyyRouter.DlvCompareTest do
  @moduledoc "[sgu F0] comparador inbox × fila sombra dlv — lógica pura (sem PG, sem cluster)."
  use ExUnit.Case, async: true
  alias ChatyyRouter.DlvCompare, as: C

  @now 10_000_000
  @g 300_000
  defp old, do: @now - @g - 1
  defp new, do: @now - 1_000

  defp dlv(cid, mid, dev, opts \\ []) do
    %{
      cid: cid,
      mid: mid,
      dev: dev,
      expected: Keyword.get(opts, :expected, true),
      msg_ms: Keyword.get(opts, :msg, old()),
      acked_ms: Keyword.get(opts, :ack),
      persisted_ms: Keyword.get(opts, :per),
      is_sender: Keyword.get(opts, :snd, false)
    }
  end

  defp run(inbox, dlv, prev \\ nil, o \\ []),
    do: C.compare(inbox, dlv, prev, now_ms: @now, grace_ms: @g, persisted_col: Keyword.get(o, :pcol, false), cids: Keyword.get(o, :cids, []))

  test "tudo casando: zero divergência" do
    r = run([{"DA", 959, 1, old()}], [dlv(959, 1, "DA")])
    assert r.gauges == %{inbox_sem_dlv: 0, dlv_sem_inbox: 0, dlv_sem_inbox_remetente: 0, ack_divergente: 0, persisted_divergente: 0}
    assert r.compared == 1
  end

  test "inbox sem dlv (ou dlv não esperava) conta só depois da graça" do
    r = run([{"DA", 959, 1, old()}, {"DA", 959, 2, new()}, {"DB", 959, 3, old()}], [dlv(959, 3, "DB", expected: false)])
    assert r.gauges.inbox_sem_dlv == 2
  end

  test "ack divergente: dlv ackou há > graça e a inbox continua" do
    r = run([{"DA", 959, 1, old()}, {"DA", 959, 2, old()}], [dlv(959, 1, "DA", ack: old()), dlv(959, 2, "DA", ack: new())])
    assert r.gauges.ack_divergente == 1
  end

  test "dlv sem inbox: só aparelho com inbox aqui, conversa no roteador, sem ack, fora da graça" do
    inbox = [{"DA", 959, 1, old()}]
    d = [dlv(959, 2, "DA"), dlv(959, 3, "DA", ack: old()), dlv(959, 4, "DZ"), dlv(2586, 5, "DA"), dlv(959, 6, "DA", msg: new())]
    assert run(inbox, d).gauges.dlv_sem_inbox == 1
    # conversa configurada (ROUTER_F0_CMP_CIDS) entra mesmo sem inbox dela aqui
    assert run(inbox, d, nil, cids: [2586]).gauges.dlv_sem_inbox == 2
  end

  test "o que já esteve na inbox e saiu não é dlv_sem_inbox: vira evento" do
    prev = MapSet.new([{"DA", 959, 1}, {"DA", 959, 2}])
    r = run([{"DA", 959, 1, old()}], [dlv(959, 1, "DA"), dlv(959, 2, "DA")], prev)
    assert r.gauges.dlv_sem_inbox == 0
    assert r.events.inbox_apagada_sem_ack == 1
  end

  test "saiu por ack sem persisted só conta com a coluna" do
    prev = MapSet.new([{"DA", 959, 1}, {"DA", 959, 2}])
    d = [dlv(959, 1, "DA", ack: old()), dlv(959, 2, "DA", ack: old(), per: old())]
    assert run([], d, prev).events == %{inbox_apagada_sem_ack: 0, apagada_sem_persisted: 0}
    r = run([], d, prev, pcol: true)
    assert r.events == %{inbox_apagada_sem_ack: 0, apagada_sem_persisted: 1}
    assert r.persisted == 1
  end

  test "1ª varredura (prev nil) não gera eventos" do
    assert run([], [dlv(959, 1, "DA")]).events == %{inbox_apagada_sem_ack: 0, apagada_sem_persisted: 0}
  end

  test "aparelho do remetente (is_sender) conta à parte" do
    inbox = [{"DA", 959, 1, old()}]
    r = run(inbox, [dlv(959, 1, "DA"), dlv(959, 2, "DA", snd: true), dlv(959, 3, "DA")])
    assert r.gauges.dlv_sem_inbox == 1 and r.gauges.dlv_sem_inbox_remetente == 1
  end

  test "persisted_divergente: gravou (persisted) há > graça, sem ack, inbox pendente — só com a coluna" do
    inbox = [{"DA", 959, 1, old()}, {"DA", 959, 2, old()}]
    d = [dlv(959, 1, "DA", per: old()), dlv(959, 2, "DA", per: new())]
    assert run(inbox, d).gauges.persisted_divergente == 0
    assert run(inbox, d, nil, pcol: true).gauges.persisted_divergente == 1
  end

  test "inbox_rows: só chaves inteiras na janela, com teto" do
    ret = 30 * 86_400_000

    meta = [
      {{"DA", 959, 1}, @now + ret, "us"},
      {{"DA", 959, 2}, @now - 90_000_000 + ret, "us"},
      {{"DA", "959x", 3}, @now + ret, nil},
      {:x, 1, 2}
    ]

    assert C.inbox_rows(meta, ret, @now - 86_400_000, 10) == [{"DA", 959, 1, @now}]
    assert length(C.inbox_rows(List.duplicate(hd(meta), 5), ret, 0, 3)) == 3
  end

  test "parse_dlv com e sem a coluna persisted" do
    assert [%{cid: 959, mid: 7, dev: "DA", expected: true, msg_ms: 5, acked_ms: nil, persisted_ms: nil, is_sender: false}] =
             C.parse_dlv([["959", "7", "DA", "true", "5", nil]])

    assert [%{expected: false, acked_ms: 9, persisted_ms: 11}] = C.parse_dlv([["959", "7", "DA", "false", "5", "9", "11", "false"]])
    assert [%{persisted_ms: nil, is_sender: true}] = C.parse_dlv([["959", "7", "DA", "true", "5", nil, nil, "true"]])
  end

  test "prom_lines vazio antes de subir" do
    :persistent_term.erase({C, :state})
    assert C.prom_lines() == []
  end
end
