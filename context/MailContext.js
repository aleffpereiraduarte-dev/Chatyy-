import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Platform, LayoutAnimation, UIManager, AppState, DeviceEventEmitter } from 'react-native';
import { usePathname } from 'expo-router';
import { HapticsCompat as Haptics } from '../services/haptics'; // [2026-10-16 motion-telegram] shim único (Core Haptics iOS / performHapticFeedback Android)
import * as api from '../services/api';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}
// Delta sync — disabled temporarily to fix crash
// TODO: re-enable when deltaSync is fully tested
// let _deltaSync = null;
// try { _deltaSync = require('../services/deltaSync'); } catch {}
import { playNewEmailAlert as playAlert } from '../services/notificationSound';
import { useAuth } from './AuthContext';
import { useLanguage } from './LanguageContext';
import {
  saveEmailsToCache, getEmailsFromCache, getEmailsFromCacheSync,
  saveMessageToCache, getMessageFromCache, getMessageFromCacheSync,
  queueOfflineAction, replayOfflineQueue,
  isOnline, onOnlineStatusChange,
} from '../services/offlineCache';
import { isLocalSearchOn, matchLocalRows, searchCachedBodies, mergeSearchResults } from '../services/mailLocalSearch'; // [2026-10-18 email-local-search]
import { getCached, setCache, getCachedEntrySync, hasCacheUser } from '../services/cache';

// Native cache (iOS only) — synchronous SQLite read for instant inbox first paint.
// Same module that powers chat list / chat messages / media URI cache.
// Storage key for the recently-read set, namespaced by the ACTIVE account so
// one identity's read-state can't bleed into another on a shared device
// (the old global 'recentlyRead' key survived logout/switch). Resolved at
// call time — not from a closure-captured `user` — so a stale capture can't
// write under the previous account's key right after a switch.
const rrStorageKey = () => {
  try {
    const e = api.getActiveAccountEmail && api.getActiveAccountEmail();
    return 'recentlyRead:' + (e ? String(e).toLowerCase() : '_noacct');
  } catch { return 'recentlyRead:_noacct'; }
};

const _NativeCache = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-chat-cache').default; } catch { return null; }
})();
// [2026-10-17 email-ios-acct] P0 PRIVACY: the native iOS emails table is keyed
// by (uid, folder) only — NOT by account. With 2 accounts on the device, B's
// saveEmails UPSERTED into the same 'INBOX' rows as A (mixed list) and B's
// frame-1 read could paint A's inbox. The folder key handed to the native
// module now carries the active account ('acct:<email>|INBOX'); no active
// account → no read / no write. Legacy unscoped rows are dropped once
// (clearFolder on the standard names) and are never read again.
const _nativeFolderKey = (folder) => {
  let e = '';
  try { e = String(api.getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch {}
  return e ? 'acct:' + e + '|' + String(folder || 'INBOX') : null;
};
let _nativeLegacyPurged = false;
const _nativePurgeLegacyOnce = () => {
  if (_nativeLegacyPurged || !_NativeCache?.clearFolder) return;
  _nativeLegacyPurged = true;
  for (const f of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Junk', 'Trash', 'Flagged', 'Starred', 'Snoozed', 'All', 'Important']) {
    try { const p = _NativeCache.clearFolder(f); if (p && p.catch) p.catch(() => {}); } catch {}
  }
};
const _nativeReadEmailsSync = (folder, limit = 50) => {
  if (!_NativeCache?.getCachedEmailsSync) return null;
  const key = _nativeFolderKey(folder);
  if (!key) return null;
  try {
    const list = _NativeCache.getCachedEmailsSync(key, limit);
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch { return null; }
};
const _nativeSaveEmails = (folder, emails) => {
  if (!_NativeCache?.saveEmails || !Array.isArray(emails)) return;
  const key = _nativeFolderKey(folder);
  if (!key) return;
  _nativePurgeLegacyOnce();
  try { const p = _NativeCache.saveEmails(key, emails); if (p && p.catch) p.catch(() => {}); } catch {}
};

// Sort key for an email list row (newest = larger). Within a folder the IMAP
// UID is monotonic (higher = newer), so caller prefers UID; this is the date
// fallback for the rare row without a numeric UID.
const _emailDateKey = (e) => {
  if (!e) return -Infinity;
  if (Number.isFinite(e.date_ts)) return e.date_ts;
  const t = e.date ? Date.parse(e.date) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Smooth layout animation for list add/remove
const SMOOTH_LAYOUT = {
  duration: 280,
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};

function animateListChange() {
  try { LayoutAnimation.configureNext(SMOOTH_LAYOUT); } catch {}
}

// --- New email alert: sound + vibration via notificationSound service ---
let _notifSettings = { notification_sound: true, notification_vibration: true };

// Load notification prefs from local storage at startup
(async () => {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const s = localStorage.getItem('notif_prefs');
      if (s) _notifSettings = JSON.parse(s);
    } else {
      const AS = await import('@react-native-async-storage/async-storage');
      const s = await AS.default.getItem('notif_prefs');
      if (s) _notifSettings = JSON.parse(s);
    }
  } catch {}
})();

export function updateNotifSettings(settings) {
  _notifSettings = { ..._notifSettings, ...settings };
  try {
    const json = JSON.stringify(_notifSettings);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem('notif_prefs', json);
    } else {
      import('@react-native-async-storage/async-storage')
        .then(m => m.default.setItem('notif_prefs', json)).catch(() => {});
    }
  } catch {}
}

function playNewEmailAlert() {
  playAlert(_notifSettings);
}

// Show local notification for new email (mobile) — triggers NotificationToast via foreground handler
// Includes AI-generated summary when available
async function showLocalEmailNotification(email, t) {
  if (Platform.OS === 'web' || !email) return;
  const _tt = typeof t === 'function' ? t : null;
  try {
    const Notifications = await import('expo-notifications');

    // Build notification body: subject + preview
    let body = email.subject || (_tt ? _tt('reader.noSubject') : '(no subject)');
    if (email.preview) {
      body = `${body}\n${email.preview.slice(0, 100)}`;
    }

    // Show notification immediately with basic content
    await Notifications.scheduleNotificationAsync({
      content: {
        title: email.from_name || email.from || (_tt ? _tt('toast.newEmail') : 'New email'),
        body,
        data: {
          type: 'new_email',
          uid: email.uid,
          from: email.from_name || email.from,
          subtitle: email.preview,
        },
        sound: true,
        ...(Platform.OS === 'android' ? { channelId: 'email' } : {}),
      },
      // [2026-10-06 android-audit] Android channel must be on the trigger.
      trigger: Platform.OS === 'android' ? { channelId: 'email' } : null,
    });

    // Fire-and-forget: get AI summary and show a follow-up notification
    if (email.preview && email.preview.length > 50) {
      getAISummaryForNotification(email, Notifications).catch(() => {});
    }
  } catch {}
}

// Get AI-powered quick summary for notification (non-blocking)
async function getAISummaryForNotification(email, Notifications) {
  try {
    const r = await api.aiAssist('summarize', {
      subject: email.subject,
      body: email.preview?.slice(0, 500) || email.body_text?.slice(0, 500) || '',
      from: email.from_name || email.from,
    });
    if (r.success && r.data?.result) {
      const summary = typeof r.data.result === 'string'
        ? r.data.result.slice(0, 200)
        : r.data.result.summary?.slice(0, 200);
      if (summary) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: `AI: ${email.from_name || email.from}`,
            body: summary,
            data: { type: 'ai_summary', uid: email.uid },
            sound: false,
            ...(Platform.OS === 'android' ? { channelId: 'email' } : {}),
          },
          trigger: Platform.OS === 'android' ? { channelId: 'email' } : null,
        });
      }
    }
  } catch {}
}

const MailContext = createContext(null);

// [2026-10-21 naolidos] Chave do "escopo" da lista (pasta + filtro do servidor).
// O chip "Não lidos" filtrava SÓ as ~20 linhas já carregadas (todas lidas na
// caixa do founder: 3251 não lidos no servidor, 0 na 1ª página) → "Caixa de
// entrada vazia". Agora o filtro vai pro servidor (filter=unread / category /
// label) e o escopo fica guardado aqui: paginar, puxar p/ atualizar, WS e
// polls recarregam o MESMO filtro em vez da caixa inteira.
export function mailListScopeKey(folder, scope) {
  const sc = scope || {};
  return `${folder || 'INBOX'}|${sc.category || ''}|${sc.label || ''}|${sc.filter || ''}`;
}

// Polling interval: 10s when WS down. [2026-10-18 battery] Com o WS autenticado
// o new_email chega pelo socket → o poll de 30 s (120/h com o e-mail aberto)
// virou rede de segurança de 5 min (lista e contadores de pasta).
const POLL_CONNECTED = 5 * 60 * 1000;
const POLL_DISCONNECTED = 10000;
// Refresh ao voltar p/ 'active' (ou aba visível): no máximo 1× a cada 30 s —
// trocas rápidas de app disparavam silentRefresh + loadFolders toda vez.
const FG_REFRESH_MIN_MS = 30000;
// Janela em que uma resposta de /folders pode ainda não refletir uma ação local
// (Desfazer = 5 s + POST). Ver loadFolders.
const FOLDER_SETTLE_MS = 6500;

// [2026-10-11 email-qa] Envio otimista em Enviados (ver subscribeEmailSent em
// services/api.js). Linha local fica até a lista do servidor trazer a real
// (casada por assunto + destinatário + horário) ou expirar.
const PENDING_SENT_TTL_MS = 10 * 60 * 1000;
const _isSentFolder = (name) => /^(INBOX[./])?\.?(sent|sent items|sent messages|sent mail|enviados|enviadas|itens enviados)$/i.test(String(name || '').trim());
const _normSubj = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
const _firstAddr = (x) => {
  const str = String(x || '');
  const m = str.match(/<([^>]+@[^>]+)>/) || str.match(/([^\s,;<>"]+@[^\s,;<>"]+)/);
  return m ? m[1].trim().toLowerCase() : '';
};
const _stripHtml = (h) => String(h || '')
  .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
const _sentMatches = (p, e) => {
  if (!e || e._optimistic) return false;
  if (_normSubj(e.subject) !== _normSubj(p.subject)) return false;
  const pTo = _firstAddr(p.to);
  const eTo = _firstAddr(e.to);
  if (pTo && eTo && pTo !== eTo) return false;
  const ek = _emailDateKey(e);
  // Data do servidor pode vir sem fuso/arredondada → janela folgada.
  return !Number.isFinite(ek) || ek <= 0 || ek >= p._optimisticAt - 15 * 60 * 1000;
};

