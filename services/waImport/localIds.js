// [wa-import-local 2026-10-22] Ids da importação do WhatsApp SÓ NO APARELHO (sem servidor).
// Puro (sem react-native): usado pelo openConversation (caminho quente) e pelos testes em node.
//
// Conversa local:  id = -(CONV_BASE + slot)        → nunca colide com conversa do servidor (> 0)
// Mensagem local:  id = MSG_BASE + slot·MSG_SPAN + seq (seq 1.., em ordem cronológica)
//   MSG_BASE 8e15 + 9e6 slots × 1e8 < Number.MAX_SAFE_INTEGER (9,007e15) → inteiro exato no JS/SQLite.
//   Ids POSITIVOS de propósito: o backup v4 (cloudBackup._localMsgs) pagina as mensagens locais por
//   id > 0 decrescente; a ordem por id = ordem cronológica do export.
// slot = sha256(conta|chave do export) → reimportar o mesmo export gera os MESMOS ids (idempotente).

export const CONV_BASE = 1000000000;      // 1e9
export const SLOTS = 9000000;             // 9e6
export const MSG_BASE = 8000000000000000; // 8e15
export const MSG_SPAN = 100000000;        // 1e8 mensagens por importação

export function localConvId(slot) { return -(CONV_BASE + (Number(slot) || 0)); }
export function slotOfConvId(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n > -CONV_BASE || n <= -(CONV_BASE + SLOTS)) return -1;
  return -n - CONV_BASE;
}
export function isLocalImportConvId(id) {
  if (id == null || id === '') return false;
  return slotOfConvId(id) >= 0;
}
export function localMsgId(slot, seq) { return MSG_BASE + (Number(slot) || 0) * MSG_SPAN + (Number(seq) || 0); }
export function isLocalImportMsgId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n >= MSG_BASE && n < MSG_BASE + SLOTS * MSG_SPAN;
}
/** slot a partir de um hex (sha256) — 8 primeiros dígitos mod SLOTS. */
export function slotFromHex(hex, probe = 0) {
  const v = parseInt(String(hex || '').slice(0, 8), 16);
  const base = Number.isFinite(v) ? v % SLOTS : 0;
  return (base + (Number(probe) || 0)) % SLOTS;
}
