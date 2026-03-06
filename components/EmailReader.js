import { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, ActivityIndicator, Image, Animated, Easing, LayoutAnimation, UIManager, TextInput } from 'react-native';
import DOMPurify from 'dompurify';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { Colors } from '../constants/theme';
import SmartReplyChips from './SmartReplyChips';
import LabelPicker, { LabelChip } from './LabelPicker';
import AttachmentPreviewModal from './AttachmentPreviewModal';
import AIEmailSummary from './AIEmailSummary';
import AIPhishingBanner from './AIPhishingBanner';
import { getAttachmentUrl, getExportUrl, blockSender, muteThread, sendEmail } from '../services/api';
import {
  IconStar, IconStarFilled, IconX, IconSparkles, IconReply, IconReplyAll,
  IconForward, IconTrash, IconPaperclip, IconFileText, IconBarChart,
  IconImage, IconPackage, IconMusic, IconFilm, IconDownload, IconTag, IconAlertTriangle,
  IconShield, IconArchive, IconPrint, IconChevronDown, IconChevronUp, IconEye, IconSend,
} from './Icons';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// Sanitize HTML to prevent XSS
const sanitizeHtml = (html) => {
  if (!html) return html;
  if (Platform.OS === 'web') {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'a', 'img', 'b', 'i', 'u', 'strong', 'em',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'sup', 'sub', 'small', 'font',
        'center', 'style'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'class', 'width', 'height',
        'target', 'color', 'size', 'face', 'align', 'valign', 'bgcolor', 'border',
        'cellpadding', 'cellspacing', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target'],
    });
  }
  // Mobile: strip dangerous tags and event handlers (DOMPurify requires browser DOM)
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<embed[\s\S]*?\/?>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, '');
};
const MEET_LINK_RE = /https?:\/\/(meet\.jit\.si|meet\.onemundo\.com\.br|mail\.onemundo\.com\.br\/meet)\/[\w-]+/g;
const ONEMUNDO_MEET_RE = /https?:\/\/mail\.onemundo\.com\.br\/meet\/([\w-]+)/;

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Colors.avatarColors[Math.abs(hash) % Colors.avatarColors.length];
}

const ATTACH_ICON_MAP = {
  pdf: IconFileText, doc: IconFileText, docx: IconFileText,
  xls: IconBarChart, xlsx: IconBarChart, csv: IconBarChart,
  png: IconImage, jpg: IconImage, jpeg: IconImage, gif: IconImage,
  zip: IconPackage, rar: IconPackage,
  mp3: IconMusic, wav: IconMusic,
  mp4: IconFilm, avi: IconFilm,
};

function getAttachIconComponent(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return ATTACH_ICON_MAP[ext] || IconPaperclip;
}

