import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Platform, LayoutAnimation, UIManager, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as api from '../services/api';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}
// Delta sync — disabled temporarily to fix crash
// TODO: re-enable when deltaSync is fully tested
// let _deltaSync = null;
// try { _deltaSync = require('../services/deltaSync'); } catch {}
import { playNewEmailAlert as playAlert } from '../services/notificationSound';
import { useAuth } from './AuthContext';
import {
  saveEmailsToCache, getEmailsFromCache,
  saveMessageToCache, getMessageFromCache,
  queueOfflineAction, replayOfflineQueue,
  isOnline, onOnlineStatusChange,
} from '../services/offlineCache';
import { getCached, setCache } from '../services/cache';

// Native cache (iOS only) — synchronous SQLite read for instant inbox first paint.
// Same module that powers chat list / chat messages / media URI cache.
const _NativeCache = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-chat-cache').default; } catch { return null; }
})();
const _nativeReadEmailsSync = (folder, limit = 50) => {
  if (!_NativeCache?.getCachedEmailsSync) return null;
  try {
    const list = _NativeCache.getCachedEmailsSync(folder, limit);
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch { return null; }
};
const _nativeSaveEmails = (folder, emails) => {
  if (!_NativeCache?.saveEmails || !Array.isArray(emails)) return;
  try { _NativeCache.saveEmails(folder, emails); } catch {}
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
async function showLocalEmailNotification(email) {
  if (Platform.OS === 'web' || !email) return;
  try {
    const Notifications = await import('expo-notifications');

    // Build notification body: subject + preview
    let body = email.subject || '(no subject)';
    if (email.preview) {
      body = `${body}\n${email.preview.slice(0, 100)}`;
    }

    // Show notification immediately with basic content
    await Notifications.scheduleNotificationAsync({
      content: {
        title: email.from_name || email.from || 'New email',
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
      trigger: null,
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
          trigger: null,
        });
      }
    }
  } catch {}
}

const MailContext = createContext(null);

// Polling interval: 30s when WS connected (safety net), 10s when WS down
const POLL_CONNECTED = 30000;
const POLL_DISCONNECTED = 10000;

export function MailProvider({ children }) {
  const { user } = useAuth();
  // Use the native SQLite cache as the initial state so the inbox is rendered
  // with real emails on the very first frame (no empty list flash).
  const [emails, setEmails] = useState(() => _nativeReadEmailsSync('INBOX') || []);
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
  // Tracks the folder+query of the last loadEmails call so we can force page 1
  // when either changes (prevents requesting a non-existent page after a
  // folder/search switch). Seeded to the initial folder.
  const loadEmailsCtxRef = useRef({ folder: 'INBOX', query: '' });
  const [recentlyReadLoaded, setRecentlyReadLoaded] = useState(false);

  // Load persisted recently-read UIDs on mount (survives app restart)
  useEffect(() => {
    (async () => {
      try {
        let stored;
        if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          stored = JSON.parse(localStorage.getItem('recentlyRead') || '{}');
        } else {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          stored = JSON.parse(await AsyncStorage.getItem('recentlyRead') || '{}');
        }
        const cutoff = Date.now() - 86400000; // 24 hours
        for (const [uid, ts] of Object.entries(stored)) {
          if (ts >= cutoff) recentlyReadRef.current.add(uid);
        }
      } catch {}
      setRecentlyReadLoaded(true);
    })();
  }, []);

  // Selection state for bulk operations
  const [selectedUids, setSelectedUids] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Undo state
  const [undoAction, setUndoAction] = useState(null);
  const undoTimerRef = useRef(null);

  // Keep folder ref in sync
  useEffect(() => { folderRef.current = currentFolder; }, [currentFolder]);

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
    // NOTE: Do NOT clear recentlyReadRef here — it persists in localStorage
    // and must survive resets to prevent the read→unread revert bug
  }, []);

  const loadFolders = useCallback(async () => {
    // Show cached folders instantly
    const cached = await getCached('email_folders');
    if (cached) setFolders(cached);
    try {
      const r = await api.getFolders();
      if (r.success) {
        const folderList = Array.isArray(r.data) ? r.data : r.data?.folders || [];
        setFolders(folderList);
        setCache('email_folders', folderList, 600000).catch(() => {});
      }
    } catch {}
  }, []);

  const loadEmails = useCallback(async (folder, pg = 1, q = '', category = '', label = '', silent = false) => {
    const f = folder || currentFolder;

    // Pagination reset guard: if the folder or the search query differs from
    // the previous loadEmails call, force page 1. Otherwise switching from a
    // large folder (where the user scrolled to page 5) into a smaller folder —
    // or starting/clearing a search — would request a non-existent page and
    // come back empty. (loadMore is the only legit path that keeps pg > 1, and
    // it always targets the same folder+query, so it's unaffected.)
    if (pg > 1 && (f !== loadEmailsCtxRef.current.folder || q !== loadEmailsCtxRef.current.query)) {
      pg = 1;
      setPage(1);
    }
    loadEmailsCtxRef.current = { folder: f, query: q };

    // Show cached data INSTANTLY on non-silent first-page loads (no spinner if cache exists)
    if (!silent && pg === 1 && !q && !category && !label) {
      const cached = await getEmailsFromCache(f);
      if (cached && cached.length > 0) {
        setEmails(cached);
        setTotal(cached.length);
        // Don't show loading spinner — we have cached data visible
        // Fetch fresh data silently in background
        silent = true;
      } else {
        setLoadingList(true);
      }
    } else if (!silent) {
      setLoadingList(true);
    }

    try {
      const r = await api.getInbox(f, pg, 20, q, category, label);
      if (r.success) {
        const emailList = r.data?.emails || [];

        // Apply recentlyRead protection: force seen=true for UIDs the user just read
        const recentlyRead = recentlyReadRef.current;
        const applyRecentlyRead = (list) =>
          recentlyRead.size === 0 ? list : list.map(e =>
            recentlyRead.has(String(e.uid)) && !e.seen ? { ...e, seen: true } : e
          );

        if (silent) {
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
            // Merge: keep order from server, but preserve local optimistic state
            return emailList.map(e => {
              const existing = prevMap.get(e.uid);
              if (!existing) {
                // New email from server — still apply recentlyRead protection
                return recentlyRead.has(String(e.uid)) ? { ...e, seen: true } : e;
              }
              // NEVER revert seen from true to false - once read, always read
              const mergedSeen = existing.seen ? true : (e.seen || recentlyRead.has(String(e.uid)));
              const mergedFlagged = e.flagged; // server is authoritative for flags
              if (existing.seen === mergedSeen && existing.flagged === mergedFlagged &&
                  existing.subject === e.subject && JSON.stringify(existing.labels) === JSON.stringify(e.labels)) {
                return existing; // Same ref = no re-render for this row
              }
              return { ...e, seen: mergedSeen };
            });
          });
        } else {
          // Non-silent load: replace all, but still protect recently-read emails
          setEmails(applyRecentlyRead(emailList));
        }
        setTotal(r.data?.total || 0);
        // Update label unread counts from server
        if (r.data?.label_counts) setLabelCounts(r.data.label_counts);
        // Cache first page results
        if (pg === 1 && !q && !category && !label) {
          saveEmailsToCache(f, emailList).catch(() => {});
          _nativeSaveEmails(f, emailList);
        }
        // Replay offline queue when back online
        if (offlineQueueRef.current) {
          offlineQueueRef.current = false;
          replayOfflineQueue(api).catch(() => {});
        }
      }
    } catch {
      // Fallback to cached data when offline (only if we didn't already show cache)
      if (pg === 1 && !q) {
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
    setLoadingMessage(true);
    try {
      const r = await api.getMessage(uid, folder || currentFolder);
      if (r.success) {
        // Optimistic: stamp seen=true on the selected message so the reader
        // pane never shows the "unread" pill/styling after open. The IMAP
        // \Seen flag flips server-side via Rust ?mark_seen=true OR via the
        // markAsRead POST below; either way the UI must not lag.
        setSelectedEmail({ ...r.data, seen: true, read: true });
        markAsRead(uid, folder);
        saveMessageToCache(uid, r.data).catch(() => {});
      }
    } catch {
      // Fallback to cached message
      const cached = await getMessageFromCache(uid);
      if (cached) setSelectedEmail({ ...cached, seen: true, read: true });
    } finally {
      setLoadingMessage(false);
    }
  }, [currentFolder]);

  // Mark email as read — updates both server and local state
  const markAsRead = useCallback(async (uid, folder) => {
    const uidStr = String(uid);
    const targetFolder = folder || currentFolder;
    // Optimistic UI update — capture whether the row was actually unread
    // so we only decrement the folder badge once (idempotent re-marks
    // shouldn't drift the counter negative).
    let wasUnread = false;
    setEmails(prev => prev.map(e => {
      if (String(e.uid) !== uidStr) return e;
      if (e.seen) return e; // already read — no change, no decrement
      wasUnread = true;
      return { ...e, seen: true };
    }));
    // Optimistic folder badge decrement — Sidebar reads
    // folders[i].unread/.unseen for the badge. Without this the
    // sidebar count lags until the next folders refresh (often >5s),
    // so users see the email move to "read" styling in the list but
    // the sidebar still shows the old unread count. (WAVE 94 fix.)
    if (wasUnread) {
      setFolders(prev => prev.map(f => {
        if (f.name !== targetFolder) return f;
        const cur = (f.unread ?? f.unseen ?? 0) | 0;
        const next = Math.max(0, cur - 1);
        return { ...f, unread: next, unseen: next };
      }));
    }
    // Track this UID as recently read — prevents revert from stale server data
    recentlyReadRef.current.add(uidStr);
    // Persist so it survives app restarts
    try {
      const now = Date.now();
      const cutoff = now - 86400000;
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        const stored = JSON.parse(localStorage.getItem('recentlyRead') || '{}');
        stored[uidStr] = now;
        for (const k of Object.keys(stored)) { if (stored[k] < cutoff) delete stored[k]; }
        localStorage.setItem('recentlyRead', JSON.stringify(stored));
      } else {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const stored = JSON.parse(await AsyncStorage.getItem('recentlyRead') || '{}');
        stored[uidStr] = now;
        for (const k of Object.keys(stored)) { if (stored[k] < cutoff) delete stored[k]; }
        await AsyncStorage.setItem('recentlyRead', JSON.stringify(stored));
      }
    } catch {}
    // Call the server — await so it completes before app might close
    try {
      const r = await api.markRead(uid, targetFolder);
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
    // No auto-expire timer needed — recentlyRead is cleaned up from
    // persisted storage on load (24h cutoff) and the ref is cleared on unmount.
  }, [currentFolder]);

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
      loadEmails('INBOX', 1, '');
    }
  }, [user?.email]);

  const changeFolder = useCallback((folder) => {
    setCurrentFolder(folder);
    setSelectedEmail(null);
    setPage(1);
    setSearch('');
    clearSelection();
    loadEmails(folder, 1, '');
  }, [loadEmails]);

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

  const doSearch = useCallback((q) => {
    setSearch(q);
    setPage(1);
    loadEmails(currentFolder, 1, q);
  }, [currentFolder, loadEmails]);

  const deleteEmail = useCallback(async (uid) => {
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const removed = emails.find(e => e.uid === uid);
    setEmails(prev => prev.filter(e => e.uid !== uid));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    if (!isOnline()) {
      offlineQueueRef.current = true;
      queueOfflineAction({ type: 'delete', uid, folder: currentFolder });
    } else {
      try {
        const r = await api.deleteEmail(uid, currentFolder);
        if (!r?.success) {
          // Restore email on failure
          if (removed) setEmails(prev => [removed, ...prev]);
          console.warn('deleteEmail failed:', r?.message);
        }
      } catch (e) {
        if (removed) setEmails(prev => [removed, ...prev]);
        console.warn('deleteEmail error:', e);
      }
    }
  }, [currentFolder, selectedEmail, emails]);

  const moveEmail = useCallback(async (uid, toFolder) => {
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const removed = emails.find(e => e.uid === uid);
    setEmails(prev => prev.filter(e => e.uid !== uid));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    if (!isOnline()) {
      offlineQueueRef.current = true;
      queueOfflineAction({ type: 'move', uid, toFolder, fromFolder: currentFolder });
    } else {
      try {
        const r = await api.moveEmail(uid, toFolder, currentFolder);
        if (!r?.success) {
          if (removed) setEmails(prev => [removed, ...prev]);
          console.warn('moveEmail failed:', r?.message);
        }
      } catch (e) {
        if (removed) setEmails(prev => [removed, ...prev]);
        console.warn('moveEmail error:', e);
      }
    }
  }, [currentFolder, selectedEmail, emails]);

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

  const selectAll = useCallback(() => {
    const all = new Set(emails.map(e => e.uid));
    setSelectedUids(all);
    setSelectMode(true);
  }, [emails]);

  const clearSelection = useCallback(() => {
    setSelectedUids(new Set());
    setSelectMode(false);
  }, []);

  const bulkDelete = useCallback(async () => {
    const uids = Array.from(selectedUids);
    const removed = emails.filter(e => selectedUids.has(e.uid));
    animateListChange();
    setEmails(prev => prev.filter(e => !selectedUids.has(e.uid)));
    clearSelection();
    if (selectedEmail && selectedUids.has(selectedEmail.uid)) setSelectedEmail(null);
    showUndo('deleted', uids, removed);
    scheduleAction(() => api.bulkDelete(uids, currentFolder));
  }, [selectedUids, emails, currentFolder, selectedEmail]);

  const bulkArchive = useCallback(async () => {
    const uids = Array.from(selectedUids);
    const removed = emails.filter(e => selectedUids.has(e.uid));
    animateListChange();
    setEmails(prev => prev.filter(e => !selectedUids.has(e.uid)));
    clearSelection();
    if (selectedEmail && selectedUids.has(selectedEmail.uid)) setSelectedEmail(null);
    showUndo('archived', uids, removed);
    scheduleAction(() => api.bulkArchive(uids, currentFolder));
  }, [selectedUids, emails, currentFolder, selectedEmail]);

  const bulkMarkRead = useCallback(async () => {
    const uids = Array.from(selectedUids);
    setEmails(prev => prev.map(e => selectedUids.has(e.uid) ? { ...e, seen: true } : e));
    clearSelection();
    try { await api.bulkMarkRead(uids, currentFolder); } catch (e) { console.warn('bulkMarkRead error:', e); }
  }, [selectedUids, currentFolder]);

  const bulkMarkUnread = useCallback(async () => {
    const uids = Array.from(selectedUids);
    setEmails(prev => prev.map(e => selectedUids.has(e.uid) ? { ...e, seen: false } : e));
    clearSelection();
    try { await api.bulkMarkUnread(uids, currentFolder); } catch (e) { console.warn('bulkMarkUnread error:', e); }
  }, [selectedUids, currentFolder]);

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
        setEmails(prev => prev.map(e => e.uid === uid ? { ...e, flagged: wasStarred } : e));
        if (selectedEmail?.uid === uid) {
          setSelectedEmail(prev => prev ? { ...prev, flagged: wasStarred } : prev);
        }
      }
    } catch {
      setEmails(prev => prev.map(e => e.uid === uid ? { ...e, flagged: wasStarred } : e));
      if (selectedEmail?.uid === uid) {
        setSelectedEmail(prev => prev ? { ...prev, flagged: wasStarred } : prev);
      }
    }
  }, [currentFolder, selectedEmail, emails]);

  const archiveEmail = useCallback(async (uid) => {
    animateListChange();
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const removed = emails.find(e => e.uid === uid);
    setEmails(prev => prev.filter(e => e.uid !== uid));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    try {
      const r = await api.archiveEmail(uid, currentFolder);
      if (!r?.success && removed) {
        setEmails(prev => [...prev, removed].sort((a, b) => b.uid - a.uid));
      }
    } catch {
      if (removed) setEmails(prev => [...prev, removed].sort((a, b) => b.uid - a.uid));
    }
  }, [currentFolder, selectedEmail, emails]);

  // --- Snooze ---

  const snoozeEmail = useCallback(async (uid, snoozeUntil) => {
    animateListChange();
    const removed = emails.find(e => e.uid === uid);
    setEmails(prev => prev.filter(e => e.uid !== uid));
    if (selectedEmail?.uid === uid) setSelectedEmail(null);
    try {
      const r = await api.snoozeEmail(uid, snoozeUntil, currentFolder);
      if (!r?.success && removed) setEmails(prev => [removed, ...prev]);
    } catch { if (removed) setEmails(prev => [removed, ...prev]); }
  }, [currentFolder, selectedEmail, emails]);

  // --- Undo system ---

  const showUndo = useCallback((type, uids, removedEmails) => {
    setUndoAction({ type, uids, removedEmails });
  }, []);

  const scheduleAction = useCallback((fn) => {
    clearTimeout(undoTimerRef.current);
    const startTime = Date.now();
    let remaining = 5000;

    const runAction = async () => {
      if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
      try { await fn(); } catch {}
      setUndoAction(null);
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
  }, []);

  const executeUndo = useCallback(() => {
    clearTimeout(undoTimerRef.current);
    if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
    if (undoAction?.removedEmails) {
      setEmails(prev => [...undoAction.removedEmails, ...prev]);
    }
    setUndoAction(null);
  }, [undoAction]);

  const dismissUndo = useCallback(() => {
    clearTimeout(undoTimerRef.current);
    if (undoTimerRef._visCleanup) { undoTimerRef._visCleanup(); undoTimerRef._visCleanup = null; }
    setUndoAction(null);
  }, []);

  // --- WebSocket real-time ---

  useEffect(() => {
    // Null-check + dep em user.email — antes o efeito não re-rodava após
    // login (handlers nunca registravam) e crashava se o require do mailWs
    // tivesse falhado.
    if (!mailWs) return;
    const token = authRef.current;
    if (!token) return;

    // Handle new email arrival
    const offNew = mailWs.on('new_email', (data) => {
      // Sound + haptic are handled by NotificationToast when it appears
      // Mobile local notification (triggers NotificationToast via foreground handler)
      if (data?.email) showLocalEmailNotification(data.email);

      // Web: trigger in-app toast (toast handles sound + vibration)
      if (Platform.OS === 'web' && data?.email) {
        try {
          const { _triggerForegroundToast } = require('../services/pushNotifications');
          const e = data.email;
          _triggerForegroundToast({
            title: e.from_name || e.from || 'New email',
            body: e.subject || '(no subject)',
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
        animateListChange();
        // Prepend new email to list
        if (data?.email) {
          let prepended = false;
          setEmails(prev => {
            // Avoid duplicates
            if (prev.some(e => e.uid === data.email.uid)) return prev;
            prepended = true;
            return [data.email, ...prev];
          });
          // Só incrementa total se realmente prependou — antes incrementava
          // mesmo em duplicata, dessincronizando o contador.
          if (prepended) setTotal(prev => prev + 1);
        } else {
          // No email data provided, silent refresh
          silentRefresh();
        }
      }
      // Desktop browser notification with preview
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        const e = data?.email;
        if (e) {
          try {
            const subject = e.subject || '(no subject)';
            const preview = e.preview ? `\n${e.preview.slice(0, 120)}` : '';
            const n = new Notification(e.from_name || e.from || 'New email', {
              body: subject + preview,
              icon: '/icon-192.png',
              tag: `email-${e.uid}`,
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
        animateListChange();
        let removed = false;
        setEmails(prev => {
          const next = prev.filter(e => e.uid !== data.uid);
          removed = next.length !== prev.length;
          return next;
        });
        if (removed) setTotal(prev => Math.max(0, prev - 1));
      }
    });

    // Handle email moved
    const offMove = mailWs.on('email_moved', (data) => {
      if (data?.uid && data?.from_folder === folderRef.current) {
        animateListChange();
        let removed = false;
        setEmails(prev => {
          const next = prev.filter(e => e.uid !== data.uid);
          removed = next.length !== prev.length;
          return next;
        });
        if (removed) setTotal(prev => Math.max(0, prev - 1));
      } else if (data?.to_folder === folderRef.current) {
        silentRefresh();
      }
    });

    // Handle read status change (but never revert recently-read emails)
    const offRead = mailWs.on('email_read', (data) => {
      if (data?.uid) {
        const isRecentlyRead = recentlyReadRef.current.has(String(data.uid));
        setEmails(prev => prev.map(e =>
          e.uid === data.uid ? { ...e, seen: (isRecentlyRead ? true : data.seen) } : e
        ));
      }
    });

    // Handle folder update
    const offFolder = mailWs.on('folder_updated', () => {
      loadFolders();
    });

    // Connection status
    const offConn = mailWs.on('connection', (data) => {
      setWsStatus(data.status);
    });

    return () => {
      offNew();
      offDel();
      offMove();
      offRead();
      offFolder();
      offConn();
    };
  }, [refresh, silentRefresh, loadFolders, user?.email]);

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
        lastConnectedEmailRef.current = user.email;
        mailWs.reset();
        mailWs.connect(token);
      }
    } else if (!user?.email) {
      lastConnectedEmailRef.current = null;
      mailWs.disconnect();
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
        unsub = ws.on('new_email', (data) => {
          // Debounced: refresh once even if multiple events fire in burst
          clearTimeout(unsub?._t);
          unsub._t = setTimeout(() => {
            try { silentRefresh(); } catch {}
            try { loadFolders(); } catch {}
          }, 200);
        });
      } catch {}
    })();
    return () => {
      try {
        if (unsub) { clearTimeout(unsub._t); unsub(); }
        import('../services/websocket').then(m => m.default.unsubscribe(`mail_${user.email}`)).catch(() => {});
      } catch {}
    };
  }, [user?.email, silentRefresh, loadFolders]);

  // Pauses when tab is hidden to save resources
  // Always poll — even with empty inbox (new accounts need to detect first email)
  const folderRefreshRef = useRef(null);
  useEffect(() => {
    if (user?.email) {
      const interval = wsStatus === 'authenticated' ? POLL_CONNECTED : POLL_DISCONNECTED;
      const start = () => {
        clearInterval(refreshRef.current);
        clearInterval(folderRefreshRef.current);
        refreshRef.current = setInterval(silentRefresh, interval);
        // Refresh folder counts less frequently (every 2 min when WS connected, 30s otherwise)
        const folderInterval = wsStatus === 'authenticated' ? 120000 : 30000;
        folderRefreshRef.current = setInterval(loadFolders, folderInterval);
      };
      const stop = () => {
        clearInterval(refreshRef.current);
        clearInterval(folderRefreshRef.current);
      };

      start();

      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const onVis = () => {
          if (document.hidden) { stop(); } else { silentRefresh(); loadFolders(); start(); }
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
        const sub = AppState.addEventListener('change', (next) => {
          if (next === 'active') {
            try { silentRefresh(); } catch {}
            try { loadFolders(); } catch {}
          }
        });
        return () => { stop(); try { sub.remove(); } catch {} };
      }

      return stop;
    }
  }, [silentRefresh, loadFolders, emails.length, currentFolder, wsStatus]);

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
    loadFolders, loadEmails, openEmail, changeFolder, refresh, doSearch,
    deleteEmail, moveEmail, setPage, setSelectedEmail, markAsRead,
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
  }), [
    emails, folders, currentFolder, selectedEmail, loadingList, loadingMessage,
    page, total, search, wsStatus,
    loadFolders, loadEmails, openEmail, changeFolder, refresh, doSearch,
    deleteEmail, moveEmail, setPage, setSelectedEmail, markAsRead,
    starEmail, archiveEmail,
    selectedUids, selectMode, toggleSelect, selectAll, clearSelection,
    bulkDelete, bulkArchive, bulkMarkRead, bulkMarkUnread,
    undoAction, executeUndo, dismissUndo,
    addLabelToEmail, removeLabelFromEmail, labelCounts,
    snoozeEmail,
    resetMailState,
    recentlyReadLoaded,
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
