import { useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { getMessage } from '../services/api';
// DOMPurify is web-only — lazy load to avoid crash on native
let DOMPurify = null;
if (Platform.OS === 'web') {
  try { DOMPurify = require('dompurify'); } catch (e) {}
}
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import { IconChevronDown, IconReply, IconReplyAll, IconForward, IconX } from './Icons';
import AvatarCircle from './AvatarCircle';

function extractEmail(fromField) {
  if (!fromField) return '';
  // RFC 5322 "Name <addr@host>" form → just the address.
  const m = String(fromField).match(/<([^>]+@[^>]+)>/);
  return m ? m[1].trim() : String(fromField).trim();
}

// [2026-06-05] No mobile o ThreadView NÃO tinha caminho de HTML (só web via
// DOMPurify) → e-mails SÓ-HTML (ex.: marketing/Transfeera) caíam em
// `body_text || body` = vazio → "(sem conteúdo)" no app, mesmo funcionando no
// web. Este fallback converte o body_html em texto legível pra exibir no
// celular. Tira <style>/<script>, vira blocos em quebra de linha, decodifica
// entidades comuns e colapsa espaços.
function htmlToText(html) {
  if (!html) return '';
  let x = String(html);
  x = x.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  x = x.replace(/<br\s*\/?>/gi, '\n');
  x = x.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n');
  x = x.replace(/<[^>]+>/g, '');
  x = x.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
       .replace(/&[a-z#0-9]+;/gi, ' ');
  return x.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// [2026-07-03] Some servers return HTML markup INSIDE body_text/body (no real
// text/plain MIME part), which rendered raw <p>/<a>/<br> tags in the thread
// view on native — the founder's screenshot showed "<p>Hi Aleff,</p>..." as
// literal text. The web path sanitizes+renders HTML (DOMPurify); native falls
// to a <Text>. Prefer a GENUINE plaintext part, but if the text field actually
// contains HTML tags, convert it via htmlToText instead of dumping the markup.
function pickBodyText(m) {
  const looksHtml = (s) => typeof s === 'string' && /<\/?[a-z][\s\S]*?>/i.test(s);
  const txt = m.body_text || m.body || '';
  if (txt && !looksHtml(txt)) return txt;      // real plaintext → use as-is
  if (m.body_html) return htmlToText(m.body_html); // HTML source of truth
  if (looksHtml(txt)) return htmlToText(txt);  // text field carried HTML
  return txt;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
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
  const [fetched, setFetched] = useState(null);
  const [loadingBody, setLoadingBody] = useState(false);

  // [2026-06-15] O backend `get_thread` monta cada mensagem da thread SÓ com
  // imap_fetch_overview (cabeçalhos: from/to/subject/date) — NUNCA traz o corpo.
  // Por isso toda mensagem de uma thread de 2+ mostrava "(sem conteúdo)", mesmo
  // o e-mail abrindo normal quando aberto sozinho (read.js busca o corpo via
  // getMessage). Fix estilo Gmail: ao expandir a mensagem pela 1ª vez, busca o
  // corpo completo via getMessage(uid, folder) e mescla. Lazy = não pesa o
  // servidor buscando N corpos de uma vez.
  const hasBody = !!(message.body_html || message.body_text || message.body);
  useEffect(() => {
    if (!expanded || hasBody || fetched || loadingBody || !message.uid) return;
    let cancelled = false;
    setLoadingBody(true);
    Promise.resolve(getMessage(message.uid, message.folder || 'INBOX'))
      .then((r) => { if (!cancelled && r && r.success && r.data) setFetched(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingBody(false); });
    return () => { cancelled = true; };
  }, [expanded, hasBody, fetched, loadingBody, message.uid, message.folder]);

  const m = fetched ? { ...message, ...fetched } : message;
  const mHasBody = !!(m.body_html || m.body_text || m.body);
  const senderEmail = extractEmail(m.from);

  const renderBody = () => {
    if (m.body_html && Platform.OS === 'web' && DOMPurify?.sanitize) {
      return (
        <div
          style={{
            padding: 0, fontSize: 14, lineHeight: 1.7, color: colors.text,
            wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(m.body_html) }}
        />
      );
    }
    // Sem corpo ainda + buscando → spinner em vez de "(sem conteúdo)".
    if (!mHasBody && loadingBody) {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}>
          <ActivityIndicator size="small" color={colors.textTertiary} />
          <Text style={[s.bodyText, { color: colors.textTertiary, marginLeft: 8 }]}>
            {t('common.loading') || 'Carregando…'}
          </Text>
        </View>
      );
    }
    return (
      <Text style={[s.bodyText, { color: colors.text }]}>
        {pickBodyText(m) || t('reader.noContent')}
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
        <AvatarCircle
          name={m.from_name || m.from}
          email={senderEmail}
          size={36}
          style={s.avatar}
        />
        <View style={s.headerInfo}>
          <View style={s.headerTopRow}>
            <Text style={[s.senderName, { color: colors.text }]} numberOfLines={1}>
              {m.from_name || m.from}
            </Text>
            <Text style={[s.dateText, { color: colors.textTertiary }]}>
              {formatDate(m.date)}
            </Text>
          </View>
          {!expanded && (
            <Text style={[s.snippet, { color: colors.textTertiary }]} numberOfLines={1}>
              {pickBodyText(m) || (m.preview || m.snippet || '')}
            </Text>
          )}
          {expanded && m.to && (
            <Text style={[s.toLine, { color: colors.textTertiary }]} numberOfLines={1}>
              {t('reader.to')} {m.to}
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
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReply?.(m)}>
              <IconReply size={14} color={colors.primary} style={{ marginRight: 4 }} />
              <Text style={[s.msgActionText, { color: colors.primary }]}>{t('reader.reply')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onReplyAll?.(m)}>
              <IconReplyAll size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={[s.msgActionText, { color: colors.textSecondary }]}>{t('reader.replyAll')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.msgActionBtn, { backgroundColor: colors.surfaceVariant }]} onPress={() => onForward?.(m)}>
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
    marginRight: Spacing.md,
  },
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
