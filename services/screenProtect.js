// services/screenProtect.js — [2026-10-15 screen-protect-all]
//
// "Nosso app deveria bloquear tirar print de qualquer parte" (founder).
// Proteção de captura no APP INTEIRO — o trabalho pesado é nativo
// (modules/expo-chat-privacy, apiVersion ≥ 2):
//   • Android: FLAG_SECURE em todas as Activities + Dialogs nativos (print e
//     gravação saem pretos; prévia preta em Recentes). Desliga sozinho enquanto
//     o usuário COMPARTILHA A TELA numa chamada (MediaProjection gravaria preto).
//   • iOS: camada segura (canvas de UITextField seguro) em cada janela do app —
//     print/gravação/espelhamento saem pretos; blur no app switcher; aviso
//     "Capturas de tela estão bloqueadas no Chatyy". Desliga durante o
//     compartilhamento de tela da chamada (extensão de broadcast).
//   • Web: não há como bloquear — nada muda.
//
// Este arquivo só DECIDE se a proteção vale para a conta ativa e avisa o
// nativo (que persiste a decisão para o próximo cold start; nunca decidido =
// LIGADO):
//   1. Kill switch OTA/console: globalThis.__chatyy_screen_protect === false.
//   2. Flag do servidor: bootstrap → data.config.screen_protect_all (padrão
//      LIGADO; false desliga para todos). Persistido (MMKV).
//      iOS ainda exige screen_protect_ios === true (padrão DESLIGADO; o nativo
//      do iOS também nasce desligado e tem guarda de crash: 2 quedas seguidas
//      com a proteção ativa → desliga até o próximo bundle). Android não usa
//      essa flag (FLAG_SECURE padrão LIGADO).
//   3. Allowlist QA/suporte (contas LIBERADAS — o founder manda prints do app):
//      lista fixa abaixo + hashes sha256(email) vindos do servidor
//      (config.screen_protect_exempt_h) para ampliar sem OTA.
// Reavalia: troca de conta (api.setActiveAccountEmail*), bootstrap, volta ao
// primeiro plano, mudança de idioma (texto do aviso).
//
// [2026-10-22 print-local] Founder: "print preto no app TODO" no Android. Agora
// o app inteiro NÃO é mais protegido por padrão (Android e iOS): só as telas
// protegidas (conversa com privacidade avançada / block_screenshots / modo
// temporário / proteção vinda de membro, visualizador da foto de perfil,
// view-once) ligam o FLAG_SECURE, por tag LOCAL com contagem de refs e só
// enquanto estão em foco. O app inteiro só volta com flag remota EXPLÍCITA
// config.screen_protect_android === true (Android) / screen_protect_ios (iOS).
// Tags locais são persistidas (MMKV) → depois de um reload do JS (OTA/Fast
// Refresh) no meio de uma conversa protegida, as tags órfãs do runtime anterior
// são soltas no boot (antes ficavam presas no hub nativo = print preto em tudo).

import { Platform, AppState } from 'react-native';

const CFG_KEY = 'screen_protect_cfg_v1';
const TAGS_KEY = 'screen_protect_local_tags_v1'; // [2026-10-22 print-local] tags locais vivas (p/ limpar órfãs no boot)
const BUILTIN_EXEMPT = [
  'aleffpereiraduarte@gmail.com',
  'duarte@chatyy.com.br',
  'duarte@onemundo.com.br',
  'apitest@onemundo.com.br',
  'qa2@chatyy.com.br',
];

let _mod; // módulo nativo | null
let _cfg; // { all: boolean, exemptH: string[] } | null
let _toast = '';
let _lastSent = null; // 'on|toast' enviado ao nativo
let _appStateSub = null;
let _syncing = null;
let _again = false;
let _hashCache = new Map(); // email → sha256 hex

function _native() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS === 'web') return null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule('ExpoChatPrivacy');
    const v = m && typeof m.apiVersion === 'function' ? Number(m.apiVersion()) : 0;
    if (m && v >= 2 && typeof m.setAppProtection === 'function') _mod = m;
  } catch { _mod = null; }
  if (_mod) _bootCleanup(_mod);
  return _mod;
}

// ─── [2026-10-22 print-local] tags locais com contagem de refs ─────────────
const _localRefs = new Map(); // tag → nº de donos neste runtime do JS (holdScreenProtect)
const _direct = new Set(); // tags ligadas direto (setScreenProtectLocalTag)
const _sentOn = new Set(); // tags que o nativo tem ligadas por este runtime
let _booted = false;

function _persistTags() {
  try { require('./mmkv').setString?.(TAGS_KEY, JSON.stringify([..._sentOn].slice(0, 64))); } catch {}
}

