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

import { Platform, AppState } from 'react-native';

const CFG_KEY = 'screen_protect_cfg_v1';
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
  return _mod;
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
      _cfg = { all: o.all !== false, ios: o.ios === true, exemptH: Array.isArray(o.exemptH) ? o.exemptH.map(String) : [] };
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
  if (!hasAll && !hasEx && !hasIos) return;
  const prev = _loadCfg();
  const next = {
    all: hasAll ? (config.screen_protect_all == null ? true : _truthy(config.screen_protect_all)) : (prev ? prev.all : true),
    ios: hasIos ? _truthy(config.screen_protect_ios) : (prev ? prev.ios === true : false),
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
  if (Platform.OS !== 'android') return;
  const m = _native();
  if (!m || typeof m.setLocalTag !== 'function') return;
  try { const r = m.setLocalTag(String(tag || 'local'), !!on); if (r && r.catch) r.catch(() => {}); } catch {}
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
