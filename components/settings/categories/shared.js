// [2026-10-15 settings-split] Peças compartilhadas pelas categorias das
// Configurações (cada categoria = arquivo próprio, carregado sob demanda e
// com estado LOCAL). Antes tudo vivia em app/settings.js (5 mil linhas, 104
// useState num componente só: qualquer toggle re-renderizava a tela inteira).
//
// Fonte da verdade das preferências do servidor = services/settingsCache
// (snapshot por conta + revalidação + commit otimista). Cada categoria só
// assina as seções que mostra; um commit atualiza o snapshot na hora e todas
// as telas assinantes acompanham (sem estado espelhado na raiz).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform, Alert, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { HapticsCompat as Haptics } from '../../../services/haptics';
import * as settingsCache from '../../../services/settingsCache';
import { pushOnce } from '../../../services/navOnce';
import { useLanguage } from '../../../context/LanguageContext';

// ── Armazenamento local (mesmas chaves de antes) ─────────────────────────
export function getStorage(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  return null; // nativo: assíncrono (readLocalKeys)
}
export function setStorage(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
  } else {
    import('@react-native-async-storage/async-storage').then(m => m.default.setItem(key, val)).catch(() => {});
  }
}
export function removeStorage(key) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch {}
  } else {
    import('@react-native-async-storage/async-storage').then(m => m.default.removeItem(key)).catch(() => {});
  }
}
/** Lê várias chaves locais → { chave: valor|null } (web síncrono por baixo). */
export async function readLocalKeys(keys) {
  const kv = {};
  if (Platform.OS === 'web') {
    for (const k of keys) kv[k] = getStorage(k);
    return kv;
  }
  try {
    const m = await import('@react-native-async-storage/async-storage');
    const vals = await Promise.all(keys.map(k => m.default.getItem(k).catch(() => null)));
    keys.forEach((k, i) => { kv[k] = vals[i]; });
  } catch {}
  return kv;
}
/** Hidrata preferências locais uma vez (apply recebe o mapa chave→valor). */
export function useLocalKeys(keys, apply) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    let alive = true;
    readLocalKeys(keys).then((kv) => { if (alive) { try { applyRef.current(kv); } catch {} } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ── Contexto do hub (fornecido por app/settings.js) ──────────────────────
export const SettingsHostContext = createContext({
  registerAnchor: () => undefined,
  openCategory: () => {},
  openAccountSwitcher: () => {},
  twoPane: false,
});
export function useSettingsHost() { return useContext(SettingsHostContext); }

// Navegação defensiva das linhas (haptic + push + alerta se o push lançar).
// [2026-10-17 nav-once] Push NA HORA (sem esperar o próximo frame) e
// idempotente (services/navOnce): toque duplo não empilha 2 telas — trava em
// voo até a tela de destino focar (≤ 1,2 s) + nunca repete a rota do topo.
export function useSafeNav() {
  const router = useRouter();
  const { t } = useLanguage();
  return useCallback((path) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    try { pushOnce(router, path); }
    catch (e) {
      try { Alert.alert(t('uiG.settings.navError'), `${typeof path === 'string' ? path : (path && path.pathname) || ''}\n${String(e?.message || e)}`); } catch {}
    }
  }, [router, t]);
}

// Revalidação ao abrir uma categoria: TTL curto (30 s) — outras telas/
// aparelhos podem ter mudado algo; o snapshot local pinta na hora.
export const OPEN_TTL = 30000;
// Leve (sem estado de "revalidando" → nenhum commit extra ao abrir): valor
// local na hora, assina mudanças e revalida em 2º plano se vencido. Troca de
// conta (multi-conta) relê o snapshot da conta nova.
export function useSection(section, ttl = OPEN_TTL) {
  let acct = '';
  try { acct = settingsCache.activeAccount(); } catch {}
  const [st, setSt] = useState(() => ({ acct, v: settingsCache.peek(section) }));
  useEffect(() => {
    const un = settingsCache.subscribe(section, (x) => { if (x != null) setSt({ acct: settingsCache.activeAccount(), v: x }); });
    const cur = settingsCache.peek(section);
    setSt((prev) => (prev.acct === acct && prev.v === cur ? prev : { acct, v: cur }));
    if (ttl !== false) settingsCache.revalidate(section, { ttl: ttl || settingsCache.DEFAULT_TTL_MS }).catch(() => {});
    return un;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, acct]);
  return st.acct === acct ? st.v : settingsCache.peek(section);
}

// ── Notificações (chat_user_notif_prefs) ─────────────────────────────────
/** Nível de entrega do push: snapshot do servidor > espelho local (web) > 'all'. */
export function pushLevelOf(notif) {
  if (notif && typeof notif.push_notif_level === 'string') return notif.push_notif_level;
  return getStorage('push_notif_level') || 'all';
}
export function useSaveNotifPref() {
  const { t } = useLanguage();
  return useCallback((patch) => {
    settingsCache.commit('notif', { patch, action: 'chat_user_notif_prefs_set', params: patch })
      .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); })
      .catch(() => {});
  }, [t]);
}

