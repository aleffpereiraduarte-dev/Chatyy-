// OutboxBanner — WhatsApp-style persistent "N messages waiting for network"
// banner. Reads the offline action queue from services/offlineCache and shows
// a count + tap-to-expand modal listing every pending action with per-item
// "Cancel" + a global "Retry now" button that drains the queue immediately.
//
// Wire-up notes (not done here): mount <OutboxBanner /> inside app/chat.js
// (chat list) and/or app/chat-conversation.js (per-conversation, filter to
// the active conv via a prop later). Render directly below the header so it
// pushes content down (NOT absolute) — matches WhatsApp's behavior.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import {
  IconClock,
  IconChevronRight,
  IconRotateCcw,
  IconX,
  IconImage,
  IconMusic,
  IconFileText,
  IconMessageSquare,
  IconFilm,
} from './Icons';

// ─── Hook: useOutboxCount ───
// Polls services/offlineCache.getOfflineQueue() every 2s, returning the
// queue snapshot + replay status. We don't subscribe to DeviceEventEmitter
// 'offline_queue_changed' because offlineCache.js doesn't emit it today —
// polling is the only reliable trigger.

export function useOutboxCount() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState([]);
  const [lastError, setLastError] = useState(null);
  const [isReplaying, setIsReplaying] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { getOfflineQueue } = require('../services/offlineCache');
      const queue = await getOfflineQueue();
      if (!mountedRef.current) return;
      const list = Array.isArray(queue) ? queue : [];
      setCount(list.length);
      setItems(list);
      // Surface the most recent permanent_fail action as "last error" so the
      // banner can flip from yellow → red once we know retries are dead.
      const failed = list.find(a => a?.permanent_fail);
      setLastError(failed ? (failed.last_error || 'send_failed') : null);
    } catch (e) {
      // Silent — outboxCache may not be initialized yet on cold start.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const retryNow = useCallback(async () => {
    if (isReplaying) return { replayed: 0, failed: 0 };
    setIsReplaying(true);
    try {
      const { replayOfflineQueue } = require('../services/offlineCache');
      const api = require('../services/api');
      const r = await replayOfflineQueue(api);
      await refresh();
      return r || { replayed: 0, failed: 0 };
    } catch (e) {
      setLastError(String(e?.message || e || 'replay_failed'));
      return { replayed: 0, failed: 1 };
    } finally {
      if (mountedRef.current) setIsReplaying(false);
    }
  }, [isReplaying, refresh]);

  const cancelItem = useCallback(async (actionId) => {
    try {
      const { removeFromQueue } = require('../services/offlineCache');
      await removeFromQueue(actionId);
      await refresh();
    } catch {}
  }, [refresh]);

  return { count, items, lastError, isReplaying, retryNow, cancelItem, refresh };
}

// ─── Helpers ───

function _actionKind(action) {
  if (!action || !action.type) return 'other';
  if (action.type === 'chat_send') return 'text';
  if (action.type === 'chat_audio_upload') return 'audio';
  if (action.type === 'chat_file_upload') {
    const t = String(action.msg_type || action.file_type || '').toLowerCase();
    if (t.includes('image')) return 'image';
    if (t.includes('video')) return 'video';
    return 'file';
  }
  if (action.type === 'send_email') return 'email';
  return 'other';
}

function _IconForKind({ kind, size, color }) {
  switch (kind) {
    case 'image': return <IconImage size={size} color={color} />;
    case 'video': return <IconFilm size={size} color={color} />;
    case 'audio': return <IconMusic size={size} color={color} />;
    case 'file': return <IconFileText size={size} color={color} />;
    case 'email': return <IconFileText size={size} color={color} />;
    case 'text':
    default: return <IconMessageSquare size={size} color={color} />;
  }
}

function _preview(action, t) {
  const kind = _actionKind(action);
  if (kind === 'text') {
    const s = String(action.content || '').trim();
    return s.length > 60 ? s.slice(0, 57) + '…' : (s || t('outbox.empty'));
  }
  if (kind === 'audio') return `${t('outbox.audio') || 'Audio'} (${action.duration || 0}s)`;
  if (kind === 'image') return action.caption || t('outbox.image') || 'Photo';
  if (kind === 'video') return action.caption || t('outbox.video') || 'Video';
  if (kind === 'file') return action.name || action.caption || t('outbox.file') || 'File';
  if (kind === 'email') return action.payload?.subject || t('outbox.email') || 'Email';
  return action.type || '';
}

function _formatTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  } catch {
    return '';
  }
}

function _resolveConvName(conversationId, convCache) {
  if (!conversationId) return '';
  const c = convCache?.[conversationId];
  if (!c) return '';
  return c.title || c.name || c.display_name || c.subject || '';
}

// ─── Component ───