export default function EmailReader({ email, onReply, onReplyAll, onForward, onDelete, onClose, onStar, onAddLabel, onRemoveLabel, folder, onReportSpam, onReportHam }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [previewAttach, setPreviewAttach] = useState({ visible: false, index: 0 });
  const [inlineReplyExpanded, setInlineReplyExpanded] = useState(false);
  const [inlineReplyText, setInlineReplyText] = useState('');
  const [inlineReplySending, setInlineReplySending] = useState(false);

  // Smooth entry animation for email content
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(12)).current;
  useEffect(() => {
    if (email) {
      const nd = Platform.OS !== 'web';
      fadeAnim.setValue(0);
      slideAnim.setValue(12);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1, duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: nd,
        }),
        Animated.timing(slideAnim, {
          toValue: 0, duration: 350,
          easing: Easing.out(Easing.exp),
          useNativeDriver: nd,
        }),
      ]).start();
    }
  }, [email?.uid]);

  if (!email) return null;

  const avatarColor = getAvatarColor(email.from_name || email.from || 'unknown');

  // Split quoted text from body
  const splitQuoted = (text) => {
    if (!text) return { main: '', quoted: '' };
    const markers = ['--- Mensagem original ---', '---------- Forwarded message', 'Em ', 'On '];
    const lines = text.split('\n');
    let splitIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('>') && i > 2) { splitIdx = i; break; }
      if (markers.some(m => line.startsWith(m)) && i > 2) { splitIdx = i; break; }
    }
    if (splitIdx === -1) return { main: text, quoted: '' };
    return { main: lines.slice(0, splitIdx).join('\n'), quoted: lines.slice(splitIdx).join('\n') };
  };

  const splitQuotedHtml = (html) => {
    if (!html) return { main: '', quoted: '' };
    const markers = ['<blockquote', 'class="gmail_quote"', '--- Mensagem original ---', '---------- Forwarded message'];
    for (const m of markers) {
      const idx = html.indexOf(m);
      if (idx > 50) return { main: html.substring(0, idx), quoted: html.substring(idx) };
    }
    return { main: html, quoted: '' };
  };

  const handlePrint = () => {
    if (Platform.OS !== 'web') return;
    const esc = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const printWin = window.open('', '_blank');
    if (!printWin) return;
    printWin.document.write(`<!DOCTYPE html><html><head><title>${esc(email.subject || 'Email')}</title>
      <style>body{font-family:-apple-system,system-ui,sans-serif;padding:40px;max-width:800px;margin:0 auto}
      .header{border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:16px}
      .from{font-weight:600;font-size:16px}.meta{color:#666;font-size:13px;margin-top:4px}
      .body{font-size:14px;line-height:1.7}img{max-width:100%}
      @media print{body{padding:20px}}</style></head><body>
      <div class="header"><div class="from">${esc(email.from_name || email.from)}</div>
      <div class="meta">Para: ${esc(email.to || '')}</div>
      <div class="meta">${esc(email.date || '')}</div>
      <div style="font-size:18px;margin-top:12px">${esc(email.subject || t('reader.noSubject'))}</div></div>
      <div class="body">${sanitizeHtml(email.body_html) || esc(email.body_text || email.body || '').replace(/\n/g, '<br>')}</div>
      </body></html>`);
    printWin.document.close();
    setTimeout(() => { printWin.print(); }, 300);
  };

  const renderBody = () => {
    if (showOriginal) {
      const raw = email.body_html || email.body_text || email.body || '';
      return (
        <View>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, fontFamily: 'monospace', color: colors.textSecondary, background: colors.surfaceVariant, padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: 500 }}>
            {raw}
          </pre>
        </View>
      );
    }

    if (email.body_html && Platform.OS === 'web') {
      const { main, quoted } = splitQuotedHtml(email.body_html);
      const cleanMain = sanitizeHtml(main);
      const cleanQuoted = sanitizeHtml(quoted);
      return (
        <View>
          <div
            style={{
              padding: 0, fontSize: 14, lineHeight: 1.7, color: colors.text,
              wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
            dangerouslySetInnerHTML={{ __html: cleanMain }}
          />
          {!!quoted && (
            <View style={{ marginTop: Spacing.md }}>
              <TouchableOpacity
                style={[s.quotedToggle, { backgroundColor: colors.surfaceVariant }]}
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setShowQuoted(!showQuoted);
                }}
              >
                <Text style={[s.quotedToggleText, { color: colors.textSecondary }]}>
                  {showQuoted ? t('reader.hideQuoted') : '...'}
                </Text>
                {showQuoted ? <IconChevronUp size={14} color={colors.textSecondary} /> : <IconChevronDown size={14} color={colors.textSecondary} />}
              </TouchableOpacity>
              {showQuoted && (
                <div
                  style={{
                    padding: 12, fontSize: 13, lineHeight: 1.6, color: colors.textSecondary,
                    wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
                    borderLeft: `3px solid ${colors.borderLight}`, marginTop: 8, paddingLeft: 12,
                  }}
                  dangerouslySetInnerHTML={{ __html: cleanQuoted }}
                />
              )}
            </View>
          )}
        </View>
      );
    }
    if (email.body_html && Platform.OS !== 'web') {
      const WebView = require('react-native-webview').default;
      const safeBody = sanitizeHtml(email.body_html);
      const htmlDoc = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>body{margin:12px;font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.7;color:${colors.text};word-break:break-word;background:${colors.authCardBg}}img{max-width:100%;height:auto}a{color:${colors.primary}}</style></head><body>${safeBody}</body></html>`;
      return (
        <WebView
          originWhitelist={['*']}
          source={{ html: htmlDoc }}
          style={{ flex: 1, minHeight: 300, backgroundColor: 'transparent' }}
          scalesPageToFit={false}
          scrollEnabled={false}
          onMessage={() => {}}
        />
      );
    }
    // Plain text with quoted collapse
    const text = email.body_text || email.body || t('reader.noContent');
    const { main, quoted } = splitQuoted(text);
    return (
      <View>
        <Text style={[s.bodyText, { color: colors.text }]}>{main}</Text>
        {!!quoted && (
          <View style={{ marginTop: Spacing.md }}>
            <TouchableOpacity
              style={[s.quotedToggle, { backgroundColor: colors.surfaceVariant }]}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowQuoted(!showQuoted);
              }}
            >
              <Text style={[s.quotedToggleText, { color: colors.textSecondary }]}>
                {showQuoted ? t('reader.hideQuoted') : '...'}
              </Text>
            </TouchableOpacity>
            {showQuoted && (
              <Text style={[s.bodyText, { color: colors.textSecondary, marginTop: 8, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: colors.borderLight }]}>{quoted}</Text>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={[s.content, Platform.OS !== 'web' && { paddingBottom: 80 + insets.bottom }]}>
      <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
      {/* Spam warning banner */}
      {(folder === 'Junk' || folder === 'Spam' || email.spam) && (
        <View style={[s.spamBanner, { backgroundColor: colors.warningBg || '#fef3c7', borderColor: (colors.warning || '#f59e0b') + '30' }]}>
          <IconAlertTriangle size={16} color={colors.warning || '#f59e0b'} />
          <Text style={[s.spamText, { color: colors.warning || '#f59e0b' }]}>
            {t('reader.spamWarning')}
          </Text>
          <TouchableOpacity
            style={[s.spamBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => onReportHam?.(email)}
          >
            <Text style={[s.spamBtnText, { color: colors.text }]}>{t('reader.notSpam')}</Text>
          </TouchableOpacity>
        </View>
      )}

      <AIPhishingBanner email={email} colors={colors} autoCheck={true} />

      {/* Header row */}
      <View style={s.headerRow}>
        <Text style={[s.subject, { color: colors.text }]} numberOfLines={3}>
          {email.subject || t('reader.noSubject')}
        </Text>
        <View style={s.headerActions}>
          <TouchableOpacity onPress={() => onStar?.(email)} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            {email.flagged ? (
              <IconStarFilled size={22} color={colors.starColor} />
            ) : (
              <IconStar size={22} color={colors.starEmpty} />
            )}
          </TouchableOpacity>
          {onClose && (
            <TouchableOpacity onPress={onClose} style={s.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Sender info */}
      <View style={s.senderRow}>
        <View style={[s.senderAvatar, { backgroundColor: avatarColor }]}>
          <Text style={s.senderAvatarText}>
            {(email.from_name || email.from || '?')[0].toUpperCase()}
          </Text>
        </View>
        <View style={s.senderInfo}>
          <View style={s.senderNameRow}>
            <Text style={[s.senderName, { color: colors.text }]}>{email.from_name || email.from}</Text>
          </View>
          <Text style={[s.senderEmail, { color: colors.textTertiary }]}>{email.from}</Text>
        </View>
        <Text style={[s.dateText, { color: colors.textTertiary }]}>{email.date}</Text>
      </View>

      {/* Recipients */}
      <View style={[s.recipientRow, { borderBottomColor: colors.borderLight }]}>
        <Text style={[s.recipientLabel, { color: colors.textTertiary }]}>{t('reader.to') + ' '}</Text>
        <Text style={[s.recipientText, { color: colors.textSecondary }]} numberOfLines={1}>{email.to}</Text>
      </View>
      {email.cc ? (
        <View style={[s.recipientRow, { borderBottomColor: colors.borderLight }]}>
          <Text style={[s.recipientLabel, { color: colors.textTertiary }]}>{t('reader.cc') + ' '}</Text>
          <Text style={[s.recipientText, { color: colors.textSecondary }]} numberOfLines={1}>{email.cc}</Text>
        </View>
      ) : null}

      {/* Labels */}
      <View style={s.labelsRow}>
        {(email.labels || []).map(label => (
          <LabelChip key={label} label={label} />
        ))}
        <TouchableOpacity
          style={[s.addLabelBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={() => setShowLabelPicker(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconTag size={14} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <LabelPicker
        visible={showLabelPicker}
        onClose={() => setShowLabelPicker(false)}
        currentLabels={email.labels || []}
        onToggleLabel={(label) => {
          if ((email.labels || []).includes(label)) {
            onRemoveLabel?.(email.uid, label);
          } else {
            onAddLabel?.(email.uid, label);
          }
        }}
      />

      {/* AI Summary */}
      <AIEmailSummary email={email} colors={colors} t={t} />

      {/* Body */}
      <View style={[s.bodyContainer, { borderTopColor: colors.borderLight }]}>
        {renderBody()}
      </View>

      {/* Meet link cards */}
      {(() => {
        const bodyText = email.body_text || email.body_html || email.body || '';
        const meetLinks = [...new Set(bodyText.match(MEET_LINK_RE) || [])];
        if (!meetLinks.length) return null;
        return (
          <View style={s.meetCards}>
            {meetLinks.map((link, i) => (
              <TouchableOpacity
                key={i}
                style={[s.meetCard, { backgroundColor: colors.primaryLight, borderColor: colors.primary + '30' }]}
                onPress={() => {
                  const omMatch = link.match(ONEMUNDO_MEET_RE);
                  if (omMatch) {
                    router.push(`/meet/${omMatch[1]}`);
                  } else if (Platform.OS === 'web') {
                    window.open(link, '_blank');
                  } else {
                    import('expo-linking').then(L => L.openURL(link)).catch(() => {});
                  }
                }}
                activeOpacity={0.7}
              >
                <IconFilm size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.meetCardTitle, { color: colors.primary }]}>{t('meet.joinMeeting')}</Text>
                  <Text style={[s.meetCardUrl, { color: colors.textSecondary }]} numberOfLines={1}>{link}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        );
      })()}

      {/* Attachments */}
      {email.attachments?.length > 0 && (
        <View style={[s.attachments, { borderTopColor: colors.borderLight }]}>
          <View style={s.attachTitleRow}>
            <IconPaperclip size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.attachTitle, { color: colors.textSecondary }]}>
              {email.attachments.length === 1 ? t('reader.attachment', { count: email.attachments.length }) : t('reader.attachments', { count: email.attachments.length })}
            </Text>
          </View>
          <View style={s.attachGrid}>
            {email.attachments.map((a, i) => {
              const AttachIcon = getAttachIconComponent(a.filename);
              const ext = (a.filename || '').split('.').pop().toLowerCase();
              const isImage = IMAGE_EXTS.includes(ext);
              const downloadUrl = getAttachmentUrl(email.uid, folder || 'INBOX', a.part || (i + 1));
              const handleDownload = () => {
                if (Platform.OS === 'web') {
                  const link = document.createElement('a');
                  link.href = downloadUrl;
                  link.download = a.filename || `anexo_${i + 1}`;
                  link.target = '_blank';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                } else {
                  import('expo-linking').then(Linking => {
                    Linking.openURL(downloadUrl);
                  }).catch(() => {});
                }
              };
              return (
                <TouchableOpacity
                  key={i}
                  style={[s.attachItem, { backgroundColor: colors.surfaceVariant, borderColor: colors.borderLight }]}
                  onPress={() => setPreviewAttach({ visible: true, index: i })}
                  activeOpacity={0.7}
                >
                  {isImage ? (
                    <Image
                      source={{ uri: downloadUrl }}
                      style={s.attachThumb}
                      resizeMode="cover"
                    />
                  ) : (
                    <AttachIcon size={24} color={colors.primary} style={{ marginRight: Spacing.sm }} />
                  )}
                  <View style={s.attachInfo}>
                    <Text style={[s.attachName, { color: colors.text }]} numberOfLines={1}>
                      {a.filename || `${t('attachment.file')} ${i + 1}`}
                    </Text>
                    <Text style={[s.attachSize, { color: colors.textTertiary }]}>
                      {a.size ? `${Math.round(a.size / 1024)} KB` : ''}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); handleDownload(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <IconDownload size={16} color={colors.primary} />
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Attachment Preview Modal */}
      <AttachmentPreviewModal
        visible={previewAttach.visible}
        attachments={email.attachments || []}
        initialIndex={previewAttach.index}
        onClose={() => setPreviewAttach({ visible: false, index: 0 })}
        getUrl={(a, i) => getAttachmentUrl(email.uid, folder || 'INBOX', a.part || (i + 1))}
      />

      {/* Smart Reply */}
      <SmartReplyChips email={email} onSelectReply={onReply} />

      {/* Inline Reply Box */}
      {email && (
        <View style={[s.inlineReplyContainer, { borderColor: inlineReplyExpanded ? colors.primary : colors.borderLight, backgroundColor: colors.surface }]}>
          {!inlineReplyExpanded ? (
            <TouchableOpacity
              style={s.inlineReplyCollapsed}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setInlineReplyExpanded(true);
              }}
              activeOpacity={0.7}
            >
              <View style={[s.inlineReplyAvatar, { backgroundColor: getAvatarColor(user?.name || user?.email || '') }]}>
                <Text style={s.inlineReplyAvatarText}>
                  {(user?.name || user?.email || '?')[0].toUpperCase()}
                </Text>
              </View>
              <Text style={[s.inlineReplyPlaceholder, { color: colors.textTertiary }]}>
                {t('reader.inlineReplyPlaceholder')}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={s.inlineReplyExpanded}>
              <View style={[s.inlineReplyToRow, { borderBottomColor: colors.borderLight }]}>
                <Text style={[s.inlineReplyToLabel, { color: colors.textTertiary }]}>Para:</Text>
                <Text style={[s.inlineReplyToEmail, { color: colors.textSecondary }]} numberOfLines={1}>{email.from}</Text>
              </View>
              <TextInput
                style={[s.inlineReplyInput, { color: colors.text, borderColor: colors.borderLight }]}
                placeholder={t('reader.inlineReplyHint')}
                placeholderTextColor={colors.textTertiary}
                multiline
                value={inlineReplyText}
                onChangeText={setInlineReplyText}
                autoFocus
              />
              <View style={s.inlineReplyActions}>
                <TouchableOpacity
                  style={[s.inlineReplySendBtn, { backgroundColor: colors.primary, opacity: (!inlineReplyText.trim() || inlineReplySending) ? 0.5 : 1 }]}
                  onPress={async () => {
                    if (!inlineReplyText.trim() || inlineReplySending) return;
                    setInlineReplySending(true);
                    try {
                      const replySubject = (email.subject || '').startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`;
                      const dateStr = email.date || '';
                      const quotedBody = `\n\n---------- ${t('reader.originalMessage')} ----------\n${t('reader.quotedFrom')}: ${email.from_name || email.from} <${email.from}>\n${t('reader.quotedDate')}: ${dateStr}\n${t('reader.quotedSubject')}: ${email.subject || ''}\n${t('reader.quotedTo')}: ${email.to || ''}\n\n${email.body_text || email.body || ''}`;
                      const fullBody = inlineReplyText + quotedBody;
                      const result = await sendEmail(email.from, replySubject, fullBody, '', '', email.uid, folder || 'INBOX');
                      if (result.success) {
                        setInlineReplyText('');
                        setInlineReplyExpanded(false);
                      } else {
                        if (Platform.OS === 'web') {
                          alert(result.message || t('reader.sendError'));
                        } else {
                          const { Alert: NativeAlert } = require('react-native');
                          NativeAlert.alert(t('common.error'), result.message || t('reader.sendError'));
                        }
                      }
                    } catch (err) {
                      if (Platform.OS === 'web') {
                        alert(t('reader.sendError'));
                      } else {
                        const { Alert: NativeAlert } = require('react-native');
                        NativeAlert.alert(t('common.error'), t('reader.sendError'));
                      }
                    } finally {
                      setInlineReplySending(false);
                    }
                  }}
                  disabled={!inlineReplyText.trim() || inlineReplySending}
                >
                  {inlineReplySending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <IconSend size={14} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={s.inlineReplySendText}>{t('reader.send')}</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.inlineReplySecBtn, { backgroundColor: colors.surfaceVariant }]}
                  onPress={() => {
                    const replySubject = (email.subject || '').startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`;
                    const dateStr = email.date || '';
                    const quotedBody = `\n\n---------- ${t('reader.originalMessage')} ----------\n${t('reader.quotedFrom')}: ${email.from_name || email.from} <${email.from}>\n${t('reader.quotedDate')}: ${dateStr}\n${t('reader.quotedSubject')}: ${email.subject || ''}\n${t('reader.quotedTo')}: ${email.to || ''}\n\n${email.body_text || email.body || ''}`;
                    router.push({
                      pathname: '/compose',
                      params: {
                        to: email.from,
                        subject: replySubject,
                        body: inlineReplyText + quotedBody,
                        replyToUid: email.uid,
                        folder: folder || 'INBOX',
                      },
                    });
                  }}
                >
                  <IconForward size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
                  <Text style={[s.inlineReplySecBtnText, { color: colors.textSecondary }]}>{t('reader.expand')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.inlineReplySecBtn, { backgroundColor: colors.surfaceVariant }]}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setInlineReplyText('');
                    setInlineReplyExpanded(false);
                  }}
                >
                  <IconX size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
                  <Text style={[s.inlineReplySecBtnText, { color: colors.textSecondary }]}>{t('reader.discard')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {/* Action buttons */}
      <View style={[s.actions, { borderTopColor: colors.borderLight }]}>
        <TouchableOpacity
          style={[s.actionBtn, s.actionBtnPrimary, { backgroundColor: colors.primary }]}
          onPress={() => onReply?.(email)}
        >
          <IconReply size={16} color="#fff" style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: '#fff' }]}>{t('reader.reply')}</Text>
        </TouchableOpacity>
        {onReplyAll && (
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '25' }]}
            onPress={() => onReplyAll?.(email)}
          >
            <IconReplyAll size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.actionText, { color: colors.primary }]}>{t('reader.replyAll')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.surfaceVariant, borderColor: 'transparent' }]}
          onPress={onForward}
        >
          <IconForward size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.text }]}>{t('reader.forward')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: '#f59e0b12', borderColor: '#f59e0b25' }]}
          onPress={() => onReportSpam?.(email)}
        >
          <IconAlertTriangle size={16} color="#f59e0b" style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: '#f59e0b' }]}>{t('reader.spam')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.error + '10', borderColor: colors.error + '20' }]}
          onPress={onDelete}
        >
          <IconTrash size={16} color={colors.error} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.error }]}>{t('reader.delete')}</Text>
        </TouchableOpacity>
      </View>

      {/* Secondary actions: Print, Show Original, Block, Mute, Export */}
      <View style={s.secondaryActions}>
        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
            onPress={handlePrint}
          >
            <IconPrint size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.secBtnText, { color: colors.textSecondary }]}>{t('reader.print')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: showOriginal ? colors.primaryLight : colors.surfaceVariant }]}
          onPress={() => setShowOriginal(!showOriginal)}
        >
          <IconEye size={14} color={showOriginal ? colors.primary : colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: showOriginal ? colors.primary : colors.textSecondary }]}>
            {showOriginal ? t('reader.back') : t('reader.original')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={async () => {
            const r = await blockSender(email.from);
            if (r.success) setBlocked(true);
          }}
        >
          <IconShield size={14} color={blocked ? colors.error : colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: blocked ? colors.error : colors.textSecondary }]}>
            {blocked ? t('reader.blocked') : t('reader.block')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={async () => {
            const r = await muteThread(email.uid, folder || 'INBOX');
            if (r.success) setMuted(true);
          }}
        >
          <IconArchive size={14} color={muted ? colors.success : colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: muted ? colors.success : colors.textSecondary }]}>
            {muted ? t('reader.muted') : t('reader.mute')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={() => {
            const url = getExportUrl(email.uid, folder || 'INBOX');
            if (Platform.OS === 'web') {
              const link = document.createElement('a');
              link.href = url;
              link.download = `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_')}.eml`;
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }
          }}
        >
          <IconDownload size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: colors.textSecondary }]}>{t('reader.export')}</Text>
        </TouchableOpacity>
      </View>
      </Animated.View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xxl, paddingBottom: 40 },
  // Header
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.xl },
  subject: { flex: 1, fontSize: 24, fontWeight: '500', lineHeight: 32, letterSpacing: -0.3 },
  headerActions: { flexDirection: 'row', marginLeft: Spacing.sm },
  headerBtn: { padding: Spacing.sm },
  // Sender
  senderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  senderAvatar: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  senderAvatarText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  senderInfo: { flex: 1 },
  senderNameRow: { flexDirection: 'row', alignItems: 'center' },
  senderName: { fontSize: FontSize.xl, fontWeight: '600', letterSpacing: -0.1 },
  senderEmail: { fontSize: FontSize.sm, marginTop: 1 },
  dateText: { fontSize: FontSize.sm },
  // Recipients
  recipientRow: {
    flexDirection: 'row', alignItems: 'center',
    marginLeft: 56, paddingVertical: 4,
  },
  recipientLabel: { fontSize: FontSize.sm },
  recipientText: { fontSize: FontSize.sm, flex: 1 },
  // Labels
  labelsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginLeft: 56, marginTop: Spacing.sm, alignItems: 'center' },
  addLabelBtn: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
  },
  // AI
  aiBtn: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.xxl, marginTop: Spacing.lg, marginBottom: Spacing.sm,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  aiBtnText: { fontSize: FontSize.md, fontWeight: '500' },
  summaryBox: {
    padding: Spacing.lg, borderRadius: BorderRadius.lg,
    borderWidth: 1, marginTop: Spacing.lg, marginBottom: Spacing.sm,
  },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  summaryLabel: { fontSize: FontSize.md, fontWeight: '600' },
  summaryText: { fontSize: FontSize.base, lineHeight: 22 },
  summaryClose: { fontSize: FontSize.sm, marginTop: Spacing.sm },
  // Body
  bodyContainer: { marginTop: Spacing.lg, paddingTop: Spacing.xl, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 200 },
  bodyText: { fontSize: FontSize.base, lineHeight: 24 },
  // Attachments
  attachments: { marginTop: Spacing.xxl, paddingTop: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
  attachTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  attachTitle: { fontSize: FontSize.md, fontWeight: '600' },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  attachItem: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.lg, padding: Spacing.md, borderWidth: 1, minWidth: 200,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  attachThumb: {
    width: 48, height: 48, borderRadius: BorderRadius.md, marginRight: Spacing.sm,
  },
  attachInfo: { flex: 1 },
  attachName: { fontSize: FontSize.md },
  attachSize: { fontSize: FontSize.xs, marginTop: 2 },
  // Meet link cards
  meetCards: { marginTop: Spacing.lg, gap: Spacing.sm },
  meetCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, borderRadius: BorderRadius.lg, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s ease' }, default: {} }),
  },
  meetCardTitle: { fontSize: FontSize.md, fontWeight: '600' },
  meetCardUrl: { fontSize: FontSize.xs, marginTop: 2 },
  // Actions
  actions: {
    flexDirection: 'row', marginTop: Spacing.xxxl, paddingTop: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth, gap: Spacing.sm, flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.xl, paddingVertical: 10, paddingHorizontal: Spacing.xl,
    borderWidth: 1.5, borderColor: 'transparent',
    ...Platform.select({
      web: { transition: 'all 0.2s ease, transform 0.1s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  actionBtnPrimary: {
    ...Platform.select({
      web: { boxShadow: '0 3px 12px rgba(37, 99, 235, 0.3)' },
      default: {},
    }),
  },
  actionText: { fontSize: FontSize.base, fontWeight: '600' },
  // Spam
  spamBanner: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, marginBottom: Spacing.lg, gap: Spacing.sm,
  },
  spamText: { flex: 1, fontSize: FontSize.sm, fontWeight: '500' },
  spamBtn: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  spamBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  // Secondary actions
  secondaryActions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, flexWrap: 'wrap',
  },
  secBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderRadius: BorderRadius.xxl,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  secBtnText: { fontSize: FontSize.sm, fontWeight: '500' },
  // Quoted text toggle
  quotedToggle: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md, paddingVertical: 4,
    borderRadius: BorderRadius.md, gap: 4,
  },
  quotedToggleText: { fontSize: FontSize.sm, fontWeight: '500' },
  // Inline Reply
  inlineReplyContainer: {
    marginTop: Spacing.xl, borderWidth: 1, borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    ...Platform.select({
      web: { transition: 'border-color 0.2s ease' },
      default: {},
    }),
  },
  inlineReplyCollapsed: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    ...Platform.select({
      web: { cursor: 'pointer' },
      default: {},
    }),
  },
  inlineReplyAvatar: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  inlineReplyAvatarText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  inlineReplyPlaceholder: { fontSize: FontSize.base, flex: 1 },
  inlineReplyExpanded: { padding: Spacing.lg },
  inlineReplyToRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingBottom: Spacing.sm, marginBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inlineReplyToLabel: { fontSize: FontSize.sm, fontWeight: '600', marginRight: Spacing.xs },
  inlineReplyToEmail: { fontSize: FontSize.sm, flex: 1 },
  inlineReplyInput: {
    minHeight: 100, fontSize: FontSize.base, lineHeight: 22,
    textAlignVertical: 'top', padding: Spacing.sm,
    borderWidth: 1, borderRadius: BorderRadius.md, marginBottom: Spacing.md,
  },
  inlineReplyActions: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
  },
  inlineReplySendBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: 8,
    borderRadius: BorderRadius.xl,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'opacity 0.15s ease' },
      default: {},
    }),
  },
  inlineReplySendText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  inlineReplySecBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderRadius: BorderRadius.xl,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'all 0.15s ease' },
      default: {},
    }),
  },
  inlineReplySecBtnText: { fontSize: FontSize.sm, fontWeight: '500' },
});