export function MailProvider({ children }) {
  const { user } = useAuth();
  // [2026-10-10 qa-sweep] Toast/notificação de e-mail novo usava "New email" /
  // "(no subject)" fixos em inglês. MailProvider mora dentro do LanguageProvider.
  const { t: _t } = useLanguage();
  const _tRef = useRef(_t);
  _tRef.current = _t;

  // ─── Email-activity gate (chat-first app) ────────────────────────────────
  // The app is chat-first and lands on /chat. A user parked on /chat used to
  // pay the full email background cost (silentRefresh every 30s + loadFolders
  // every 120s) for a mailbox they never opened — wasted network/CPU/battery
  // that also stole fluidity from chat. We gate the TIME-BASED email poll (the
  // interval effect further down) so it only runs once the user shows intent to
  // use email: either they're on an email screen (inbox/read/compose) right
  // now, or they've opened one at least once this session (after which email
  // behaves exactly as before — real-time poll — for the rest of the session).
  //
  // What stays ALWAYS on, so email never regresses:
  //   • the WS `new_email` handlers + the `mail_{email}` channel subscription —
  //     event-driven and cheap, so a real-time push still prepends the email
  //     and refreshes folder counts (the unread badge) even while the poll is
  //     paused on /chat;
  //   • the WS zombie watchdog — it guards the shared realtime socket (chat
  //     uses the same singleton), so gating it would risk breaking chat.
  const pathname = usePathname();
  const onEmailScreen = useMemo(() => {
    const p = pathname || '';
    return p === '/inbox' || p.startsWith('/inbox/')
        || p === '/read' || p.startsWith('/read/')
        || p === '/compose' || p.startsWith('/compose/');
  }, [pathname]);
  // Latches true on the first email-screen visit; once set, email stays live
  // for the session so briefly navigating away (e.g. tapping a link) doesn't
  // thrash the poll on/off.
  const [emailEverActive, setEmailEverActive] = useState(false);
  useEffect(() => {
    if (onEmailScreen && !emailEverActive) setEmailEverActive(true);
  }, [onEmailScreen, emailEverActive]);
  const emailPollingEnabled = onEmailScreen || emailEverActive;
  const emailPollingWasEnabledRef = useRef(false);
  const emailPollingEnabledRef = useRef(emailPollingEnabled);
  emailPollingEnabledRef.current = emailPollingEnabled;
  // [2026-10-16 pisca] LayoutAnimation é GLOBAL (próximo commit do Fabric em
  // QUALQUER tela). Eventos de WS (e-mail novo/apagado/movido) chegam com o
  // usuário no chat/conversa e animavam (fade de opacidade 280 ms) o que a tela
  // aberta montasse em seguida → "piscada" aleatória no Android. Só anima com a
  // lista do inbox na tela.
  const inboxListVisibleRef = useRef(false);
  inboxListVisibleRef.current = (() => { const p = pathname || ''; return p === '/inbox' || p.startsWith('/inbox/'); })();

  // Use the native SQLite cache as the initial state so the inbox is rendered
  // with real emails on the very first frame (no empty list flash).
  const [emails, setEmails] = useState(() => _nativeReadEmailsSync('INBOX') || getEmailsFromCacheSync('INBOX') || []);
  // [2026-10-11 email-qa] Leitura SÍNCRONA da lista atual. Os "wasUnread"/
  // "removed" calculados DENTRO do updater do setEmails só rodam no próximo
  // render (React 18 batch) → o `if (wasUnread)` logo abaixo via sempre false e
  // o contador da barra lateral não baixava ao abrir/excluir (só no refetch).
  const emailsRef = useRef(emails);
  emailsRef.current = emails;
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState('INBOX');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [labelCounts, setLabelCounts] = useState({});
  const refreshRef = useRef(null);
  // [2026-10-11 email-qa] refs p/ os re-fetch atrasados do aviso de chegada.
  const arrivalRetryRef = useRef({ a: null, b: null });
  const silentRefreshRef = useRef(null);
  const loadFoldersRef = useRef(null);
  // Última mudança OTIMISTA nos contadores de pasta (ver loadFolders).
  const folderMutAtRef = useRef(0);
  const folderResyncRef = useRef(null);
  const foldersPaintedRef = useRef(false);
  const folderRef = useRef(currentFolder);
  const authRef = useRef(null);
  // Tracks the email we *intended* to connect WS for. Survives the brief
  // window between socket open and server `authenticated` reply when
  // mailWs.email is still null — preventing the WS effect from racing
  // itself on a re-render. (Reconnect storm fix 2026-05-19.)
  const lastConnectedEmailRef = useRef(null);
  const offlineQueueRef = useRef(false);

  // Track recently-read UIDs to prevent seen state from reverting (IMAP flag lag)
  const recentlyReadRef = useRef(new Set());
  // Track recently-ARRIVED UIDs (uid -> ts) prepended by the new_email WS
  // handler, so a silent refresh doesn't DROP a just-arrived email when the
  // server's IMAP page-1 view hasn't indexed it yet (list flicker fix).
  const recentlyArrivedRef = useRef(new Map());
  // Track recent star/unstar toggles (uid -> {flagged, ts}) so a refresh
  // painting stale server data (in-flight request, Rust page cache, PG index
  // waiting on the reconcile cron) doesn't revert the optimistic toggle.
  // In-memory only, 150s window — after that the server wins, so a change
  // made on another device can't get stuck here.
  const recentlyFlaggedRef = useRef(new Map());
  // In-memory Map<folder, rows[]> retaining each folder's last rows across
  // switches, so changeFolder can paint instantly instead of showing the
  // previous folder's rows under the new header (instant folder switch fix).
  const folderRowsRef = useRef(new Map());
  // [2026-10-21 naolidos] Escopo ativo da lista (ver mailListScopeKey) e o que
  // está pintado agora: `listView.key` = escopo das linhas em `emails`,
  // `confirmed` = o servidor respondeu ESTE escopo (só então "vazio" é
  // verdade), `error` = a carga deste escopo falhou (sem rede etc.).
  const listScopeRef = useRef({ folder: 'INBOX', category: '', label: '', filter: '' });
  const scopedPaintRef = useRef(false);
  const [listView, setListViewState] = useState({ key: 'INBOX|||', confirmed: false, error: false });
  const listViewKeyRef = useRef('INBOX|||');
  const setListView = useCallback((key, confirmed, error) => {
    listViewKeyRef.current = key;
    setListViewState(prev => (prev.key === key && prev.confirmed === confirmed && prev.error === error)
      ? prev : { key, confirmed, error });
  }, []);
  const setListScope = useCallback((folder, scope) => {
    const sc = scope || {};
    listScopeRef.current = {
      folder: folder || 'INBOX',
      category: sc.category || '', label: sc.label || '', filter: sc.filter || '',
    };
  }, []);
  // [2026-10-11 email-qa] Linhas otimistas de Enviados (mais nova primeiro).
  const pendingSentRef = useRef([]);
  const mergePendingSent = useCallback((folder, list) => {
    const base = Array.isArray(list) ? list : [];
    if (!_isSentFolder(folder)) return base;
    const hadOptimistic = base.some(e => e && e._optimistic);
    const pend = pendingSentRef.current;
    if (!pend.length && !hadOptimistic) return base;
    const now = Date.now();
    const used = new Set();
    const keep = [];
    for (const p of pend) {
      if (now - p._optimisticAt > PENDING_SENT_TTL_MS) continue;
      const idx = base.findIndex((e, i) => !used.has(i) && _sentMatches(p, e));
      if (idx >= 0) { used.add(idx); continue; } // servidor já trouxe a real
      keep.push(p);
    }
    pendingSentRef.current = keep;
    const rest = hadOptimistic ? base.filter(e => !(e && e._optimistic)) : base;
    return keep.length ? [...keep, ...rest] : rest;
  }, []);
  // Tracks the folder+query of the last loadEmails call so we can force page 1
  // when either changes (prevents requesting a non-existent page after a
  // folder/search switch). Seeded to the initial folder.
  const loadEmailsCtxRef = useRef({ folder: 'INBOX', query: '' });
  // [2026-10-18 email-local-search] resultados locais da busca ativa — unidos
  // ao resultado do servidor quando ele chega (e mantidos se a rede falhar).
  const localSearchRef = useRef({ q: '', folder: '', rows: [] });
  const searchServerDoneRef = useRef(false);
  const [recentlyReadLoaded, setRecentlyReadLoaded] = useState(false);

  // Load persisted recently-read UIDs on mount (survives app restart).
  // Keyed PER ACCOUNT: the old global 'recentlyRead' key survived logout, so
  // after a restart under account B the uids read under account A painted B's
  // unread emails as read on uid collision. Re-runs on account switch so the
  // ref always holds the active account's set.
  useEffect(() => {
    (async () => {
      try {
        recentlyReadRef.current = new Set();
        const key = rrStorageKey();
        let stored;
        if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          stored = JSON.parse(localStorage.getItem(key) || '{}');
        } else {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          stored = JSON.parse(await AsyncStorage.getItem(key) || '{}');
        }
        const cutoff = Date.now() - 86400000; // 24 hours
        for (const [uid, ts] of Object.entries(stored)) {
          if (ts >= cutoff) recentlyReadRef.current.add(uid);
        }
      } catch {}
      setRecentlyReadLoaded(true);
    })();
  }, [user?.email]);

  // Selection state for bulk operations
  const [selectedUids, setSelectedUids] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Undo state
  const [undoAction, setUndoAction] = useState(null);
  const undoTimerRef = useRef(null);
  // Deferred undo-window action still waiting to hit the API. Kept outside
  // the setTimeout closure so a second action / toast dismiss can FLUSH it
  // instead of silently dropping it (clearTimeout alone lost the first
  // delete/archive whenever two actions landed inside the same 5s window —
  // the email reappeared on the next refresh).
  const pendingActionRef = useRef(null);
  // Rows hidden optimistically while their delete/archive API call is still
  // deferred inside the undo window (or the server hasn't caught up yet). The
  // silent merge treats any server row missing from `prev` as a NEW arrival,
  // so without this a background refresh (focus/WS/poll) inside the 5s undo
  // window resurrected the just-deleted email. Keyed `folder:uid` (IMAP uids
  // are per-mailbox) -> expiry ts.
  const pendingRemovalRef = useRef(new Map());
  const markPendingRemoval = useCallback((folder, uids) => {
    // Long expiry on purpose: a hidden web tab pauses the undo timer, so the
    // deferred action can outlive 5s. settlePendingRemoval shortens/clears it.
    const exp = Date.now() + 600000;
    uids.forEach(u => pendingRemovalRef.current.set(folder + ':' + String(u), exp));
  }, []);
  const settlePendingRemoval = useCallback((folder, uids, restored) => {
    uids.forEach(u => {
      const key = folder + ':' + String(u);
      if (restored) pendingRemovalRef.current.delete(key);
      else pendingRemovalRef.current.set(key, Date.now() + 30000); // IMAP lag grace
    });
  }, []);

  // [2026-10-11 email-qa] Ajuste otimista do contador de não lidos de uma pasta
  // (barra lateral + badge do e-mail na barra do Chatyy). Usado por excluir/
  // arquivar/mover/adiar/ações em massa e pelo Desfazer — antes só abrir o
  // e-mail mexia no número; o resto esperava o loadFolders (até 2 min com WS).
  const bumpFolderUnread = useCallback((name, delta) => {
    if (!name || !delta) return;
    folderMutAtRef.current = Date.now();
    setFolders(prev => prev.map(f => {
      if (f.name !== name) return f;
      const cur = (f.unread ?? f.unseen ?? 0) | 0;
      const next = Math.max(0, cur + delta);
      return { ...f, unread: next, unseen: next };
    }));
    if (name === 'INBOX') {
      try { DeviceEventEmitter.emit('mail:unread-changed', { folder: name, delta }); } catch {}
    }
  }, []);
  const unreadIn = (rows) => (rows || []).reduce((n, e) => n + (e && !e.seen ? 1 : 0), 0);
  // Linhas restauradas (Desfazer / falha da API) voltam na POSIÇÃO certa (UID
  // decrescente = mais novo primeiro) e com o estado de lido atual — antes iam
  // pro topo da lista, acima do cabeçalho "Hoje", e voltavam "não lidas".
  const mergeRestored = useCallback((prev, restored) => {
    if (!restored?.length) return prev;
    const have = new Set(prev.map(e => String(e.uid)));
    const rr = recentlyReadRef.current;
    const add = restored.filter(e => e && !have.has(String(e.uid)))
      .map(e => (rr.has(String(e.uid)) && !e.seen ? { ...e, seen: true } : e));
    if (!add.length) return prev;
    const all = [...prev, ...add];
    const allNumeric = all.every(e => Number.isFinite(Number(e.uid)));
    return allNumeric
      ? all.sort((a, b) => Number(b.uid) - Number(a.uid))
      : all.sort((a, b) => _emailDateKey(b) - _emailDateKey(a));
  }, []);

  // Keep folder ref in sync
  useEffect(() => { folderRef.current = currentFolder; }, [currentFolder]);

  // Remember each folder's current rows in-memory so returning to a
  // previously-visited folder is instant (FIX: instant folder switch). Skip
  // while a search is active — search results are not the folder's canonical
  // list. Covers every mutation path (network load, silent merge, WS prepend).
  useEffect(() => {
    // [2026-10-21 naolidos] Lista filtrada (Não lidos/categoria/marcador) não
    // é a pasta: guardá-la fazia "Todos" voltar mostrando só os não lidos.
    if (!search && !scopedPaintRef.current) folderRowsRef.current.set(currentFolder, emails);
  }, [emails, currentFolder, search]);

  // Reset all state (used when switching accounts)
  const resetMailState = useCallback(() => {
    setEmails([]);
    setFolders([]);
    setCurrentFolder('INBOX');
    setSelectedEmail(null);
    setPage(1);
    setTotal(0);
    setSearch('');
    setSelectedUids(new Set());
    setSelectMode(false);
    setUndoAction(null);
    foldersPaintedRef.current = false;
    folderMutAtRef.current = 0;
    listScopeRef.current = { folder: 'INBOX', category: '', label: '', filter: '' };
    scopedPaintRef.current = false;
    setListView('INBOX|||', false, false);
    // NOTE: Do NOT clear recentlyReadRef here — it persists in localStorage
    // and must survive resets to prevent the read→unread revert bug
  }, []);

  const loadFolders = useCallback(async () => {
    // Show cached folders instantly — SÓ no primeiro paint. [2026-10-11
    // email-qa] Antes repintava o cache (velho) a cada chamada, desfazendo o
    // ajuste otimista do contador (abriu/excluiu → número voltava por ~1-2 s).
    if (!foldersPaintedRef.current) {
      // [2026-10-14 offline-first] cópia salva mesmo após o TTL de 10 min (máx. 7 dias).
      let cached = null;
      try { cached = hasCacheUser() ? (getCachedEntrySync('email_folders')?.data || null) : null; } catch {}
      if (cached && !foldersPaintedRef.current) setFolders(cached);
    }
    const reqAt = Date.now();
    try {
      const r = await api.getFolders();
      if (r.success) {
        const folderList = Array.isArray(r.data) ? r.data : r.data?.folders || [];
        foldersPaintedRef.current = true;
        setCache('email_folders', folderList, 600000).catch(() => {});
        // [2026-10-11 email-qa] Resposta que saiu ANTES do servidor aplicar a
        // última ação local (mark_read em voo, excluir/arquivar na janela do
        // Desfazer, evento IDLE do Rust disparado pela própria ação) traz o
        // contador VELHO. Nesse caso mantém os não lidos locais, aceita o resto
        // e reconfere quando a janela fecha.
        const lastMut = folderMutAtRef.current;
        if (lastMut && lastMut >= reqAt - FOLDER_SETTLE_MS) {
          setFolders(prev => {
            const m = new Map((prev || []).map(f => [f.name, f]));
            return folderList.map(f => {
              const p = m.get(f.name);
              if (!p) return f;
              const u = (p.unread ?? p.unseen);
              return u == null ? f : { ...f, unread: u, unseen: u };
            });
          });
          clearTimeout(folderResyncRef.current);
          folderResyncRef.current = setTimeout(() => { try { loadFoldersRef.current?.(); } catch {} },
            Math.max(400, lastMut + FOLDER_SETTLE_MS + 300 - Date.now()));
        } else {
          setFolders(folderList);
        }
      }
    } catch {}
  }, []);

  const loadEmails = useCallback(async (folder, pg = 1, q = '', category = '', label = '', silent = false, filter = '') => {
    const f = folder || currentFolder;
    // [2026-10-21 naolidos] Sem filtro explícito → herda o escopo ativo da
    // pasta (paginação/refresh/WS/poll continuam no "Não lidos").
    {
      const sc = listScopeRef.current;
      if (!category && !label && !filter && sc.folder === f) {
        category = sc.category; label = sc.label; filter = sc.filter;
      }
    }
    const scoped = !!(category || label || filter);
    const scopeKey = mailListScopeKey(f, { category, label, filter });

    // Pagination reset guard: if the folder or the search query differs from
    // the previous loadEmails call, force page 1. Otherwise switching from a
    // large folder (where the user scrolled to page 5) into a smaller folder —
    // or starting/clearing a search — would request a non-existent page and
    // come back empty. (loadMore is the only legit path that keeps pg > 1, and
    // it always targets the same folder+query, so it's unaffected.)
    if (pg > 1 && (f !== loadEmailsCtxRef.current.folder || q !== loadEmailsCtxRef.current.query
        || scopeKey !== loadEmailsCtxRef.current.scope)) {
      pg = 1;
      setPage(1);
    }
    loadEmailsCtxRef.current = { folder: f, query: q, scope: scopeKey };

    // [account-epoch guard] Capture the active account NOW. A slow in-flight
    // getInbox for account A can resolve AFTER the user switched to B —
    // switchAccount doesn't abort in-flight requests. Without this guard, A's
    // emails would paint over B's list AND get persisted into B's cache
    // namespace (saveEmailsToCache/_nativeSaveEmails resolve the namespace at
    // save time = B), poisoning B's cold starts forever. We re-check after the
    // await and drop the stale response.
    const _acctEpoch = api.getActiveAccountEmail?.() ?? '';

    // Show cached data INSTANTLY on non-silent first-page loads (no spinner if cache exists)
    if (!silent && pg === 1 && !q && !scoped) {
      // [2026-09-24 fix "Yesterday→Today pisca"] Se JÁ temos linhas em memória
      // desta sessão pra esta pasta (changeFolder acabou de pintá-las via
      // folderRowsRef), NÃO sobrescrever com o cache de DISCO — ele pode estar
      // mais velho (ex: sem os emails de hoje), o que fazia a lista pintar
      // "Yesterday" no topo e só depois "atualizar" pra "Today" (o flash que o
      // user via ao clicar em Inbox). Mantemos as linhas em memória e só
      // buscamos fresco em silêncio. Cold start (sem memória) segue no cache.
      const remembered = folderRowsRef.current.get(f);
      if (remembered && remembered.length > 0) {
        // [2026-10-21 naolidos] Voltando de um filtro (Não lidos → Todos): a
        // tela ainda mostra a lista filtrada → repinta a pasta na hora.
        if (scopedPaintRef.current) {
          scopedPaintRef.current = false;
          setEmails(mergePendingSent(f, remembered));
          setListView(scopeKey, false, false);
        }
        silent = true;
      } else {
        const cached = await getEmailsFromCache(f);
        if (cached && cached.length > 0) {
          scopedPaintRef.current = false;
          setListView(scopeKey, false, false);
          setEmails(mergePendingSent(f, cached));
          setTotal(cached.length);
          // Don't show loading spinner — we have cached data visible
          // Fetch fresh data silently in background
          silent = true;
        } else {
          setLoadingList(true);
        }
      }
    } else if (!silent) {
      setLoadingList(true);
      // [2026-10-21 naolidos] Entrou num filtro: pinta NA HORA só o que já se
      // sabe dele (linhas da pasta em memória que batem) e o resto vem do
      // servidor; sem nada local → lista vazia + skeleton (nunca "Caixa
      // vazia" antes do servidor confirmar — ver listView.confirmed).
      if (scoped && pg === 1 && !q && listViewKeyRef.current !== scopeKey) {
        const base = folderRowsRef.current.get(f) || [];
        let local = [];
        if (!label) {
          local = base.filter(e => e && (!filter || !e.seen) && (!category || e.category === category));
        }
        scopedPaintRef.current = true;
        setEmails(local);
        setListView(scopeKey, false, false);
      }
    }

    try {
      const r = await api.getInbox(f, pg, 20, q, category, label, filter);
      // [2026-10-21 naolidos] Resposta de um escopo/pasta que já não é o atual
      // (trocou de chip/pasta com a requisição em voo) não pinta por cima.
      if (loadEmailsCtxRef.current.scope !== scopeKey) return;
      // Account switched while this request was in flight → this is account A's
      // data arriving after the user moved to B. Drop it: painting or caching
      // it now would leak A into B and poison B's persisted cache namespace.
      if ((api.getActiveAccountEmail?.() ?? '') !== _acctEpoch) return;
      // [2026-10-18 email-local-search] busca: resposta de uma consulta/pasta
      // que já não é a atual (digitou de novo, limpou) não pinta por cima.
      if ((q || loadEmailsCtxRef.current.query) && isLocalSearchOn()
          && (loadEmailsCtxRef.current.query !== q || loadEmailsCtxRef.current.folder !== f)) return;
      if (r.success) {
        let emailList = r.data?.emails || [];
        // Drop rows whose removal is still pending/settling server-side so a
        // background refresh can't resurrect a just-deleted/archived email.
        const pendingRemoval = pendingRemovalRef.current;
        if (pendingRemoval.size) {
          const now = Date.now();
          for (const [k, exp] of pendingRemoval) { if (exp <= now) pendingRemoval.delete(k); }
          if (pendingRemoval.size) emailList = emailList.filter(e => !pendingRemoval.has(f + ':' + String(e.uid)));
        }

        // Apply recentlyRead protection: force seen=true for UIDs the user just read
        const recentlyRead = recentlyReadRef.current;
        const applyRecentlyRead = (list) =>
          recentlyRead.size === 0 ? list : list.map(e =>
            recentlyRead.has(String(e.uid)) && !e.seen ? { ...e, seen: true } : e
          );

        // Recently-flagged protection (mirrors recentlyRead, but keeps the
        // toggle DIRECTION so both star and unstar are covered).
        const recentFlags = recentlyFlaggedRef.current;
        const flagCutoff = Date.now() - 150000;
        for (const [k, v] of recentFlags) { if (v.ts < flagCutoff) recentFlags.delete(k); }
        const applyRecentFlags = (list) =>
          recentFlags.size === 0 ? list : list.map(e => {
            const rf = recentFlags.get(String(e.uid));
            return rf && e.flagged !== rf.flagged ? { ...e, flagged: rf.flagged } : e;
          });

        const _ls = localSearchRef.current;
        if (pg === 1 && q && _ls.q === q) searchServerDoneRef.current = true;
        // [2026-10-21 naolidos] O servidor respondeu ESTE escopo: a partir
        // daqui uma lista vazia é verdade (estado vazio liberado).
        if (pg === 1) {
          scopedPaintRef.current = scoped;
          setListView(scopeKey, true, false);
        }
        if (pg === 1 && q && silent === 'local' && _ls.q === q && _ls.folder === f) {
          // Local já está na tela: servidor por cima + achados locais que ele
          // não trouxe (corpo em cache, prévia), sem spinner nem pulo.
          setEmails(mergeSearchResults(applyRecentFlags(applyRecentlyRead(emailList)), _ls.rows));
        } else if (pg > 1) {
          // Pagination (infinite scroll / pager "next"): APPEND this page and
          // dedupe by uid instead of REPLACING the list. Previously loadEmails
          // replaced state for pg>1, so scrolling to page 2 wiped page 1 and
          // the list appeared to reset — infinite scroll was effectively dead.
          setEmails(prev => {
            const seen = new Set(prev.map(e => String(e.uid)));
            const additions = applyRecentFlags(applyRecentlyRead(emailList)).filter(e => !seen.has(String(e.uid)));
            return additions.length ? [...prev, ...additions] : prev;
          });
        } else if (silent) {
          // Silent merge: update existing emails in-place, prepend new ones, remove deleted
          // IMPORTANT: preserve local seen=true if user just read the email (IMAP may lag)
          setEmails(prev => {
            const prevMap = new Map(prev.map(e => [e.uid, e]));
            // Check if anything actually changed
            if (prev.length === emailList.length && emailList.every((e, i) =>
              prev[i]?.uid === e.uid && prev[i]?.seen === e.seen && prev[i]?.flagged === e.flagged
            )) {
              return prev; // No change — skip re-render entirely
            }
            // Reconcile the server page: keep order from server, but preserve
            // local optimistic state.
            const reconciled = emailList.map(e => {
              const existing = prevMap.get(e.uid);
              if (!existing) {
                // New email from server — still apply recentlyRead protection
                return recentlyRead.has(String(e.uid)) ? { ...e, seen: true } : e;
              }
              // NEVER revert seen from true to false - once read, always read
              const mergedSeen = existing.seen ? true : (e.seen || recentlyRead.has(String(e.uid)));
              const rf = recentFlags.get(String(e.uid));
              const mergedFlagged = rf ? rf.flagged : e.flagged;
              if (existing.seen === mergedSeen && existing.flagged === mergedFlagged &&
                  existing.subject === e.subject && JSON.stringify(existing.labels) === JSON.stringify(e.labels)) {
                return existing; // Same ref = no re-render for this row
              }
              return { ...e, seen: mergedSeen, flagged: mergedFlagged };
            });
            // UNION merge (FIX: "últimos emails somem depois aparecem"). The
            // server's page-1 is authoritative for the *content* of the rows it
            // returns, but NOT for MEMBERSHIP: a just-arrived email (prepended
            // by the new_email WS handler) is dropped when IMAP hasn't indexed
            // it yet, then reappears next poll. So we keep local-only rows that
            // are NEWER than the server's newest returned item — or that just
            // arrived within the protection window (recentlyArrivedRef, mirrors
            // recentlyReadRef for seen-state). Deleted/moved rows still fall out
            // (email_deleted / email_moved WS events prune `prev`), and older
            // page-2+ rows are still collapsed as before.
            const serverUids = new Set(emailList.map(e => String(e.uid)));
            const arrived = recentlyArrivedRef.current;
            const arrivedCutoff = Date.now() - 120000; // 2 min
            // Prune stale arrival marks so the set can't grow unbounded.
            for (const [uid, ts] of arrived) {
              if (ts < arrivedCutoff || serverUids.has(uid)) arrived.delete(uid);
            }
            const newestUid = emailList.length ? Number(emailList[0].uid) : NaN;
            const newestKey = emailList.length ? _emailDateKey(emailList[0]) : -Infinity;
            const survivors = prev.filter(e => {
              const key = String(e.uid);
              if (serverUids.has(key)) return false; // reconciled above
              if (arrived.has(key)) return true; // just arrived, protect it
              // [2026-10-21 naolidos] Filtro (Não lidos/categoria/marcador): o
              // servidor é a verdade da pertença — com resposta vazia o
              // fallback por data abaixo mantinha TODAS as linhas antigas.
              if (scoped) return false;
              const uidN = Number(e.uid);
              if (Number.isFinite(uidN) && Number.isFinite(newestUid)) return uidN > newestUid;
              return _emailDateKey(e) > newestKey; // date fallback
            });
            const merged = survivors.length ? [...survivors, ...reconciled] : reconciled;
            return (pg === 1 && !q && !scoped) ? mergePendingSent(f, merged) : merged;
          });
        } else {
          // Non-silent load: replace all, but still protect recently-read emails
          const fresh = applyRecentFlags(applyRecentlyRead(emailList));
          if (pg === 1 && q && _ls.q === q && _ls.folder === f) setEmails(mergeSearchResults(fresh, _ls.rows));
          else setEmails((pg === 1 && !q && !scoped) ? mergePendingSent(f, fresh) : fresh);
        }
        setTotal(r.data?.total || 0);
        // Update label unread counts from server
        if (r.data?.label_counts) setLabelCounts(r.data.label_counts);
        // Cache first page results
        if (pg === 1 && !q && !scoped) {
          saveEmailsToCache(f, emailList).catch(() => {});
          _nativeSaveEmails(f, emailList);
        }
        // Replay offline queue when back online
        if (offlineQueueRef.current) {
          offlineQueueRef.current = false;
          replayOfflineQueue(api).catch(() => {});
        }
      } else if (pg === 1 && scoped) {
        throw new Error(r?.message || 'inbox_scope_failed'); // → catch: erro, não "vazio"
      }
    } catch {
      // [2026-10-21 naolidos] Falha do filtro: não pinta a caixa inteira
      // (cache) por baixo do chip, e avisa a tela (erro ≠ "vazio").
      if (pg === 1 && scoped && loadEmailsCtxRef.current.scope === scopeKey) {
        listViewKeyRef.current = scopeKey;
        setListViewState(prev => (prev.key === scopeKey ? (prev.error ? prev : { ...prev, error: true })
          : { key: scopeKey, confirmed: false, error: true }));
      }
      // Fallback to cached data when offline (only if we didn't already show cache)
      if (pg === 1 && !q && !scoped) {
        const cached = await getEmailsFromCache(f);
        if (cached) {
          setEmails(cached);
          setTotal(cached.length);
        }
      }
    } finally {
      setLoadingList(false);
    }
  }, [currentFolder]);

  const openEmail = useCallback(async (uid, folder) => {
    // [2026-10-11 email-qa] Linha otimista de Enviados (ainda sem uid IMAP):
    // mostra o que foi enviado direto da memória, sem rede.
    if (String(uid).startsWith('local-')) {
      const p = pendingSentRef.current.find(x => String(x.uid) === String(uid))
        || emailsRef.current.find(x => String(x.uid) === String(uid));
      if (p) setSelectedEmail({ ...p, body_html: p._bodyHtml || '', body_text: p._bodyText || p.preview || '' });
      setLoadingMessage(false);
      return;
    }
    // [2026-10-14 offline-first] corpo já salvo → pinta no MESMO frame (sem skeleton).
    let _syncHit = null;
    try { _syncHit = getMessageFromCacheSync(uid, folder || currentFolder); } catch {}
    if (_syncHit) { setSelectedEmail({ ..._syncHit, seen: true, read: true }); setLoadingMessage(false); }
    else setLoadingMessage(true);
    // [2026-10-11] Abriu = lido NA HORA na lista/contador (local, sem POST); o
    // POST ao servidor continua no caminho da rede abaixo (ou no catch).
    try { markAsRead(uid, folder, true); } catch {}
    // [2026-07-02 email speed] Paint from the LOCAL cache FIRST so re-opening an
    // already-seen email is instant (Gmail/Superhuman pattern), then revalidate
    // from the network in the background. Email bodies are immutable once
    // delivered, so the cached copy is correct; the network result only refreshes
    // mutable bits (flags/labels) and self-corrects the view when it lands.
    // Guarded: a cache miss (or a body-less stub) falls straight through to the
    // network path below with the spinner still showing.
    let paintedFromCache = !!_syncHit;
    if (!_syncHit) try {
      const cached = await getMessageFromCache(uid, folder || currentFolder);
      if (cached && (cached.body_html || cached.body_text || cached.body)) {
        setSelectedEmail({ ...cached, seen: true, read: true });
        paintedFromCache = true;
        setLoadingMessage(false); // we already have something real on screen
      }
    } catch {}
    try {
      const _hasBody = (d) => !!(d && (d.body_html || d.body_text || d.body ||
        (Array.isArray(d.attachments) && d.attachments.length > 0)));
      let r = await api.getMessage(uid, folder || currentFolder);
      // Desktop parity with app/read.js (~112): a single transient IMAP 401 /
      // edge timeout — or an empty body from a Rust blip — used to strand the
      // reader on a blank pane. Retry the fetch ONCE before trusting "no
      // body". api.js's Rust-dead state is cooldown-based, so the retry can
      // land on a healthy path (PHP fallback or recovered Rust).
      if (!(r && r.success && _hasBody(r.data))) {
        const r2 = await api.getMessage(uid, folder || currentFolder).catch(() => null);
        if (r2 && r2.success && (_hasBody(r2.data) || !(r && r.success))) r = r2;
      }
      if (r && r.success) {
        // Optimistic: stamp seen=true on the selected message so the reader
        // pane never shows the "unread" pill/styling after open. The IMAP
        // \Seen flag flips server-side via Rust ?mark_seen=true OR via the
        // markAsRead POST below; either way the UI must not lag.
        setSelectedEmail({ ...r.data, seen: true, read: true });
        // FIX: drop the redundant markRead POST. getMessage hits Rust with
        // ?mark_seen=true, so when the message comes back already seen the
        // server has ALREADY set \Seen — skip the extra POST and keep only the
        // local optimistic seen-state + persisted recentlyRead set. When the
        // message came back unseen (PHP fallback / offline stub that didn't
        // flag it), fall through to the full path that also POSTs to the server.
        // [2026-10-11] SEMPRE avisa o servidor: o cache do Rust pode responder
        // seen=true sem ter marcado no IMAP (prévia/disco) → ficava não lido.
        markAsRead(uid, folder);
        saveMessageToCache(uid, r.data, folder || currentFolder).catch(() => {});
      }
    } catch {
      // Fallback to cached message
      const cached = await getMessageFromCache(uid, folder || currentFolder);
      if (cached) setSelectedEmail({ ...cached, seen: true, read: true });
      // Rede falhou: ainda assim avisa o servidor que foi lido.
      try { markAsRead(uid, folder); } catch {}
    } finally {
      setLoadingMessage(false);
    }
  }, [currentFolder]); // markAsRead é declarado abaixo (TDZ) — não pode ir nas deps

  // Mark email as read — updates both server and local state
  const markAsRead = useCallback(async (uid, folder, skipServerPost = false) => {
    const uidStr = String(uid);
    const targetFolder = folder || currentFolder;
    // Optimistic UI update — capture whether the row was actually unread
    // so we only decrement the folder badge once (idempotent re-marks
    // shouldn't drift the counter negative).
    // Decide SINCRONAMENTE (emailsRef) — o updater do setEmails só roda no
    // próximo render, então o flag setado lá dentro chegava tarde (sempre false).
    // Só conta quando a linha é da pasta visível (uids são por pasta).
    const wasUnread = targetFolder === folderRef.current &&
      emailsRef.current.some(e => String(e.uid) === uidStr && !e.seen);
    setEmails(prev => prev.map(e => {
      if (String(e.uid) !== uidStr) return e;
      if (e.seen) return e; // already read — no change, no decrement
      return { ...e, seen: true };
    }));
    // Optimistic folder badge decrement — Sidebar reads
    // folders[i].unread/.unseen for the badge. Without this the
    // sidebar count lags until the next folders refresh (often >5s),
    // so users see the email move to "read" styling in the list but
    // the sidebar still shows the old unread count. (WAVE 94 fix.)
    if (wasUnread) {
      folderMutAtRef.current = Date.now();
      setFolders(prev => prev.map(f => {
        if (f.name !== targetFolder) return f;
        const cur = (f.unread ?? f.unseen ?? 0) | 0;
        const next = Math.max(0, cur - 1);
        return { ...f, unread: next, unseen: next };
      }));
    }
    // [2026-10-11] Avisa o resto do app (badge de e-mail na barra do Chatyy).
    try { DeviceEventEmitter.emit('mail:unread-changed', { uid: uidStr, folder: targetFolder, delta: wasUnread ? -1 : 0 }); } catch {}
    // Track this UID as recently read — prevents revert from stale server data
    recentlyReadRef.current.add(uidStr);
    // Persist so it survives app restarts
    try {
      const now = Date.now();
      const cutoff = now - 86400000;
      const rrKey = rrStorageKey();
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        const stored = JSON.parse(localStorage.getItem(rrKey) || '{}');
        stored[uidStr] = now;
        for (const k of Object.keys(stored)) { if (stored[k] < cutoff) delete stored[k]; }
        localStorage.setItem(rrKey, JSON.stringify(stored));
      } else {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const stored = JSON.parse(await AsyncStorage.getItem(rrKey) || '{}');
        stored[uidStr] = now;
        for (const k of Object.keys(stored)) { if (stored[k] < cutoff) delete stored[k]; }
        await AsyncStorage.setItem(rrKey, JSON.stringify(stored));
      }
    } catch {}
    // Call the server — await so it completes before app might close.
    // skipServerPost=true when the caller already knows the server set \Seen
    // (e.g. openEmail's getMessage used ?mark_seen=true and came back seen),
    // making this POST redundant. The optimistic seen-state + persisted
    // recentlyRead above still run; only the network round-trip is skipped.
    if (!skipServerPost) {
      try {
        const r = await api.markRead(uid, targetFolder);
        if (r?.success) {
          // Servidor confirmou → recontar (barra do Chatyy + ícone do app).
          try { DeviceEventEmitter.emit('mail:unread-changed', { uid: uidStr, folder: targetFolder, synced: true }); } catch {}
          try { require('../services/pushNotifications').refreshBadgeCount?.()?.catch?.(() => {}); } catch {}
        }
        if (!r?.success) {
          console.warn('markRead failed for uid', uid, r?.message);
          // Backend rejected the flag-set. Revert the optimistic seen=true and
          // the folder badge decrement, otherwise the unread "bounces back" on
          // the next folders/inbox refresh and the counter drifts. Only revert
          // rows we actually flipped (wasUnread).
          if (wasUnread) {
            recentlyReadRef.current.delete(uidStr);
            setEmails(prev => prev.map(e =>
              String(e.uid) === uidStr ? { ...e, seen: false } : e
            ));
            setFolders(prev => prev.map(f => {
              if (f.name !== targetFolder) return f;
              const cur = (f.unread ?? f.unseen ?? 0) | 0;
              const next = cur + 1;
              return { ...f, unread: next, unseen: next };
            }));
          }
        }
      } catch (e) {
        console.warn('markRead error for uid', uid, e);
        // Queue for offline retry
        queueOfflineAction({ type: 'markRead', uid, folder: targetFolder }).catch(() => {});
      }
    }
    // No auto-expire timer needed — recentlyRead is cleaned up from
    // persisted storage on load (24h cutoff) and the ref is cleared on unmount.
  }, [currentFolder]);

  // Drop uids from the recentlyRead protection (ref + persisted store).
  // recentlyRead exists to stop stale server data from reverting a READ email
  // to unread — but the same protection made "mark as unread" impossible to
  // keep: the user had read the email, so every silent merge forced seen=true
  // back within one poll (and for up to 24h via the persisted key).
  const forgetRecentlyRead = useCallback(async (uids) => {
    const strs = uids.map(String);
    for (const s of strs) recentlyReadRef.current.delete(s);
    try {
      const rrKey = rrStorageKey();
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        const stored = JSON.parse(localStorage.getItem(rrKey) || '{}');
        for (const s of strs) delete stored[s];
        localStorage.setItem(rrKey, JSON.stringify(stored));
      } else {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const stored = JSON.parse(await AsyncStorage.getItem(rrKey) || '{}');
        for (const s of strs) delete stored[s];
        await AsyncStorage.setItem(rrKey, JSON.stringify(stored));
      }
    } catch {}
  }, []);

  const markAsUnread = useCallback(async (uid, folder) => {
    const uidStr = String(uid);
    const targetFolder = folder || currentFolder;
    await forgetRecentlyRead([uidStr]);
    // Optimistic flip + folder badge increment — mirror of markAsRead. The
    // merge's "once read always read" clause keys off existing.seen, so the
    // optimistic seen=false here is what lets the server's unread state win
    // on the next refresh.
    // Síncrono via emailsRef (ver markAsRead). Linha fora da lista visível
    // (ex.: leitor aberto por link) ainda conta: se não está na lista, o
    // servidor tinha ela como lida (acabamos de abrir).
    const _row = emailsRef.current.find(e => String(e.uid) === uidStr);
    const wasSeen = _row ? !!_row.seen : targetFolder === folderRef.current;
    setEmails(prev => prev.map(e => {
      if (String(e.uid) !== uidStr) return e;
      if (!e.seen) return e; // already unread — no change, no increment
      return { ...e, seen: false };
    }));
    if (wasSeen) {
      folderMutAtRef.current = Date.now();
      setFolders(prev => prev.map(f => {
        if (f.name !== targetFolder) return f;
        const cur = (f.unread ?? f.unseen ?? 0) | 0;
        const next = cur + 1;
        return { ...f, unread: next, unseen: next };
      }));
    }
    try {
      const r = await api.markUnread(uid, targetFolder);
      if (!r?.success) {
        console.warn('markUnread failed for uid', uid, r?.message);
        if (wasSeen) {
          setEmails(prev => prev.map(e =>
            String(e.uid) === uidStr ? { ...e, seen: true } : e
          ));
          setFolders(prev => prev.map(f => {
            if (f.name !== targetFolder) return f;
            const cur = (f.unread ?? f.unseen ?? 0) | 0;
            const next = Math.max(0, cur - 1);
            return { ...f, unread: next, unseen: next };
          }));
        }
      }
    } catch (e) {
      console.warn('markUnread error for uid', uid, e);
    }
  }, [currentFolder, forgetRecentlyRead]);

  // Reset and reload when user changes (account switch)
  const prevUserRef = useRef(user?.email);
  useEffect(() => {
    if (user?.email && user.email !== prevUserRef.current) {
      prevUserRef.current = user.email;
      setEmails([]);
      setFolders([]);
      setSelectedEmail(null);
      setCurrentFolder('INBOX');
      setPage(1);
      setSearch('');
      recentlyReadRef.current = new Set();
      foldersPaintedRef.current = false;
      folderMutAtRef.current = 0;
      // Per-account caches: without these clears, changeFolder instant-paints
      // the PREVIOUS account's remembered rows, and pendingRemoval/arrived
      // windows filter or protect the new account's uids on collision.
      folderRowsRef.current = new Map();
      listScopeRef.current = { folder: 'INBOX', category: '', label: '', filter: '' };
      scopedPaintRef.current = false;
      setListView('INBOX|||', false, false);
      pendingSentRef.current = [];
      pendingRemovalRef.current = new Map();
      recentlyArrivedRef.current = new Map();
      recentlyFlaggedRef.current = new Map();
      // DROP (never flush) a pending undo-window action from the previous
      // account: the deferred closure holds uid+folder from account A, but
      // apiCall signs with the module-level token — which is account B's by
      // the time the 5s timer fires, so it would delete B's email on a
      // colliding IMAP uid. Dropping just resurfaces A's email on next load.
      clearTimeout(undoTimerRef.current);
      pendingActionRef.current = null;
      if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
      setUndoAction(null);
      // [perf 2026-10-06] Chat-first boot: this effect also fires on the FIRST
      // auth hydrate (prevUserRef starts undefined), which used to issue an
      // api.getInbox on every cold start even though the user lands on /chat.
      // Only reload here when email is live (or this is a real account switch
      // while email is live); inbox.js loads INBOX itself on mount.
      if (emailPollingEnabledRef.current) loadEmails('INBOX', 1, '');
    }
  }, [user?.email]);

  const changeFolder = useCallback((folder) => {
    // [2026-10-21 naolidos] Trocar de pasta sai do filtro (estilo Gmail).
    listScopeRef.current = { folder, category: '', label: '', filter: '' };
    scopedPaintRef.current = false;
    setListView(mailListScopeKey(folder), false, false);
    setCurrentFolder(folder);
    setSelectedEmail(null);
    setPage(1);
    setSearch('');
    clearSelection();
    // Instant folder switch: SYNCHRONOUSLY paint this folder's last-known rows
    // from the in-memory map, so the UI never shows the PREVIOUS folder's rows
    // under the new folder's header while loadEmails awaits disk/network. An
    // unvisited folder → empty list + loading, which renders the honest
    // skeleton (EmailList shows the skeleton only when loading && no rows).
    const remembered = folderRowsRef.current.get(folder);
    if (remembered && remembered.length > 0) {
      setEmails(mergePendingSent(folder, remembered));
    } else {
      // [2026-10-17 email-gmail-parity] Pasta não vista NESTA sessão mas salva no
      // disco (sessão anterior) → pinta síncrono do cache local em vez do skeleton;
      // o loadEmails abaixo revalida em silêncio (estilo Gmail: nunca spinner com cache).
      let disk = null;
      // Só o cache MMKV/localStorage (namespaced por conta) — o SQLite nativo do
      // iOS não separa por conta e aqui pode ser logo após uma troca de conta.
      try { disk = getEmailsFromCacheSync(folder); } catch { disk = null; }
      // Enviados nunca visitado mas com envio otimista → já pinta a linha.
      const pend = mergePendingSent(folder, Array.isArray(disk) ? disk : []);
      setEmails(pend);
      if (!pend.length) setLoadingList(true);
    }
    loadEmails(folder, 1, '');
  }, [loadEmails, mergePendingSent, setListView]);

  // [2026-10-11 email-qa] Enviou → linha em Enviados NA HORA; Desfazer remove.
  // Reconciliação: mergePendingSent em toda carga da pasta Enviados + recargas
  // silenciosas agendadas enquanto ela estiver aberta.
  const sentReloadTimersRef = useRef([]);
  useEffect(() => {
    if (typeof api.subscribeEmailSent !== 'function') return undefined;
    const applyEverywhere = () => {
      for (const [k, rows] of folderRowsRef.current) {
        if (_isSentFolder(k)) folderRowsRef.current.set(k, mergePendingSent(k, rows));
      }
      if (_isSentFolder(folderRef.current)) {
        setEmails(prev => mergePendingSent(folderRef.current, prev));
      }
    };
    const unsub = api.subscribeEmailSent((evt) => {
      if (!evt) return;
      if (evt.type === 'cancelled') {
        if (!evt.sendId) return;
        pendingSentRef.current = pendingSentRef.current.filter(p => p._sendId !== evt.sendId);
        const drop = (rows) => rows.filter(e => !(e && e._optimistic && e._sendId === evt.sendId));
        for (const [k, rows] of folderRowsRef.current) {
          if (_isSentFolder(k)) folderRowsRef.current.set(k, drop(rows));
        }
        if (_isSentFolder(folderRef.current)) setEmails(prev => drop(prev));
        return;
      }
      if (evt.type !== 'sent') return;
      const at = evt.at || Date.now();
      const id = 'local-' + (evt.clientSendId || String(at));
      if (pendingSentRef.current.some(p => p.uid === id)) return;
      const html = /<[a-z][\s\S]*>/i.test(String(evt.body || '')) ? String(evt.body) : '';
      const text = html ? _stripHtml(html) : String(evt.body || '');
      const me = api.getActiveAccountEmail?.() || user?.email || '';
      const row = {
        uid: id, _optimistic: true, _optimisticAt: at, _sendId: evt.sendId || null,
        _bodyHtml: html, _bodyText: text,
        from: me, from_email: me, from_name: user?.name || me,
        to: evt.to || '', cc: evt.cc || '', subject: evt.subject || '',
        preview: text.slice(0, 200), date: new Date(at).toISOString(),
        seen: true, read: true, flagged: false, has_attachments: !!evt.hasAttachments, labels: [],
      };
      pendingSentRef.current = [row, ...pendingSentRef.current];
      applyEverywhere();
      // O servidor reindexa Enviados em até ~2 min: reconfere em silêncio se o
      // usuário estiver olhando a pasta.
      sentReloadTimersRef.current.forEach(clearTimeout);
      sentReloadTimersRef.current = [15000, 60000, 135000].map(ms => setTimeout(() => {
        if (_isSentFolder(folderRef.current) && pendingSentRef.current.length) {
          try { loadEmails(folderRef.current, 1, '', '', '', true); } catch {}
        }
      }, ms));
    });
    return () => {
      unsub && unsub();
      sentReloadTimersRef.current.forEach(clearTimeout);
    };
  }, [user?.email, user?.name, mergePendingSent, loadEmails]);

  // Manual refresh (pull-to-refresh) — always use silent merge to preserve seen state
  // Manual pull-to-refresh always resets to page 1 so the user sees the
  // newest emails first. Bug 2026-05-12: refresh was reusing `page` from
  // state, so if the user had scrolled and loaded page 3, pulling to refresh
  // re-fetched page 3 (older emails) instead of the newest. Page 1 = newest
  // in IMAP fetch order; setPage(1) keeps loadMore pagination consistent.
  const refresh = useCallback(() => {
    setPage(1);
    loadEmails(currentFolder, 1, search, '', '', true);
  }, [currentFolder, search, loadEmails]);

  // Silent refresh — background poll, no spinner, no scroll jump. Also
  // fetches page 1 so new arrivals land at the top of the list without
  // disturbing scroll position.
  const silentRefresh = useCallback(() => {
    loadEmails(currentFolder, 1, search, '', '', true);
  }, [currentFolder, search, loadEmails]);
  silentRefreshRef.current = silentRefresh;
  loadFoldersRef.current = loadFolders;

  const doSearch = useCallback((q) => {
    setSearch(q);
    setPage(1);
    // [2026-10-18 email-local-search] 1º o que já está no aparelho (na hora),
    // depois o servidor mescla por cima. Kill: __chatyy_mail_local_search=false.
    const qq = String(q || '').trim();
    if (qq && isLocalSearchOn()) {
      const f = currentFolder;
      let hits = null;
      try {
        const base = [];
        const mem = folderRowsRef.current.get(f);
        if (Array.isArray(mem)) base.push(...mem);
        if (!search && Array.isArray(emailsRef.current)) base.push(...emailsRef.current);
        let disk = null;
        try { disk = getEmailsFromCacheSync(f); } catch {}
        if (Array.isArray(disk)) base.push(...disk);
        hits = matchLocalRows(base, qq);
      } catch { hits = null; }
      if (hits) {
        localSearchRef.current = { q, folder: f, rows: hits };
        searchServerDoneRef.current = false;
        if (hits.length) setEmails(hits);
        const stale = () => localSearchRef.current.q !== q || localSearchRef.current.folder !== f;
        searchCachedBodies(f, qq, new Set(hits.map(e => String(e.uid))), stale).then((more) => {
          if (stale() || !more || !more.length) return;
          const hadRows = localSearchRef.current.rows.length > 0;
          localSearchRef.current = { q, folder: f, rows: mergeSearchResults(localSearchRef.current.rows, more) };
          // Sem achado nas linhas a tela ainda mostra a pasta → troca; com
          // achados (ou servidor já chegou) → só acrescenta.
          if (!hadRows && !searchServerDoneRef.current) setEmails(localSearchRef.current.rows);
          else setEmails(prev => mergeSearchResults(prev, more));
        }).catch(() => {});
        loadEmails(f, 1, q, '', '', hits.length ? 'local' : false);
        return;
      }
    }
    localSearchRef.current = { q: '', folder: '', rows: [] };
    loadEmails(currentFolder, 1, q);
  }, [currentFolder, loadEmails, search]);

  const deleteEmail = useCallback(async (uid, folder) => {
    // folder is OPTIONAL and defaults to currentFolder. The reader (read.js)
    // passes the email's REAL folder so a delete triggered from a message
    // opened in a folder other than the one the list is showing (e.g. a
    // cross-folder search result) hits the correct mailbox — not currentFolder.
    const f = folder || currentFolder;
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const removed = emailsRef.current.find(e => String(e.uid) === String(uid));
    setEmails(prev => prev.filter(e => String(e.uid) !== String(uid)));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    const dUnread = removed && !removed.seen ? 1 : 0;
    bumpFolderUnread(f, -dUnread);
    if (!isOnline()) {
      offlineQueueRef.current = true;
      queueOfflineAction({ type: 'delete', uid, folder: f });
    } else {
      // Gmail-style: show a 5s Undo toast and DEFER the real API call so the
      // user can take it back. Same infra as bulkDelete. On failure, restore.
      showUndo('deleted', [uid], removed ? [removed] : []);
      markPendingRemoval(f, [uid]);
      scheduleAction(async () => {
        try {
          const r = await api.deleteEmail(uid, f);
          settlePendingRemoval(f, [uid], !r?.success);
          if (!r?.success) {
            if (removed) { setEmails(prev => mergeRestored(prev, [removed])); bumpFolderUnread(f, dUnread); }
            console.warn('deleteEmail failed:', r?.message);
          }
        } catch (e) {
          settlePendingRemoval(f, [uid], true);
          if (removed) { setEmails(prev => mergeRestored(prev, [removed])); bumpFolderUnread(f, dUnread); }
          console.warn('deleteEmail error:', e);
        }
      });
    }
  }, [currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  const moveEmail = useCallback(async (uid, toFolder, fromFolder) => {
    const from = fromFolder || currentFolder;
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const removed = emailsRef.current.find(e => String(e.uid) === String(uid));
    setEmails(prev => prev.filter(e => String(e.uid) !== String(uid)));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    const dUnread = removed && !removed.seen ? 1 : 0;
    bumpFolderUnread(from, -dUnread);
    bumpFolderUnread(toFolder, dUnread);
    if (!isOnline()) {
      offlineQueueRef.current = true;
      queueOfflineAction({ type: 'move', uid, toFolder, fromFolder: from });
    } else {
      const restore = () => {
        if (removed) setEmails(prev => mergeRestored(prev, [removed]));
        bumpFolderUnread(from, dUnread);
        bumpFolderUnread(toFolder, -dUnread);
      };
      try {
        const r = await api.moveEmail(uid, toFolder, from);
        if (!r?.success) {
          restore();
          console.warn('moveEmail failed:', r?.message);
        }
      } catch (e) {
        restore();
        console.warn('moveEmail error:', e);
      }
    }
  }, [currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  // --- Selection / Bulk ---

  const toggleSelect = useCallback((uid) => {
    setSelectedUids(prev => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      if (next.size === 0) setSelectMode(false);
      else setSelectMode(true);
      return next;
    });
  }, []);

  // Accepts an optional list so callers can scope "select all" to what is
  // actually rendered (filtered tab). Without it, select-all in a filtered
  // view silently selected — and bulk-deleted — emails outside the filter
  // that never appeared on screen. [deep-20260805-032549]
  const selectAll = useCallback((list) => {
    const src = Array.isArray(list) ? list : emails;
    const all = new Set(src.map(e => e.uid));
    setSelectedUids(all);
    setSelectMode(true);
  }, [emails]);

  const clearSelection = useCallback(() => {
    setSelectedUids(new Set());
    setSelectMode(false);
  }, []);

  const bulkDelete = useCallback(async () => {
    const uids = Array.from(selectedUids);
    const removed = emailsRef.current.filter(e => selectedUids.has(e.uid));
    animateListChange();
    setEmails(prev => prev.filter(e => !selectedUids.has(e.uid)));
    clearSelection();
    if (selectedEmail && selectedUids.has(selectedEmail.uid)) setSelectedEmail(null);
    const dUnread = unreadIn(removed);
    bumpFolderUnread(currentFolder, -dUnread);
    showUndo('deleted', uids, removed);
    markPendingRemoval(currentFolder, uids);
    const folder = currentFolder;
    scheduleAction(async () => {
      try {
        const r = await api.bulkDelete(uids, folder);
        settlePendingRemoval(folder, uids, !r?.success);
        if (!r?.success) {
          if (removed.length) { setEmails(prev => mergeRestored(prev, removed)); bumpFolderUnread(folder, dUnread); }
          console.warn('bulkDelete failed:', r?.message);
        }
      } catch (e) {
        settlePendingRemoval(folder, uids, true);
        if (removed.length) { setEmails(prev => mergeRestored(prev, removed)); bumpFolderUnread(folder, dUnread); }
        console.warn('bulkDelete error:', e);
      }
    });
  }, [selectedUids, currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  const bulkArchive = useCallback(async () => {
    const uids = Array.from(selectedUids);
    const removed = emailsRef.current.filter(e => selectedUids.has(e.uid));
    animateListChange();
    setEmails(prev => prev.filter(e => !selectedUids.has(e.uid)));
    clearSelection();
    if (selectedEmail && selectedUids.has(selectedEmail.uid)) setSelectedEmail(null);
    const dUnread = unreadIn(removed);
    bumpFolderUnread(currentFolder, -dUnread);
    showUndo('archived', uids, removed);
    markPendingRemoval(currentFolder, uids);
    const folder = currentFolder;
    scheduleAction(async () => {
      try {
        const r = await api.bulkArchive(uids, folder);
        settlePendingRemoval(folder, uids, !r?.success);
        if (!r?.success) {
          if (removed.length) { setEmails(prev => mergeRestored(prev, removed)); bumpFolderUnread(folder, dUnread); }
          console.warn('bulkArchive failed:', r?.message);
        }
      } catch (e) {
        settlePendingRemoval(folder, uids, true);
        if (removed.length) { setEmails(prev => mergeRestored(prev, removed)); bumpFolderUnread(folder, dUnread); }
        console.warn('bulkArchive error:', e);
      }
    });
  }, [selectedUids, currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  const bulkMarkRead = useCallback(async () => {
    const uids = Array.from(selectedUids);
    const dUnread = unreadIn(emailsRef.current.filter(e => selectedUids.has(e.uid)));
    // Protege contra o merge "voltar a não lido" com dado velho do servidor.
    uids.forEach(u => recentlyReadRef.current.add(String(u)));
    setEmails(prev => prev.map(e => selectedUids.has(e.uid) ? { ...e, seen: true } : e));
    bumpFolderUnread(currentFolder, -dUnread);
    clearSelection();
    try {
      const r = await api.bulkMarkRead(uids, currentFolder);
      if (r?.success && currentFolder === 'INBOX') { try { DeviceEventEmitter.emit('mail:unread-changed', { folder: 'INBOX', synced: true }); } catch {} }
    } catch (e) { console.warn('bulkMarkRead error:', e); }
  }, [selectedUids, currentFolder, bumpFolderUnread]);

  const bulkMarkUnread = useCallback(async () => {
    const uids = Array.from(selectedUids);
    // Without this the recentlyRead protection reverted every uid back to
    // seen=true on the next silent merge (for up to 24h, persisted).
    forgetRecentlyRead(uids).catch(() => {});
    const dRead = emailsRef.current.filter(e => selectedUids.has(e.uid) && e.seen).length;
    setEmails(prev => prev.map(e => selectedUids.has(e.uid) ? { ...e, seen: false } : e));
    bumpFolderUnread(currentFolder, dRead);
    clearSelection();
    try { await api.bulkMarkUnread(uids, currentFolder); } catch (e) { console.warn('bulkMarkUnread error:', e); }
  }, [selectedUids, currentFolder, forgetRecentlyRead, bumpFolderUnread]);

  // --- Labels ---

  const addLabelToEmail = useCallback(async (uid, label) => {
    setEmails(prev => prev.map(e =>
      e.uid === uid ? { ...e, labels: [...(e.labels || []).filter(l => l !== label), label] } : e
    ));
    if (selectedEmail?.uid === uid) {
      setSelectedEmail(prev => prev ? { ...prev, labels: [...(prev.labels || []).filter(l => l !== label), label] } : prev);
    }
    await api.addLabel(uid, label, currentFolder);
  }, [currentFolder, selectedEmail]);

  const removeLabelFromEmail = useCallback(async (uid, label) => {
    setEmails(prev => prev.map(e =>
      e.uid === uid ? { ...e, labels: (e.labels || []).filter(l => l !== label) } : e
    ));
    if (selectedEmail?.uid === uid) {
      setSelectedEmail(prev => prev ? { ...prev, labels: (prev.labels || []).filter(l => l !== label) } : prev);
    }
    await api.removeLabel(uid, label, currentFolder);
  }, [currentFolder, selectedEmail]);

  // --- Star / Archive (optimistic) ---

  const starEmail = useCallback(async (uid) => {
    const email = emails.find(e => e.uid === uid);
    if (!email) return;
    const wasStarred = email.flagged;
    // Optimistic toggle
    recentlyFlaggedRef.current.set(String(uid), { flagged: !wasStarred, ts: Date.now() });
    setEmails(prev => prev.map(e => e.uid === uid ? { ...e, flagged: !wasStarred } : e));
    if (selectedEmail?.uid === uid) {
      setSelectedEmail(prev => prev ? { ...prev, flagged: !wasStarred } : prev);
    }
    try {
      const r = wasStarred
        ? await api.unstarEmail(uid, currentFolder)
        : await api.starEmail(uid, currentFolder);
      if (!r?.success) {
        // Revert
        recentlyFlaggedRef.current.delete(String(uid));
        setEmails(prev => prev.map(e => e.uid === uid ? { ...e, flagged: wasStarred } : e));
        if (selectedEmail?.uid === uid) {
          setSelectedEmail(prev => prev ? { ...prev, flagged: wasStarred } : prev);
        }
      }
    } catch {
      recentlyFlaggedRef.current.delete(String(uid));
      setEmails(prev => prev.map(e => e.uid === uid ? { ...e, flagged: wasStarred } : e));
      if (selectedEmail?.uid === uid) {
        setSelectedEmail(prev => prev ? { ...prev, flagged: wasStarred } : prev);
      }
    }
  }, [currentFolder, selectedEmail, emails]);

  const archiveEmail = useCallback(async (uid, folder) => {
    // folder OPTIONAL, defaults to currentFolder — same reasoning as deleteEmail:
    // the reader passes the message's real folder so archive never hits the
    // wrong mailbox when the reader's folder ≠ the list's currentFolder.
    const f = folder || currentFolder;
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const removed = emailsRef.current.find(e => String(e.uid) === String(uid));
    setEmails(prev => prev.filter(e => String(e.uid) !== String(uid)));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    const dUnread = removed && !removed.seen ? 1 : 0;
    bumpFolderUnread(f, -dUnread);
    // Gmail-style undo: toast + defer the real archive 5s so it can be taken back.
    showUndo('archived', [uid], removed ? [removed] : []);
    markPendingRemoval(f, [uid]);
    scheduleAction(async () => {
      try {
        const r = await api.archiveEmail(uid, f);
        settlePendingRemoval(f, [uid], !r?.success);
        if (!r?.success && removed) {
          setEmails(prev => mergeRestored(prev, [removed]));
          bumpFolderUnread(f, dUnread);
        }
      } catch {
        settlePendingRemoval(f, [uid], true);
        if (removed) { setEmails(prev => mergeRestored(prev, [removed])); bumpFolderUnread(f, dUnread); }
      }
    });
  }, [currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  // --- Snooze ---

  const snoozeEmail = useCallback(async (uid, snoozeUntil, folder) => {
    const f = folder || currentFolder; // reader passes real folder (see deleteEmail)
    animateListChange();
    const removed = emailsRef.current.find(e => String(e.uid) === String(uid));
    setEmails(prev => prev.filter(e => String(e.uid) !== String(uid)));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    const dUnread = removed && !removed.seen ? 1 : 0;
    bumpFolderUnread(f, -dUnread);
    const restore = () => { if (removed) { setEmails(prev => mergeRestored(prev, [removed])); bumpFolderUnread(f, dUnread); } };
    try {
      const r = await api.snoozeEmail(uid, snoozeUntil, f);
      if (!r?.success) restore();
    } catch { restore(); }
  }, [currentFolder, selectedEmail, bumpFolderUnread, mergeRestored]);

  // --- Undo system ---

  const showUndo = useCallback((type, uids, removedEmails) => {
    setUndoAction({ type, uids, removedEmails, folder: folderRef.current });
  }, []);

  // Run the still-pending deferred action NOW (no-op when it already ran or
  // was undone). Fire-and-forget: the fn carries its own failure/restore
  // handling (see deleteEmail/archiveEmail).
  const flushPendingAction = useCallback(() => {
    const prev = pendingActionRef.current;
    pendingActionRef.current = null;
    if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
    if (prev) {
      try {
        const p = prev();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    }
  }, []);

  const scheduleAction = useCallback((fn) => {
    clearTimeout(undoTimerRef.current);
    // A previous action still inside its undo window is COMMITTED (the user
    // didn't undo it), not cancelled — flush it before scheduling the new one.
    flushPendingAction();
    pendingActionRef.current = fn;
    const startTime = Date.now();
    let remaining = 5000;

    const runAction = async () => {
      if (pendingActionRef.current === fn) pendingActionRef.current = null;
      if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
      try { await fn(); } catch {}
      setUndoAction(null);
      // Ação confirmada no servidor → ressincroniza os contadores das pastas
      // (o ajuste otimista já mostrou o número certo; isto só confirma).
      try { loadFolders(); } catch {}
    };

    const startTimer = () => {
      undoTimerRef.current = setTimeout(runAction, remaining);
    };

    startTimer();

    // Pause timer when tab hidden, resume when visible (web only)
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVis = () => {
        if (document.hidden) {
          clearTimeout(undoTimerRef.current);
          remaining = Math.max(0, remaining - (Date.now() - startTime));
        } else {
          startTimer();
        }
      };
      document.addEventListener('visibilitychange', onVis);
      // Cleanup after action completes or is cancelled
      const origTimer = undoTimerRef.current;
      const cleanup = () => document.removeEventListener('visibilitychange', onVis);
      // Store cleanup so executeUndo/dismissUndo can call it
      undoTimerRef._visCleanup = cleanup;
    }
  }, [flushPendingAction, loadFolders]);

  const executeUndo = useCallback(() => {
    clearTimeout(undoTimerRef.current);
    // Undo = the deferred action must never run.
    pendingActionRef.current = null;
    if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
    if (undoAction?.uids) {
      // Un-mark pending removals so the restored rows survive the next merge
      // (match by uid across all folder keys — un-hiding is safe cross-folder).
      const undone = new Set(undoAction.uids.map(String));
      for (const k of pendingRemovalRef.current.keys()) {
        if (undone.has(k.slice(k.indexOf(':') + 1))) pendingRemovalRef.current.delete(k);
      }
    }
    if (undoAction?.removedEmails) {
      // Restore rows into the folder they were removed from — the visible
      // list may be a different folder by now (the toast survives folder
      // switches). The server was never touched, so a wrong-list prepend
      // would plant ghost rows that the union-merge keeps alive.
      // [2026-10-11 email-qa] mergeRestored = volta na posição certa (não no
      // topo acima de "Hoje") + devolve o não-lido ao contador da pasta.
      if (!undoAction.folder || undoAction.folder === folderRef.current) {
        setEmails(prev => mergeRestored(prev, undoAction.removedEmails));
      } else {
        const rows = folderRowsRef.current.get(undoAction.folder);
        if (rows) folderRowsRef.current.set(undoAction.folder, mergeRestored(rows, undoAction.removedEmails));
      }
      bumpFolderUnread(undoAction.folder || folderRef.current, unreadIn(undoAction.removedEmails));
    }
    setUndoAction(null);
  }, [undoAction, mergeRestored, bumpFolderUnread]);

  const dismissUndo = useCallback(() => {
    clearTimeout(undoTimerRef.current);
    // Dismiss (X button or the toast's own 5s auto-dismiss) accepts the
    // action — commit it now. Before, this clearTimeout CANCELLED the API
    // call while the rows stayed optimistically hidden (and the auto-dismiss
    // even raced the action's own timer), so the email quietly came back.
    flushPendingAction();
    setUndoAction(null);
  }, [flushPendingAction]);

  // --- WebSocket real-time ---

  useEffect(() => {
    // Null-check + dep em user.email — antes o efeito não re-rodava após
    // login (handlers nunca registravam) e crashava se o require do mailWs
    // tivesse falhado.
    if (!mailWs) return;
    // Sem gate de token aqui: registrar handler não exige auth (o socket só
    // emite eventos depois de conectado/autenticado) e o gate lia authRef
    // ANTES do effect de conexão (abaixo) escrever — no login/cold-start os
    // handlers nunca registravam até o usuário trocar de pasta/buscar.

    // Handle new email arrival
    const offNew = mailWs.on('new_email', (raw) => {
      // [2026-10-11 email-qa] O hub manda DOIS formatos e nenhum era o que este
      // handler esperava: Rust IDLE = { email: "<endereço do DONO>", folder, ts }
      // (string!) e PHP sieve = { from, subject, summary }. A string virava uma
      // "linha fantasma" (sem remetente, "(sem assunto)", não lida → contador +1)
      // e o toast "Novo email / (sem assunto)". Só tratamos como linha quando
      // vem um objeto de e-mail de verdade (com uid); senão = aviso → refresh.
      const _em = raw && raw.email && typeof raw.email === 'object' && raw.email.uid != null ? raw.email : null;
      const _hint = !_em && raw && (raw.subject || raw.from)
        ? { from: raw.from || '', from_name: raw.from_name || '', subject: raw.subject || '', preview: raw.summary || raw.preview || '' }
        : null;
      const data = { ...(raw || {}), email: _em };
      const _notif = _em || _hint;
      // Sound + haptic are handled by NotificationToast when it appears
      // Mobile local notification (triggers NotificationToast via foreground handler)
      if (_notif) showLocalEmailNotification(_notif, _tRef.current);

      // Web: trigger in-app toast (toast handles sound + vibration)
      if (Platform.OS === 'web' && _notif) {
        try {
          const { _triggerForegroundToast } = require('../services/pushNotifications');
          const e = _notif;
          _triggerForegroundToast({
            title: e.from_name || e.from || _tRef.current('toast.newEmail'),
            body: e.subject || _tRef.current('reader.noSubject'),
            data: {
              type: 'new_email',
              uid: e.uid,
              from: e.from_name || e.from,
              subtitle: e.preview,
              folder: data.folder || 'INBOX',
            },
          });
        } catch {}
      }

      if (folderRef.current === 'INBOX' || folderRef.current === data?.folder) {
        if (data?.email && inboxListVisibleRef.current) animateListChange(); // [2026-10-16 pisca]
        // Prepend new email to list
        if (data?.email) {
          // Decide síncrono (o flag dentro do updater chegava tarde).
          const prepended = !emailsRef.current.some(e => String(e.uid) === String(data.email.uid));
          setEmails(prev => {
            // Avoid duplicates
            if (prev.some(e => String(e.uid) === String(data.email.uid))) return prev;
            return [data.email, ...prev];
          });
          // Só incrementa total se realmente prependou — antes incrementava
          // mesmo em duplicata, dessincronizando o contador.
          if (prepended) {
            setTotal(prev => prev + 1);
            // Protect this arrival from being dropped by a silent refresh that
            // races IMAP indexing (see UNION merge in loadEmails).
            recentlyArrivedRef.current.set(String(data.email.uid), Date.now());
          }
        } else {
          // No email data provided, silent refresh. [2026-10-11 email-qa] O
          // aviso do sieve (PHP) sai ANTES da mensagem estar gravada na caixa,
          // então o refresh imediato voltava sem ela e o e-mail só aparecia no
          // próximo poll (~20 s medidos). Repete em 1,5 s e 4 s (Rust ~150 ms).
          silentRefresh();
          clearTimeout(arrivalRetryRef.current.a); clearTimeout(arrivalRetryRef.current.b);
          arrivalRetryRef.current.a = setTimeout(() => { try { silentRefreshRef.current?.(); loadFoldersRef.current?.(); } catch {} }, 1500);
          arrivalRetryRef.current.b = setTimeout(() => { try { silentRefreshRef.current?.(); loadFoldersRef.current?.(); } catch {} }, 4000);
          // [2026-10-15 email-melhorias] 3ª tentativa: o índice PG do e-mail
          // novo leva 0,6–2,5 s medidos (às vezes mais sob carga).
          clearTimeout(arrivalRetryRef.current.c);
          arrivalRetryRef.current.c = setTimeout(() => { try { silentRefreshRef.current?.(); } catch {} }, 9000);
        }
      }
      // Desktop browser notification with preview
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        const e = _notif;
        if (e) {
          try {
            const subject = e.subject || _tRef.current('reader.noSubject');
            const preview = e.preview ? `\n${e.preview.slice(0, 120)}` : '';
            const n = new Notification(e.from_name || e.from || _tRef.current('toast.newEmail'), {
              body: subject + preview,
              icon: '/icon-192.png',
              tag: `email-${e.uid ?? e.subject ?? ''}`,
              silent: false,
            });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 10000);
          } catch {}
        }
      }
      // Refresh folder counts
      loadFolders();
    });

    // Handle email deleted elsewhere
    const offDel = mailWs.on('email_deleted', (data) => {
      if (data?.uid) {
        if (inboxListVisibleRef.current) animateListChange(); // [2026-10-16 pisca]
        const gone = emailsRef.current.find(e => String(e.uid) === String(data.uid));
        setEmails(prev => prev.filter(e => String(e.uid) !== String(data.uid)));
        if (gone) {
          setTotal(prev => Math.max(0, prev - 1));
          if (!gone.seen) bumpFolderUnread(folderRef.current, -1);
        }
      }
    });

    // Handle email moved
    const offMove = mailWs.on('email_moved', (data) => {
      if (data?.uid && data?.from_folder === folderRef.current) {
        if (inboxListVisibleRef.current) animateListChange(); // [2026-10-16 pisca]
        const gone = emailsRef.current.find(e => String(e.uid) === String(data.uid));
        setEmails(prev => prev.filter(e => String(e.uid) !== String(data.uid)));
        if (gone) {
          setTotal(prev => Math.max(0, prev - 1));
          if (!gone.seen) bumpFolderUnread(folderRef.current, -1);
        }
      } else if (data?.to_folder === folderRef.current) {
        silentRefresh();
      }
    });

    // Handle read status change (but never revert recently-read emails)
    const offRead = mailWs.on('email_read', (data) => {
      if (data?.uid) {
        const isRecentlyRead = recentlyReadRef.current.has(String(data.uid));
        setEmails(prev => prev.map(e =>
          String(e.uid) === String(data.uid) ? { ...e, seen: (isRecentlyRead ? true : data.seen) } : e
        ));
      }
    });

    // Handle folder update
    const offFolder = mailWs.on('folder_updated', () => {
      loadFolders();
    });

    // [2026-10-15 email-melhorias] Push de e-mail com o app ABERTO (só virava
    // toast) e silent push de sync (`silent_sync` type email — ninguém ouvia)
    // agora atualizam a caixa na hora, mesmo com o WS caído (rede trocando).
    const offSync = mailWs.on('silent_sync', (d) => {
      if (d && d.type !== 'email') return;
      clearTimeout(arrivalRetryRef.current.s);
      arrivalRetryRef.current.s = setTimeout(() => {
        try { silentRefreshRef.current?.(); loadFoldersRef.current?.(); } catch {}
      }, 300);
    });

    // Connection status
    const offConn = mailWs.on('connection', (data) => {
      setWsStatus(data.status);
    });

    return () => {
      clearTimeout(arrivalRetryRef.current.a); clearTimeout(arrivalRetryRef.current.b);
      clearTimeout(arrivalRetryRef.current.c); clearTimeout(arrivalRetryRef.current.s);
      try { offSync(); } catch {}
      offNew();
      offDel();
      offMove();
      offRead();
      offFolder();
      offConn();
    };
  }, [refresh, silentRefresh, loadFolders, user?.email, bumpFolderUnread]);

  // Connect WebSocket when auth token available. The cleanup used to fire
  // `mailWs.disconnect()` on every MailProvider unmount — but the WS is a
  // singleton and should only be torn down on actual logout, not on every
  // re-render/Strict Mode double-run. The old cleanup was destroying the
  // socket mid-session, causing the reconnect spiral we saw in the WS log
  // (Connected → Close 1000 → Connected → Close 1000, 20+ cycles a minute).
  //
  // Reconnect-storm fix 2026-05-19: the previous guard `!mailWs.connected ||
  // mailWs.email !== user.email` was racy — between the WS firing `auth` and
  // the server replying with `authenticated` (which sets mailWs.email), this
  // effect could re-trigger on a re-render (token sliding-refresh changes
  // authRef but user.email is the same identity), see `!mailWs.email`, and
  // call reset()+connect() again, killing the in-flight handshake. We now
  // track the *intended* connected email in a ref so re-renders don't see
  // the transient null state during the handshake window.
  useEffect(() => {
    if (!mailWs) return;
    const token = api.getAuthToken?.();
    if (token && user?.email) {
      authRef.current = token;
      if (lastConnectedEmailRef.current !== user.email) {
        const prevEmail = lastConnectedEmailRef.current;
        lastConnectedEmailRef.current = user.email;
        // [2026-10-06 ws rock-solid] Dono único: nada de reset()+connect() às
        // cegas. No cold start o socket do eager bootstrap já está em voo/
        // autenticado com o token desta conta → ensureConnected é no-op (antes:
        // um slide do bearer durante a hidratação fazia o connect() derrubar o
        // socket 100-900ms depois do auth em TODO reload). Só TROCA DE CONTA
        // (outro e-mail logado nesta sessão, ou socket autenticado como outra
        // conta) zera estado e força socket novo.
        const wsEmail = String(mailWs.email || '').toLowerCase();
        const accountSwitch = (!!prevEmail && prevEmail !== user.email) ||
          (!!wsEmail && wsEmail !== String(user.email).toLowerCase());
        if (accountSwitch) {
          mailWs.reset();
          mailWs.ensureConnected?.('account_switch', { force: true });
        } else if (typeof mailWs.ensureConnected === 'function') {
          mailWs.ensureConnected('mailcontext_login', { urgent: true });
        } else {
          mailWs.connect(token);
        }
        // ─── Phoenix parallel transport (flag-gated, ADDITIVE) ───
        // Started IN PARALLEL with the Go WS (which stays connected for email
        // real-time). When USE_PHOENIX_HUB is OFF (default / shipped), this is
        // a no-op and nothing about the legacy path changes.
        try {
          const flags = require('../services/flags');
          // [2026-10-02 Stage 3 cohort] Resolve per-account: the global flag OR
          // the staged test-cohort allowlist. For a cohort account we flip the
          // runtime global ON here so EVERY other isPhoenixHubEnabled() read this
          // session (outbound relay in websocket.js, conversation join in
          // chat-conversation.js) is consistent; for a non-cohort account we flip
          // it OFF so a previous cohort session can't leak into this one.
          const usePhx = flags.isPhoenixForEmail(user.email);
          flags.setPhoenixHubEnabled(usePhx);
          if (usePhx) {
            require('../services/phoenixAdapter').startPhoenix(token, user.email);
          } else {
            // Switching INTO a non-cohort account: tear down any Phoenix socket
            // a previous cohort account left running this session.
            try { require('../services/phoenixAdapter').stopPhoenix(); } catch {}
          }
        } catch {}
      }
    } else if (!user?.email) {
      // [2026-10-08 chat-gaps2] Só derruba o socket numa TRANSIÇÃO real
      // logado→deslogado (ref setada por um user anterior). No cold start o
      // user ainda está hidratando (null) enquanto o eager bootstrap já
      // conectou+autenticou com o bearer salvo — o disconnect() aqui matava
      // esse socket ~0,5-1 s depois do auth e o mailcontext_login reabria
      // outro (abrir conversa por link/reload = fecha+reabre ~1 s, chat_870
      // assinado 2×). Logout real (doLogout) passa por aqui com a ref setada.
      const hadUser = lastConnectedEmailRef.current != null;
      lastConnectedEmailRef.current = null;
      if (hadUser || !api.getAuthToken?.()) {
        mailWs.disconnect();
        try { require('../services/phoenixAdapter').stopPhoenix(); } catch {}
      }
    }
    // No cleanup — the socket should outlive provider re-renders.
  }, [user?.email]);

  // [WAVE 43G 2026-05-21 / WAVE 66 2026-05-21] Zombie WS watchdog.
  // Auto-reconnect handles the common case (close → backoff → connect), but
  // does NOT cover:
  //   - destroyed=true tombstone from 8 auth_error strikes (outside grace
  //     window the chatyy:authFailure handler refuses logout but the WS
  //     never wakes up again)
  //   - readyState===OPEN zombie sockets that the ping watchdog missed
  //     because the timer was cleared by a botched AppState cycle
  // We poll every 10s (WAVE 66 — was 30s, too slow per user feedback
  // "ainda acontece") and call ws.resurrect() if isZombie() returns true.
  // resurrect() is a no-op when the socket is healthy so the overhead is
  // a single property read every 10s while logged in. Bug report:
  // "me desloga do nada parece qe eu to logado mas as mensagens para de
  //  chegar... tenho que deslogar e logar denovo".
  useEffect(() => {
    if (!user?.email || !mailWs) return;
    const iv = setInterval(() => {
      try {
        // [perf 2026-10-06] Skip while backgrounded — the socket is parked
        // there on purpose; resurrecting it would just churn reconnects.
        try { const { AppState } = require('react-native'); if (AppState.currentState && AppState.currentState !== 'active') return; } catch {}
        if (typeof mailWs.isZombie === 'function' && mailWs.isZombie()) {
          mailWs.resurrect?.('mailcontext_watchdog_10s');
        }
      } catch {}
    }, 10000);
    return () => clearInterval(iv);
  }, [user?.email]);

  // Adaptive polling: silent background refresh — no spinner, no scroll jump
  // Real-time new-email push — Rust email-api runs IMAP IDLE per user and
  // emits `new_email` to the `mail_{email}` channel on the WS hub. When we
  // receive it, trigger a silent refresh and re-load folder counts.
  useEffect(() => {
    if (!user?.email) return;
    let unsub = null;
    (async () => {
      try {
        const ws = (await import('../services/websocket')).default;
        ws.subscribe(`mail_${user.email}`);
        // [2026-10-15 email-melhorias] Só a inscrição no canal. O refresh do
        // `new_email` já é feito pelo handler principal (acima, com retries
        // 1,5/4/9 s) — este segundo listener duplicava silentRefresh+loadFolders
        // a cada e-mail (2 eventos por e-mail → 4 refreshes de lista).
        unsub = () => {};
      } catch {}
    })();
    return () => {
      try {
        if (unsub) unsub();
        import('../services/websocket').then(m => m.default.unsubscribe(`mail_${user.email}`)).catch(() => {});
      } catch {}
    };
  }, [user?.email, silentRefresh, loadFolders]);

  // Adaptive email poll — GATED by email activity (see emailPollingEnabled).
  // Pauses when the tab/app is hidden to save resources. When the user is
  // parked on a non-email screen (e.g. /chat) and hasn't opened email this
  // session, this whole effect stays torn down: no silentRefresh, no loadFolders
  // poll, no AppState/visibility listeners — the chat-only session stops paying.
  const folderRefreshRef = useRef(null);
  const fgRefreshAtRef = useRef(0);
  useEffect(() => {
    if (!user?.email || !emailPollingEnabled) {
      // Paused: clear the "was enabled" latch so re-entering email does an
      // immediate catch-up refresh below instead of waiting for the first tick.
      emailPollingWasEnabledRef.current = false;
      return;
    }

    // Entered (or re-entered) an email screen → refresh right now so the list
    // and folder counts never look stale while waiting for the first interval.
    if (!emailPollingWasEnabledRef.current) {
      emailPollingWasEnabledRef.current = true;
      try { silentRefresh(); } catch {}
      try { loadFolders(); } catch {}
    }

    const interval = wsStatus === 'authenticated' ? POLL_CONNECTED : POLL_DISCONNECTED;
    const start = () => {
      clearInterval(refreshRef.current);
      clearInterval(folderRefreshRef.current);
      refreshRef.current = setInterval(silentRefresh, interval);
      // Refresh folder counts less frequently (5 min when WS connected, 30s otherwise)
      const folderInterval = wsStatus === 'authenticated' ? POLL_CONNECTED : 30000;
      folderRefreshRef.current = setInterval(loadFolders, folderInterval);
    };
    const stop = () => {
      clearInterval(refreshRef.current);
      clearInterval(folderRefreshRef.current);
    };

    start();

    // [2026-10-18 battery] throttle do refresh de retorno ao primeiro plano.
    const fgRefresh = () => {
      const now = Date.now();
      if (now - (fgRefreshAtRef.current || 0) < FG_REFRESH_MIN_MS) return;
      fgRefreshAtRef.current = now;
      try { silentRefresh(); } catch {}
      try { loadFolders(); } catch {}
    };

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVis = () => {
        if (document.hidden) { stop(); } else { fgRefresh(); start(); }
      };
      document.addEventListener('visibilitychange', onVis);
      return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
    }

    // Native: when app returns to foreground (push tap, switch back from
    // another app), immediately silent-refresh the inbox. Without this, a
    // push for a new email fires while WS is disconnected (background),
    // the broadcast lands with delivered=0, and the email only shows up
    // on the next poll interval. AppState listener closes that gap.
    if (Platform.OS !== 'web') {
      // [2026-10-10 perf-battery] Pause the poll while backgrounded (it used
      // to keep firing — at the 10 s POLL_DISCONNECTED rate, since the WS is
      // parked in background — until the OS froze JS). Resume on 'active'.
      if (AppState.currentState === 'background') stop();
      const sub = AppState.addEventListener('change', (next) => {
        if (next === 'active') {
          fgRefresh();
          start();
        } else if (next === 'background') {
          stop();
        }
      });
      return () => { stop(); try { sub.remove(); } catch {} };
    }

    return stop;
  // [2026-10-15 email-melhorias] `emails.length` saiu das deps: cada e-mail
  // novo/apagado recriava o intervalo e empurrava o próximo poll para frente.
  }, [silentRefresh, loadFolders, currentFolder, wsStatus, user?.email, emailPollingEnabled]);

  // Memoize the context value so consumers don't re-render on every internal
  // state change that doesn't affect the slice they read. Previously this was
  // a fresh object literal on every MailProvider render — so each poll tick,
  // each WS event, each `wsStatus`/`undoAction`/`emails` mutation handed every
  // consumer a brand-new context object and forced the entire subtree to
  // re-render. All callbacks below are `useCallback`-stable and the setters
  // (setPage/setSelectedEmail) are React-stable, so they're sound deps.
  const contextValue = useMemo(() => ({
    emails, folders, currentFolder, selectedEmail, loadingList, loadingMessage,
    page, total, search, wsStatus,
    loadFolders, loadEmails, openEmail, changeFolder, refresh, silentRefresh, doSearch,
    deleteEmail, moveEmail, setPage, setSelectedEmail, markAsRead, markAsUnread,
    starEmail, archiveEmail,
    // Selection
    selectedUids, selectMode, toggleSelect, selectAll, clearSelection,
    // Bulk
    bulkDelete, bulkArchive, bulkMarkRead, bulkMarkUnread,
    // Undo
    undoAction, executeUndo, dismissUndo,
    // Labels
    addLabelToEmail, removeLabelFromEmail, labelCounts,
    // Snooze
    snoozeEmail,
    // Account
    resetMailState,
    // Ready state
    recentlyReadLoaded,
    // [2026-10-21 naolidos] filtro da lista no servidor
    listView, setListScope, bumpFolderUnread,
  }), [
    emails, folders, currentFolder, selectedEmail, loadingList, loadingMessage,
    page, total, search, wsStatus,
    loadFolders, loadEmails, openEmail, changeFolder, refresh, silentRefresh, doSearch,
    deleteEmail, moveEmail, setPage, setSelectedEmail, markAsRead, markAsUnread,
    starEmail, archiveEmail,
    selectedUids, selectMode, toggleSelect, selectAll, clearSelection,
    bulkDelete, bulkArchive, bulkMarkRead, bulkMarkUnread,
    undoAction, executeUndo, dismissUndo,
    addLabelToEmail, removeLabelFromEmail, labelCounts,
    snoozeEmail,
    resetMailState,
    recentlyReadLoaded,
    listView, setListScope, bumpFolderUnread,
  ]);

  return (
    <MailContext.Provider value={contextValue}>
      {children}
    </MailContext.Provider>
  );
}

export function useMail() {
  const ctx = useContext(MailContext);
  if (!ctx) throw new Error('useMail must be inside MailProvider');
  return ctx;
}