// Boot do JS (cold start, OTA aplicado, Fast Refresh): solta no nativo as tags
// que o runtime ANTERIOR deixou ligadas (o efeito de limpeza nunca rodou).
function _bootCleanup(m) {
  if (_booted) return;
  _booted = true;
  if (Platform.OS !== 'android') return;
  let stale = [];
  try {
    const raw = require('./mmkv').getString?.(TAGS_KEY);
    const a = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a)) stale = a.map(String).filter(Boolean).slice(0, 64);
  } catch {}
  for (const tag of stale) {
    if (_sentOn.has(tag)) continue;
    try { const r = m.setLocalTag(tag, false); if (r && r.catch) r.catch(() => {}); } catch {}
  }
  // Binário novo: zera tudo o que o hub tiver de tags (inclusive de JS antigo).
  try {
    if (typeof m.resetLocalTags === 'function') {
      const keep = [..._sentOn];
      const r = m.resetLocalTags(keep);
      if (r && r.catch) r.catch(() => {});
    }
  } catch {}
  _persistTags();
  // FLAG_SECURE posto pelo expo-screen-capture no runtime anterior (view-once,
  // conversa) — o Set de tags do expo é do JS e morreu no reload. Com o Set
  // novo vazio, allow limpa a janela; quem precisar de proteção pede de novo.
  try {
    const SC = require('expo-screen-capture');
    const r = SC.allowScreenCaptureAsync?.('chatyy-boot-reset');
    // Depois do allow (main thread): re-aplica as tags que este runtime já pediu.
    const again = () => { try { const x = m.reassert?.(); if (x && x.catch) x.catch(() => {}); } catch {} };
    if (r && r.then) r.then(again, again); else again();
  } catch {}
}

/** Binário com a proteção do app inteiro? (false na web / binário antigo) */
export function isScreenProtectSupported() {
  return !!_native();
}

function _killed() {
  try { return globalThis.__chatyy_screen_protect === false; } catch { return false; }
}

function _truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

function _loadCfg() {
  if (_cfg !== undefined) return _cfg;
  _cfg = null;
  try {
    const raw = require('./mmkv').getString?.(CFG_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === 'object') {
      _cfg = { all: o.all !== false, ios: o.ios === true, android: o.android === true, exemptH: Array.isArray(o.exemptH) ? o.exemptH.map(String) : [] };
    }
  } catch {}
  return _cfg;
}

/** Config do servidor (bootstrap → data.config). Ignora config sem as chaves. */
export function noteServerConfig(config) {
  if (!config || typeof config !== 'object') return;
  const hasAll = Object.prototype.hasOwnProperty.call(config, 'screen_protect_all');
  const hasEx = Object.prototype.hasOwnProperty.call(config, 'screen_protect_exempt_h');
  const hasIos = Object.prototype.hasOwnProperty.call(config, 'screen_protect_ios');
  const hasAnd = Object.prototype.hasOwnProperty.call(config, 'screen_protect_android');
  if (!hasAll && !hasEx && !hasIos && !hasAnd) return;
  const prev = _loadCfg();
  const next = {
    all: hasAll ? (config.screen_protect_all == null ? true : _truthy(config.screen_protect_all)) : (prev ? prev.all : true),
    ios: hasIos ? _truthy(config.screen_protect_ios) : (prev ? prev.ios === true : false),
    android: hasAnd ? _truthy(config.screen_protect_android) : (prev ? prev.android === true : false),
    exemptH: hasEx && Array.isArray(config.screen_protect_exempt_h)
      ? config.screen_protect_exempt_h.map((h) => String(h || '').toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)).slice(0, 200)
      : (prev ? prev.exemptH : []),
  };
  _cfg = next;
  try { require('./mmkv').setString?.(CFG_KEY, JSON.stringify(next)); } catch {}
  syncScreenProtect('config');
}

/** Texto do aviso no idioma do app (LanguageContext). */
export function setScreenProtectText(text) {
  const s = String(text || '').trim();
  if (!s || s === _toast || s === 'screenProtect.blocked') return;
  _toast = s;
  syncScreenProtect('locale');
}

// Versão do bundle (OTA) — o guarda de crash do iOS zera quando ela muda.
function _bundleTag() {
  try {
    const U = require('expo-updates');
    return String((U && (U.updateId || U.runtimeVersion)) || 'embedded');
  } catch { return 'embedded'; }
}

function _activeEmail() {
  try {
    const api = require('./api');
    const e = api.getActiveAccountEmail?.();
    return String(e || '').trim().toLowerCase();
  } catch { return ''; }
}

async function _sha256(email) {
  if (_hashCache.has(email)) return _hashCache.get(email);
  let h = '';
  try {
    const Crypto = require('expo-crypto');
    h = String(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, email) || '').toLowerCase();
  } catch { h = ''; }
  if (h) _hashCache.set(email, h);
  return h;
}

async function _isExempt(email) {
  if (!email) return false;
  if (BUILTIN_EXEMPT.includes(email)) return true;
  const c = _loadCfg();
  if (!c || !c.exemptH || !c.exemptH.length) return false;
  const h = await _sha256(email);
  return !!h && c.exemptH.includes(h);
}