// ── Privacidade do chat (chat_privacy_get/set) ───────────────────────────
export function normalizePrivacy(d) {
  const x = d && typeof d === 'object' ? d : {};
  return {
    last_seen: x.last_seen || 'everyone',
    profile_photo: x.profile_photo || 'everyone',
    keep_archived: x.keep_archived !== undefined ? !!x.keep_archived : true,
    online: x.online || 'everyone',
    status_except: Array.isArray(x.status_except) ? x.status_except : [],
    // Padrão seguro: recibos OFF até o valor real chegar.
    read_receipts: x.read_receipts !== undefined ? !!x.read_receipts : false,
    story_privacy: x.story_privacy || 'everyone',
    group_add: x.group_add || 'everyone',
    mute_call_ringtone: x.mute_call_ringtone !== undefined ? !!x.mute_call_ringtone : false,
    block_unknown: x.block_unknown === true,
    block_screenshots: x.block_screenshots === true || x.block_screenshots === 1 || x.block_screenshots === '1', // [2026-10-19 secure-view]
    phone_visibility: x.phone_visibility || 'contacts',
    about: x.about || 'everyone',
    cloud_chats_default: x.cloud_chats_default !== false,
  };
}
function _mirrorMuteRingtone(v) {
  try {
    const s = v ? 'true' : 'false';
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem('mute_call_ringtone', s); }
    else import('@react-native-async-storage/async-storage').then(m => m.default.setItem('mute_call_ringtone', s).catch(() => {})).catch(() => {});
  } catch {}
}
/** { privacy, savePrivacy } — espelhos (typing no WS, toque silencioso) quando o servidor confirma. */
export function useChatPrivacy() {
  const { t } = useLanguage();
  const raw = useSection('privacy');
  const privacy = normalizePrivacy(raw);
  // Valor vindo do servidor → espelhos locais (antes: applyPrivacy).
  const lastRaw = useRef(null);
  useEffect(() => {
    if (!raw || typeof raw !== 'object' || raw === lastRaw.current) return;
    lastRaw.current = raw;
    try {
      require('../../../services/websocket').default?.setTypingPrivacy?.({
        read_receipts: raw.read_receipts !== undefined ? !!raw.read_receipts : undefined,
        last_seen: raw.last_seen,
        online: raw.online,
      });
    } catch {}
    _mirrorMuteRingtone(!!raw.mute_call_ringtone);
  }, [raw]);
  const savePrivacy = useCallback((patch) => {
    settingsCache.commit('privacy', { patch, action: 'chat_privacy_set', params: patch }).then((res) => {
      if (res && res.ok === false) { settingsCache.notifySaveFailed(t); return; }
      if (Object.prototype.hasOwnProperty.call(patch, 'mute_call_ringtone')) _mirrorMuteRingtone(!!patch.mute_call_ringtone);
      if ('read_receipts' in patch || 'last_seen' in patch || 'online' in patch) {
        try { require('../../../services/websocket').default?.setTypingPrivacy?.(patch); } catch {}
      }
    }).catch(() => {});
  }, [t]);
  return { privacy, savePrivacy };
}

// Rótulos/opções das linhas de visibilidade (usado pela categoria e pelo
// subtítulo da raiz).
export function privacyValueLabel(t, privacy, field) {
  const v = privacy[field];
  if (field === 'story_privacy') {
    if (v === 'all' || v === 'everyone') return t('settings.privacyEveryone');
    if (v === 'contacts') return t('settings.privacyContacts');
    if (v === 'close_friends') return t('settings.privacyCloseFriends');
    if (v === 'except') return t('settings.privacyStatusExcept');
    return t('settings.privacyNobody');
  }
  if (v === 'everyone') return t('settings.privacyEveryone');
  if (v === 'contacts') return t('settings.privacyContacts');
  return field === 'online' ? t('settings.privacyInvisible') : t('settings.privacyNobody');
}

