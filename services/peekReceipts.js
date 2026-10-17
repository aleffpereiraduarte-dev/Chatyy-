// [2026-10-17 peek-fit] Watermark de leitura do PEER por conversa (1:1),
// guardado quando a conversa abre (chat-conversation: readReceipts → maxReadId,
// que já EXCLUI o meu e-mail = peer-autoritativo). A prévia do toque longo na
// lista (components/chatlist/peekItems.js) usa isto para pintar ✓✓ azul igual
// à conversa — o cache local de mensagens quase nunca traz read_at por linha
// (o visto em 1:1 é watermark monotônico; ver computeTickState).
// Escopo por conta (mesma conv vista por 2 contas no aparelho = peers diferentes).
import { getJSON, setJSON } from './mmkv';

const KEY = 'peek_peer_rr_v1';
const MAX = 400;
let _mem = null; // { "<me>|<convId>": [readId, ts] }
let _timer = null;

function _load() {
  if (_mem) return _mem;
  try {
    const v = getJSON(KEY);
    _mem = v && typeof v === 'object' ? v : {};
  } catch { _mem = {}; }
  return _mem;
}

function _k(me, convId) { return `${String(me || '').toLowerCase()}|${String(convId)}`; }

function _flush() {
  _timer = null;
  try {
    const m = _load();
    const keys = Object.keys(m);
    if (keys.length > MAX) {
      keys.sort((a, b) => ((m[a] && m[a][1]) || 0) - ((m[b] && m[b][1]) || 0));
      for (let i = 0; i < keys.length - MAX; i++) delete m[keys[i]];
    }
    setJSON(KEY, m);
  } catch {}
}

/** Só sobe (monotônico). readId = maior id de msg minha que o peer leu. */
export function notePeerRead(me, convId, readId) {
  const n = Number(readId);
  if (!me || convId == null || !Number.isFinite(n) || n <= 0) return;
  const m = _load();
  const k = _k(me, convId);
  const cur = m[k];
  if (cur && Number(cur[0]) >= n) return;
  m[k] = [n, Date.now()];
  if (!_timer) _timer = setTimeout(_flush, 1500);
}

export function getPeerRead(me, convId) {
  try {
    const cur = _load()[_k(me, convId)];
    const n = cur ? Number(cur[0]) : -1;
    return Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}