/** Decide para a conta ativa e avisa o nativo. Seguro chamar a qualquer hora. */
export function syncScreenProtect(reason) {
  const m = _native();
  if (!m) return Promise.resolve(false);
  _ensureAppState();
  if (_syncing) { _again = true; return _syncing; }
  _syncing = (async () => {
    let on = false;
    try {
      do {
        _again = false;
        on = true;
        let skip = false;
        if (_killed()) on = false;
        else {
          const c = _loadCfg();
          if (c && c.all === false) on = false;
          // iOS: só com a flag remota própria (padrão desligado).
          else if (Platform.OS === 'ios' && !(c && c.ios === true)) on = false;
          // [2026-10-22 print-local] Android: idem — app inteiro só com
          // config.screen_protect_android === true (padrão DESLIGADO). Decide
          // sem esperar a conta (desliga já no cold start).
          else if (Platform.OS === 'android' && !(c && c.android === true)) on = false;
          else {
            const email = _activeEmail();
            // Conta ainda não carregada (cold start): mantém o que o nativo
            // persistiu da última sessão — não pisca liga/desliga na conta liberada.
            if (!email) skip = true;
            else if (await _isExempt(email)) on = false;
          }
        }
        const key = `${on ? 1 : 0}|${_toast}`;
        if (!skip && key !== _lastSent) {
          _lastSent = key;
          try {
            const r = m.setAppProtection(on, { toast: _toast || '', bundle: _bundleTag() });
            if (r && r.catch) r.catch(() => {});
          } catch {}
        }
      } while (_again);
    } catch {}
    return on;
  })().finally(() => { _syncing = null; });
  return _syncing;
}

function _ensureAppState() {
  if (_appStateSub || Platform.OS === 'web') return;
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        syncScreenProtect('active');
        reassertScreenProtect();
      }
    });
  } catch {}
}

/**
 * Android: depois de um expo-screen-capture allowScreenCaptureAsync (que limpa
 * o FLAG_SECURE da Activity quando a última tag dele sai), re-aplica a
 * proteção do app. iOS: no-op.
 */
export function reassertScreenProtect() {
  if (Platform.OS !== 'android') return;
  const m = _native();
  if (!m || typeof m.reassert !== 'function') return;
  const run = () => { try { const r = m.reassert(); if (r && r.catch) r.catch(() => {}); } catch {} };
  run();
  setTimeout(run, 120);
}

/**
 * Android: proteção LOCAL (conversa com privacidade avançada, toggle do
 * usuário) — vale mesmo com a proteção do app desligada (conta liberada /
 * compartilhando a tela). iOS: no-op (lá a conversa usa o escudo de gravação).
 */
export function setScreenProtectLocalTag(tag, on) {
  // Chamada direta (toggle "no app", re-armada a cada volta ao 1º plano) =
  // liga/desliga IDEMPOTENTE, sem contagem.
  const k = String(tag || 'local');
  if (on) _direct.add(k); else _direct.delete(k);
  return _applyTag(k);
}

// [2026-10-22 print-local] Estado de cada tag = donos com contagem
// (holdScreenProtect: a mesma conversa empilhada 2x, visualizador por cima…)
// OU ligada direto. Só manda ao nativo quando o "ligada?" muda.
function _applyTag(k) {
  if (Platform.OS !== 'android') return Promise.resolve(false);
  const m = _native();
  if (!m || typeof m.setLocalTag !== 'function') return Promise.resolve(false);
  const want = (_localRefs.get(k) || 0) > 0 || _direct.has(k);
  if (want === _sentOn.has(k)) return Promise.resolve(true);
  if (want) _sentOn.add(k); else _sentOn.delete(k);
  _persistTags();
  try {
    const r = m.setLocalTag(k, want);
    if (r && r.then) return r.then(() => true, () => false);
  } catch {}
  return Promise.resolve(true);
}

/** [2026-10-22 print-local] Alguma tela protegida segura o FLAG_SECURE agora? */
export function hasScreenProtectLocalTags() {
  return _sentOn.size > 0;
}

/**
 * [2026-10-22 print-local] Liga a proteção LOCAL e devolve a função que solta
 * (idempotente). Uso: const release = holdScreenProtect('tela-x'); … release().
 */
export function holdScreenProtect(tag) {
  let done = false;
  const k = String(tag || 'local');
  _localRefs.set(k, (_localRefs.get(k) || 0) + 1);
  const armed = _applyTag(k);
  const release = () => {
    if (done) return;
    done = true;
    const n = _localRefs.get(k) || 0;
    if (n > 1) _localRefs.set(k, n - 1); else _localRefs.delete(k);
    _applyTag(k);
  };
  // Promessa: o nativo já recebeu a tag (a flag entra na fila da main thread
  // ANTES de qualquer Dialog/Modal que for montado depois).
  release.armed = armed || Promise.resolve(true);
  return release;
}

/** { supported, enabled, effective, sharing } do nativo (ou null). */
export async function getScreenProtectState() {
  const m = _native();
  if (!m || typeof m.getAppProtection !== 'function') return null;
  try { return await m.getAppProtection(); } catch { return null; }
}

/** Eventos do nativo: { effective, sharing } quando muda (compartilhar tela etc.). */
export function addScreenProtectListener(cb) {
  const m = _native();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try {
    const sub = m.addListener('onProtectChange', (e) => { try { cb(e || {}); } catch {} });
    return { remove() { try { sub.remove(); } catch {} } };
  } catch { return { remove() {} }; }
}