// ── Padrões do chat (auto-download + temporárias) ────────────────────────
export function normalizeDefaults(d) {
  const x = d && typeof d === 'object' ? d : {};
  const pol = (x.auto_download_policy && typeof x.auto_download_policy === 'object') ? x.auto_download_policy : null;
  const modeOf = (b, fb) => {
    const row = pol && pol[b];
    if (!row) return fb;
    if (row.mobile) return 'mobile';
    if (row.wifi) return 'wifi';
    return 'never';
  };
  const dd = x.default_disappearing_seconds ?? x.default_disappearing;
  return {
    policy: pol,
    default_disappearing: Number.isFinite(+dd) ? +dd : 0,
    media_auto_dl_photos: modeOf('photos', 'mobile'),
    media_auto_dl_audio: modeOf('audio', 'mobile'),
    media_auto_dl_videos: modeOf('videos', 'wifi'),
    media_auto_dl_docs: modeOf('documents', 'wifi'),
  };
}
/** { defaults, updateDefault } — mesmas ações reais do servidor de antes. */
export function useChatDefaults() {
  const { t } = useLanguage();
  const raw = useSection('defaults');
  const defaults = normalizeDefaults(raw);
  // Matriz do servidor → gate do mediaCache (o mesmo do boot).
  useEffect(() => {
    if (defaults.policy) { try { require('../../../services/mediaCache').setAutoDownloadPolicy?.(defaults.policy); } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  const updateDefault = useCallback((patch) => {
    const mediaPatch = {};
    for (const k of ['media_auto_dl_photos', 'media_auto_dl_audio', 'media_auto_dl_videos', 'media_auto_dl_docs']) {
      if (k in patch) mediaPatch[k] = patch[k];
    }
    if (Object.keys(mediaPatch).length) {
      try { require('../../../services/mediaCache').setMediaDownloadPrefs?.(mediaPatch); } catch {}
    }
    const BUCKET = { media_auto_dl_photos: 'photos', media_auto_dl_audio: 'audio', media_auto_dl_videos: 'videos', media_auto_dl_docs: 'documents' };
    for (const k of Object.keys(patch)) {
      if (BUCKET[k]) {
        const mode = patch[k];
        const mobile = mode === 'mobile' ? 1 : 0;
        const wifi = mode === 'never' ? 0 : 1;
        const b = BUCKET[k];
        const polPatch = (prevD) => {
          const base = prevD && typeof prevD === 'object' ? prevD : {};
          const pol = { ...(base.auto_download_policy && typeof base.auto_download_policy === 'object' ? base.auto_download_policy : {}) };
          pol[b] = { ...(pol[b] || {}), mobile: !!mobile, wifi: !!wifi };
          return { ...base, auto_download_policy: pol };
        };
        settingsCache.commit('defaults', { patch: polPatch, action: 'chat_set_auto_download_policy', params: { bucket: b, column: 'mobile', value: mobile } })
          .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); }).catch(() => {});
        settingsCache.commit('defaults', { action: 'chat_set_auto_download_policy', params: { bucket: b, column: 'wifi', value: wifi } }).catch(() => {});
      } else if (k === 'default_disappearing') {
        const sec = Number(patch[k]) || 0;
        settingsCache.commit('defaults', { patch: { default_disappearing_seconds: sec }, action: 'chat_set_default_disappearing', params: { seconds: sec } })
          .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); }).catch(() => {});
      }
    }
  }, [t]);
  return { defaults, updateDefault };
}

