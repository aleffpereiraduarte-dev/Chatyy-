// AISummarizeModal — modal that asks the backend to summarize the last N
// unread messages of a conversation. Telegram parity (Telegram Premium
// "Summary" feature). Backend uses OpenAI gpt-4o-mini.
//
// Props:
//   visible       bool
//   conversationId number
//   sinceMessageId number  — first unread id; backend reads from here forward
//   onClose       () => void
//   onMarkRead    () => void  — called when user taps "Mark as read"
//   colors        theme colors
//   t             i18n function

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Pressable,
  Platform,
} from 'react-native';
import { IconSparkles, IconX, IconCheck } from '../Icons';

const BRAND = '#7C3AED';

export default function AISummarizeModal({
  visible,
  conversationId,
  sinceMessageId,
  onClose,
  onMarkRead,
  colors,
  t,
}) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setError('');
    (async () => {
      try {
        const api = require('../../services/api');
        const r = await api.chatAiSummarize(conversationId, sinceMessageId || 0);
        if (cancelled) return;
        if (r?.success && r?.data) {
          setSummary(r.data.summary_text || '');
          setParticipants(Array.isArray(r.data.participants) ? r.data.participants : []);
          setCount(parseInt(r.data.message_count || 0, 10));
        } else {
          setError(r?.message || (t?.('chatConv.summarizeError') || 'Could not summarize'));
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, conversationId, sinceMessageId]);

  // Parse bullet-style summary: split on newlines, strip leading dashes.
  const bullets = React.useMemo(() => {
    if (!summary) return [];
    return summary
      .split(/\r?\n+/)
      .map(l => l.replace(/^[\-•*\d.)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 8);
  }, [summary]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={[s.card, { backgroundColor: colors?.surface || '#fff' }]}
        >
          {/* Header */}
          <View style={s.header}>
            <View style={s.headerLeft}>
              <View style={[s.iconCircle, { backgroundColor: BRAND + '22' }]}>
                <IconSparkles size={18} color={BRAND} />
              </View>
              <Text style={[s.title, { color: colors?.text || '#000' }]}>
                {t?.('chatConv.summaryTitle') || 'Resumo da conversa'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <IconX size={20} color={colors?.textSecondary || '#666'} />
            </TouchableOpacity>
          </View>

          {/* Body */}
          <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 18, paddingTop: 8 }}>
            {loading ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <ActivityIndicator size="large" color={BRAND} />
                <Text style={[s.loadingText, { color: colors?.textSecondary || '#666' }]}>
                  {t?.('chatConv.summarizing') || 'Lendo mensagens não lidas...'}
                </Text>
              </View>
            ) : error ? (
              <Text style={[s.errText, { color: colors?.error || '#EF4444' }]}>
                {error}
              </Text>
            ) : (
              <View>
                {/* Metadata strip */}
                <View style={[s.metaRow, { borderColor: colors?.border || '#eee' }]}>
                  <Text style={[s.metaText, { color: colors?.textSecondary || '#666' }]}>
                    {(t?.('chatConv.summaryCount') || '{count} mensagens').replace('{count}', String(count || bullets.length))}
                  </Text>
                  {participants.length > 0 && (
                    <Text style={[s.metaText, { color: colors?.textSecondary || '#666' }]} numberOfLines={1}>
                      {participants.slice(0, 3).join(', ')}
                      {participants.length > 3 ? ' +' + (participants.length - 3) : ''}
                    </Text>
                  )}
                </View>

                {/* Bullet list */}
                {bullets.length === 0 ? (
                  <Text style={{ color: colors?.textTertiary || '#999', textAlign: 'center', paddingVertical: 20 }}>
                    {t?.('chatConv.summaryEmpty') || 'Nada para resumir.'}
                  </Text>
                ) : (
                  bullets.map((b, i) => (
                    <View key={i} style={s.bulletRow}>
                      <View style={[s.bulletDot, { backgroundColor: BRAND }]} />
                      <Text style={[s.bulletText, { color: colors?.text || '#000' }]}>{b}</Text>
                    </View>
                  ))
                )}
              </View>
            )}
          </ScrollView>

          {/* Actions */}
          {!loading && !error && bullets.length > 0 && (
            <View style={[s.actions, { borderTopColor: colors?.border || '#eee' }]}>
              <TouchableOpacity
                onPress={() => { onMarkRead?.(); onClose?.(); }}
                style={[s.actionBtn, { backgroundColor: BRAND }]}
              >
                <IconCheck size={16} color="#fff" strokeWidth={3} />
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
                  {t?.('chatConv.markAsRead') || 'Marcar como lido'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  card: {
    width: '100%',
    maxWidth: 460,
    borderRadius: 18,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 22, shadowOffset: { width: 0, height: 12 } },
      android: { elevation: 12 },
      default: { boxShadow: '0 18px 40px rgba(0,0,0,0.28)' },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 6,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 10,
    marginBottom: 14,
    gap: 12,
  },
  metaText: { fontSize: 12 },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  loadingText: {
    marginTop: 14,
    fontSize: 14,
  },
  errText: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
  actions: {
    padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
});
