import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import DOMPurify from 'dompurify';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import { IconChevronDown, IconReply, IconReplyAll, IconForward, IconX } from './Icons';

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' ' +
      d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  } catch {
    return dateStr;
  }
}

function MessageItem({ message, isLast, colors, t, onReply, onReplyAll, onForward }) {
  const [expanded, setExpanded] = useState(isLast);
  const avatarColor = getAvatarColor(message.from_name || message.from);
  const initial = (message.from_name || message.from || '?')[0].toUpperCase();

  const renderBody = () => {
    if (message.body_html && Platform.OS === 'web') {
      return (
        <div
          style={{
            padding: 0, fontSize: 14, lineHeight: 1.7, color: colors.text,
            wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.body_html) }}
        />
      );
    }
    return (
      <Text style={[s.bodyText, { color: colors.text }]}>
        {message.body_text || message.body || t('reader.noContent')}
      </Text>
    );
  };

  return (
    <View style={[s.messageCard, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <TouchableOpacity
        style={s.messageHeader}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={[s.avatar, { backgroundColor: avatarColor }]}>
          <Text style={s.avatarText}>{initial}</Text>
        </View>
        <View style={s.headerInfo}>
          <View style={s.headerTopRow}>
            <Text style={[s.senderName, { color: colors.text }]} numberOfLines={1}>
              {message.from_name || message.from}
            </Text>
            <Text style={[s.dateText, { color: colors.textTertiary }]}>
              {formatDate(message.date)}
            </Text>
          </View>
          {!expanded && (
            <Text style={[s.snippet, { color: colors.textTertiary }]} numberOfLines={1}>
              {message.body_text || message.body || t('reader.noContent')}
            </Text>
          )}
          {expanded && message.to && (
            <Text style={[s.toLine, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('reader.to')} {message.to}
            </Text>
          )}
        </View>
        <View style={[s.chevronWrap, { transform: [{ rotate: expanded ? '180deg' : '0deg' }] }]}>
          <IconChevronDown size={18} color={colors.textTertiary} />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={[s.messageBody, { borderTopColor: colors.borderLight }]}>
          {renderBody()}
          {/* Per-message reply actions */}
          <View style={s.msgActions}>
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReply?.(message)}>
              <IconReply size={14} color={colors.primary} style={{ marginRight: 4 }} />
              <Text style={[s.msgActionText, { color: colors.primary }]}>{t('reader.reply')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReplyAll?.(message)}>
              <IconReplyAll size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={[s.msgActionText, { color: colors.textSecondary }]}>{t('reader.replyAll')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onForward?.(message)}>
              <IconForward size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={[s.msgActionText, { color: colors.textSecondary }]}>{t('reader.forward')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

export default function ThreadView({ thread, onReply, onReplyAll, onForward, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  if (!thread || thread.length === 0) return null;

  const subject = thread[0]?.subject || t('reader.noSubject');
  const messageCount = thread.length;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Thread header */}
      <View style={s.threadHeader}>
        <View style={s.subjectRow}>
          <Text style={[s.subject, { color: colors.text }]} numberOfLines={3}>
            {subject}
          </Text>
          {onClose && (
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <Text style={[s.messageCount, { color: colors.textTertiary }]}>
          {messageCount} {messageCount === 1 ? t('thread.message') : t('thread.messages')}
        </Text>
      </View>

      {/* Messages */}
      {thread.map((msg, index) => (
        <MessageItem
          key={msg.uid || msg.id || index}
          message={msg}
          isLast={index === thread.length - 1}
          colors={colors}
          t={t}
          onReply={onReply}
          onReplyAll={onReplyAll}
          onForward={onForward}
        />
      ))}

      {/* Action buttons */}
      <View style={[s.actions, { borderTopColor: colors.borderLight }]}>
        <TouchableOpacity
          style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          onPress={() => onReply?.(thread[thread.length - 1])}
        >
          <IconReply size={16} color={colors.primary} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.text }]}>{t('reader.reply')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          onPress={() => onReplyAll?.(thread[thread.length - 1])}
        >
          <IconReplyAll size={16} color={colors.primary} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.text }]}>{t('reader.replyAll')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          onPress={() => onForward?.(thread[thread.length - 1])}
        >
          <IconForward size={16} color={colors.primary} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.text }]}>{t('reader.forward')}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xxl, paddingBottom: 40 },
  // Thread header
  threadHeader: { marginBottom: Spacing.xl },
  subjectRow: { flexDirection: 'row', alignItems: 'flex-start' },
  subject: { flex: 1, fontSize: 22, fontWeight: '400', lineHeight: 30, letterSpacing: -0.2 },
  closeBtn: { padding: Spacing.sm, marginLeft: Spacing.sm },
  messageCount: { fontSize: FontSize.sm, marginTop: Spacing.xs },
  // Message card
  messageCard: {
    borderRadius: BorderRadius.lg, borderWidth: 1,
    marginBottom: Spacing.md, overflow: 'hidden',
  },
  messageHeader: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.lg,
  },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerInfo: { flex: 1, marginRight: Spacing.sm },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  senderName: { fontSize: FontSize.base, fontWeight: '600', flex: 1, marginRight: Spacing.sm },
  dateText: { fontSize: FontSize.xs },
  snippet: { fontSize: FontSize.sm, marginTop: 2 },
  toLine: { fontSize: FontSize.xs, marginTop: 2 },
  chevronWrap: { padding: Spacing.xs },
  // Message body
  messageBody: {
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bodyText: { fontSize: FontSize.base, lineHeight: 24 },
  // Per-message actions
  msgActions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.06)',
  },
  msgActionBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderRadius: BorderRadius.xxl,
  },
  msgActionText: { fontSize: FontSize.xs, fontWeight: '500' },
  // Actions
  actions: {
    flexDirection: 'row', flexWrap: 'wrap', marginTop: Spacing.xl, paddingTop: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth, gap: Spacing.md,
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderRadius: BorderRadius.xxl, paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  actionText: { fontSize: FontSize.base, fontWeight: '500' },
});
