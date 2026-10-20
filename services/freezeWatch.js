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
//
// [2026-10-18 perf-telemetry] Timer de 250 ms (era 1 s: stall de 0,4–1 s quase
// nunca aparecia) e stalls ≥ 400 ms vão AGREGADOS por rota p/ o beacon 'perf'
// (services/nativeTelemetry notePerfStall — faixas + máx, 1 envio a cada ~5 min,
// nunca 1 beacon por stall). js_stall individual continua só > 2,5 s (teto 8).
// A rota também alimenta o contador nativo de quadros (notePerfRoute) e o
// prev_end daqui vai junto no perf_exit (getPrevEnd). Tick: __chatyy_stall_tick_ms.
import { AppState, Platform } from 'react-native';

const KEY = '@chatyy/freeze_snap_v1';
const TICK_MS_DEFAULT = 250;
const STALL_MS = 2500;
const PERF_STALL_MS = 400;
const PERF_START_DELAY_MS = 8000;
const SNAP_MS = 5000;
const PREV_MAX_AGE_MS = 30 * 60 * 1000;
// [2026-10-19 perf-android] Atraso > 60 s com AppState 'active' = processo
// suspenso/congelado (Doze, freezer de apps em cache, tela desligada sem
// onPause) — não é JS travado (uma trava real dessas vira prev_end). Em campo
// saiu js "stall" de 931 s em 2º plano. Idem quando o relógio monotônico
// (performance.now, não anda em sono profundo) andou bem menos que o de parede.
const SUSPEND_MS = 60000;

let _started = false;
let _route = '';
let _lastTouch = 0;
let _appState = 'active';
let _lastTick = 0;
let _lastMono = 0;
let _suspends = 0;
let _lastSnap = 0;
let _stalls = 0;
let _maxStall = 0;
let _stallPosts = 0;
let _stalls4 = 0;
let _tickMs = TICK_MS_DEFAULT;
let _prevEnd = null;
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

function _perf() {
  try { return require('./nativeTelemetry'); } catch { return null; } // eslint-disable-line global-require
}
// [2026-10-20 perf-js] origem da trava: últimas ações antes do início (services/perfTrace)
function _trace() {
  try { return require('./perfTrace'); } catch { return null; } // eslint-disable-line global-require
}
let _lastLa = '';

export function setFreezeRoute(r) {
  try { _route = String(r || '').slice(0, 48); } catch {}
  try { _perf()?.notePerfRoute?.(_route); } catch {}
}

/** prev_end do processo anterior (se relevante) — vai junto no perf_exit. */
export function getPrevEnd() { return _prevEnd; }
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
    st: _stalls, mx: _maxStall, s4: _stalls4, sp: _suspends, up: Math.round((now - _bootAt) / 1000),
  };
  try { const tr = _trace(); o.la = tr ? tr.lastActions(now, 3) : '-'; if (_lastLa) o.sla = _lastLa; } catch {}
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
  _prevEnd = { as: o.as, gap: Math.round(age / 1000), r: o.r || '-', n: o.n || 0, tap: o.tap, st: o.st || 0, mx: o.mx || 0, s4: o.s4 || 0, up: o.up || 0 };
  if (o.la) _prevEnd.la = String(o.la).slice(0, 120);
  if (o.sla) _prevEnd.sla = String(o.sla).slice(0, 120);
  _report('prev_end', `as=${o.as} gap=${Math.round(age / 1000)}s r=${o.r || '-'} n=${o.n || 0} m=${o.m || '-'} tap=${o.tap} st=${o.st || 0} mx=${o.mx || 0} up=${o.up || 0} la=${o.la || '-'}`);
}

function _mono() {
  try { return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : 0; } catch { return 0; }
}

