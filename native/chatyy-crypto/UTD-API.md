# UTD-API — contrato núcleo ⇄ host [e2ee5 utd-wa 2026-10-23] (BUILD)

Fonte: `src/utd.rs`. Mudou algo aqui? Avise o lado JS/hosts antes.

## prewarmConversation
- Host: `invoke('prewarmConversation', {convId: string, memberUids: string[]})` (rede: prazo 35 s).
- Rust: `prewarm_conversation(conv_id: String, member_uids: Vec<String>) -> PrewarmResult`.
- Faz o que o `encrypt` faz antes de cifrar, sem cifrar: keys_query + keys_claim + share_room_key
  (chave da sessão de saída atual, ou de uma nova se a atual girou) para TODOS os aparelhos que ainda
  não a têm; grava `record_share` (regra do pedido de chave). Idempotente (2ª chamada = 0 pedidos).
- Retorno: `{keyShareRequests: u32, keyShareBytes: u64, sessionId: string}`.

## backupFetchSession
- Host: `invoke('backupFetchSession', {convId: string, sessionId: string})` (rede: prazo 35 s).
- Rust: `backup_fetch_session(conv_id: String, session_id: String) -> BackupFetchResult`.
- Usa a chave de decifração do backup JÁ guardada no store (backup ligado/restaurado neste aparelho);
  `backup_keys_get {version, room_id, session_id}` (servidor sem filtro devolve tudo; o núcleo filtra).
- Retorno: `{imported: u32, reason: string, convs: string[]}`;
  reason: `""` ok · `have` (já tinha) · `no_backup` · `not_found`.

## Build sem os métodos
Host antigo → erro `unsupported` (iOS `ChatyyCryptoHostError("unsupported")`, Android idem): o JS desliga o atalho e segue.
