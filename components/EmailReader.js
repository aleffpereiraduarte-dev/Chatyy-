import { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, ActivityIndicator, Image, Animated, Easing, LayoutAnimation, UIManager, TextInput } from 'react-native';
// DOMPurify is web-only — lazy load to avoid crash on native
let DOMPurify = null;
if (Platform.OS === 'web') {
  try { DOMPurify = require('dompurify'); } catch (e) {}
}

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow, haptic } from '../constants/theme';
import { Colors } from '../constants/theme';
import SmartReplyChips from './SmartReplyChips';
import LabelPicker, { LabelChip } from './LabelPicker';
import AvatarCircle from './AvatarCircle';
import AttachmentPreviewModal from './AttachmentPreviewModal';
import AIEmailSummary from './AIEmailSummary';
import AIPhishingBanner from './AIPhishingBanner';
import { getAttachmentUrl, getExportUrl, blockSender, muteThread, sendEmail, translate as apiTranslate } from '../services/api';
import {
  IconStar, IconStarFilled, IconX, IconSparkles, IconReply, IconReplyAll,
  IconForward, IconTrash, IconPaperclip, IconFileText, IconBarChart,
  IconImage, IconPackage, IconMusic, IconFilm, IconDownload, IconTag, IconAlertTriangle,
  IconShield, IconArchive, IconPrint, IconChevronDown, IconChevronUp, IconEye, IconSend, IconMarkUnread, IconGlobe, IconCalendar,
} from './Icons';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// Sanitize HTML to prevent XSS
// Force all links to open in new tab and constrain wide elements
if (Platform.OS === 'web' && DOMPurify?.addHook) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    // Constrain tables and images to container width
    if (node.tagName === 'TABLE') {
      const s = node.style;
      s.maxWidth = '100%';
      s.overflowX = 'auto';
      s.display = 'block';
      s.wordBreak = 'break-word';
    }
    if (node.tagName === 'IMG') {
      node.style.maxWidth = '100%';
      node.style.height = 'auto';
    }
  });
}

const sanitizeHtml = (html) => {
  if (!html) return html;
  if (Platform.OS === 'web') {
    return DOMPurify?.sanitize ? DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'a', 'img', 'b', 'i', 'u', 'strong', 'em',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'sup', 'sub', 'small', 'font',
        'center'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'class', 'width', 'height',
        'target', 'color', 'size', 'face', 'align', 'valign', 'bgcolor', 'border',
        'cellpadding', 'cellspacing', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['style', 'svg', 'math'],
    }) : html;
  }
  // Mobile: strip dangerous tags and event handlers (DOMPurify requires browser DOM)
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<embed[\s\S]*?\/?>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<math[\s\S]*?<\/math>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=[^\s>]*/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '');
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

function formatEmailDate(dateStr) {
  if (!dateStr) return '';
  let d;
  // Handle ISO 8601 format (2026-03-22T16:00:00Z) - returned as UTC, auto-converts to local
  if (dateStr.includes('T') || dateStr.endsWith('Z')) {
    d = new Date(dateStr);
  } else {
    // Legacy: Parse d/m/Y H:i format from old API responses
    const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      // Treat as UTC since server runs in UTC
      d = new Date(Date.UTC(+match[3], +match[2] - 1, +match[1], +match[4], +match[5]));
    } else {
      // Fallback: append Z to treat ambiguous dates as UTC
      const str = dateStr.includes('+') || dateStr.endsWith('Z') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
      d = new Date(str);
    }
  }
  if (isNaN(d.getTime())) return dateStr;
  // toLocaleString auto-converts UTC to user's local timezone
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function getAttachIconComponent(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return ATTACH_ICON_MAP[ext] || IconPaperclip;
}

