# UX de segurança E2EE v5 — onde plugar (WP-15)

Todos os componentes ficam invisíveis até `isE2eeUiEnabled()` (em `e2eeUi.js`) devolver `true`:
`global.__chatyy_e2ee5_ui === true`, ou `global.__chatyy_e2ee5 === true` sem `__chatyy_e2ee5_ui === false`.
Com a flag desligada, cada componente devolve `null` e cada helper é inofensivo (o
`confirmExitEncryption` resolve `true` sem perguntar). Nada aqui faz cripto: números, QR e estados vêm
do núcleo `chatyy-crypto` (CONTRATO §6).

`app/chat-conversation.js` é do WP-08c: este pacote **não** edita o arquivo. Cada ponto abaixo é uma
chamada de 1 linha dentro dos blocos `[e2ee5]` do WP-08c.

| Componente | Onde entra | Dado que o host passa |
|---|---|---|
| `E2eeTopNotice` | 1º item da lista (cabeçalho do FlatList/CML) quando `e2ee_mode=1` | `calls` = flag `e2ee5_calls`; `onVerify` → abre `SafetyNumberScreen` |
| `E2eeDivider` + `e2eeSysKind(content)` | renderer de mensagem `type='system'`: `e2eeSysKind` dá `'on'`/`'off'`/`null` | `kind`, `name` (de `by_uid`), `reason` |
| `SafetyCodeChangedRow` | linha local inserida pelo host ao receber `SyncResult.identity_changed_uids` | `name`, `kind='changed'\|'new_device'`, `onVerify` |
| `E2eeInfoSheet mode='blocked'` | `encrypt` falhou com `IdentityViolation` (contato verificado trocou de código) | `name`, `onAccept` → `core.pin_identity(uid)` + reenvio, `onVerify` |
| `E2eeMessageState` + `e2eeMessageStateFor(err, envVersion)` | balão no lugar do texto quando a decifragem não deu certo | `state`; `onUpdate` → loja (estado `update_to_read`) |
| `e2eePreviewText(t, state)` | prévia da lista de conversas (`ChatListTab`, WP-08c) e notificação local | `state` |
| `SafetyNumberScreen` | menu da conversa / informações do contato ("Código de segurança") | `load` → `core.safety_number(uid)` + `core.identity_status(uid).verified`; `onVerifyScanned(txt)` → `core.verify_safety_qr(uid, txt)`; `onMarkVerified` → `core.mark_verified(uid)` |
| `E2eeHeaderLock` | ao lado do subtítulo do cabeçalho da conversa | — |
| `E2eeContactInfoRow` | tela de informações do contato/grupo (ChatInfo JS; o ChatInfo nativo recebe os textos por props, pedir ao dono do nativo) | `isGroup`, `onPress` → `SafetyNumberScreen` |
| `NeedsUpdateBanner` | abaixo do cabeçalho ou acima do composer em conversa elegível ainda em texto | `names` dos membros com `capable=false` (`e2ee5_conversation_state`, `blocked_reason='member_needs_update'`) |
| `NotEncryptedBadge` | cartões de jogo e assistir junto (WP-09, só o selo), cabeçalho de canal/comunidade/bot/ponte, cabeçalho de conversa com conta Kids (`blocked_reason='kids'`) | `kind` = `kids`/`game`/`watch`/`gift`/`channel`/`community`/`bot`/`bridge`/`status`/`mural` |
| `confirmExitEncryption(t, kind)` | WP-17, antes de traduzir / Bia / transcrever / resumir numa conversa E2EE; denúncia com `{always:true}` | `kind` = `translate`/`bia`/`transcribe`/`summary`/`report` |

Saúde (WP-18, `services/e2ee/health.js`): o host chama `recordDecrypt(false, reason, mid)` quando
mostra `E2eeMessageState state='waiting'` e `recordResolved(mid)` quando a mensagem decifra depois.
Isso alimenta o gate "UTD depois de 60 s < 0,1 %".

## i18n
Chaves `e2ee5.*` em `i18n/pt-BR.js`, `i18n/en.js` e `i18n/es.js`, no bloco marcado
`[e2ee5 WP-15 2026-10-21]` (início/fim). Outros idiomas caem no fallback (en → pt-BR). Os componentes
também têm o texto pt-BR embutido via `tx()`, então nunca aparece chave crua. O CONTRATO §10 previa
`i18n/e2ee5/*.js` com import em cada locale, mas o `scripts/build-i18n-json.js` avalia cada locale sem
`require`; por isso as chaves entram no próprio arquivo. `npm run i18n:json` regenera o manifesto no
deploy web.

## Ainda não feito neste pacote
- Página "Criptografia" nas configurações e `/var/www/mail/p/criptografia.html` (próxima entrega do WP-15).
- Revisão visual em iOS/Android/web, claro e escuro (precisa da flag ligada num build de QA).
- pt-PT (cai no pt-BR).

## Decisão do founder (21/10): canais
Nos canais NÃO mostrar selo "não criptografado" no cabeçalho. Só uma linha discreta no fim do feed ("Canais são públicos. Saiba mais", 11,5 pt, cor secundária) e uma linha na info do canal. Pílula "Não criptografado" fica só nos cartões de jogo/Assistir junto e no Kids.
