// services/photosBackupNative.js — [2026-10-15 photos-native]
//
// Orquestra o backup de fotos NATIVO (modules/expo-photos-backup). Quando o
// binário tem o módulo e o kill switch não está desligado, o nativo é o DONO do
// backup: o fluxo antigo (autoBackup JS + startNativeBackup do iOS +
// BackupWorker do Android) é desligado para não enviar em dobro.
//
// Kill switch OTA/console: globalThis.__chatyy_native_backup = false → volta tudo
// para o fluxo antigo (e o motor nativo é parado, se existir no binário).
//
// Configuração: as MESMAS chaves do fluxo antigo (@chatyy_backup/settings via
// backup/backupStorage: enabled, wifiOnly, chargingPreferred, includeVideos,
// quality). Conta/token: services/api (o motor isola a fila por conta).
import { Platform } from 'react-native';

let _mod = null;
function mod() {
  if (_mod !== null) return _mod || null;
  _mod = false;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const m = require('../modules/expo-photos-backup');
    if (m && typeof m.native === 'function') _mod = m;
  } catch { _mod = false; }
  return _mod || null;
}

/** Binário tem o módulo (independente do kill switch). */
export function nativeBackupPresent() {
  const m = mod();
  try { return !!(m && m.native()); } catch { return false; }
}

/** true = o motor nativo é o dono do backup nesta sessão. */
export function nativeBackupOwns() {
  const m = mod();
  if (!m) return false;
  try { return !!m.isAvailable(); } catch { return false; }
}

function N() {
  const m = mod();
  try { return m ? m.native() : null; } catch { return null; }
}

function api() {
  try { return require('./api'); } catch { return null; }
}

// Textos das notificações nativas: a tela de Fotos passa `labels` já traduzidos
// (t() do React); guardamos para o boot/BG usar no idioma certo.
const LABELS_KEY = '@chatyy_backup/native_labels';
let _labels = null;
const DEFAULT_LABELS = {
  channel: 'Backup de fotos', progressTitle: 'Salvando fotos', progressBody: '{done} de {total}',
  doneTitle: 'Backup de fotos', doneBody: '{n} itens salvos', waitingWifi: 'Aguardando Wi-Fi',
  waitingCharger: 'Aguardando carregador', pause: 'Pausar',
};
async function labels(given) {
  const AS = require('@react-native-async-storage/async-storage').default;
  if (given && typeof given === 'object') {
    _labels = { ...DEFAULT_LABELS, ...given };
    try { await AS.setItem(LABELS_KEY, JSON.stringify(_labels)); } catch {}
    return _labels;
  }
  if (_labels) return _labels;
  try { const raw = await AS.getItem(LABELS_KEY); if (raw) _labels = { ...DEFAULT_LABELS, ...JSON.parse(raw) }; } catch {}
  return _labels || DEFAULT_LABELS;
}

async function legacySettings() {
  try {
    const bs = require('./backup/backupStorage');
    const s = await bs.getSettings();
    let notify = true;
    try { notify = await bs.isBackupNotificationsEnabled(); } catch {}
    return { ...s, notify };
  } catch {
    return { enabled: false, wifiOnly: true, chargingPreferred: false, includeVideos: true, quality: 'economy', notify: true };
  }
}

/** Desliga as peças nativas do fluxo ANTIGO (idempotente). */
function disableLegacyNative() {
  try {
    const old = require('../modules/expo-background-upload').default;
    if (!old) return;
    if (Platform.OS === 'ios') {
      // credencial vazia → o BGTask antigo (runBackgroundBackupSlice) não autentica e sai
      try { old.setBackupCreds && old.setBackupCreds('', '', ''); } catch {}
      try { old.stopBackup && old.stopBackup(); } catch {}
    } else if (Platform.OS === 'android') {
      try { old.cancelBackup && old.cancelBackup(); } catch {}
    }
  } catch {}
}

let _lastConfigKey = '';
let _configuring = null;