export default function EmailReader({ email, onReply, onReplyAll, onForward, onDelete, onClose, onStar, onAddLabel, onRemoveLabel, folder, onReportSpam, onReportHam, onScrollProgress, onMarkUnread }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const [previewAttach, setPreviewAttach] = useState({ visible: false, index: 0 });
  const [inlineReplyExpanded, setInlineReplyExpanded] = useState(false);
  const [inlineReplyText, setInlineReplyText] = useState('');
  const [inlineReplySending, setInlineReplySending] = useState(false);
  const [translatedHtml, setTranslatedHtml] = useState('');
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [webViewHeight, setWebViewHeight] = useState(300);
  const bodyRef = useRef(null);
  const translateUidRef = useRef(null);

  // ─── AI Action Items modal state ───
  const [actionItems, setActionItems] = useState(null);
  const [actionItemsLoading, setActionItemsLoading] = useState(false);

  // ─── AI Smart Actions (boleto, tracking, meeting) ───
  const [smartActions, setSmartActions] = useState(null); // {boleto, tracking, meeting}
  const smartActionsForUidRef = useRef(null);
  useEffect(() => {
    if (!email || !email.uid) return;
    if (smartActionsForUidRef.current === email.uid) return;
    smartActionsForUidRef.current = email.uid;
    setSmartActions(null);
    const bodyText = (email.body_text || email.body_html?.replace(/<[^>]+>/g, ' ') || email.body || '').slice(0, 4000);
    const subject = email.subject || '';
    if (!bodyText || bodyText.length < 20) return;
    (async () => {
      try {
        const api = require('../services/api');
        const [boleto, tracking, meeting] = await Promise.all([
          api.aiDetectBoleto(bodyText).catch(() => null),
          api.aiDetectTracking(bodyText, subject).catch(() => null),
          api.aiDetectMeeting(`${subject}\n\n${bodyText}`).catch(() => null),
        ]);
        // Only update if still on same email
        if (smartActionsForUidRef.current !== email.uid) return;
        const result = {
          boleto: boleto?.data?.is_bill ? boleto.data : null,
          tracking: tracking?.data?.has_tracking ? tracking.data : null,
          meeting: meeting?.data?.has_meeting ? meeting.data : null,
        };
        if (result.boleto || result.tracking || result.meeting) {
          setSmartActions(result);
        }
      } catch {}
    })();
  }, [email?.uid]);

  // Intercept link clicks in HTML email body (web) — open in new tab instead of navigating away
  const quotedRef = useRef(null);
  const translatedRef = useRef(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const refs = [bodyRef, quotedRef, translatedRef];
    const cleanups = [];
    const handler = (e) => {
      const link = e.target.closest?.('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      if (href.startsWith('mailto:')) {
        e.preventDefault();
        window.location.href = href;
        return;
      }
      // Ensure target is _blank so the browser opens in a new tab natively
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      // Do NOT call preventDefault — let the browser handle the click natively.
      // This avoids popup-blocker issues that window.open() can trigger.
    };
    refs.forEach((ref) => {
      const el = ref.current;
      if (!el) return;
      el.addEventListener('click', handler);
      cleanups.push(() => el.removeEventListener('click', handler));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [email?.uid, email?.body_html, showQuoted, showTranslation]);

  // Reset per-email state when switching emails
  useEffect(() => {
    setBlocked(false);
    setMuted(false);
    setInlineReplyExpanded(false);
    setInlineReplyText('');
    setWebViewHeight(300);
    setShowQuoted(false);
    setTranslatedHtml('');
    setShowTranslation(false);
    setTranslating(false);
  }, [email?.uid]);

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
          useNativeDriver: false,
        }),
        Animated.timing(slideAnim, {
          toValue: 0, duration: 350,
          easing: Easing.out(Easing.exp),
          useNativeDriver: false,
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
    if (email.body_html && Platform.OS === 'web') {
      const { main, quoted } = splitQuotedHtml(email.body_html);
      const cleanMain = sanitizeHtml(main);
      const cleanQuoted = sanitizeHtml(quoted);
      return (
        <View>
          <div
            ref={bodyRef}
            style={{
              padding: 0, fontSize: 14, lineHeight: 1.7, color: colors.text,
              wordBreak: 'break-word', overflowWrap: 'break-word',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              maxWidth: '100%', overflowX: 'auto',
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
                accessibilityLabel={showQuoted ? t('reader.hideQuoted') : (t('reader.showQuoted') || 'Show quoted text')}
                accessibilityRole="button"
              >
                <Text style={[s.quotedToggleText, { color: colors.textSecondary }]}>
                  {showQuoted ? t('reader.hideQuoted') : '...'}
                </Text>
                {showQuoted ? <IconChevronUp size={14} color={colors.textSecondary} /> : <IconChevronDown size={14} color={colors.textSecondary} />}
              </TouchableOpacity>
              {showQuoted && (
                <div
                  ref={quotedRef}
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
      const safeBody = sanitizeHtml(email.body_html);
      // Native HTML view from expo-native-toolkit (iOS only).
      // Uses a pre-warmed WKWebView pool so the email body paints on the
      // very first frame instead of waiting ~200ms for WebView init.
      if (Platform.OS === 'ios') {
        try {
          const HtmlView = require('../modules/expo-native-toolkit').HtmlView;
          if (HtmlView) {
            const css = `body{margin:12px;font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.7;color:${colors.text};word-break:break-word;background:transparent;overflow-x:hidden}img{max-width:100%;height:auto}a{color:${colors.primary}}pre{white-space:pre-wrap;overflow-x:auto;max-width:100%}table{max-width:100%;overflow-x:auto;display:block;border-collapse:collapse}td,th{max-width:80vw;word-break:break-word}*{box-sizing:border-box}`;
            return (
              <HtmlView
                style={{ width: '100%', height: webViewHeight, backgroundColor: 'transparent' }}
                html={safeBody}
                injectedCss={css}
                openLinksExternally={true}
                onRendered={(e) => {
                  const h = e?.nativeEvent?.contentHeight || 0;
                  if (h > 0) setWebViewHeight(Math.max(100, h + 24));
                }}
              />
            );
          }
        } catch {}
      }
      const WebView = require('react-native-webview').default;
      const heightScript = `
        (function() {
          function postHeight() {
            var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight);
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'height',height:h}));
          }
          postHeight();
          new MutationObserver(postHeight).observe(document.body, {childList:true,subtree:true,attributes:true});
          window.addEventListener('load', function(){ setTimeout(postHeight, 100); setTimeout(postHeight, 500); });
          var imgs = document.querySelectorAll('img');
          for(var i=0;i<imgs.length;i++) imgs[i].addEventListener('load', postHeight);
          // Intercept link clicks and send to React Native
          document.addEventListener('click', function(e) {
            var link = e.target.closest ? e.target.closest('a[href]') : null;
            if (!link) { var el = e.target; while(el && el.tagName !== 'A') el = el.parentElement; link = el; }
            if (!link || !link.getAttribute('href')) return;
            var href = link.getAttribute('href');
            if (href.charAt(0) === '#') return;
            e.preventDefault();
            e.stopPropagation();
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'link',url:href}));
          }, true);
        })();
        true;
      `;
      const htmlDoc = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>body{margin:12px;font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.7;color:${colors.text};word-break:break-word;background:${colors.authCardBg || 'transparent'};overflow-x:hidden}img{max-width:100%;height:auto}a{color:${colors.primary}}pre{white-space:pre-wrap;overflow-x:auto;max-width:100%}table{max-width:100%;overflow-x:auto;display:block;border-collapse:collapse}td,th{max-width:80vw;word-break:break-word}*{box-sizing:border-box}</style></head><body>${safeBody}</body></html>`;
      return (
        <WebView
          originWhitelist={['*']}
          source={{ html: htmlDoc }}
          style={{ height: webViewHeight, backgroundColor: 'transparent' }}
          scalesPageToFit={false}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          injectedJavaScript={heightScript}
          onMessage={(event) => {
            try {
              const msg = JSON.parse(event.nativeEvent.data);
              if (msg.type === 'height' && msg.height > 0) {
                setWebViewHeight(Math.max(100, msg.height + 24));
              } else if (msg.type === 'link' && msg.url) {
                const url = msg.url;
                if (url.startsWith('mailto:')) {
                  import('expo-linking').then(L => L.openURL(url)).catch(() => {});
                } else {
                  import('expo-web-browser').then(B => B.openBrowserAsync(url)).catch(() => {
                    import('expo-linking').then(L => L.openURL(url)).catch(() => {});
                  });
                }
              }
            } catch {}
          }}
          onShouldStartLoadWithRequest={(request) => {
            // Allow initial HTML load
            if (request.url === 'about:blank' || request.url.startsWith('data:')) return true;
            // Open all other links in external browser
            if (request.url.startsWith('mailto:')) {
              import('expo-linking').then(L => L.openURL(request.url)).catch(() => {});
              return false;
            }
            import('expo-web-browser').then(B => B.openBrowserAsync(request.url)).catch(() => {
              import('expo-linking').then(L => L.openURL(request.url)).catch(() => {});
            });
            return false;
          }}
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
              accessibilityLabel={showQuoted ? t('reader.hideQuoted') : (t('reader.showQuoted') || 'Show quoted text')}
              accessibilityRole="button"
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
    <ScrollView
      style={s.container}
      contentContainerStyle={[s.content, Platform.OS !== 'web' && { paddingBottom: 80 + insets.bottom }]}
      scrollEventThrottle={16}
      onScroll={onScrollProgress ? (e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const scrollable = contentSize.height - layoutMeasurement.height;
        if (scrollable > 0) {
          const progress = Math.min(1, Math.max(0, contentOffset.y / scrollable));
          onScrollProgress(progress);
        }
      } : undefined}
    >
      <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
      {/* AI Smart Actions Banner: boleto, tracking, meeting */}
      {smartActions && (
        <View style={{ marginHorizontal: 16, marginTop: 12, gap: 8 }}>
          {smartActions.boleto && (
            <View style={{ backgroundColor: '#fef3c7', borderLeftWidth: 4, borderLeftColor: '#f59e0b', padding: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 24 }}>💰</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: '#92400e', fontSize: 14 }}>
                  Boleto detectado{smartActions.boleto.amount ? ` — R$ ${Number(smartActions.boleto.amount).toFixed(2)}` : ''}
                </Text>
                {smartActions.boleto.due_date && (
                  <Text style={{ fontSize: 12, color: '#92400e' }}>Vence: {smartActions.boleto.due_date}</Text>
                )}
                {smartActions.boleto.payee && (
                  <Text style={{ fontSize: 12, color: '#92400e' }}>{smartActions.boleto.payee}</Text>
                )}
              </View>
              {smartActions.boleto.barcode && (
                <TouchableOpacity onPress={() => {
                  try {
                    if (Platform.OS === 'web') navigator.clipboard?.writeText(smartActions.boleto.barcode);
                    else require('expo-clipboard').setStringAsync(smartActions.boleto.barcode);
                  } catch {}
                }} style={{ backgroundColor: '#f59e0b', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 }}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Copiar codigo</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          {smartActions.tracking && smartActions.tracking.tracking_codes?.length > 0 && (
            <View style={{ backgroundColor: '#dbeafe', borderLeftWidth: 4, borderLeftColor: '#3b82f6', padding: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 24 }}>📦</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: '#1e40af', fontSize: 14 }}>
                  Rastreio {smartActions.tracking.carrier ? `(${smartActions.tracking.carrier})` : ''}
                </Text>
                <Text style={{ fontSize: 12, color: '#1e40af', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                  {smartActions.tracking.tracking_codes[0]}
                </Text>
                {smartActions.tracking.estimated_delivery && (
                  <Text style={{ fontSize: 12, color: '#1e40af' }}>Entrega: {smartActions.tracking.estimated_delivery}</Text>
                )}
              </View>
            </View>
          )}
          {smartActions.meeting && smartActions.meeting.start && (
            <View style={{ backgroundColor: '#dcfce7', borderLeftWidth: 4, borderLeftColor: '#22c55e', padding: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 24 }}>📅</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: '#166534', fontSize: 14 }}>
                  {smartActions.meeting.title || 'Reuniao detectada'}
                </Text>
                <Text style={{ fontSize: 12, color: '#166534' }}>{smartActions.meeting.start}</Text>
                {smartActions.meeting.location && (
                  <Text style={{ fontSize: 12, color: '#166534' }}>{smartActions.meeting.location}</Text>
                )}
              </View>
              <TouchableOpacity onPress={() => {
                try {
                  router.push({
                    pathname: '/event-detail',
                    params: {
                      mode: 'create',
                      title: smartActions.meeting.title || 'Reuniao',
                      start: smartActions.meeting.start,
                      end: smartActions.meeting.end || '',
                      location: smartActions.meeting.location || '',
                      description: smartActions.meeting.description || '',
                    },
                  });
                } catch {}
              }} style={{ backgroundColor: '#22c55e', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Adicionar</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Header row */}
      <View style={s.headerRow}>
        <Text style={[s.subject, { color: colors.text }]} numberOfLines={3}>
          {email.subject || t('reader.noSubject')}
        </Text>
        <View style={s.headerActions}>
          <TouchableOpacity onPress={() => { haptic.light(); onStar?.(email); }} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={email.flagged ? 'Remove star' : 'Add star'} accessibilityRole="button">
            {email.flagged ? (
              <IconStarFilled size={22} color={colors.starColor} />
            ) : (
              <IconStar size={22} color={colors.starEmpty} />
            )}
          </TouchableOpacity>
          {onClose && (
            <TouchableOpacity onPress={onClose} style={s.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Close" accessibilityRole="button">
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Sender info — with profile photo, shadow, and verified-style layout */}
      <View style={s.senderRow}>
        <View style={{ marginRight: Spacing.md + 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 3 }}>
          <AvatarCircle name={email.from_name || email.from} email={email.from} size={50} />
        </View>
        <View style={s.senderInfo}>
          <View style={s.senderNameRow}>
            <Text style={[s.senderName, { color: colors.text }]} numberOfLines={1}>{email.from_name || email.from}</Text>
          </View>
          <Text style={[s.senderEmail, { color: colors.textTertiary }]} numberOfLines={1}>{email.from}</Text>
        </View>
        <Text style={[s.dateText, { color: colors.textTertiary }]}>{formatEmailDate(email.date)}</Text>
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
        {(email.labels || []).map((label, i) => {
          const lblKey = (typeof label === 'object' && label !== null) ? (label.name || `l${i}`) : String(label || `l${i}`);
          return <LabelChip key={lblKey + i} label={label} />;
        })}
        <TouchableOpacity
          style={[s.addLabelBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={() => setShowLabelPicker(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={t('reader.addLabel') || 'Add label'}
          accessibilityRole="button"
        >
          <IconTag size={14} color={colors.textSecondary} />
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: 4, fontWeight: '500' }}>
            {t('reader.addLabel') || 'Label'}
          </Text>
        </TouchableOpacity>
      </View>

      <LabelPicker
        visible={showLabelPicker}
        onClose={() => setShowLabelPicker(false)}
        currentLabels={(email.labels || []).map(l => (typeof l === 'object' && l !== null) ? (l.name || '') : String(l || '')).filter(Boolean)}
        onToggleLabel={(label) => {
          const names = (email.labels || []).map(l => (typeof l === 'object' && l !== null) ? (l.name || '') : String(l || ''));
          if (names.includes(label)) {
            onRemoveLabel?.(email.uid, label);
          } else {
            onAddLabel?.(email.uid, label);
          }
        }}
      />

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
            accessibilityLabel={t('reader.notSpam')}
            accessibilityRole="button"
          >
            <Text style={[s.spamBtnText, { color: colors.text }]}>{t('reader.notSpam')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Phishing check — only on received emails, silent until suspicious */}
      {folder !== 'Sent' && folder !== 'Drafts' && !(user?.email && email?.from?.toLowerCase() === user.email.toLowerCase()) && (
        <AIPhishingBanner email={email} colors={colors} autoCheck={true} />
      )}

      {/* AI Summary */}
      <AIEmailSummary email={email} colors={colors} t={t} />

      {/* Body */}
      <View style={[s.bodyContainer, { borderTopColor: colors.borderLight }]}>
        {renderBody()}
      </View>

      {/* Translation */}
      {showTranslation && translatedHtml ? (
        <View style={[s.translationContainer, { backgroundColor: colors.primaryLight || (colors.primary + '08'), borderColor: colors.primary + '25' }]}>
          <View style={s.translationHeader}>
            <IconGlobe size={14} color={colors.primary} style={{ marginRight: 6 }} />
            <Text style={[s.translationLabel, { color: colors.primary }]}>{t('reader.translatedText')}</Text>
            <TouchableOpacity onPress={() => setShowTranslation(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconX size={14} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {Platform.OS === 'web' ? (
            <div
              ref={translatedRef}
              style={{
                fontSize: 14, lineHeight: 1.7, color: colors.text,
                wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif',
              }}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(translatedHtml) }}
            />
          ) : (
            <Text style={[s.bodyText, { color: colors.text }]}>{translatedHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}</Text>
          )}
        </View>
      ) : null}

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
                accessibilityLabel={t('meet.joinMeeting')}
                accessibilityRole="button"
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
            {Platform.OS === 'web' && email.attachments.length > 1 && (
              <TouchableOpacity
                style={[s.downloadAllBtn, { backgroundColor: colors.surfaceVariant }]}
                onPress={() => {
                  email.attachments.forEach((a, i) => {
                    const url = getAttachmentUrl(email.uid, folder || 'INBOX', a.part || (i + 1));
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = a.filename || `anexo_${i + 1}`;
                    link.target = '_blank';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                  });
                }}
                accessibilityLabel="Download all attachments"
                accessibilityRole="button"
              >
                <IconDownload size={13} color={colors.primary} style={{ marginRight: 4 }} />
                <Text style={[s.downloadAllText, { color: colors.primary }]}>{t('reader.downloadAll')}</Text>
              </TouchableOpacity>
            )}
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
                  accessibilityLabel={`${t('reader.openAttachment') || 'Open'} ${a.filename || `attachment ${i + 1}`}`}
                  accessibilityRole="button"
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
                  <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); handleDownload(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel={`Download ${a.filename || 'attachment'}`} accessibilityRole="button">
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
            <View style={s.inlineReplyCollapsed}>
              <AvatarCircle name={user?.name || user?.email || ''} email={user?.email} size={32} />
              <TouchableOpacity
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setInlineReplyExpanded(true);
                }}
                activeOpacity={0.7}
                style={{ flex: 1, marginLeft: Spacing.md, paddingVertical: 6 }}
                accessibilityLabel={t('reader.inlineReplyPlaceholder')}
                accessibilityRole="button"
              >
                <Text style={[s.inlineReplyPlaceholder, { color: colors.textTertiary }]}>
                  {t('reader.inlineReplyPlaceholder')}
                </Text>
              </TouchableOpacity>
              {/* Quick-action pills: Reply / Reply All / Forward. Tap goes
                  straight to the full composer — faster than expanding inline. */}
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity
                  onPress={() => { haptic.light(); onReply?.(email); }}
                  style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary + '18', alignItems: 'center', justifyContent: 'center' }}
                  accessibilityLabel={t('reader.reply')}
                >
                  <IconReply size={17} color={colors.primary} />
                </TouchableOpacity>
                {onReplyAll && (
                  <TouchableOpacity
                    onPress={() => { haptic.light(); onReplyAll?.(email); }}
                    style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary + '12', alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel={t('reader.replyAll')}
                  >
                    <IconReplyAll size={17} color={colors.primary} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => { haptic.light(); onForward?.(); }}
                  style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}
                  accessibilityLabel={t('reader.forward')}
                >
                  <IconForward size={17} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
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
                  accessibilityLabel={t('reader.send')}
                  accessibilityRole="button"
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
                  accessibilityLabel={t('reader.expand')}
                  accessibilityRole="button"
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
                  accessibilityLabel={t('reader.discard')}
                  accessibilityRole="button"
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
          onPress={() => { haptic.light(); onReply?.(email); }}
          accessibilityLabel={t('reader.reply')}
          accessibilityRole="button"
        >
          <IconReply size={16} color="#fff" style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: '#fff' }]}>{t('reader.reply')}</Text>
        </TouchableOpacity>
        {onReplyAll && (
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '25' }]}
            onPress={() => { haptic.light(); onReplyAll?.(email); }}
            accessibilityLabel={t('reader.replyAll')}
            accessibilityRole="button"
          >
            <IconReplyAll size={16} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.actionText, { color: colors.primary }]}>{t('reader.replyAll')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.surfaceVariant, borderColor: 'transparent' }]}
          onPress={() => { haptic.light(); onForward?.(); }}
          accessibilityLabel={t('reader.forward')}
          accessibilityRole="button"
        >
          <IconForward size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.text }]}>{t('reader.forward')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: '#f59e0b12', borderColor: '#f59e0b25' }]}
          onPress={() => onReportSpam?.(email)}
          accessibilityLabel={t('reader.spam')}
          accessibilityRole="button"
        >
          <IconAlertTriangle size={16} color="#f59e0b" style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: '#f59e0b' }]}>{t('reader.spam')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: showTranslation ? colors.primary + '18' : colors.surfaceVariant, borderColor: showTranslation ? colors.primary + '30' : 'transparent' }]}
          onPress={async () => {
            if (showTranslation) {
              setShowTranslation(false);
              return;
            }
            if (translatedHtml) {
              setShowTranslation(true);
              return;
            }
            setTranslating(true);
            const currentUid = email.uid || email.id;
            translateUidRef.current = currentUid;
            try {
              const bodyText = email.body_html || email.body_text || email.body || '';
              const r = await apiTranslate(bodyText, 'pt-BR');
              if (translateUidRef.current !== currentUid) return; // stale response — email changed
              if (r.success && (r.data?.translation || r.data?.translated)) {
                setTranslatedHtml(r.data.translation || r.data.translated);
                setShowTranslation(true);
              }
            } catch {} finally {
              setTranslating(false);
            }
          }}
          accessibilityLabel={t('reader.translate')}
          accessibilityRole="button"
          disabled={translating}
        >
          {translating ? (
            <ActivityIndicator size={14} color={colors.primary} style={{ marginRight: 8 }} />
          ) : (
            <IconGlobe size={16} color={showTranslation ? colors.primary : colors.textSecondary} style={{ marginRight: 8 }} />
          )}
          <Text style={[s.actionText, { color: showTranslation ? colors.primary : colors.text }]}>{t('reader.translate')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.error + '10', borderColor: colors.error + '20' }]}
          onPress={() => { haptic.warning(); onDelete?.(); }}
          accessibilityLabel={t('reader.delete')}
          accessibilityRole="button"
        >
          <IconTrash size={16} color={colors.error} style={{ marginRight: 8 }} />
          <Text style={[s.actionText, { color: colors.error }]}>{t('reader.delete')}</Text>
        </TouchableOpacity>
      </View>

      {/* Secondary actions: Print, Show Original, Block, Mute, Export */}
      <View style={s.secondaryActions}>
        {/* AI: Action items button (only for long emails) */}
        {(email.body_text || '').length > 300 && (
          <TouchableOpacity
            style={[s.secBtn, { backgroundColor: '#a78bfa22', borderWidth: 1, borderColor: '#a78bfa' }]}
            onPress={async () => {
              setActionItemsLoading(true);
              try {
                const api = require('../services/api');
                const r = await api.aiActionItems(email.body_text || email.body_html?.replace(/<[^>]+>/g, ' ') || '');
                setActionItems(r?.data?.action_items || []);
              } catch {} finally { setActionItemsLoading(false); }
            }}
          >
            <Text style={{ color: '#7C3AED', fontWeight: '600', fontSize: 12 }}>
              {actionItemsLoading ? '...' : '✨ Tarefas'}
            </Text>
          </TouchableOpacity>
        )}
        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
            onPress={handlePrint}
            accessibilityLabel={t('reader.print')}
            accessibilityRole="button"
          >
            <IconPrint size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.secBtnText, { color: colors.textSecondary }]}>{t('reader.print')}</Text>
          </TouchableOpacity>
        )}
        {onMarkUnread && (
          <TouchableOpacity
            style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
            onPress={() => { onMarkUnread(email); onClose?.(); }}
            accessibilityLabel={t('contextMenu.markUnread')}
            accessibilityRole="button"
          >
            <IconMarkUnread size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[s.secBtnText, { color: colors.textSecondary }]}>{t('contextMenu.markUnread')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={async () => {
            const r = await blockSender(email.from);
            if (r.success) setBlocked(true);
          }}
          accessibilityLabel={blocked ? t('reader.blocked') : t('reader.block')}
          accessibilityRole="button"
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
          accessibilityLabel={muted ? t('reader.muted') : t('reader.mute')}
          accessibilityRole="button"
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
          accessibilityLabel={t('reader.export')}
          accessibilityRole="button"
        >
          <IconDownload size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: colors.textSecondary }]}>{t('reader.export')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.secBtn, { backgroundColor: colors.surfaceVariant }]}
          onPress={() => {
            const title = encodeURIComponent(email.subject || '');
            router.push(`/calendar?newEvent=true&title=${title}`);
          }}
          accessibilityLabel={t('reader.createEvent')}
          accessibilityRole="button"
        >
          <IconCalendar size={14} color={colors.primary} style={{ marginRight: 6 }} />
          <Text style={[s.secBtnText, { color: colors.primary }]}>{t('reader.createEvent')}</Text>
        </TouchableOpacity>
      </View>

      {/* AI Action Items Modal */}
      {actionItems && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.6)', justifyContent:'center', alignItems:'center', padding:20, zIndex:99999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:20, maxWidth:500, width:'100%', maxHeight:'80%' }}>
            <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <Text style={{ fontSize:18, fontWeight:'700', color:colors.text }}>✨ Tarefas extraidas</Text>
              <TouchableOpacity onPress={() => setActionItems(null)}><Text style={{ fontSize:24, color:colors.textSecondary }}>×</Text></TouchableOpacity>
            </View>
            {actionItems.length === 0 ? (
              <Text style={{ color:colors.textSecondary, padding:12 }}>Nenhuma tarefa identificada nesse email.</Text>
            ) : (
              <ScrollView style={{ maxHeight:400 }}>
                {actionItems.map((item, i) => (
                  <View key={i} style={{ padding:12, borderRadius:8, backgroundColor:colors.background, marginBottom:8 }}>
                    <Text style={{ color:colors.text, fontSize:14, fontWeight:'600', marginBottom:4 }}>{item.task}</Text>
                    <View style={{ flexDirection:'row', flexWrap:'wrap', gap:8 }}>
                      {item.owner && <Text style={{ fontSize:11, color:colors.textSecondary }}>👤 {item.owner}</Text>}
                      {item.deadline && <Text style={{ fontSize:11, color:colors.textSecondary }}>📅 {item.deadline}</Text>}
                      {item.priority && (
                        <View style={{ backgroundColor: item.priority==='high'?'#fee2e2':(item.priority==='medium'?'#fef3c7':'#e0f2fe'), paddingHorizontal:6, borderRadius:4 }}>
                          <Text style={{ fontSize:10, color: item.priority==='high'?'#991b1b':(item.priority==='medium'?'#92400e':'#0369a1'), fontWeight:'600' }}>{item.priority}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}
      </Animated.View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xxl + 4, paddingBottom: 48 },
  // Header
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.xl + 4 },
  subject: { flex: 1, fontSize: 26, fontWeight: '800', lineHeight: 34, letterSpacing: -0.8 },
  headerActions: { flexDirection: 'row', marginLeft: Spacing.sm, gap: 4 },
  headerBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.15s ease', cursor: 'pointer' } : {}),
  },
  // Sender
  senderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md + 2 },
  senderAvatar: {
    width: 50, height: 50, borderRadius: 25,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md + 2,
  },
  senderAvatarText: { color: '#fff', fontSize: 21, fontWeight: '800' },
  senderInfo: { flex: 1 },
  senderNameRow: { flexDirection: 'row', alignItems: 'center' },
  senderName: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  senderEmail: { fontSize: 12.5, marginTop: 2, opacity: 0.6, fontWeight: '500' },
  dateText: { fontSize: 12.5, opacity: 0.55, fontWeight: '600', letterSpacing: 0.1 },
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
  bodyContainer: { marginTop: Spacing.lg, paddingTop: Spacing.xl + 4, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 200 },
  bodyText: { fontSize: 16, lineHeight: 28, letterSpacing: -0.05 },
  // Attachments
  attachments: { marginTop: Spacing.xxl, paddingTop: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
  attachTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  attachTitle: { fontSize: FontSize.md, fontWeight: '600', flex: 1 },
  downloadAllBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  downloadAllText: { fontSize: FontSize.xs, fontWeight: '600' },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  attachItem: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 16, padding: Spacing.md, borderWidth: 1, minWidth: 200,
    ...Platform.select({
      web: { transition: 'all 0.18s ease, transform 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  attachThumb: {
    width: 48, height: 48, borderRadius: 12, marginRight: Spacing.sm,
  },
  attachInfo: { flex: 1 },
  attachName: { fontSize: FontSize.md, fontWeight: '500' },
  attachSize: { fontSize: FontSize.xs, marginTop: 2, opacity: 0.6 },
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
    borderRadius: 24, paddingVertical: 11, paddingHorizontal: Spacing.xl,
    borderWidth: 1.5, borderColor: 'transparent',
    ...Platform.select({
      web: { transition: 'all 0.18s ease, transform 0.12s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  actionBtnPrimary: {
    ...Platform.select({
      web: { boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)', background: 'linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)' },
      default: {},
    }),
  },
  actionText: { fontSize: FontSize.base, fontWeight: '700', letterSpacing: 0.1 },
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
    paddingHorizontal: Spacing.md, paddingVertical: 9,
    borderRadius: 20,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  secBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  // Translation
  translationContainer: {
    marginTop: Spacing.lg, padding: Spacing.lg, borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  translationHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md,
  },
  translationLabel: { fontSize: FontSize.sm, fontWeight: '600', flex: 1 },
  // Quoted text toggle
  quotedToggle: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md, paddingVertical: 4,
    borderRadius: BorderRadius.md, gap: 4,
  },
  quotedToggleText: { fontSize: FontSize.sm, fontWeight: '500' },
  // Inline Reply
  inlineReplyContainer: {
    marginTop: Spacing.xl, borderWidth: 1, borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
    ...Platform.select({
      web: { transition: 'border-color 0.2s ease' },
      default: {},
    }),
  },
  inlineReplyCollapsed: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: 10, gap: 0,
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