// ── Blob get_settings (e-mail, idioma, fonte…) com auto-save ─────────────
const SETTINGS_DEFAULTS = {
  signature: '',
  emails_per_page: 20,
  notifications: true,
  notification_sound: true,
  notification_vibration: true,
  language: 'pt-BR',
  auto_reply: false,
  auto_reply_message: '',
  forwarding_email: '',
  forwarding_enabled: false,
  font_size: 'medium',
};
function _initialSettings() {
  let lastKnown = null;
  try { lastKnown = require('../../../services/api').getOfflineLastKnown?.('get_settings') || null; } catch {}
  const c = settingsCache.peek('settings');
  const n = settingsCache.peek('notif');
  const out = {
    ...SETTINGS_DEFAULTS,
    ...(lastKnown && lastKnown.data && typeof lastKnown.data === 'object' ? lastKnown.data : {}),
    ...(c && typeof c === 'object' ? c : {}),
  };
  if (n && typeof n === 'object') {
    if (n.morning_briefing !== undefined && n.morning_briefing !== null) out.morning_briefing = !!n.morning_briefing;
    if (typeof n.font_size === 'string') out.font_size = n.font_size;
  }
  return out;
}
/**
 * Blob do get_settings com auto-save (debounce 700 ms; grava na hora ao sair
 * da categoria). Hidratação (cache/servidor) não ecoa de volta e não
 * sobrescreve uma edição ainda não salva.
 *   const { settings, setSettings } = useSettingsBlob();
 *   setSettings(prev => ({ ...prev, emails_per_page: 50 }))
 */
export function useSettingsBlob() {
  const { t } = useLanguage();
  const [settings, setState] = useState(_initialSettings);
  const latest = useRef(settings);
  latest.current = settings;
  const timer = useRef(null);
  const dirty = useRef(false);

  const save = useCallback(async () => {
    dirty.current = false;
    const s = latest.current;
    try {
      const res = await settingsCache.commit('settings', { patch: s, action: 'update_settings', params: s });
      if (res?.ok === false) settingsCache.notifySaveFailed(t);
      else {
        try { const { invalidate } = await import('../../../services/cache'); invalidate?.('user_profile'); } catch {}
      }
      const notifPrefs = { notification_sound: s.notification_sound, notification_vibration: s.notification_vibration };
      setStorage('notif_prefs', JSON.stringify(notifPrefs));
      try { const { updateNotifSettings } = await import('../../../context/MailContext'); updateNotifSettings(notifPrefs); } catch {}
    } catch {}
  }, [t]);

  const setSettings = useCallback((updater) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      latest.current = next;
      return next;
    });
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; save(); }, 700);
  }, [save]);

  // Hidratação: snapshot/servidor (get_settings) + fonte/briefing (notif) +
  // som/vibração locais. Ignora enquanto houver edição pendente.
  useEffect(() => {
    const hydrate = (patch) => {
      if (!patch || dirty.current) return;
      setState((prev) => { const next = { ...prev, ...patch }; latest.current = next; return next; });
    };
    const u1 = settingsCache.subscribe('settings', (v) => { if (v && typeof v === 'object') hydrate(v); });
    const u2 = settingsCache.subscribe('notif', (d) => {
      if (!d || typeof d !== 'object') return;
      const p = {};
      if (d.morning_briefing !== undefined && d.morning_briefing !== null) p.morning_briefing = !!d.morning_briefing;
      if (typeof d.font_size === 'string') p.font_size = d.font_size;
      if (Object.keys(p).length) hydrate(p);
    });
    readLocalKeys(['notif_prefs']).then((kv) => {
      try { if (kv.notif_prefs) hydrate(JSON.parse(kv.notif_prefs)); } catch {}
    });
    settingsCache.revalidate('settings', { ttl: OPEN_TTL }).catch(() => {});
    return () => {
      u1(); u2();
      // Saiu da categoria com edição pendente → grava já (antes: handleBack).
      if (timer.current) { clearTimeout(timer.current); timer.current = null; save(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { settings, setSettings };
}

// ── Recarregar (puxar p/ baixo) — a raiz avisa as categorias montadas ────
const _refreshSubs = new Set();
export function emitSettingsRefresh() { _refreshSubs.forEach((fn) => { try { fn(); } catch {} }); }
export function useSettingsRefresh(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current?.();
    _refreshSubs.add(h);
    return () => { _refreshSubs.delete(h); };
  }, []);
}

export const catStyles = StyleSheet.create({
  cardInputWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  cardInput: {
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  timeInput: {
    minWidth: 76, textAlign: 'center', fontSize: 16, fontVariant: ['tabular-nums'],
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  inkBtn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  inkBtnText: { fontSize: 15, fontWeight: '600' },
});