function _tick() {
  const now = Date.now();
  const late = _lastTick ? now - _lastTick - _tickMs : 0;
  _lastTick = now;
  const mono = _mono();
  const monoLate = (_lastMono && mono) ? mono - _lastMono - _tickMs : late;
  _lastMono = mono;
  if (_appState !== 'active') return;
  // evento de AppState perdido/atrasado → confia no estado atual
  try { const cs = AppState.currentState; if (cs && cs !== 'active' && cs !== 'unknown') { _appState = cs; return; } } catch {}
  if (late > SUSPEND_MS || (late >= PERF_STALL_MS && monoLate < late / 2)) {
    _suspends += 1;
    // [2026-10-20 perf-js] iOS não suspende app ATIVO: > 60 s com o relógio
    // monotônico andando junto = trava real (main+JS: o contador nativo viu
    // quadros de 184–454 s em /chat-conversation que sumiam como "suspensão").
    if (Platform.OS === 'ios' && late > SUSPEND_MS && monoLate >= late * 0.9 && _stallPosts < 8) {
      _stallPosts += 1;
      let la = '-';
      try { const tr = _trace(); la = tr ? tr.lastActions(now - late, 3) : '-'; } catch {}
      _report('js_stall', `ms=${late} long=1 r=${_route || '-'} up=${Math.round((now - _bootAt) / 1000)} la=${la}`);
    }
    return;
  }
  let la = '';
  if (late >= PERF_STALL_MS) {
    _stalls4 += 1;
    // início da trava ≈ agora − atraso; a última ação ANTES disso é a suspeita
    try { const tr = _trace(); la = tr ? tr.lastActions(now - late, 3) : ''; } catch {}
    try { _perf()?.notePerfStall?.(late, _route, la); } catch {}
  }
  if (late > STALL_MS) {
    _stalls += 1;
    if (late > _maxStall) { _maxStall = late; _lastLa = la; }
    if (_stallPosts < 8) {
      _stallPosts += 1;
      const m = _modals();
      let sp = '-';
      try { const tr = _trace(); sp = tr ? tr.topSpans(3) : '-'; } catch {}
      const tap = _lastTouch ? Math.max(0, (now - late) - _lastTouch) : -1;
      _report('js_stall', `ms=${late} r=${_route || '-'} n=${m.length} m=${m.slice(0, 3).join(',') || '-'} up=${Math.round((now - _bootAt) / 1000)} tap=${tap} la=${la || '-'} sp=${sp}`);
    }
    _snap(now);
    return;
  }
  if (now - _lastSnap >= SNAP_MS) _snap(now);
}

export function startFreezeWatch() {
  if (_started || Platform.OS === 'web') return;
  // perf nativo (quadros/memória/saída) tem kill switch próprio (__chatyy_perf_telemetry)
  setTimeout(() => { try { _perf()?.startPerfTelemetry?.(); } catch {} }, PERF_START_DELAY_MS);
  try { if (globalThis.__chatyy_freeze_watch === false) return; } catch {}
  _started = true;
  try {
    const t = Number(globalThis.__chatyy_stall_tick_ms);
    if (t >= 100 && t <= 1000) _tickMs = t;
  } catch {}
  try { _appState = AppState.currentState || 'active'; } catch {}
  // Lê JÁ (antes do 1º snapshot); publica depois do boot (rede/identidade prontas).
  _readPrev().then((raw) => { setTimeout(() => { try { _reportPrev(raw); } catch {} }, 6000); }).catch(() => { _prevRead = true; });
  // [2026-10-20 tg2] bateria: em 2º plano o tick de 250 ms só retornava (o _tick
  // ignora não-ativo) mas acordava o JS 4×/s (Android e iOS c/ áudio/VoIP/local).
  // Agora o timer para no background e volta no active. Kill: __chatyy_freeze_bg_timer=true.
  let _iv = null;
  const _arm = () => { if (_iv == null) { _lastTick = Date.now(); _lastMono = 0; _iv = setInterval(_tick, _tickMs); } };
  const _disarm = () => { if (_iv != null) { clearInterval(_iv); _iv = null; } };
  try {
    AppState.addEventListener('change', (s) => {
      _appState = s;
      _lastTick = 0; // 2º plano congela timers → não é stall
      _lastMono = 0;
      _snap(Date.now());
      let keep = false; try { keep = globalThis.__chatyy_freeze_bg_timer === true; } catch {}
      if (s === 'background' && !keep) _disarm();
      else if (s === 'active') _arm();
    });
  } catch {}
  _arm();
}
