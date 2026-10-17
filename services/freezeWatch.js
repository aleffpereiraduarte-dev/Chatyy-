// [2026-10-17 freeze] Forense de "o app trava e tenho que fechar e abrir".
//
// Telemetria do founder (push_diag 16–17/10) só mostrava boot_start 7–23 s
// depois de um foreground/login — sem crash, sem stall, sem nada: não dava
// p/ separar JS travado (loop/render infinito) de camada invisível bloqueando
// toque (Modal órfão no iOS) de main thread nativa presa. Isto adiciona:
//   • js_stall      — o timer de 1 s atrasou > STALL_MS com o app ATIVO
//                     (JS thread bloqueada); leva rota + Modais abertos;
//   • prev_end      — no boot seguinte: como o processo anterior morreu.
//                     as=active  → morreu com o JS parado/ativo (sem ir p/ 2º plano);
//                     as=inactive→ morto pelo seletor de apps (o caso "fechar e abrir");
//                     m=…        → Modais RN que estavam abertos (services/modalGuardIOS)
//                     tap=…      → segundos desde o último toque que chegou na raiz.
// Snapshot persistido a cada SNAP_MS só com o app ativo (AsyncStorage, ~100 B).
// Kill switch: globalThis.__chatyy_freeze_watch = false.
import { AppState, Platform } from 'react-native';

const KEY = '@chatyy/freeze_snap_v1';
const TICK_MS = 1000;
const STALL_MS = 2500;
const SNAP_MS = 5000;
const PREV_MAX_AGE_MS = 30 * 60 * 1000;

let _started = false;
let _route = '';
let _lastTouch = 0;
let _appState = 'active';
let _lastTick = 0;
let _lastSnap = 0;
let _stalls = 0;
let _maxStall = 0;
let _stallPosts = 0;
let _prevRead = false; // não sobrescrever o snapshot do processo anterior antes de lê-lo
const _bootAt = Date.now();

function _AS() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } // eslint-disable-line global-require
}
function _report(step, info) {
  try { require('./crashReporter').reportStep(step, String(info || '').slice(0, 300)); } catch {} // eslint-disable-line global-require
}
function _modals() {
  try {
    const g = require('./modalGuardIOS'); // eslint-disable-line global-require
    return (g && typeof g.getOpenModals === 'function') ? g.getOpenModals() : [];
  } catch { return []; }
}

export function setFreezeRoute(r) {
  try { _route = String(r || '').slice(0, 48); } catch {}
}
// Chamado por um responder de CAPTURA na raiz (não consome o toque).
export function noteRootTouch() { _lastTouch = Date.now(); }

function _snap(now) {
  if (!_prevRead) return;
  const AS = _AS();
  if (!AS) return;
  _lastSnap = now;
  const m = _modals();
  const o = {
    t: now, as: _appState, r: _route, m: m.slice(0, 4).join(','), n: m.length,
    tap: _lastTouch ? Math.round((now - _lastTouch) / 1000) : -1,
    st: _stalls, mx: _maxStall, up: Math.round((now - _bootAt) / 1000),
  };
  try { AS.setItem(KEY, JSON.stringify(o)).catch(() => {}); } catch {}
}

async function _readPrev() {
  const AS = _AS();
  let raw = null;
  try { raw = AS ? await AS.getItem(KEY) : null; } catch {}
  _prevRead = true;
  return raw;
}
function _reportPrev(raw) {
  if (!raw) return;
  let o = null;
  try { o = JSON.parse(raw); } catch { return; }
  if (!o || !o.t) return;
  const age = _bootAt - Number(o.t);
  if (!(age >= 0 && age < PREV_MAX_AGE_MS)) return;
  if (o.as === 'background') return; // suspenso/jetsam em 2º plano = normal
  _report('prev_end', `as=${o.as} gap=${Math.round(age / 1000)}s r=${o.r || '-'} n=${o.n || 0} m=${o.m || '-'} tap=${o.tap} st=${o.st || 0} mx=${o.mx || 0} up=${o.up || 0}`);
}

function _tick() {
  const now = Date.now();
  const late = _lastTick ? now - _lastTick - TICK_MS : 0;
  _lastTick = now;
  if (_appState !== 'active') return;
  if (late > STALL_MS) {
    _stalls += 1;
    if (late > _maxStall) _maxStall = late;
    if (_stallPosts < 8) {
      _stallPosts += 1;
      const m = _modals();
      _report('js_stall', `ms=${late} r=${_route || '-'} n=${m.length} m=${m.slice(0, 3).join(',') || '-'} up=${Math.round((now - _bootAt) / 1000)}`);
    }
    _snap(now);
    return;
  }
  if (now - _lastSnap >= SNAP_MS) _snap(now);
}

export function startFreezeWatch() {
  if (_started || Platform.OS === 'web') return;
  try { if (globalThis.__chatyy_freeze_watch === false) return; } catch {}
  _started = true;
  try { _appState = AppState.currentState || 'active'; } catch {}
  // Lê JÁ (antes do 1º snapshot); publica depois do boot (rede/identidade prontas).
  _readPrev().then((raw) => { setTimeout(() => { try { _reportPrev(raw); } catch {} }, 6000); }).catch(() => { _prevRead = true; });
  try {
    AppState.addEventListener('change', (s) => {
      _appState = s;
      _lastTick = 0; // 2º plano congela timers → não é stall
      _snap(Date.now());
    });
  } catch {}
  _lastTick = Date.now();
  setInterval(_tick, TICK_MS);
}
