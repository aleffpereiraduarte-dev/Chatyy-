// [apagar-ao-entregar F1 2026-10-22] Aparelho (device_id e2ee5) que vai junto no ack de ENTREGA
// (chat_delivery_ack HTTP, frame WS delivery_ack, chat_push_delivered do push). O servidor grava o ack
// POR APARELHO numa fila sombra (só mede; nada é apagado) e confere que o aparelho é desta conta.
// Sem e2ee5 ligado / sem sessão → '' (o servidor trata como ack sem aparelho, igual a cliente antigo).
//
// [2026-10-22 dlv-device 2] O id é o MESMO do núcleo (e2ee5.deviceIdSync = op.deviceId do open), nunca
// o id anônimo do crashReporter. Antes a 1ª leva de acks do boot saía vazia (sessão e2ee5 ainda abrindo
// e só a task de push consultava a cópia em disco). Agora:
//   - cópia POR CONTA no MMKV (leitura síncrona, hidratada no boot) → o ack sai com o id já no 1º
//     frame/POST, mesmo antes do núcleo abrir;
//   - espelho no AsyncStorage (task de push em 2º plano/headless, onde o MMKV pode não ter hidratado);
//   - conta do ack: a da sessão e2ee5 → a ativa do app → a do token d_ack (push).
// Kill OTA: globalThis.__chatyy_dlv_device = false.

const KEY = '@chatyy_dlv_device_v1';   // AsyncStorage (legado: string; agora JSON {a:{conta:id}, l:conta})
const MM_KEY = 'chatyy_dlv_device_v2'; // MMKV (mesmo JSON)
const DEV_RE = /^[A-Z][A-Z2-7]{12}$/;
let _map = null;      // { conta: device_id }
let _last = '';       // última conta vista com sessão
let _savedJson = '';
let _asTried = false;

function _off() {
  try { return globalThis.__chatyy_dlv_device === false; } catch { return false; }
}

function _AS() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

function _MM() {
  try { return require('./mmkv'); } catch { return null; }
}

function _norm(e) { return String(e || '').trim().toLowerCase(); }

function _parse(raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (DEV_RE.test(s)) return { a: {}, l: '', legacy: s }; // formato antigo (só o id)
  try {
    const j = JSON.parse(s);
    if (!j || typeof j !== 'object') return null;
    const a = {};
    for (const [k, v] of Object.entries(j.a || {})) if (k && DEV_RE.test(String(v))) a[_norm(k)] = String(v);
    return { a, l: _norm(j.l) };
  } catch { return null; }
}

function _merge(p) {
  if (!p) return;
  if (!_map) _map = {};
  for (const [k, v] of Object.entries(p.a || {})) if (!_map[k]) _map[k] = v;
  if (!_last && p.l) _last = p.l;
  if (p.legacy && !_map.__legacy) _map.__legacy = p.legacy;
}

function _load() {
  if (_map) return;
  _map = {};
  try { const mm = _MM(); _merge(_parse(mm && mm.getString(MM_KEY))); } catch {}
}

function _persist() {
  const out = { a: {}, l: _last };
  for (const [k, v] of Object.entries(_map || {})) if (k !== '__legacy') out.a[k] = v;
  const json = JSON.stringify(out);
  if (json === _savedJson) return;
  _savedJson = json;
  try { const mm = _MM(); mm && mm.setString(MM_KEY, json); } catch {}
  const AS = _AS();
  if (AS) { try { AS.setItem(KEY, json).catch(() => {}); } catch {} }
}

function _session() {
  try {
    const s = require('./e2ee/e2ee5').sessionSync?.();
    const d = s && String(s.deviceId || '');
    return d && DEV_RE.test(d) ? { d, email: _norm(s.email) } : null;
  } catch { return null; }
}

function _activeAcct() {
  try { return _norm(require('./api').getActiveAccountEmail?.() || require('./api').getTokenMeta?.()?.email || ''); } catch { return ''; }
}

function _pick(acct) {
  const m = _map || {};
  if (acct && m[acct]) return m[acct];
  if (!acct && _last && m[_last]) return m[_last];
  // conta desconhecida: só arrisca se houver UM aparelho guardado (o servidor confere a conta e,
  // se não bater, conta como '?' — igual a mandar vazio).
  const vals = Object.entries(m).filter(([k]) => k !== '__legacy').map(([, v]) => v);
  if (!acct && vals.length === 1) return vals[0];
  if (!vals.length && m.__legacy) return m.__legacy;
  return '';
}

/** Grava o id do núcleo quando a sessão e2ee5 está aberta. Devolve o id ('' sem sessão). */
function _captureLive() {
  const s = _session();
  if (!s) return '';
  _load();
  const acct = s.email || _activeAcct();
  if (acct && (_map[acct] !== s.d || _last !== acct)) { _map[acct] = s.d; _last = acct; _persist(); }
  return s.d;
}

/** device_id e2ee5 deste aparelho para a conta (padrão: a ativa) — síncrono, nunca bloqueia. */
export function dlvDeviceIdSync(acct) {
  if (_off()) return '';
  const a = _norm(acct);
  const live = _captureLive();
  if (live) {
    const s = _session();
    if (!a || !s || !s.email || s.email === a) return live;
  }
  _load();
  return _pick(a || _activeAcct());
}

/** Igual, mas cai na cópia do AsyncStorage (task de push em 2º plano, MMKV ainda não hidratado). */
export async function dlvDeviceIdAsync(acct) {
  const d = dlvDeviceIdSync(acct);
  if (d || _off()) return d;
  if (!_asTried) {
    _asTried = true;
    const AS = _AS();
    if (AS) { try { _merge(_parse(await AS.getItem(KEY))); } catch {} }
  }
  return _pick(_norm(acct) || _activeAcct());
}

/** Conta (campo `e`) do token d_ack do push — sem validar assinatura (só escolhe o aparelho). */
export function acctOfDack(tok) {
  try {
    const p = String(tok || '').split('.')[0];
    if (!p) return '';
    let b = p.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const raw = typeof atob === 'function' ? atob(b) : (globalThis.Buffer ? globalThis.Buffer.from(b, 'base64').toString('binary') : '');
    const j = JSON.parse(raw || '{}');
    return _norm(j && j.e);
  } catch { return ''; }
}
