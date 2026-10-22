// [e2ee5 flag-conta 2026-10-21] Liga o E2EE v5 POR CONTA, sem OTA novo (teste do founder).
//
// O servidor responde `e2ee5_client_flag` → {e2ee5, kill, ttl}: e2ee5=true só para a conta com
// e2ee5_allow.enabled + client_on (kit /root/e2ee-2026-10-21/kits/ligar-teste-founder.sh).
//   - true  → globalThis.__chatyy_e2ee5 = true SÓ enquanto esta conta estiver ativa (abre a sessão do
//             núcleo; link/backup/ligações seguem os interruptores do e2ee5_status do servidor).
//   - false → desliga se FOI ESTE módulo que ligou (QA que ligou à mão continua).
//   - kill  → desliga sempre (touch api/.e2ee5-off | api/.e2ee5-client-off | E2EE5_CLIENT_KILL=1).
// Troca de conta / logout → desliga antes de olhar a conta nova. Pergunta no login/boot, ao voltar ao
// 1º plano (≥ 60 s desde a última) e a cada ttl (10 min). Cache por conta (AsyncStorage) para o boot
// já sair ligado antes da 1ª conversa abrir. Só celular (web = só vinculada pelo QR, decisão 4).
// Kill só deste módulo (OTA): globalThis.__chatyy_e2ee5_acct_flag = false.
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ORIGIN = 'https://chatyy.com.br';
const CACHE_KEY = 'chatyy_e2ee5_acct_on_v1';
const MIN_GAP_MS = 60 * 1000;

let _email = '';
let _remoteOn = false;   // este módulo ligou a flag global
let _lastAt = 0;
let _ttlMs = 10 * 60 * 1000;
let _timer = null;
let _sub = null;
let _gen = 0;

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
const _canon = (e) => { const s = String(e || '').trim().toLowerCase(); return s.endsWith('@onemundo.com.br') ? s.slice(0, -16) + '@chatyy.com.br' : s; };
function _disabledHere() {
  if (Platform.OS === 'web') return true;
  try { return _g().__chatyy_e2ee5_acct_flag === false; } catch (_) { return false; }
}
function _bearer() {
  try { const a = require('../api'); return String((a.getAuthToken && a.getAuthToken()) || (a.getToken && a.getToken()) || ''); } catch (_) { return ''; }
}
function _E() { return require('./e2ee5'); }
// [e2ee5 rollout §5 2026-10-22] o servidor só liga a coorte (E2EE5_PCT) p/ app que DECLARA
// {platform, build ≥ E2EE5_MIN_IOS/ANDROID, core: 1}. `core` = o binário tem o núcleo chatyy-crypto
// carregado (módulo + API + coreLinked), nunca suposição; `build` = nativeBuildVersion do binário.
let _infoCache = null;
function _clientInfo() {
  if (_infoCache) return _infoCache;
  let build = 0;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const A = requireOptionalNativeModule ? requireOptionalNativeModule('ExpoApplication') : null;
    build = parseInt(String((A && A.nativeBuildVersion) || '0'), 10) || 0;
  } catch (_) { build = 0; }
  let core = 0;
  try { core = require('./updateGate').coreLinked() ? 1 : 0; } catch (_) { core = 0; }
  const out = { platform: Platform.OS, build, core };
  if (build > 0) _infoCache = out; // o binário não muda durante a sessão
  return out;
}

async function _cacheGet() {
  try { const v = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
async function _cacheSet(email, on) {
  try {
    const v = await _cacheGet();
    if (on) v[email] = 1; else delete v[email];
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(v));
  } catch (_) {}
}
async function _cacheClear() { try { await AsyncStorage.removeItem(CACHE_KEY); } catch (_) {} }

function _turnOn() {
  const g = _g();
  if (g.__chatyy_e2ee5 === true) return;
  g.__chatyy_e2ee5 = true;
  _remoteOn = true;
  try { _E().onWsAuth(); } catch (_) {} // abre a sessão do núcleo + sync (o WS seguinte já leva e2ee5_device)
}
async function _turnOff(force) {
  const g = _g();
  if (!(force || _remoteOn) || g.__chatyy_e2ee5 !== true) { _remoteOn = false; return; }
  try { await _E().endSession({ wipe: false }); } catch (_) {} // fecha o núcleo ANTES de desligar (endSession exige a flag)
  g.__chatyy_e2ee5 = false;
  _remoteOn = false;
}

async function _ask(gen, tries = 0) {
  const bearer = _bearer();
  if (!_email) return;
  if (!bearer) { // boot pelo cache: o bearer chega logo depois do user
    if (tries < 10) setTimeout(() => { if (gen === _gen) _ask(gen, tries + 1).catch(() => {}); }, 3000);
    return;
  }
  _lastAt = Date.now();
  let j = null;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = setTimeout(() => { try { ctl && ctl.abort(); } catch (_) {} }, 12000);
    try {
      const r = await fetch(ORIGIN + '/api/email.php?action=e2ee5_client_flag', {
        method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(_clientInfo()),
        signal: ctl ? ctl.signal : undefined,
      });
      j = await r.json().catch(() => null);
    } finally { clearTimeout(tm); }
  } catch (_) { return; } // sem rede: mantém o que está (cache)
  if (gen !== _gen || !j || j.success !== true || !j.data) return; // servidor antigo/erro: mantém
  const d = j.data;
  if (Number(d.ttl) >= 60) _ttlMs = Math.min(Number(d.ttl), 3600) * 1000;
  if (d.kill === true) { await _cacheClear(); await _turnOff(true); return; }
  if (d.e2ee5 === true) { await _cacheSet(_email, true); if (gen === _gen) _turnOn(); }
  else { await _cacheSet(_email, false); await _turnOff(false); }
}

function _arm() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    try { if (AppState.currentState && AppState.currentState !== 'active') return; } catch (_) {}
    if (Date.now() - _lastAt >= _ttlMs) _ask(_gen).catch(() => {});
  }, 60 * 1000);
  if (!_sub) {
    try {
      _sub = AppState.addEventListener('change', (st) => {
        if (st === 'active' && _email && Date.now() - _lastAt >= MIN_GAP_MS) _ask(_gen).catch(() => {});
      });
    } catch (_) {}
  }
}

/** AuthContext: conta ativa mudou (login, troca, boot, logout = ''). */
export async function setAccount(email) {
  if (_disabledHere()) return;
  const e = _canon(email);
  if (e === _email) return;
  const gen = ++_gen;
  const prev = _email;
  _email = e;
  if (prev) await _turnOff(false); // nunca herda a flag da conta anterior
  if (!e) { if (_timer) { clearInterval(_timer); _timer = null; } return; }
  try { const c = await _cacheGet(); if (gen === _gen && c[e] === 1) _turnOn(); } catch (_) {}
  _arm();
  _ask(gen).catch(() => {});
}

export default { setAccount };
