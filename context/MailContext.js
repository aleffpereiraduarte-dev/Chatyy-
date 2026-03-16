import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Platform, LayoutAnimation, UIManager } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as api from '../services/api';
import mailWs from '../services/websocket';
import { playNewEmailAlert as playAlert } from '../services/notificationSound';
import { useAuth } from './AuthContext';
import {
  saveEmailsToCache, getEmailsFromCache,
  saveMessageToCache, getMessageFromCache,
  queueOfflineAction, replayOfflineQueue,
  isOnline, onOnlineStatusChange,
} from '../services/offlineCache';

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

// Polling interval: 60s when WS connected, 15s when disconnected
const POLL_CONNECTED = 60000;
const POLL_DISCONNECTED = 15000;

export function MailProvider({ children }) {
  const { user } = useAuth();
  const [emails, setEmails] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState('INBOX');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const refreshRef = useRef(null);
  const folderRef = useRef(currentFolder);
  const authRef = useRef(null);
  const offlineQueueRef = useRef(false);

  // Track recently-read UIDs to prevent seen state from reverting (IMAP flag lag)
  const recentlyReadRef = useRef(new Set());
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
    try {
      const r = await api.getFolders();
      if (r.success) setFolders(Array.isArray(r.data) ? r.data : r.data?.folders || []);
    } catch {}
  }, []);

  const loadEmails = useCallback(async (folder, pg = 1, q = '', category = '', label = '', silent = false) => {
    if (!silent) setLoadingList(true);
    const f = folder || currentFolder;
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
              // Preserve local seen=true even if server still says false (IMAP flag lag)
              const mergedSeen = existing.seen || e.seen || recentlyRead.has(String(e.uid));
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
        // Cache first page results
        if (pg === 1 && !q && !category && !label) {
          saveEmailsToCache(f, emailList).catch(() => {});
        }
        // Replay offline queue when back online
        if (offlineQueueRef.current) {
          offlineQueueRef.current = false;
          replayOfflineQueue(api).catch(() => {});
        }
      }
    } catch {
      // Fallback to cached data when offline
      if (pg === 1 && !q) {
        const cached = await getEmailsFromCache(f);
        if (cached) {
          setEmails(cached);
          setTotal(cached.length);
        }
      }
    } finally {
      if (!silent) setLoadingList(false);
    }
  }, [currentFolder]);

  const openEmail = useCallback(async (uid, folder) => {
    setLoadingMessage(true);
    try {
      const r = await api.getMessage(uid, folder || currentFolder);
      if (r.success) {
        setSelectedEmail(r.data);
        markAsRead(uid, folder);
        saveMessageToCache(uid, r.data).catch(() => {});
      }
    } catch {
      // Fallback to cached message
      const cached = await getMessageFromCache(uid);
      if (cached) setSelectedEmail(cached);
    } finally {
      setLoadingMessage(false);
    }
  }, [currentFolder]);

  // Mark email as read — updates both server and local state
  const markAsRead = useCallback(async (uid, folder) => {
    const uidStr = String(uid);
    // Optimistic UI update
    setEmails(prev => prev.map(e => String(e.uid) === uidStr ? { ...e, seen: true } : e));
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
      const r = await api.markRead(uid, folder || currentFolder);
      if (!r?.success) console.warn('markRead failed for uid', uid, r?.message);
    } catch (e) {
      console.warn('markRead error for uid', uid, e);
      // Queue for offline retry
      queueOfflineAction({ type: 'markRead', uid, folder: folder || currentFolder }).catch(() => {});
    }
    // No auto-expire timer needed — recentlyRead is cleaned up from
    // persisted storage on load (24h cutoff) and the ref is cleared on unmount.
  }, [currentFolder]);

  const changeFolder = useCallback((folder) => {
    setCurrentFolder(folder);
    setSelectedEmail(null);
    setPage(1);
    setSearch('');
    clearSelection();
    loadEmails(folder, 1, '');
  }, [loadEmails]);

  // Manual refresh (pull-to-refresh) — shows loading spinner
  const refresh = useCallback(() => {
    loadEmails(currentFolder, page, search);
  }, [currentFolder, page, search, loadEmails]);

  // Silent refresh — background poll, no spinner, no scroll jump
  const silentRefresh = useCallback(() => {
    loadEmails(currentFolder, page, search, '', '', true);
  }, [currentFolder, page, search, loadEmails]);

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
          setEmails(prev => {
            // Avoid duplicates
            if (prev.some(e => e.uid === data.email.uid)) return prev;
            return [data.email, ...prev];
          });
          setTotal(prev => prev + 1);
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
        setEmails(prev => prev.filter(e => e.uid !== data.uid));
      }
    });

    // Handle email moved
    const offMove = mailWs.on('email_moved', (data) => {
      if (data?.uid && data?.from_folder === folderRef.current) {
        animateListChange();
        setEmails(prev => prev.filter(e => e.uid !== data.uid));
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
  }, [refresh, silentRefresh, loadFolders]);

  // Connect WebSocket when auth token is available (reactive to login/logout)
  useEffect(() => {
    const token = api.getAuthToken?.();
    if (token && user?.email) {
      authRef.current = token;
      mailWs.reset(); // Reset destroyed flag from previous disconnect
      mailWs.connect(token);
    } else if (!user?.email) {
      mailWs.disconnect();
    }

    return () => {
      mailWs.disconnect();
    };
  }, [user?.email]);

  // Adaptive polling: silent background refresh — no spinner, no scroll jump
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

      return stop;
    }
  }, [silentRefresh, loadFolders, emails.length, currentFolder, wsStatus]);

  return (
    <MailContext.Provider value={{
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
      addLabelToEmail, removeLabelFromEmail,
      // Snooze
      snoozeEmail,
      // Account
      resetMailState,
      // Ready state
      recentlyReadLoaded,
    }}>
      {children}
    </MailContext.Provider>
  );
}

export function useMail() {
  const ctx = useContext(MailContext);
  if (!ctx) throw new Error('useMail must be inside MailProvider');
  return ctx;
}