/**
 * Aplica conta/token/base + preferências no motor nativo. Seguro chamar sempre
 * (login, troca de token, mudança de preferência, abrir a tela).
 */
export async function configureNative(extra = {}) {
  const n = N();
  if (!n || !nativeBackupOwns()) return false;
  const a = api();
  const token = (a && a.getAuthToken && a.getAuthToken()) || '';
  const account = (a && a.getSavedEmail && a.getSavedEmail()) || '';
  if (!token || !account) return false;
  const { labels: givenLabels, force, ...rest } = extra || {};
  const s = { ...(await legacySettings()), ...rest };
  const cfg = {
    account,
    token,
    apiBase: ((a && a.BASE_URL) || 'https://chatyy.com.br').replace(/\/+$/, ''),
    fallbackBase: 'https://chatyy.com.br',
    enabled: !!s.enabled,
    wifiOnly: s.wifiOnly !== false,
    chargingOnly: !!s.chargingPreferred,
    quality: s.quality === 'original' ? 'original' : 'economy',
    includeVideos: s.includeVideos !== false,
    notify: s.notify !== false,
    labels: await labels(givenLabels),
  };
  const key = JSON.stringify(cfg);
  if (key === _lastConfigKey && !force) return true;
  _lastConfigKey = key;
  disableLegacyNative();
  try {
    _configuring = n.configure(cfg);
    await _configuring;
    return true;
  } catch (e) {
    _lastConfigKey = '';
    return false;
  } finally {
    _configuring = null;
  }
}

/**
 * Chamado no boot (autoBackup.initAutoBackup). Retorna true quando o nativo
 * assumiu — o chamador NÃO deve iniciar o fluxo antigo.
 */
export async function bootNativeBackup() {
  if (!nativeBackupOwns()) {
    // binário novo com kill switch: garante o motor nativo parado
    const n = N();
    if (n && nativeBackupPresent()) { try { await n.stop(); } catch {} }
    return false;
  }
  await configureNative();
  return true;
}

/** Token mudou (login, rotação) ou saiu (null). */
let _tokTimer = null;
export function onTokenChanged(token) {
  if (!nativeBackupOwns()) return;
  if (_tokTimer) clearTimeout(_tokTimer);
  _tokTimer = setTimeout(() => {
    _tokTimer = null;
    const n = N();
    if (!n) return;
    if (!token) {
      _lastConfigKey = '';
      n.signOut().catch(() => {});
    } else {
      configureNative().catch(() => {});
    }
  }, 600);
}

/** Preferências (mesmos nomes do backupStorage). Persiste no legado + aplica no nativo. */
export async function setNativeBackupSettings(partial) {
  try {
    const bs = require('./backup/backupStorage');
    await bs.saveSettings(partial);
  } catch {}
  return configureNative();
}

export async function startNow() {
  const n = N(); if (!n) return false;
  await setNativeBackupSettings({ enabled: true });
  try { await n.start(); await n.runNow(); } catch {}
  return true;
}

export async function pauseNative() { const n = N(); try { return n ? await n.pause() : false; } catch { return false; } }
export async function resumeNative() { const n = N(); try { return n ? await n.resume() : false; } catch { return false; } }
export async function runNowNative() { const n = N(); try { return n ? await n.runNow() : false; } catch { return false; } }

export async function getNativeStatus() {
  const n = N(); if (!n) return null;
  try { return await n.getStatus(); } catch { return null; }
}

export async function getNativeSnapshot() {
  const n = N(); if (!n) return null;
  try { return await n.getSnapshot(); } catch { return null; }
}

/** Assina eventos do motor: cb(type, payload). Devolve unsubscribe. */
export function subscribeNative(cb) {
  const n = N();
  if (!n || typeof n.addListener !== 'function') return () => {};
  const subs = ['onProgress', 'onItem', 'onState'].map((ev) => {
    try { return n.addListener(ev, (e) => { try { cb(ev, e || {}); } catch {} }); } catch { return null; }
  });
  return () => subs.forEach((s) => { try { s && s.remove(); } catch {} });
}
