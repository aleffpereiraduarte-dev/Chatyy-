// services/bootIdle.js — [perf 2026-10-17 boot-fanout] "depois do boot" p/ trabalho
// que NÃO é do caminho crítico (diagnósticos, autochecagens, telemetria nativa,
// prefetch de perfil, início do backup de fotos).
//
// Medido nos logs do nginx (perf_pass_2026_10_17): 36–56 requests nos primeiros
// 15 s de cada abertura, metade diagnóstico (push_diag ×3,7, backup_debug,
// callkit_diag, sqlite_self_check) disputando o rádio/conexões com chat_list /
// chat_sync / chat_messages — o que o usuário está esperando ver.
//
// runWhenBootIdle(fn, { minMs, key }) roda `fn`:
//   • já, se o boot já passou de `minMs` desde o início do JS;
//   • senão depois da 1ª pintura (bootTrace.afterFirstPaint, teto próprio) E de
//     `minMs` desde o início do JS E de InteractionManager ocioso (teto 3 s);
//   • a fila drena espaçada (STAGGER_MS) — nunca vira uma 2ª rajada.
//   `key` = coalesce: a mesma chave na fila troca a função (vale a última).
//
// Kill switch (OTA): globalThis.__chatyy_boot_dedupe === false → tudo roda na hora
// (comportamento anterior). Mesmo switch do single-flight/host fixo de avatar.
import { InteractionManager } from 'react-native';

const T0 = (() => {
  try { const bt = require('./bootTrace'); const t = bt && bt.getBootT0 && bt.getBootT0(); if (t > 0) return t; } catch {}
  return Date.now();
})();
const STAGGER_MS = 120;
const IDLE_CAP_MS = 3000;
const QUEUE_MAX = 80;

export const BOOT_IDLE_DEFAULT_MS = 25000;

export function bootDeferOff() {
  try { return globalThis.__chatyy_boot_dedupe === false; } catch { return false; }
}
export function bootElapsedMs() { return Date.now() - T0; }
/** true enquanto o app está nos primeiros `ms` do boot (e o adiamento está ligado). */
export function inBootWindow(ms = BOOT_IDLE_DEFAULT_MS) {
  return !bootDeferOff() && bootElapsedMs() < ms;
}

const _queue = []; // { fn, key, due }
let _timer = null;
let _painted = false;
let _paintArmed = false;
let _draining = false;

function _safe(fn) { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {} }

function _armPaint() {
  if (_paintArmed) return;
  _paintArmed = true;
  let fired = false;
  const done = () => { if (fired) return; fired = true; _painted = true; _schedule(); };
  try { require('./bootTrace').afterFirstPaint(done, 0); } catch { done(); }
  // Boot em 2º plano (push/VoIP/BG fetch) pode nunca pintar → teto.
  setTimeout(done, 8000);
}

let _timerAt = 0;
function _schedule() {
  if (_draining || !_queue.length || !_painted) return;
  let next = Infinity;
  for (const it of _queue) if (it.due < next) next = it.due;
  if (_timer) {
    if (next >= _timerAt) return;
    try { clearTimeout(_timer); } catch {}
    _timer = null;
  }
  const wait = Math.max(0, next - Date.now());
  _timerAt = Date.now() + wait;
  _timer = setTimeout(() => {
    _timer = null;
    _draining = true; // segura novos agendamentos durante a espera de ocioso
    let idleDone = false;
    const go = () => { if (idleDone) return; idleDone = true; _drain(); };
    try { InteractionManager.runAfterInteractions(go); } catch { go(); }
    setTimeout(go, IDLE_CAP_MS);
  }, wait);
}

function _drain() {
  _draining = true;
  const now = Date.now();
  const ready = [];
  for (let i = 0; i < _queue.length;) {
    if (_queue[i].due <= now) ready.push(_queue.splice(i, 1)[0]); else i++;
  }
  let k = 0;
  const step = () => {
    if (k >= ready.length) { _draining = false; _schedule(); return; }
    const it = ready[k++];
    _safe(it.fn);
    setTimeout(step, STAGGER_MS);
  };
  step();
}

export function runWhenBootIdle(fn, opts = {}) {
  if (typeof fn !== 'function') return;
  const minMs = Number(opts.minMs) >= 0 ? Number(opts.minMs) : BOOT_IDLE_DEFAULT_MS;
  if (bootDeferOff() || (bootElapsedMs() >= minMs && _queue.length === 0)) {
    setTimeout(() => _safe(fn), 0);
    return;
  }
  const due = T0 + minMs;
  if (opts.key) {
    const ex = _queue.find(it => it.key === opts.key);
    if (ex) { ex.fn = fn; return; }
  }
  if (_queue.length >= QUEUE_MAX) _queue.shift(); // diagnóstico velho cai primeiro
  _queue.push({ fn, key: opts.key || null, due });
  _armPaint();
  _schedule();
}

export default { runWhenBootIdle, inBootWindow, bootElapsedMs, bootDeferOff, BOOT_IDLE_DEFAULT_MS };