export default function OutboxBanner() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { count, items, isReplaying, retryNow, cancelItem } = useOutboxCount();
  const [expanded, setExpanded] = useState(false);
  const [convCache, setConvCache] = useState({});

  // Best-effort: resolve conversation names from chatCache so the expanded
  // list can show "to: Maria" instead of a raw uuid. Only loads when modal
  // opens so we don't burn an IndexedDB hit on every poll.
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    (async () => {
      try {
        const { getCachedConversations } = require('../services/chatCache');
        const convs = await getCachedConversations();
        if (!alive) return;
        const map = {};
        for (const c of convs || []) map[c.id] = c;
        setConvCache(map);
      } catch {}
    })();
    return () => { alive = false; };
  }, [expanded]);

  if (count === 0) return null;

  const bg = colors.warningBg || '#fffbeb';
  const fg = colors.warning || '#d97706';
  // i18n key supports {n} placeholder; fall back to manual replace if the
  // translation file hasn't been updated yet.
  const labelRaw = count === 1
    ? (t('outbox.bannerOne') || t('outbox.banner') || '{n} message waiting for network')
    : (t('outbox.banner') || '{n} messages waiting for network');
  const label = String(labelRaw).replace('{n}', String(count));

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded(true)}
        style={[s.banner, { backgroundColor: bg, borderBottomColor: fg + '33' }]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <IconClock size={16} color={fg} />
        <Text style={[s.bannerText, { color: fg }]} numberOfLines={1}>{label}</Text>
        {isReplaying ? (
          <ActivityIndicator size="small" color={fg} />
        ) : (
          <IconChevronRight size={16} color={fg} />
        )}
      </TouchableOpacity>

      <Modal
        visible={expanded}
        animationType="slide"
        transparent
        onRequestClose={() => setExpanded(false)}
      >
        <View style={s.modalRoot}>
          <TouchableOpacity
            style={s.modalBackdrop}
            activeOpacity={1}
            onPress={() => setExpanded(false)}
          />
          <View style={[s.sheet, { backgroundColor: colors.card || colors.bg || '#fff' }]}>
            <View style={[s.sheetHeader, { borderBottomColor: colors.border || '#e5e7eb' }]}>
              <Text style={[s.sheetTitle, { color: colors.text || '#111' }]}>
                {t('outbox.expand') || 'Pending messages'}
              </Text>
              <TouchableOpacity
                onPress={() => setExpanded(false)}
                style={s.sheetCloseBtn}
                accessibilityRole="button"
                accessibilityLabel={t('common.close') || 'Close'}
              >
                <IconX size={20} color={colors.text || '#111'} />
              </TouchableOpacity>
            </View>

            {items.length === 0 ? (
              <View style={s.emptyBox}>
                <Text style={{ color: colors.textSecondary || '#888' }}>
                  {t('outbox.empty') || 'No pending messages'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={items}
                keyExtractor={(it, idx) => String(it.id || idx)}
                contentContainerStyle={{ paddingBottom: Spacing.lg }}
                renderItem={({ item }) => {
                  const kind = _actionKind(item);
                  const isFailed = !!item.permanent_fail;
                  const iconColor = isFailed ? (colors.error || '#dc2626') : fg;
                  const target = _resolveConvName(item.conversation_id, convCache);
                  return (
                    <View style={[s.row, { borderBottomColor: colors.border || '#eee' }]}>
                      <View style={[s.kindIcon, { backgroundColor: (isFailed ? (colors.error || '#dc2626') : fg) + '15' }]}>
                        <_IconForKind kind={kind} size={18} color={iconColor} />
                      </View>
                      <View style={s.rowBody}>
                        <Text style={[s.rowTitle, { color: colors.text || '#111' }]} numberOfLines={1}>
                          {target || t('outbox.unknownTarget') || 'Pending'}
                        </Text>
                        <Text style={[s.rowPreview, { color: colors.textSecondary || '#666' }]} numberOfLines={1}>
                          {_preview(item, t)}
                        </Text>
                        {item.retries ? (
                          <Text style={[s.rowMeta, { color: isFailed ? (colors.error || '#dc2626') : (colors.textSecondary || '#888') }]}>
                            {isFailed
                              ? (t('outbox.failedAttempts') || 'Failed after {n} attempts').replace('{n}', String(item.retries))
                              : (t('outbox.retrying') || 'Retry #{n}').replace('{n}', String(item.retries))}
                          </Text>
                        ) : null}
                      </View>
                      <View style={s.rowRight}>
                        <Text style={[s.rowTs, { color: colors.textSecondary || '#888' }]}>
                          {_formatTs(item.ts)}
                        </Text>
                        <TouchableOpacity
                          onPress={() => cancelItem(item.id)}
                          style={s.cancelBtn}
                          accessibilityRole="button"
                          accessibilityLabel={t('outbox.cancel') || 'Cancel'}
                        >
                          <IconX size={16} color={colors.textSecondary || '#888'} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                }}
              />
            )}

            <View style={[s.footer, { borderTopColor: colors.border || '#eee' }]}>
              <TouchableOpacity
                style={[s.retryBtn, { backgroundColor: fg }]}
                onPress={retryNow}
                disabled={isReplaying || items.length === 0}
                accessibilityRole="button"
                accessibilityLabel={t('outbox.retryNow') || 'Retry now'}
              >
                {isReplaying ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <IconRotateCcw size={16} color="#fff" />
                )}
                <Text style={s.retryBtnText}>
                  {t('outbox.retryNow') || 'Retry now'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ─── Styles ───

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    borderBottomWidth: 1,
    width: '100%',
  },
  bannerText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    maxHeight: '75%',
    minHeight: 240,
    borderTopLeftRadius: BorderRadius.xl || 20,
    borderTopRightRadius: BorderRadius.xl || 20,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: -4 } },
      android: { elevation: 12 },
      default: {},
    }),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  sheetTitle: {
    fontSize: FontSize.lg || 16,
    fontWeight: '700',
  },
  sheetCloseBtn: {
    padding: 4,
  },
  emptyBox: {
    paddingVertical: Spacing.xl || 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  kindIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: FontSize.sm || 14,
    fontWeight: '600',
  },
  rowPreview: {
    fontSize: FontSize.xs || 12,
    marginTop: 2,
  },
  rowMeta: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: '500',
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  rowTs: {
    fontSize: 11,
  },
  cancelBtn: {
    padding: 4,
  },
  footer: {
    flexDirection: 'row',
    padding: Spacing.lg,
    borderTopWidth: 1,
  },
  retryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md || 8,
    gap: Spacing.sm,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: FontSize.md || 15,
    fontWeight: '700',
  },
});
