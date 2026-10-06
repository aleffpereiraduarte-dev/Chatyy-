# Teste no aparelho — fix `[2026-10-06 callkit-dedupe]` (iOS)

Requer build nativo novo (não é OTA). Pré-requisito: iPhone do founder com o build instalado,
logado, e uma segunda conta (Android ou outro iPhone) para ligar. Após cada teste, conferir
`voip_diag.log` no servidor (eventos `native_ios_*`, filtrar pelo e-mail do founder).

## Cenário A — app em background, tela BLOQUEADA (o bug relatado)
1. Abrir o Chatyy, deixar na lista de conversas, bloquear o iPhone (botão lateral). Esperar ~10s.
2. Da outra conta, ligar (áudio) para o founder.
3. Esperado no iPhone: UMA tela de chamada do CallKit (toque + nome/foto), sem duplicar.
4. Deslizar para atender.
5. Esperado: tela nativa de chamada abre, áudio nos dois sentidos em < 2s, status "Conectado".
   No chamador: toque de chamada para, status "Conectado" (NÃO "recusada").
6. Falar 20s, desligar pelo iPhone. Chamador deve ver "encerrada".
7. voip_diag esperado (ordem típica): `ws_yield_to_push` → `ws_yield_push_won`
   (ou `voip_dedupe_reuse_uuid` se o WS reportou antes) → `voipstub_cxanswer_entry` →
   `voipstub_cxanswer_handling` → `voipstub_present_autoaccept`.
   NÃO deve aparecer: `voipstub_no_payload`, `voipstub_duplicate_uuid_quiet_end` com `accepted=true`
   seguido de chamada recusada no chamador.

## Cenário B — app em background, tela DESBLOQUEADA (outro app em primeiro plano)
1. Abrir o Chatyy, ir para a home do iOS (ou abrir outro app).
2. Ligar da outra conta. Atender pelo banner/tela do CallKit.
3. Esperado: igual ao A (uma só tela, abre a chamada nativa, chamador vê "Conectado").

## Cenário C — recusar em background
1. Repetir A, mas tocar em Recusar.
2. Esperado: chamador vê "recusada" imediatamente (< 2s); iPhone sem chamada presa no CallKit.
   voip_diag: SEM `voipstub_duplicate_uuid_quiet_end`.

## Cenário D — chamador desliga antes de atender (durante o toque)
1. Repetir A; na outra conta, desligar após ~1s de toque.
2. Esperado: o toque no iPhone para sozinho; nenhuma chamada fantasma fica tocando.
   voip_diag: `ws_yield_aborted_call_gone` OU o cancel normal do push.

## Cenário E — app em PRIMEIRO PLANO
1. Chatyy aberto na lista de conversas, tela ligada.
2. Ligar da outra conta.
3. Esperado: sheet de chamada do app (comportamento atual, sem CallKit duplicado). Atender →
   tela de chamada → áudio OK → chamador "Conectado".

## Cenário F — app FECHADO (swipe-kill) — regressão do cold-start
1. Fechar o Chatyy pelo app switcher. Bloquear.
2. Ligar da outra conta. Atender pela tela bloqueada.
3. Esperado: tela nativa abre, áudio OK, chamador "Conectado" (caminho só-push, sem WS).

## Cenário G — vídeo
Repetir A com chamada de vídeo. Esperado: CallKit mostra "Vídeo", tela nativa abre com câmera.

## Se falhar
Anotar horário exato + cenário e mandar o trecho do `voip_diag.log` daquele minuto
(eventos `native_ios_ws_*`, `native_ios_voip_*`, `native_ios_voipstub_*`).
