// [e2ee5 WP-18 2026-10-21] Beacon de saúde do E2EE v5 no HOST (só contagens, nunca conteúdo nem ids).
//
// Divisão de trabalho com o núcleo (sem contar nada duas vezes):
//   - o núcleo `chatyy-crypto` já manda, por flush_metrics() → e2ee5_metrics, o MetricsSnapshot:
//     encrypt, decrypt_ok, utd_total, utd.<motivo>, to_device_in, to_device_utd, dropped_untrusted…
//   - este módulo manda SÓ o que o núcleo não sabe medir, no objeto `counters`:
//       utd_60s          mensagem que continuou "aguardando" por mais de 60 s (métrica do GATE)
//       utd_resolved     "aguardando" que depois decifrou
//       enc_le50 / enc_le150 / enc_le500 / enc_gt500   tempo de cifrar visto pelo host (ms)
//       missing_sessions envio que precisou abrir sessão (keys_claim) antes de cifrar
//       plaintext_refused servidor respondeu e2ee5_plaintext_refused
//       nse_fallback     notificação mostrou "Nova mensagem" por não decifrar a tempo
// O monitor/painel do WP-18 calculam UTD>60 s = utd_60s / (decrypt_ok + utd_60s).
// [pendente WP-05] o e2ee5.php de 21/10 só grava os campos do snapshot; precisa aceitar também
// `counters` com esses nomes (até 20 por chamada, 0..10000). Até lá o envio é inofensivo.
//
// Desligado por padrão: tudo é no-op enquanto global.__chatyy_e2ee5 !== true.
// Quem chama (WP-08c no JS; o nativo pode chamar pela ponte):
//   e2eeHealth.setTransport((action, body) => api.e2ee5Call(action, body))   // 1x no boot do E2EE
//   e2eeHealth.recordEncrypt(ms, { claimed })      // claimed = precisou de keys_claim
//   e2eeHealth.recordDecrypt(false, reason, key)   // UTD retentável; key = mid/cmid local, só em memória
//   e2eeHealth.recordResolved(key)                 // a mensagem "aguardando" decifrou depois
//   e2eeHealth.recordPlaintextRefused()
//   e2eeHealth.recordNseFallback()
//   e2eeHealth.flush()                             // ao ir para 2º plano (também roda sozinho a cada 10 min)
// O `key` nunca sai do aparelho: serve só para contar uma vez a mensagem que passou de 60 s.
import { Platform } from 'react-native';

const FLUSH_MS = 10 * 60 * 1000;
const UTD_GATE_MS = 60 * 1000;
const MAX_PENDING = 500;
const RETRYABLE = new Set(['missing_session', 'unknown_index', 'store', 'untrusted_device']);

let _transport = null;
let _counters = Object.create(null);
let _pending = new Map(); // key → { t0, counted }
let _timer = null;
let _gateTimer = null;
let _flushing = false;

function _on() {
  try { const g = typeof globalThis !== 'undefined' ? globalThis : global; return g.__chatyy_e2ee5 === true; } catch { return false; }
}

function _inc(name, n = 1) {
  _counters[name] = Math.min(10000, (_counters[name] || 0) + n);
  _arm();
}

function _arm() {
  if (_timer) return;
  try { _timer = setTimeout(() => { _timer = null; flush(); }, FLUSH_MS); } catch {}
}

function _sweepGate() {
  const now = Date.now();
  for (const [k, p] of _pending) {
    if (!p.counted && now - p.t0 >= UTD_GATE_MS) { p.counted = true; _inc('utd_60s'); }
    if (now - p.t0 > 24 * 3600 * 1000) _pending.delete(k);
  }
  if (_pending.size && !_gateTimer) {
    try { _gateTimer = setTimeout(() => { _gateTimer = null; _sweepGate(); }, UTD_GATE_MS + 500); } catch {}
  }
}

export function setTransport(fn) { _transport = typeof fn === 'function' ? fn : null; }

export function recordEncrypt(ms, opts = {}) {
  if (!_on()) return;
  const v = Number(ms) || 0;
  _inc(v <= 50 ? 'enc_le50' : v <= 150 ? 'enc_le150' : v <= 500 ? 'enc_le500' : 'enc_gt500');
  if (opts && opts.claimed) _inc('missing_sessions');
}

export function recordDecrypt(ok, reason, key) {
  if (!_on() || ok) return; // decrypt_ok/utd_total já vêm do núcleo
  if (!RETRYABLE.has(String(reason || ''))) return; // não retentável não "aguarda"
  if (key != null && _pending.size < MAX_PENDING && !_pending.has(String(key))) {
    _pending.set(String(key), { t0: Date.now(), counted: false });
    _sweepGate();
  }
}

export function recordResolved(key) {
  if (!_on()) return;
  const k = String(key);
  const p = _pending.get(k);
  if (!p) return;
  _pending.delete(k);
  _inc('utd_resolved');
  if (!p.counted && Date.now() - p.t0 >= UTD_GATE_MS) _inc('utd_60s');
}

// [e2ee5 1.7 keyreq] contadores nomeados (só os que o e2ee5_metrics aceita).
const NAMED = new Set(['key_request_sent', 'key_request_served', 'key_request_ok', 'native_timeout', 'native_err', 'core_slow']);
// [e2ee5 utd-wa 2026-10-23] + família utdw_* (tempo/motivo em "aguardando"; o servidor grava com o kit utd-wa)
const UTDW_RE = /^utdw_[a-z0-9_]{1,40}$/;
export function recordCounter(name, n = 1) { const k = String(name); if (_on() && (NAMED.has(k) || UTDW_RE.test(k)) && n > 0) _inc(k, n); }

export function recordPlaintextRefused() { if (_on()) _inc('plaintext_refused'); }
export function recordNseFallback(n = 1) { if (_on() && n > 0) _inc('nse_fallback', n); }

// Envia e zera. Em falha devolve os contadores para a próxima vez (sem perder nem duplicar).
export async function flush() {
  if (!_on() || !_transport || _flushing) return false;
  _sweepGate();
  const names = Object.keys(_counters).filter((k) => _counters[k] > 0);
  if (!names.length) return true;
  _flushing = true;
  const snap = _counters;
  _counters = Object.create(null);
  let ok = true;
  try {
    for (let i = 0; i < names.length; i += 20) {
      const counters = {};
      names.slice(i, i + 20).forEach((k) => { counters[k] = snap[k]; });
      try {
        await _transport('metrics', { platform: Platform.OS, app_version: _appVersion(), counters });
        names.slice(i, i + 20).forEach((k) => { delete snap[k]; });
      } catch { ok = false; }
    }
  } finally {
    Object.keys(snap).forEach((k) => { _counters[k] = Math.min(10000, (_counters[k] || 0) + snap[k]); });
    _flushing = false;
    if (Object.keys(_counters).length) _arm();
  }
  return ok;
}

function _appVersion() {
  try { return String(require('expo-constants').default?.expoConfig?.version || ''); } catch { return ''; }
}

// Só para testes/diagnóstico (sem conteúdo).
export function _peek() { return { counters: { ..._counters }, pending: _pending.size }; }

const e2eeHealth = { setTransport, recordEncrypt, recordDecrypt, recordResolved, recordPlaintextRefused, recordNseFallback, recordCounter, flush, _peek };
export default e2eeHealth;
