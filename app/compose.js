import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  Animated, Modal, Pressable, Switch, AppState, useWindowDimensions,
} from 'react-native';
import KeyboardSafeView from '../components/ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
let DOMPurify = null;
if (Platform.OS === 'web') {
  try {
    // dompurify exporta uma factory — sem instanciar com window
    // DOMPurify.sanitize fica undefined e o HTML citado vai sem sanitização (XSS).
    const mod = require('dompurify');
    DOMPurify = (typeof mod === 'function' ? mod(window) : mod);
  } catch (e) {}
}
// Bare-minimum HTML sanitizer for the case where DOMPurify failed to load
// (very rare — bundle splits, broken require). Strips scripts, iframes,
// event handlers, javascript: URLs. Defense in depth so quoted email
// bodies can never run code if the proper sanitizer is missing.
function _safeFallbackSanitize(html) {
  if (!html || typeof html !== 'string') return '';
  // Fixed-point loop (mirrors EmailReader._regexFallbackSanitize): single-pass
  // regex stripping lets nested payloads reconstruct a live tag after the
  // inner match is removed. Re-run until stable; cap 10 → fail closed.
  let out = html;
  for (let i = 0; i < 10; i++) {
    const prev = out;
    out = out
      .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
      .replace(/<\s*(iframe|object|embed|base|meta|link|form|input|textarea|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(iframe|object|embed|base|meta|link|form|input|textarea|style)\b[^>]*\/?>/gi, '')
      // `[\s/]`: `/` is an attribute separator — `<img/onerror=...>` fires.
      .replace(/[\s/]on\w+\s*=\s*"[^"]*"/gi, ' ')
      .replace(/[\s/]on\w+\s*=\s*'[^']*'/gi, ' ')
      .replace(/[\s/]on\w+\s*=\s*[^\s>]*/gi, ' ')
      .replace(/javascript:/gi, '')
      .replace(/vbscript:/gi, '')
      .replace(/data:text\/html/gi, '')
      .replace(/data:application\//gi, '');
    if (out === prev) return out;
  }
  return String(html).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function sanitizeQuotedHtml(html) {
  // Native included: the quoted body lands in the RichTextEditor's
  // contentEditable WebView (JS + bridge live) — returning it raw was a
  // stored-XSS hole identical to the reader's, just in the compose editor.
  if (DOMPurify?.sanitize) return DOMPurify.sanitize(html);
  return _safeFallbackSanitize(html);
}
import { useRouter, useLocalSearchParams } from 'expo-router';
import { HapticsCompat as Haptics } from '../services/haptics'; // [2026-10-16 motion-telegram] shim único (Core Haptics iOS / performHapticFeedback Android)
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sendEmail, getMessage, aliasesList, archiveEmail, emailUrlPreview } from '../services/api';
import { detectSensitive, sensitiveTypeLabel } from '../services/sensitiveDetect'; // [2026-10-09 on-device-privacy]
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import useIsMounted from '../hooks/useIsMounted';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { animateLayout } from '../constants/motion'; // [2026-10-16 motion] Cc/Cco com mola
import AIComposeModal from '../components/AIComposeModal';
import RichTextEditor from '../components/RichTextEditor';
import QuotedHtmlView, { isQuoteHtmlOn } from '../components/email/QuotedHtmlView'; // [2026-10-18 email-quote-html]
import ContactAutocomplete from '../components/ContactAutocomplete';
import AttachmentPicker from '../components/AttachmentPicker';
// [2026-10-08 email-outbox] pre-upload on pick + durable outbox
import { startAttachUpload, cancelAttachUpload, withServerId } from '../services/emailAttachUploads';
import { enqueueEmail, newClientSendId, classifyEmailSend, isEmailDeviceOffline } from '../services/emailOutbox';
import ScheduleSendModal from '../components/ScheduleSendModal';
import TemplatePickerModal from '../components/TemplatePickerModal';
import AISmartCompose from '../components/AISmartCompose';
import {
  IconX, IconSparkles, IconSend, IconCheckCircle,
  IconClock, IconFileText, IconPaperclip, IconFilm,
  IconChevronDown, IconChevronUp, IconArrowLeft, IconArchive,
  IconLock, IconAlertTriangle, IconCheck, IconLink,
} from '../components/Icons';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from '../components/ui/useDragToDismiss';
import {
  isDraftLocalOn, newDraftSid, saveLocalDraft, markLocalDraftSynced, clearLocalDraft, recoverOrphanDrafts,
  DRAFT_IDLE_SYNC_MS, DRAFT_MAX_WAIT_MS,
} from '../services/mailDraftLocal'; // [2026-10-18 email-draft-local]
import { RouteDragDismiss } from '../components/ui/RouteDragDismiss'; // [2026-10-20 tg-modal] arrastar p/ baixo fecha (iOS)
import BiaIcon from '../components/bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

const DRAFT_SAVE_INTERVAL = 5000; // legado (__chatyy_mail_draft_local === false)

// [2026-10-18 email-quote-html] Citação (responder/encaminhar) com HTML de
// verdade: leitura nativa read-only abaixo do editor + blockquote no envio e no
// rascunho (com classes p/ o rascunho reaberto separar a citação de novo).
// Kill switch: globalThis.__chatyy_mail_quote_html = false → texto puro antigo.
function _quoteHtmlOn() {
  try { return globalThis.__chatyy_mail_quote_html !== false; } catch { return true; }
}
function _escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function buildQuotedSendBody(body, quotedHeader, quotedHtml) {
  if (!quotedHtml) return body;
  if (!_quoteHtmlOn()) {
    const qh = quotedHeader
      ? `<p style="color:#5f6368;font-size:13px">${quotedHeader.replace(/\n/g, '<br/>')}</p>`
      : '';
    return body + `<br/><br/>${qh}<blockquote style="border-left:3px solid #dadce0;padding-left:16px;margin:8px 0 0 0;color:#5f6368">${quotedHtml}</blockquote>`;
  }
  // Cabeçalho ESCAPADO: "Fulano <a@b.com>" virava uma tag desconhecida e o
  // endereço sumia da citação.
  const qh = quotedHeader
    ? `<p class="chatyy-quote-h" style="color:#5f6368;font-size:13px">${_escHtml(quotedHeader).replace(/\n/g, '<br/>')}</p>`
    : '';
  return (body || '') + `<br/><br/><div class="chatyy-quote">${qh}<blockquote class="chatyy-quote-b" style="border-left:3px solid #dadce0;padding-left:16px;margin:8px 0 0 0;color:#5f6368">${quotedHtml}</blockquote></div>`;
}
// Rascunho reaberto: separa o que o usuário escreveu da citação (salva por
// buildQuotedSendBody). null = sem citação reconhecível.
function splitQuotedDraft(html) {
  if (!html || typeof html !== 'string' || !_quoteHtmlOn()) return null;
  const m = /<div[^>]*class="[^"]*\bchatyy-quote\b[^"]*"[^>]*>/i.exec(html);
  if (!m) return null;
  const rest = html.slice(m.index + m[0].length);
  const bq = /<blockquote[^>]*>/i.exec(rest);
  if (!bq) return null;
  const end = rest.lastIndexOf('</blockquote>');
  if (end < bq.index) return null;
  const quote = rest.slice(bq.index + bq[0].length, end);
  let header = '';
  const hm = /<p[^>]*class="[^"]*\bchatyy-quote-h\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(rest.slice(0, bq.index));
  if (hm) {
    header = hm[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  const body = html.slice(0, m.index).replace(/(?:\s|<br\s*\/?>)+$/i, '').replace(/(?:<br\s*\/?>\s*)+$/i, '');
  return { body, header, quote };
}

// Matches styles.header.height below — used as the iOS KeyboardAvoidingView
// offset (header sits INSIDE the KAV, above the scrollable form) so the
// keyboard-avoid padding is computed correctly instead of relying on the
// KAV's automatic (and, inside a modal presentation, sometimes unreliable)
// frame measurement.
const HEADER_HEIGHT = 56;

// ── Gmail-level limits (protect data processing/storage from pathological
//    input). Generous enough that normal use never trips them. ──
const MAX_SUBJECT_LEN = 255;          // Gmail truncates display beyond this
const MAX_BODY_LEN = 100000;          // ~100KB of text content
const MAX_EMAIL_LEN = 254;            // RFC 5321 addr-spec total
const MAX_EMAIL_LOCAL_LEN = 64;       // local part (before @)
const MAX_EMAIL_DOMAIN_LEN = 255;     // domain part (after @)
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024; // Gmail's hard 25 MB total

// Validate a single email address against Gmail/RFC limits + basic format.
// Accepts either a bare addr-spec ("a@b.com") or a "Name <a@b.com>" entry.
// Returns true when the addr-spec is well-formed and within all length caps.
function isValidRecipient(entry) {
  if (!entry || typeof entry !== 'string') return false;
  let addr = entry.trim();
  const m = addr.match(/<([^>]+)>/);
  if (m) addr = m[1].trim();
  if (!addr || addr.length > MAX_EMAIL_LEN) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@')) return false; // exactly one @, non-empty local
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!local || local.length > MAX_EMAIL_LOCAL_LEN) return false;
  if (!domain || domain.length > MAX_EMAIL_DOMAIN_LEN) return false;
  // Domain must have a dot and no whitespace; local must have no whitespace.
  if (/\s/.test(local) || /\s/.test(domain)) return false;
  if (!domain.includes('.')) return false;
  return true;
}

// Split an RFC address-list on commas OUTSIDE quoted display names and
// <angle-addrs> — `"Silva, João" <j@x.com>` must stay ONE entry — and return
// bare addr-specs only: the backend explodes to/cc on "," verbatim, so a chip
// carrying a display name with a comma would corrupt the list again on send.
function splitAddressList(str) {
  const entries = [];
  let cur = '', inQuote = false, inAngle = false;
  for (const ch of String(str || '')) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<' && !inQuote) inAngle = true;
    else if (ch === '>' && !inQuote) inAngle = false;
    if (ch === ',' && !inQuote && !inAngle) { entries.push(cur); cur = ''; continue; }
    cur += ch;
  }
  entries.push(cur);
  return entries
    .map(e => e.trim())
    .filter(Boolean)
    .map(e => (e.match(/<([^>]+)>/)?.[1] || e).trim())
    .filter(Boolean);
}

// Approximate UTF-8 byte length without relying on TextEncoder (RN web/native).
function utf8ByteLength(str) {
  if (!str) return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; } // surrogate pair
    else bytes += 3;
  }
  return bytes;
}

// Format date for reply/forward headers using device locale
function formatGmailDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Short date for reply header
function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Send button (primary CTA) ──────────────────────────────
// Animated press scale (0.97 spring) layered on top of the brand shadow
// for a tactile, weight-bearing send. Inline ActivityIndicator while
// sending. Icon = SVG (IconSend). Long-press opens schedule sheet.
function SendButton({ size, sending, onPress, onLongPress, colors, label }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97, useNativeDriver: true, friction: 7, tension: 220,
    }).start();
  };
  const pressOut = () => {
    Animated.spring(scale, {
      toValue: 1, useNativeDriver: true, friction: 5, tension: 180,
    }).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[
          s.sendBtn,
          size === 'large' && s.sendBtnLarge,
          size === 'compact' && s.sendBtnCompact,
          { backgroundColor: colors.primary },
          sending && s.sendBtnDisabled,
        ]}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        onLongPress={onLongPress}
        delayLongPress={350}
        disabled={sending}
        activeOpacity={0.85}
        accessibilityLabel={label + ' (Ctrl+Enter)'}
        accessibilityRole="button"
      >
        {sending ? (
          <ActivityIndicator size="small" color={colors.onPrimary} />
        ) : (
          <>
            <IconSend size={size === 'large' ? 18 : 15} color={colors.onPrimary} />
            <Text style={[s.sendBtnText, size === 'large' && s.sendBtnTextLarge, { color: colors.onPrimary }]}>{label}</Text>
          </>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Rotating sparkle (used in AI buttons while busy) ────────
// Continuous 360° rotation, 1.2s linear, used while AI is composing/improving.
function SpinningSparkle({ size, color }) {
  const rot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rot, { toValue: 1, duration: 1200, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [rot]);
  const spin = rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate: spin }] }}>
      <BiaIcon size={size} color={color} />
    </Animated.View>
  );
}

// ─── Subject field with floating label (Material-style) ───
// Animated label that lifts + scales when focused or filled. Border tints
// to primary on focus. Counter sits bottom-right inside the card.
function SubjectField({ value, onChangeText, placeholder, label, colors }) {
  const [focused, setFocused] = useState(false);
  const lift = useRef(new Animated.Value((value && value.length > 0) ? 1 : 0)).current;
  const borderAnim = useRef(new Animated.Value(0)).current;
  const isLifted = focused || (value && value.length > 0);

  useEffect(() => {
    Animated.spring(lift, {
      toValue: isLifted ? 1 : 0,
      useNativeDriver: false,
      friction: 8,
      tension: 80,
    }).start();
    Animated.timing(borderAnim, {
      toValue: focused ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [focused, isLifted, lift, borderAnim]);

  const labelTop = lift.interpolate({ inputRange: [0, 1], outputRange: [18, 6] });
  const labelSize = lift.interpolate({ inputRange: [0, 1], outputRange: [15, 11] });
  const labelColor = borderAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.textTertiary || colors.textSecondary, colors.primary],
  });
  const borderColor = borderAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.borderLight, colors.primary],
  });

  return (
    <View style={{ marginHorizontal: Spacing.xl, marginTop: Spacing.md, marginBottom: Spacing.sm }}>
      <Animated.View
        style={[
          {
            borderWidth: 1.5,
            borderRadius: 14,
            paddingHorizontal: 16,
            paddingTop: 22,
            paddingBottom: 10,
            borderColor,
            backgroundColor: colors.surface,
          },
          Platform.select({
            web: { transition: 'border-color 0.18s, box-shadow 0.18s' },
            default: {},
          }),
        ]}
      >
        <Animated.Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 16,
            top: labelTop,
            fontSize: labelSize,
            color: labelColor,
            fontWeight: '500',
            letterSpacing: 0.2,
            backgroundColor: 'transparent',
          }}
        >
          {label}
        </Animated.Text>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={focused ? placeholder : ''}
          placeholderTextColor={colors.textTertiary}
          maxLength={255}
          style={[
            {
              fontSize: 16,
              fontWeight: '500',
              color: colors.text,
              paddingVertical: 0,
              minHeight: 22,
              letterSpacing: -0.1,
            },
            Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
          ]}
        />
        <Text
          style={{
            position: 'absolute',
            right: 14,
            bottom: 6,
            fontSize: 10,
            fontWeight: '500',
            color: (value && value.length > 235) ? colors.error : colors.textTertiary,
            letterSpacing: 0.3,
          }}
        >
          {(value || '').length}/255
        </Text>
      </Animated.View>
    </View>
  );
}

// Confidential mode options sheet — bottom sheet with expiry options +
// optional passcode + recipient phone (for SMS). Wired in the toolbar.
function ConfidentialOptionsModal({ visible, onClose, confidential, setConfidential, expiry, setExpiry, passcode, setPasscode, phone, setPhone, colors, t, insetsBottom = 0 }) {
  const opts = [
    { d: 1,   label: t?.('compose.confidential1d') || '1 dia' },
    { d: 7,   label: t?.('compose.confidential1w') || '1 semana' },
    { d: 30,  label: t?.('compose.confidential1m') || '1 mês' },
    { d: 180, label: t?.('compose.confidential6m') || '6 meses' },
  ];
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: onClose }); // [2026-10-17 drag-dismiss]
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot>
      <Pressable style={{ flex: 1, justifyContent: 'flex-end' }} onPress={onClose}>
        <DragBackdrop drag={drag} color="rgba(0,0,0,0.5)" />
        <DragPanel
          drag={drag}
          onStartShouldSetResponder={() => true}
          style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 14, paddingBottom: insetsBottom + 36, paddingHorizontal: 18 }}
        >
          <View style={{ alignItems: 'center', marginBottom: 10 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
          </View>
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 6 }}>
            {t?.('compose.confidential') || 'Modo confidencial'}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 14 }}>
            {t?.('compose.confidentialDesc') || 'Email expira após o prazo. Recipiente verá um link em vez do conteúdo.'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>
              {confidential ? (t?.('common.enabled') || 'Ativado') : (t?.('common.disabled') || 'Desativado')}
            </Text>
            <Switch value={confidential} onValueChange={setConfidential} trackColor={{ true: colors.primary, false: colors.border }} />
          </View>
          {confidential && (
            <>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('compose.confidentialExpiry') || 'Expira em'}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {opts.map(o => {
                  const active = expiry === o.d;
                  return (
                    <TouchableOpacity key={o.d} onPress={() => setExpiry(o.d)}
                      style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18,
                        backgroundColor: active ? colors.primary : colors.surfaceVariant }}>
                      <Text style={{ color: active ? colors.onPrimary : colors.text, fontWeight: '600', fontSize: 13 }}>{o.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 16, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('compose.confidentialPasscode') || 'Senha (opcional)'}
              </Text>
              <TextInput
                value={passcode}
                onChangeText={setPasscode}
                placeholder={t?.('compose.confidentialPasscodePlaceholder') || 'Senha pra abrir o email'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                autoCapitalize="none"
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, height: 40, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */ }}
              />
              {!!passcode && (
                <>
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {t?.('compose.confidentialPhone') || 'Telefone do destinatário (SMS)'}
                  </Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="+55..."
                    placeholderTextColor={colors.textTertiary}
                    keyboardType="phone-pad"
                    style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, height: 40, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */ }}
                  />
                </>
              )}
            </>
          )}
          <TouchableOpacity onPress={onClose}
            style={{ backgroundColor: colors.primary, paddingVertical: 13, borderRadius: 12, alignItems: 'center', marginTop: 18 }}>
            <Text style={{ color: colors.onPrimary, fontWeight: '700', fontSize: 15 }}>
              {t?.('common.done') || 'Pronto'}
            </Text>
          </TouchableOpacity>
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

export default function ComposeScreen() {
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const { refresh } = useMail();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // [2026-10-11 email-qa] Tela estreita (celular): o selo "Rascunho salvo HH:MM"
  // empurrava o botão Enviar pra fora da tela (390 px → "Envia" cortado).
  const { width: composeWinW } = useWindowDimensions();
  const compactHeader = composeWinW < 480;

  const isReply = !!params.reply_uid;
  const isReplyAll = !!params.reply_all;
  const isForward = !!params.forward_uid;

  // --- Field state ---
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [bcc, setBcc] = useState([]);
  const [subject, setSubject] = useState(params.subject || '');
  const [body, setBody] = useState('');
  const [quotedHtml, setQuotedHtml] = useState('');
  const [quotedHeader, setQuotedHeader] = useState('');
  const [showQuote, setShowQuote] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  // Original message metadata (for reply header card)
  const [origMsg, setOrigMsg] = useState(null);
  const [loading, setLoading] = useState(!!params.reply_uid || !!params.forward_uid);

  // --- Send-as aliases (Gmail multi-from). Loads once on mount; falls back
  //     to the user's login email if the endpoint is unavailable. ---
  const [aliases, setAliases] = useState([]);
  const [fromAlias, setFromAlias] = useState('');
  const [showAliasMenu, setShowAliasMenu] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await aliasesList();
        if (!alive || !r?.success || !Array.isArray(r.data?.aliases)) return;
        const verified = r.data.aliases.filter(a => a.verified);
        setAliases(verified);
        // Default to primary (login email) if not already chosen.
        const primary = verified.find(a => a.is_primary) || verified[0];
        if (primary?.alias_email) setFromAlias(primary.alias_email);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // --- UI state ---
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  // [2026-10-17 qa-web] Compose aberto direto (deep link / F5 no web / push) não
  // tem tela atrás: router.back() era no-op → preso em "Email enviado!
  // Redirecionando..." para sempre. Sem histórico → caixa de entrada.
  const _leaveAfterSend = () => {
    try { if (router.canGoBack && !router.canGoBack()) { router.replace('/inbox'); return; } } catch {}
    router.back();
    // Web: canGoBack() pode dizer true (pilha âncora do expo-router) e o back
    // não sair daqui → se ainda montado, vai p/ a caixa de entrada.
    setTimeout(() => { try { if (mountedRef.current) router.replace('/inbox'); } catch {} }, 900);
  };
  const [showAI, setShowAI] = useState(false);
  const [improving, setImproving] = useState(false);
  const [aiImprovedHint, setAiImprovedHint] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  // Long-press send → quick "send when?" sheet (Gmail parity).
  const [showSendOptions, setShowSendOptions] = useState(false);
  // Read-receipt opt-in. Persisted as a per-user default in
  // localStorage/AsyncStorage under `track_opens_default`. Backend injects
  // a 1×1 tracking pixel into the HTML body when this is on.
  const [trackOpens, setTrackOpens] = useState(false);
  // Confidential mode (Gmail parity) — body is stored server-side keyed by an
  // opaque UUID and replaced in the email with a "view confidential" link.
  const [confidential, setConfidential] = useState(false);
  const [confidentialModal, setConfidentialModal] = useState(false);
  const [confidentialExpiry, setConfidentialExpiry] = useState(7); // days
  const [confidentialPasscode, setConfidentialPasscode] = useState('');
  const [confidentialPhone, setConfidentialPhone] = useState('');
  // PGP encryption (round-6 gap-closer). Toggle attempts to look up the
  // recipient's public key via pgp_key_get and encrypt the body with
  // openpgpjs before send. If no key is on file we offer the SMS-passphrase
  // fallback (symmetric encryption with a generated passphrase that's
  // delivered to the recipient over SMS via Telnyx).
  const [pgpEncrypt, setPgpEncrypt] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        const v = typeof localStorage !== 'undefined' && localStorage.getItem('track_opens_default');
        if (v === '1') setTrackOpens(true);
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('track_opens_default').then(v => { if (v === '1') setTrackOpens(true); }).catch(() => {});
      }).catch(() => {});
    }
  }, []);
  const persistTrackOpens = useCallback((next) => {
    setTrackOpens(next);
    if (Platform.OS === 'web') {
      try { typeof localStorage !== 'undefined' && localStorage.setItem('track_opens_default', next ? '1' : '0'); } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.setItem('track_opens_default', next ? '1' : '0').catch(() => {});
      }).catch(() => {});
    }
  }, []);

  // --- Undo send ---
  const [undoCountdown, setUndoCountdown] = useState(0);
  const undoSendRef = useRef(null);
  const undoSendIdRef = useRef(null); // server send_id for backend-side cancel
  // Synchronous re-entry guard for doSend: `sending` only flips inside doSend,
  // so taps during the AI checks (or the 60ms setTimeout window) each scheduled
  // their own doSend — same email sent twice, and the undo send_id of the first
  // was overwritten. A ref is set in the same tick, closing both windows across
  // all entry points (handleSend, handleSendAnyway, leak modal, Ctrl+Enter).
  const sendingGuardRef = useRef(false);
  const undoIntervalRef = useRef(null);
  const undoDelayRef = useRef(5);

  // --- Refs ---
  const toRef = useRef(null);
  const toValueRef = useRef(to);
  // Cc/Bcc mirror the To pattern: component refs so send paths can flush()
  // typed-but-unchipped text, value refs so doSend (which fires on a 60ms
  // timeout / after async AI checks) reads the post-flush list instead of
  // the stale closure — without both, a typed Cc was silently dropped.
  const ccRef = useRef(null);
  const bccRef = useRef(null);
  const ccValueRef = useRef(cc);
  const bccValueRef = useRef(bcc);

  // --- Draft auto-save ---
  const [draftSaved, setDraftSaved] = useState(false);
  // Persistent header indicator state: 'idle' | 'saving' | 'saved' | 'error'
  // Replaces the 2s toast — status now stays visible so the user always
  // knows whether their work is committed.
  const [draftStatus, setDraftStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null); // Date
  const draftUidRef = useRef(null);
  // Set true once the message is successfully sent. From that point on
  // saveDraft/flushDraft become no-ops so the unmount flush (or a late
  // autosave tick) can't re-persist the just-sent content as a draft —
  // which previously left the message showing in BOTH Sent AND Drafts.
  const sentRef = useRef(false);
  // 'Descartar' confirmed → saveDraft/flushDraft become no-ops so the unmount
  // flush can't re-save the draft the user just chose to throw away.
  const discardedRef = useRef(false);
  const draftTimerRef = useRef(null);
  const draftSavedTimerRef = useRef(null);
  const contentChangedRef = useRef(false);
  // Reentrance guard: the beforeunload/background flush can fire while an
  // autosave tick's draft_save is still in flight — two concurrent saves hit
  // the backend's append-then-delete race and leave a DUPLICATE draft.
  const draftSavingRef = useRef(false);
  // Consecutive draft_save failures. Failures re-arm the dirty flag so typed
  // content isn't silently dropped, but after 3 strikes we stop retrying on
  // the timer (next keystroke re-arms via the content-change effect) —
  // precedent: the storage-quota retry storm, pulse-20260723.
  const draftSaveFailsRef = useRef(0);
  const mountedRef = useIsMounted();
  // [2026-10-18 email-draft-local] Local a cada mudança; servidor só depois de
  // ~30 s parado / 2º plano / saída. Decide UMA vez por montagem (OTA flag).
  const draftLocalOnRef = useRef(null);
  if (draftLocalOnRef.current === null) draftLocalOnRef.current = isDraftLocalOn();
  const draftSidRef = useRef(null);
  if (!draftSidRef.current) draftSidRef.current = newDraftSid();
  // Pedido de salvar chegou com outro em voo → roda de novo quando ele acabar
  // (antes era descartado: o flush do unmount se perdia ou duplicava).
  const draftPendingRef = useRef(false);
  const draftIdleTimerRef = useRef(null);
  const draftLocalWriteTimerRef = useRef(null);
  const draftDirtySinceRef = useRef(0);

  // --- Animated values ---
  const undoOpacity = useRef(new Animated.Value(0)).current;
  const draftOpacity = useRef(new Animated.Value(0)).current;
  const headerScale = useRef(new Animated.Value(0)).current;

  // Entrance animation
  useEffect(() => {
    Animated.spring(headerScale, { toValue: 1, tension: 60, friction: 10, useNativeDriver: false }).start();
  }, []);

  // Helper: parse email string/array param into contact objects
  const parseEmailsParam = useCallback((val) => {
    if (!val) return [];
    const str = typeof val === 'string' ? val : String(val);
    return splitAddressList(str).map(email => ({ email, name: '' }));
  }, []);

  // Load undo send delay
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        const d = typeof localStorage !== 'undefined' && localStorage.getItem('undo_send_delay');
        if (d != null && d !== '' && !isNaN(parseInt(d, 10))) undoDelayRef.current = Math.max(0, parseInt(d, 10));
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('undo_send_delay').then(d => {
          if (d != null && d !== '' && !isNaN(parseInt(d, 10))) undoDelayRef.current = Math.max(0, parseInt(d, 10));
        }).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  // --- Load original message ---
  useEffect(() => {
    let alive = true;
    if (params.draft_uid) {
      getMessage(params.draft_uid, 'Drafts').then(r => {
        if (!alive) return;
        if (r.success && r.data) {
          const draft = r.data;
          if (draft.to) setTo(parseEmailsParam(draft.to));
          if (draft.cc) { setCc(parseEmailsParam(draft.cc)); setShowCc(true); }
          if (draft.bcc) { setBcc(parseEmailsParam(draft.bcc)); setShowBcc(true); }
          if (draft.subject) setSubject(draft.subject);
          if (draft.body_html || draft.body_text || draft.body) {
            const raw = draft.body_html || draft.body_text || draft.body;
            // [2026-10-18 email-quote-html] citação salva no rascunho volta pro
            // bloco read-only (o editor nativo fica só com o texto do usuário).
            const sp = draft.body_html ? splitQuotedDraft(draft.body_html) : null;
            if (sp && sp.quote) {
              setBody(sp.body);
              setQuotedHeader(sp.header || '');
              setQuotedHtml(sanitizeQuotedHtml(sp.quote));
            } else {
              setBody(raw);
            }
          }
          draftUidRef.current = params.draft_uid;
        }
      }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }

    if (params.to && !params.reply_uid) {
      setTo(parseEmailsParam(params.to));
    }

    // [2026-10-07 email-instant-send] reopened by "Desfazer" in EmailUndoBar.
    if (params.restore_undo === '1') {
      try {
        const r = require('../services/emailUndo').takeEmailUndoRestore();
        if (r) {
          setTo(r.to || []);
          if (r.cc?.length) { setCc(r.cc); setShowCc(true); }
          if (r.bcc?.length) { setBcc(r.bcc); setShowBcc(true); }
          setSubject(r.subject || '');
          setBody(r.body || '');
          if (r.attachments?.length) setAttachments(r.attachments);
          contentChangedRef.current = true;
        }
      } catch {}
    }

    // Follow-up chip ("Enviar follow-up") navigates without reply_uid — the
    // suggested text only used to be consumed inside the reply branch below,
    // so the compose opened empty and the AI suggestion was lost.
    if (params.smart_reply && !params.reply_uid && !params.draft_uid) {
      setBody(String(params.smart_reply));
    }

    // Parse mailto: URL (web protocol handler: /compose?mailto=mailto:user@example.com?subject=Hello)
    if (params.mailto) {
      try {
        const mailtoUrl = decodeURIComponent(params.mailto);
        // Strip the "mailto:" prefix then split address from query string
        const stripped = mailtoUrl.replace(/^mailto:/i, '');
        const [emailPart, queryPart] = stripped.split('?');
        if (emailPart) setTo(parseEmailsParam(emailPart));
        if (queryPart) {
          const sp = new URLSearchParams(queryPart);
          if (sp.get('subject')) setSubject(sp.get('subject'));
          if (sp.get('body')) setBody(sp.get('body'));
          if (sp.get('cc')) { setCc(parseEmailsParam(sp.get('cc'))); setShowCc(true); }
          if (sp.get('bcc')) { setBcc(parseEmailsParam(sp.get('bcc'))); setShowBcc(true); }
        }
      } catch {}
    }

    const uid = params.reply_uid || params.forward_uid;
    if (uid) {
      getMessage(uid, params.folder || 'INBOX').then(r => {
        if (!alive) return;
        // [2026-10-21] falha ao carregar o original → avisa (antes abria vazio calado).
        if (!(r?.success && r.data)) { setError(t('compose.errorConnection')); return; }
        if (r.success && r.data) {
          const orig = r.data;
          setOrigMsg(orig);

          if (params.reply_uid) {
            // [deep-20261023] responder respeita Reply-To (formulário/lista/noreply); o servidor
            // devolve reply_to = From quando o cabeçalho não existe.
            setTo(parseEmailsParam(orig.reply_to || orig.from));

            // Reply All: add all recipients + original CC to CC field.
            // The sender already goes in To (setTo above) — on lists/group
            // mail the sender also appears in the original to/cc, so exclude
            // them here or they receive the reply twice (To + Cc).
            if (params.reply_all) {
              const fromLower = (String(orig.from || '').match(/<([^>]+)>/)?.[1] ||
                String(orig.from || '')).trim().toLowerCase();
              // splitAddressList returns bare addr-specs, so compare by
              // equality; an unknown own address must NOT empty the CC.
              const notSelfOrSender = (e) => {
                const clean = e.toLowerCase();
                if (user?.email && clean === user.email.toLowerCase()) return false;
                if (fromLower && clean === fromLower) return false;
                if (orig.reply_to && clean === String(orig.reply_to).trim().toLowerCase()) return false;
                return true;
              };
              const allRecipients = splitAddressList(orig.to)
                .filter(notSelfOrSender)
                .map(email => ({ email, name: '' }));

              const origCc = splitAddressList(orig.cc)
                .filter(notSelfOrSender)
                .map(email => ({ email, name: '' }));

              const combined = [...allRecipients, ...origCc];
              if (combined.length > 0) {
                setCc(combined);
                setShowCc(true);
              }
            }

            const smartReply = params.smart_reply || '';
            const senderLabel = orig.from_name ? `${orig.from_name} <${orig.from}>` : orig.from;
            const qHeader = t('compose.replyHeader', { date: formatGmailDate(orig.date), sender: senderLabel });
            // If the original has no HTML part, its plain text must be HTML-escaped and
            // newline-converted before it goes into a <blockquote> — otherwise line
            // breaks collapse into one run-on paragraph and literal < / & are read as markup.
            const qContent = orig.body_html
              ? orig.body_html
              : (orig.body_text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
            setQuotedHeader(qHeader);
            setQuotedHtml(sanitizeQuotedHtml(qContent));
            setBody(smartReply || '');
          } else {
            // Forward
            const fwdBody = orig.body_html
              ? orig.body_html
              : (orig.body_text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
            const fwdHeader = t('compose.forwardHeader', { from: orig.from, date: formatGmailDate(orig.date), subject: orig.subject, to: orig.to });
            setQuotedHeader(fwdHeader);
            setQuotedHtml(sanitizeQuotedHtml(fwdBody));
            setBody('');

            // [FORWARD KEEPS ATTACHMENTS] A normal forward must carry the
            // original's files, not just the quoted body (Gmail parity).
            // Download each non-inline attachment from the original message and
            // add it to the compose attachments list so sendEmail re-uploads
            // it. Fire-and-forget so it never blocks the compose from opening.
            // (Inline images referenced by cid: live in the quoted body and are
            // intentionally skipped here to avoid duplicate file attachments.)
            const fwdAtts = Array.isArray(orig.attachments) ? orig.attachments.filter(a => a && !a.inline && (a.filename || a.name)) : [];
            if (fwdAtts.length > 0) {
              (async () => {
                try {
                  const fwFolder = params.folder || 'INBOX';
                  for (const a of fwdAtts) {
                    if (!alive) return;
                    const name = a.filename || a.name || `attachment_${a.part_id || ''}`;
                    const type = a.mime || a.type || 'application/octet-stream';
                    try {
                      const url = api.getAttachmentUrl(uid, fwFolder, a.part_id);
                      if (Platform.OS === 'web') {
                        const resp = await fetch(url, { credentials: 'include' });
                        if (!resp.ok) throw new Error('HTTP ' + resp.status);
                        const blob = await resp.blob();
                        const file = new File([blob], name, { type });
                        if (!alive) return;
                        setAttachments(prev => [...prev, { name, size: blob.size, type, _raw: file, uri: '' }]);
                      } else {
                        let FS; try { FS = await import('expo-file-system/legacy'); } catch { FS = await import('expo-file-system'); }
                        const safeName = String(name).replace(/[^\w.\-]+/g, '_');
                        const dest = (FS.cacheDirectory || FS.documentDirectory || '') + 'fwd_' + Date.now() + '_' + safeName;
                        const dl = await FS.downloadAsync(url, dest);
                        const info = await FS.getInfoAsync(dl.uri);
                        if (!alive) return;
                        setAttachments(prev => [...prev, { name, size: info.size || a.size || 0, type, uri: dl.uri }]);
                      }
                    } catch (e) { console.warn('forward attachment fetch failed', name, e); }
                  }
                } catch (e) { console.warn('forward attachments', e); }
              })();
            }
          }
        }
      }).catch(() => { if (alive) setError(t('compose.errorConnection')); }).finally(() => { if (alive) setLoading(false); });
    } else {
      setLoading(false);
    }
    loadSignature();
    // Forward as attachment — when the launcher passes attach_eml_uid we
    // download the original message's .eml via getExportUrl and stick it
    // in the attachments list. The user gets a clean compose body + the
    // raw RFC822 message as a real attachment, exactly like Gmail's
    // "Forward as attachment".
    if (params.attach_eml_uid) {
      (async () => {
        try {
          const apiMod = await import('../services/api');
          const url = apiMod.getExportUrl(params.attach_eml_uid, params.attach_eml_folder || 'INBOX');
          const name = `forwarded_${params.attach_eml_uid}.eml`;
          if (Platform.OS === 'web') {
            const resp = await fetch(url, { credentials: 'include' });
            const blob = await resp.blob();
            const file = new File([blob], name, { type: 'message/rfc822' });
            setAttachments(prev => [...prev, {
              name, size: blob.size, type: 'message/rfc822', _raw: file, uri: '',
            }]);
          } else {
            // Native: download the .eml to FileSystem cache so RN's
            // FormData multipart picker can attach it via file:// URI.
            try {
              let FS; try { FS = await import('expo-file-system/legacy'); } catch { FS = await import('expo-file-system'); }
              const dest = (FS.cacheDirectory || FS.documentDirectory || '') + name;
              const dl = await FS.downloadAsync(url, dest);
              const info = await FS.getInfoAsync(dl.uri);
              setAttachments(prev => [...prev, {
                name, size: info.size || 0, type: 'message/rfc822', uri: dl.uri,
              }]);
            } catch (e) {
              // Best-effort fallback: pass remote URL straight to RN
              // (works on Android, may fail on iOS — better than nothing).
              setAttachments(prev => [...prev, {
                name, size: 0, type: 'message/rfc822', uri: url,
              }]);
            }
          }
        } catch (e) { console.warn('attach_eml fetch', e); }
      })();
    }
    return () => { alive = false; };
  }, []);

  const loadSignature = async () => {
    try {
      const { getSettings } = await import('../services/api');
      const r = await getSettings();
      // Get signature text, ensuring it's never null/undefined/"null"
      const rawSig = r.success ? r.data?.signature : '';
      const sig = (rawSig && typeof rawSig === 'string' && rawSig !== 'null')
        ? rawSig.trim()
        : '';
      if (sig && !params.reply_uid && !params.forward_uid) {
        setBody(prev => prev + '<br><br>--<br>' + sig.replace(/\n/g, '<br>'));
      }
    } catch {}
  };

  // --- Draft auto-save ---
  const contactsToString = useCallback((contacts) => {
    return contacts.map(c => c.email).join(', ');
  }, []);

  // Returns true when the compose has at least one piece of meaningful
  // content worth persisting as a draft. An empty compose (no recipient,
  // no subject, no body, no attachment) must NEVER create a junk draft.
  // The rich editor returns markup like `<p></p>`, `<div><br></div>` or
  // `&nbsp;` for a "visually empty" body, so we strip tags + entities +
  // whitespace before deciding the body is empty.
  const isComposeEmpty = useCallback(() => {
    const anyRecipient =
      to.some(c => (c.email || '').trim()) ||
      cc.some(c => (c.email || '').trim()) ||
      bcc.some(c => (c.email || '').trim());
    if (anyRecipient) return false;
    if (subject.trim()) return false;
    if (attachments.length > 0) return false;
    const plainBody = (body || '')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')        // strip all tags (<p></p>, <div>, …)
      .replace(/&nbsp;/gi, '')         // non-breaking spaces
      .replace(/ /g, '')          // literal nbsp char
      .replace(/\s+/g, '')             // any remaining whitespace
      .trim();
    if (plainBody.length > 0) return false;
    return true;
  }, [to, cc, bcc, subject, body, attachments]);

  const saveDraft = useCallback(async () => {
    // Message already sent (or compose discarded) → never re-persist its
    // content as a draft (otherwise it shows up in Drafts as well as Sent).
    if (sentRef.current || discardedRef.current) return;
    // Save already in flight → skip WITHOUT consuming the dirty flag; the
    // next tick (or the in-flight save itself) picks the content up.
    // [2026-10-18] Fluxo local: marca pendente → o save em voo re-dispara no
    // finally com o uid que acabou de voltar (nunca 2 draft_save simultâneos).
    if (draftSavingRef.current) { if (draftLocalOnRef.current) draftPendingRef.current = true; return; }
    if (!contentChangedRef.current) return;
    // Never persist a completely empty compose as a draft. If we are
    // editing an existing draft that the user cleared to empty, delete it
    // (it's now empty) instead of leaving a junk draft behind. Either way
    // we consume the dirty flag so the timer doesn't keep retrying.
    if (isComposeEmpty()) {
      contentChangedRef.current = false;
      if (draftUidRef.current) {
        const staleUid = draftUidRef.current;
        draftUidRef.current = null;
        let deleted = false;
        try {
          const dr = await api.apiCall('draft_delete', { uid: staleUid }, 'POST');
          deleted = !!dr?.success;
        } catch {}
        // Single best-effort retry before reporting failure.
        if (!deleted) {
          try {
            const dr2 = await api.apiCall('draft_delete', { uid: staleUid }, 'POST');
            deleted = !!dr2?.success;
          } catch {}
        }
        if (mountedRef.current) {
          if (deleted) {
            setDraftStatus('idle');
            setLastSavedAt(null);
          } else {
            // Don't claim the draft was deleted — surface the error and
            // restore the uid so a later save/delete can still target it.
            draftUidRef.current = staleUid;
            setDraftStatus('error');
          }
        }
      } else if (mountedRef.current) {
        setDraftStatus('idle');
      }
      if (draftLocalOnRef.current) clearLocalDraft(draftSidRef.current);
      return;
    }
    contentChangedRef.current = false;
    draftDirtySinceRef.current = 0;
    if (draftIdleTimerRef.current) { clearTimeout(draftIdleTimerRef.current); draftIdleTimerRef.current = null; }
    if (mountedRef.current) setDraftStatus('saving');
    draftSavingRef.current = true;
    try {
      // api.draftSave = keepalive fetch on web so the beforeunload flush
      // actually completes after the tab closes (plain apiCall was killed
      // by the browser and everything since the last tick was lost).
      // [2026-10-18 email-quote-html] a citação vai junto no rascunho (antes o
      // rascunho de uma resposta reaberto perdia o e-mail original).
      const draftBody = _quoteHtmlOn() ? buildQuotedSendBody(body, quotedHeader, quotedHtml) : body;
      const r = await api.draftSave({
        subject, to: contactsToString(to), cc: contactsToString(cc),
        bcc: contactsToString(bcc), body: draftBody,
        draft_uid: draftUidRef.current || undefined,
      });
      // uid ANTES do check de montado: o save que roda depois do unmount
      // (pendente) precisa trocar ESTE rascunho, não criar outro.
      if (r?.success && r.data?.draft_uid) draftUidRef.current = r.data.draft_uid;
      if (r?.success) {
        draftSaveFailsRef.current = 0;
        if (draftLocalOnRef.current && !contentChangedRef.current) markLocalDraftSynced(draftSidRef.current, draftUidRef.current);
      } else {
        // Failure consumed the dirty flag above — re-arm it so the content
        // is retried next tick instead of silently never saved (3-strike
        // backoff: see draftSaveFailsRef).
        draftSaveFailsRef.current += 1;
        if (draftSaveFailsRef.current < 3) contentChangedRef.current = true;
      }
      if (!mountedRef.current) return;
      setDraftSaved(true);
      setDraftStatus(r?.success ? 'saved' : 'error');
      if (r?.success) setLastSavedAt(new Date());
      // Keep the legacy `draftSaved` flag wired so the bottom toast still
      // animates briefly, but the header indicator (driven by draftStatus
      // / lastSavedAt) now persists across the rest of the session.
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
      draftSavedTimerRef.current = setTimeout(() => setDraftSaved(false), 2000);
    } catch {
      draftSaveFailsRef.current += 1;
      if (draftSaveFailsRef.current < 3) contentChangedRef.current = true;
      if (mountedRef.current) setDraftStatus('error');
    } finally {
      draftSavingRef.current = false;
      if (draftPendingRef.current) {
        draftPendingRef.current = false;
        // Ref = closure mais nova (conteúdo atual), mesmo após o unmount.
        if (contentChangedRef.current && !sentRef.current && !discardedRef.current) {
          setTimeout(() => { try { saveDraftRef.current?.(); } catch {} }, 0);
        }
      }
    }
  }, [subject, to, cc, bcc, body, quotedHeader, quotedHtml, contactsToString, isComposeEmpty]);

  useEffect(() => { toValueRef.current = to; }, [to]);
  useEffect(() => { ccValueRef.current = cc; }, [cc]);
  useEffect(() => { bccValueRef.current = bcc; }, [bcc]);
  useEffect(() => { contentChangedRef.current = true; }, [to, cc, bcc, subject, body]);

  const saveDraftRef = useRef(saveDraft);
  useEffect(() => { saveDraftRef.current = saveDraft; }, [saveDraft]);

  // [2026-10-18 email-draft-local] Cada mudança → slot local (síncrono, sem
  // rede) + agenda o servidor p/ 30 s depois da ÚLTIMA mudança (no máx. 2 min
  // digitando sem parar). Primeira passada (montagem) não conta.
  const draftLocalFirstRef = useRef(true);
  const draftLocalSnapRef = useRef(null);
  // Grava o último retrato pendente (timer de 400 ms, ou já no unmount/2º plano).
  const writeLocalDraftNow = useCallback(() => {
    if (draftLocalWriteTimerRef.current) { clearTimeout(draftLocalWriteTimerRef.current); draftLocalWriteTimerRef.current = null; }
    const pending = draftLocalSnapRef.current;
    draftLocalSnapRef.current = null;
    if (!pending || sentRef.current || discardedRef.current) return;
    const snap = pending.snap;
    if (!snap) { clearLocalDraft(draftSidRef.current); return; }
    saveLocalDraft(draftSidRef.current, {
      draftUid: draftUidRef.current,
      subject: snap.subject, to: snap.to, cc: snap.cc, bcc: snap.bcc,
      body: buildQuotedSendBody(snap.body, snap.quotedHeader, snap.quotedHtml),
      // já sincronizado entre a mudança e a gravação? então não é órfão
      dirty: !!contentChangedRef.current || !!draftSavingRef.current,
    });
  }, []);
  useEffect(() => {
    if (!draftLocalOnRef.current) return;
    if (draftLocalFirstRef.current) { draftLocalFirstRef.current = false; return; }
    if (sentRef.current || discardedRef.current) return;
    // Gravação local com respiro de 400 ms (corpo + citação grandes não são
    // serializados a cada tecla); o servidor continua no timer de 30 s.
    const empty = isComposeEmpty();
    const snap = empty ? null : {
      subject, to: contactsToString(to), cc: contactsToString(cc), bcc: contactsToString(bcc),
      body, quotedHeader, quotedHtml,
    };
    draftLocalSnapRef.current = { snap };
    if (draftLocalWriteTimerRef.current) clearTimeout(draftLocalWriteTimerRef.current);
    draftLocalWriteTimerRef.current = setTimeout(writeLocalDraftNow, 400);
    const now = Date.now();
    if (!draftDirtySinceRef.current) draftDirtySinceRef.current = now;
    if (draftIdleTimerRef.current) clearTimeout(draftIdleTimerRef.current);
    const waited = now - draftDirtySinceRef.current;
    const delay = waited >= DRAFT_MAX_WAIT_MS ? 0 : Math.min(DRAFT_IDLE_SYNC_MS, DRAFT_MAX_WAIT_MS - waited);
    draftIdleTimerRef.current = setTimeout(() => {
      draftIdleTimerRef.current = null;
      try { saveDraftRef.current?.(); } catch {}
    }, delay);
  }, [to, cc, bcc, subject, body, quotedHeader, quotedHtml, contactsToString, isComposeEmpty]);

  // Rascunho de sessão anterior que morreu antes de sincronizar → Rascunhos.
  useEffect(() => {
    if (!draftLocalOnRef.current) return undefined;
    const tm = setTimeout(() => {
      recoverOrphanDrafts(draftSidRef.current, api.draftSave).catch(() => {});
    }, 4000);
    return () => clearTimeout(tm);
  }, []);

  // Force a final draft persist regardless of where we are in the autosave
  // cycle. Used by the unmount cleanup and by the web beforeunload / native
  // AppState 'background' handlers so a draft is never lost just because the
  // interval timer hadn't fired yet. We re-arm the dirty flag first so the
  // existing saveDraft (which early-returns when clean) actually writes.
  const flushDraft = useCallback(() => {
    try {
      if (sentRef.current || discardedRef.current) return; // sent/discarded → don't resurrect as a draft
      if (isComposeEmpty()) return;
      contentChangedRef.current = true;
      // Fire-and-forget: on unmount/background the component may be gone before
      // the network call resolves, but the request still goes out.
      saveDraftRef.current?.();
    } catch {}
  }, [isComposeEmpty]);
  const flushDraftRef = useRef(flushDraft);
  useEffect(() => { flushDraftRef.current = flushDraft; }, [flushDraft]);

  useEffect(() => {
    // Legado: servidor a cada 5 s. Fluxo local: o timer de ociosidade acima.
    if (!draftLocalOnRef.current) draftTimerRef.current = setInterval(() => saveDraftRef.current(), DRAFT_SAVE_INTERVAL);

    // Persist on web tab close/refresh and on native app-background. Without
    // this a user who closes the tab or backgrounds the app between autosave
    // ticks loses everything typed since the last save.
    let _removeBeforeUnload = null;
    let _appStateSub = null;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.addEventListener) {
        const onBeforeUnload = () => { try { flushDraftRef.current?.(); } catch {} };
        window.addEventListener('beforeunload', onBeforeUnload);
        _removeBeforeUnload = () => window.removeEventListener('beforeunload', onBeforeUnload);
      }
    } else {
      _appStateSub = AppState.addEventListener('change', (next) => {
        if (next === 'background' || next === 'inactive') {
          try { if (draftLocalOnRef.current) writeLocalDraftNow(); } catch {}
          try { flushDraftRef.current?.(); } catch {}
        }
      });
    }

    return () => {
      if (draftTimerRef.current) clearInterval(draftTimerRef.current);
      if (draftIdleTimerRef.current) { clearTimeout(draftIdleTimerRef.current); draftIdleTimerRef.current = null; }
      // Gravação local pendente vai pro disco AGORA (se o flush abaixo falhar
      // offline, a próxima abertura recupera o slot).
      try { writeLocalDraftNow(); } catch {}
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
      // Clean up undo send timers on unmount to prevent sending after navigation
      if (undoSendRef.current) clearTimeout(undoSendRef.current);
      if (undoIntervalRef.current) clearInterval(undoIntervalRef.current);
      // Leaving during the undo-send countdown: the message is already queued
      // server-side and WILL transmit — it's sent, not a draft. Clearing the
      // timer above killed finishSendSuccess, so flip the guard here (else the
      // flush below duplicates the sent email into Drafts) and drop the
      // autosaved draft the same way finishSendSuccess would have.
      if (undoSendIdRef.current) {
        sentRef.current = true;
        if (draftUidRef.current) {
          const staleUid = draftUidRef.current;
          draftUidRef.current = null;
          try { api.apiCall('draft_delete', { uid: staleUid }, 'POST').catch(() => {}); } catch {}
        }
      }
      // Final flush so an in-progress draft survives navigating away / unmount.
      try { flushDraftRef.current?.(); } catch {}
      // Enviado / descartado → o slot local some (senão "recuperaria" depois).
      if (draftLocalOnRef.current && (sentRef.current || discardedRef.current)) {
        try { clearLocalDraft(draftSidRef.current); } catch {}
      }
      try { _removeBeforeUnload?.(); } catch {}
      try { _appStateSub?.remove?.(); } catch {}
    };
  }, []);

  // Fade animations
  useEffect(() => {
    Animated.timing(undoOpacity, { toValue: undoCountdown > 0 ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [undoCountdown]);

  useEffect(() => {
    Animated.timing(draftOpacity, { toValue: draftSaved ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [draftSaved]);

  // --- Handlers ---
  const cancelUndoSend = useCallback(() => {
    if (undoSendRef.current) clearTimeout(undoSendRef.current);
    if (undoIntervalRef.current) clearInterval(undoIntervalRef.current);
    // The email is already queued on the server — tell the backend to drop it
    // by its send_id (real undo, survives tab/screen close). The local timer
    // above only governs our visual transition to "sent".
    const sid = undoSendIdRef.current;
    undoSendIdRef.current = null;
    if (sid) { try { api.cancelSend?.(sid); } catch {} }
    // Undo means the message will NOT be sent — the compose content is live
    // again, so re-arm the draft guards flipped when the send was queued.
    sentRef.current = false;
    contentChangedRef.current = true;
    setUndoCountdown(0);
    sendingGuardRef.current = false;
    setSending(false);
  }, []);

  const handleClose = () => {
    const hasContent = body.trim() || attachments.length > 0 || (!isReply && !isForward && (to.length > 0 || subject.trim()));
    if (hasContent) {
      if (Platform.OS === 'web') {
        if (window.confirm(t('compose.discardDraftConfirm'))) { discardedRef.current = true; router.back(); }
      } else {
        Alert.alert(t('compose.discard'), t('compose.discardDraftConfirm'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('compose.discard'), style: 'destructive', onPress: () => { discardedRef.current = true; router.back(); } },
        ]);
      }
    } else {
      router.back();
    }
  };

  const [toneWarning, setToneWarning] = useState(null); // {tone, score, suggestion}
  const [leakWarning, setLeakWarning] = useState(null); // {types, warning}
  const [toneCheckedHash, setToneCheckedHash] = useState('');
  // ── Reply-All external-recipient warning state ──
  // Counts how many people on To/Cc are outside the user's own domain(s).
  // Surfaces a banner above the send button (only on reply-all when there
  // are 3+ recipients and at least one is external) so the user doesn't
  // accidentally CC a customer/competitor.
  const [externalWarning, setExternalWarning] = useState(null); // {externalCount, totalCount, externalAddrs}
  // ── Send & Archive — after a successful reply send, archives the
  // original thread (Gmail's "Send + Archive" parity). Only meaningful in
  // reply/replyAll mode; toggle is sticky in localStorage so users who
  // prefer this default don't have to re-pick on each compose.
  const [sendAndArchive, setSendAndArchive] = useState(false);
  useEffect(() => {
    if (!isReply) return;
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined') {
          const v = localStorage.getItem('send_and_archive_default');
          if (v === '1') setSendAndArchive(true);
        }
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('send_and_archive_default').then(v => { if (v === '1') setSendAndArchive(true); }).catch(() => {});
      }).catch(() => {});
    }
  }, [isReply]);
  // ── URL preview cards (compose body unfurl) ──
  // Detects http(s) URLs in the body, fetches og:* meta via backend, and
  // exposes a one-tap "Insert preview card" button. Per-URL cache so a tap
  // doesn't re-fetch the same link. Only renders the most-recent unique URL.
  const [urlPreview, setUrlPreview] = useState(null); // {url, title, image, description, site_name}
  const [urlPreviewLoading, setUrlPreviewLoading] = useState(false);
  const urlPreviewCacheRef = useRef({}); // {url: previewObj}
  const lastDetectedUrlRef = useRef('');
  useEffect(() => {
    const plain = (body || '').replace(/<[^>]+>/g, ' ');
    const m = plain.match(/https?:\/\/[A-Za-z0-9._/?=&%~+:#@!$'()*,;\-]+/);
    const url = m ? m[0].replace(/[).,;!?]+$/, '') : '';
    if (!url || url === lastDetectedUrlRef.current) return;
    lastDetectedUrlRef.current = url;
    if (urlPreviewCacheRef.current[url]) {
      setUrlPreview(urlPreviewCacheRef.current[url]);
      return;
    }
    let cancelled = false;
    setUrlPreviewLoading(true);
    emailUrlPreview(url).then(r => {
      if (cancelled) return;
      if (r?.success && (r.data?.title || r.data?.image)) {
        urlPreviewCacheRef.current[url] = r.data;
        setUrlPreview(r.data);
      } else {
        setUrlPreview(null);
      }
    }).catch(() => { if (!cancelled) setUrlPreview(null); })
      .finally(() => { if (!cancelled) setUrlPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [body]);
  const insertUrlPreviewCard = useCallback(() => {
    if (!urlPreview) return;
    const escAttr = (s) => String(s || '').replace(/"/g, '&quot;');
    const escTxt = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let hostname = '';
    try { hostname = new URL(urlPreview.url).hostname; } catch {}
    const card = `<div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin:12px 0;max-width:480px;font-family:system-ui">
      ${urlPreview.image ? `<img src="${escAttr(urlPreview.image)}" alt="" style="width:100%;max-height:240px;object-fit:cover;display:block"/>` : ''}
      <div style="padding:12px 14px">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px">${escTxt(urlPreview.site_name || hostname)}</div>
        <a href="${escAttr(urlPreview.url)}" style="display:block;font-size:15px;font-weight:600;color:#111827;margin-top:4px;text-decoration:none">${escTxt(urlPreview.title || urlPreview.url)}</a>
        ${urlPreview.description ? `<div style="font-size:13px;color:#4b5563;margin-top:6px;line-height:1.4">${escTxt(urlPreview.description)}</div>` : ''}
      </div>
    </div><br/>`;
    setBody(prev => (prev || '') + card);
  }, [urlPreview]);

  // Helper: user's own domain(s) for external-recipient detection.
  const userDomains = useRef(new Set());
  useEffect(() => {
    const set = new Set();
    if (user?.email && user.email.includes('@')) set.add(user.email.split('@')[1].toLowerCase());
    aliases.forEach(a => {
      const e = a.alias_email || '';
      if (e.includes('@')) set.add(e.split('@')[1].toLowerCase());
    });
    userDomains.current = set;
  }, [user?.email, aliases]);
  // Re-evaluate external-recipient warning on every recipient change.
  // Only fires for reply-all flows (per spec) and only when there are
  // 3+ recipients on To+Cc combined.
  useEffect(() => {
    if (!isReplyAll) { setExternalWarning(null); return; }
    const allAddrs = [...to, ...cc].map(c => (c.email || '').toLowerCase()).filter(Boolean);
    if (allAddrs.length < 3) { setExternalWarning(null); return; }
    const externals = allAddrs.filter(a => {
      const at = a.lastIndexOf('@');
      if (at < 0) return false;
      const dom = a.slice(at + 1);
      return !userDomains.current.has(dom);
    });
    if (externals.length === 0) { setExternalWarning(null); return; }
    setExternalWarning({
      externalCount: externals.length,
      totalCount: allAddrs.length,
      externalAddrs: externals.slice(0, 3),
    });
  }, [to, cc, isReplyAll]);

  const handleSend = async () => {
    // Guard contra duplo envio enquanto AI checks rodam — antes podia
    // disparar várias chamadas simultâneas em taps rápidos.
    if (sending) return;
    toRef.current?.flush();
    ccRef.current?.flush();
    bccRef.current?.flush();
    const plainBody = (body || '').replace(/<[^>]+>/g, ' ').trim();
    const hash = subject + '|' + plainBody;
    if (plainBody.length > 10 && hash !== toneCheckedHash) {
      // [2026-10-09 on-device-privacy] Checagem de dado sensível NO APARELHO
      // (síncrona, sem rede): o corpo do e-mail não vai mais para
      // `ai_detect_leak`, e `ai_tone_check` (stub "disabled" no servidor,
      // ~0,9 s) saiu do caminho do Enviar.
      try {
        const leak = detectSensitive(`${subject || ''}\n${plainBody}`);
        if (leak.has_secret) {
          setLeakWarning({
            types: leak.types.map((k) => sensitiveTypeLabel(k, t)),
            warning: t('sensitive.warningBody'),
          });
          setToneCheckedHash(hash);
          return;
        }
      } catch {}
      setToneCheckedHash(hash);
    }
    setTimeout(() => doSend(), 0);
  };

  const handleSendAnyway = () => {
    setToneWarning(null);
    setTimeout(() => doSend(), 60);
  };

  // Ctrl+Enter / Cmd+Enter to send (web only)
  const handleSendRef = useRef(handleSend);
  useEffect(() => { handleSendRef.current = handleSend; });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSendRef.current();
      }
      if (e.key === 'Escape' && !e.target?.closest?.('[role="dialog"]')) {
        router.back();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const doSend = () => {
    if (sendingGuardRef.current) return;
    const currentTo = toValueRef.current;
    if (currentTo.length === 0) { setError(t('compose.errorRecipient')); return; }
    if (!body.trim() && !subject.trim()) { setError(t('compose.errorEmpty')); return; }

    // ── Recipient validation (Gmail/RFC length + format) ──
    // Flag the first invalid/over-length address across To/Cc/Bcc and block
    // send so we never hand a malformed addr-spec to the backend.
    const allRecipients = [...currentTo, ...ccValueRef.current, ...bccValueRef.current];
    const bad = allRecipients.find(c => !isValidRecipient(c?.email));
    if (bad) {
      setError(t('compose.errorInvalidRecipient', { email: (bad.email || '').slice(0, 80) }));
      return;
    }

    // ── Total message size (Gmail's 25 MB hard limit) ──
    // Sum body bytes + every attachment size (drive refs carry no bytes).
    const bodyBytes = utf8ByteLength(body || '') + utf8ByteLength(subject || '');
    const attachBytes = attachments.reduce(
      (sum, f) => sum + (f?.is_drive_ref ? 0 : (f?.size || 0)), 0
    );
    if (bodyBytes + attachBytes > MAX_MESSAGE_BYTES) {
      setError(t('compose.errorTooLarge'));
      return;
    }

    const delay = undoDelayRef.current;
    setError('');
    // Arm the guard only after validation passes, so an early-return above
    // (missing recipient etc.) never leaves the Send button dead.
    sendingGuardRef.current = true;
    setSending(true);

    const sendTo = toValueRef.current;
    const sendCc = [...ccValueRef.current];
    const sendBcc = [...bccValueRef.current];
    const sendSubject = subject;
    // Build final body: user's reply + quoted original
    const sendBody = buildQuotedSendBody(body, quotedHeader, quotedHtml);
    const sendAttachments = [...attachments];

    // After a successful send (queued or immediate), transition the UI to
    // "sent" and pop back. For undo_delay>0 the backend holds the message and
    // actually transmits it after `delay`s — this only governs our visuals.
    const finishSendSuccess = async (opts = {}) => {
      // Message is sent — flip the guard FIRST so the unmount flush + any
      // pending autosave tick become no-ops and can't re-create the draft.
      sentRef.current = true;
      contentChangedRef.current = false;
      // Delete the autosaved draft (if one exists) so the sent message does
      // NOT also linger in Drafts. Best-effort with a single retry; clear the
      // ref either way so nothing later targets a now-sent draft.
      // [2026-10-17 email-send-gmail] instant close: draft cleanup + Send &
      // Archive run in the background — before, both POSTs were awaited
      // before router.back(), so the composer lingered ~0,3–1 s after Send.
      const sentDraftUid = draftUidRef.current;
      draftUidRef.current = null;
      const cleanup = async () => {
        if (sentDraftUid) {
          try {
            const dr = await api.apiCall('draft_delete', { uid: sentDraftUid }, 'POST');
            if (!dr?.success) {
              try { await api.apiCall('draft_delete', { uid: sentDraftUid }, 'POST'); } catch {}
            }
          } catch {
            try { await api.apiCall('draft_delete', { uid: sentDraftUid }, 'POST'); } catch {}
          }
        }
        // Send & Archive: when the user has the toggle on for a reply, archive
        // the original thread. Best-effort, never blocks the success transition.
        if (sendAndArchive && isReply && params.reply_uid) {
          try { await archiveEmail(params.reply_uid, params.folder || 'INBOX'); } catch {}
        }
      };
      if (opts.instant) cleanup().catch(() => {});
      else await cleanup();
      if (draftTimerRef.current) clearInterval(draftTimerRef.current);
      setSuccess(true);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refresh();
      setTimeout(_leaveAfterSend, opts.instant ? 0 : 450);
    };

    // Fire the send NOW. With undo_delay>0 the backend enqueues for `delay`
    // seconds and returns a send_id we cancel via cancelSend() — so Undo now
    // survives the screen unmounting (no longer a purely local setTimeout).
    (async () => {
      try {
        const toStr = contactsToString(sendTo);
        const ccStr = contactsToString(sendCc);
        const bccStr = contactsToString(sendBcc);
        let finalBody = sendBody;
        // [2026-10-16 pgp-v2] Cifra p/ TODOS os destinatários (Para/Cc/Cco) + o
        // próprio remetente (lê no Enviados); assina se a chave estiver
        // destrancada (services/pgp). Destinatário sem chave pública → NÃO
        // envia (antes caía numa senha aleatória que ninguém recebia quando não
        // havia telefone = e-mail ilegível). Senha por SMS só se o telefone do
        // modo confidencial foi informado.
        if (pgpEncrypt) {
          try {
            const P = await import('../services/pgp');
            const me = String(user?.email || '').toLowerCase();
            const allRcpt = [...(sendTo || []), ...(sendCc || []), ...(sendBcc || [])].map(c => String((typeof c === 'string' ? c : c?.email) || '').trim()).filter(Boolean);
            const plain = P.htmlToPlain(sendBody);
            const r = await P.encryptForRecipients({ me, text: plain, recipients: allRcpt });
            const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            if (!r.missing.length && r.armored) {
              finalBody = `<p style="color:#5f6368;font-size:13px">${t('compose.pgpEncryptedNote')}</p><pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;color:#374151">${esc(r.armored)}</pre>`;
            } else if (confidentialPhone) {
              const pgpMod = await P.loadOpenPGP();
              const rnd = new Uint8Array(10); globalThis.crypto.getRandomValues(rnd);
              const passphrase = Array.from(rnd, b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
              const msg = await pgpMod.createMessage({ text: plain });
              const armored = await pgpMod.encrypt({ message: msg, passwords: [passphrase] });
              const sms = await import('../services/api').then(m => m.pgpSendPassphraseSms(confidentialPhone, passphrase)).catch(() => null);
              if (!sms?.success) throw new Error('pgp_sms_failed');
              finalBody = `<p style="color:#5f6368;font-size:13px">${t('compose.pgpPassphraseNote')}</p><pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;color:#374151">${esc(armored)}</pre>`;
            } else {
              setError(t('compose.pgpMissingKeys', { emails: r.missing.join(', ') }));
              sendingGuardRef.current = false;
              setSending(false);
              return;
            }
          } catch (e) {
            // Fail CLOSED: the user asked for encryption, so a failure here
            // must abort the send — falling through would ship the full body
            // in plaintext.
            console.warn('PGP encrypt failed', e);
            setError(t('compose.errorPgpEncrypt') || 'Falha ao criptografar (PGP). O email NÃO foi enviado — tente de novo ou desligue o PGP.');
            sendingGuardRef.current = false;
            setSending(false);
            return;
          }
        }
        // Confidential mode: stash the real body server-side and replace
        // the email body with a "view confidential" link before sending.
        if (confidential) {
          // Flag pattern (not a return inside the try) so BOTH failure shapes
          // — throw and non-success response — abort instead of leaking the
          // real body into a normal email.
          let confidentialOk = false;
          try {
            const cr = await api.confidentialCreate?.({
              recipient: toStr,
              subject: sendSubject,
              body: sendBody,
              expiry_days: confidentialExpiry,
              passcode: confidentialPasscode,
              sms_phone: confidentialPhone,
            });
            if (cr?.success && cr.data?.view_url) {
              const expDays = confidentialExpiry;
              finalBody = `<div style="padding:18px;border:1px solid #e5e7eb;border-radius:12px;font-family:system-ui;background:#f9fafb">
                <p style="margin:0 0 10px 0;font-weight:600">${t('compose.confidential') || 'Email confidencial'}</p>
                <p style="margin:0 0 14px 0;color:#374151">${(t('compose.confidentialNote') || 'Este email expira em {n} dias.').replace('{n}', expDays)}</p>
                <a href="${cr.data.view_url}" style="display:inline-block;padding:10px 18px;background:#111111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${t('compose.confidentialView') || 'Visualizar email confidencial'}</a>
              </div>`;
              confidentialOk = true;
            }
          } catch {}
          if (!confidentialOk) {
            setError(t('compose.errorConfidential') || 'Falha ao criar o email confidencial. O email NÃO foi enviado — tente de novo ou desligue o modo confidencial.');
            sendingGuardRef.current = false;
            setSending(false);
            return;
          }
        }
        // [2026-10-08 email-outbox] Attachments travel as server ids (already
        // uploaded on pick). Still uploading, device offline, or a network /
        // 5xx failure → hand the message to the durable outbox (same csid, the
        // server dedupes) and close the composer like a normal send.
        const csid = newClientSendId();
        const attsNow = sendAttachments.map(withServerId);
        const uploadsPending = attsNow.some(a => a && !a.is_drive_ref && !a.server_id);
        const toOutbox = async (reason) => {
          await enqueueEmail({
            csid, reason, to: toStr, cc: ccStr, bcc: bccStr, subject: sendSubject, body: finalBody,
            replyUid: params.reply_uid || null, folder: params.folder || 'INBOX', trackOpens, fromAlias,
            undoDelay: delay, attachments: attsNow,
            restore: { to: sendTo, cc: sendCc, bcc: sendBcc, subject: sendSubject, body: sendBody },
          });
          sentRef.current = true;
          try { require('../services/emailUndo').showEmailNotice((reason === 'send' || reason === 'uploading') && !isEmailDeviceOffline() ? 'sending' : 'outbox'); } catch {}
          finishSendSuccess({ instant: true });
        };
        if (uploadsPending || isEmailDeviceOffline()) {
          try { await toOutbox(uploadsPending ? 'uploading' : 'offline'); return; } catch {}
        }
        // [2026-10-17 email-send-gmail] Gmail model for EVERY send: the
        // composer closes as soon as the message is in the durable outbox;
        // the global bar shows "Enviando…" → "Enviada · Desfazer" (server
        // holds it for the undo window via send_id) or "Não enviada · Tentar
        // de novo" (entry stays in the outbox). Same csid = server dedupe.
        // Kill switch: globalThis.__chatyy_email_send_direct = true → old
        // wait-for-POST path below.
        if (!(typeof globalThis !== 'undefined' && globalThis.__chatyy_email_send_direct === true)) {
          try { await toOutbox('send'); return; } catch {}
        }
        let r = null;
        let sendErr = null;
        try {
          r = await sendEmail(toStr, sendSubject, finalBody, ccStr, bccStr, params.reply_uid || null, params.folder || 'INBOX', attsNow, { trackOpens, fromAlias, undoDelay: delay, clientSendId: csid });
        } catch (e) { sendErr = e; }
        const sendKind = classifyEmailSend(r, sendErr);
        if (sendKind === 'offline' || sendKind === 'transient' || sendKind === 'att_expired') {
          try { await toOutbox(sendKind); return; } catch {}
        }
        if (sendErr) throw sendErr;
        if (r && r.success) {
          // Stash the server send_id so the Desfazer button can cancel the
          // queued message backend-side (real undo, not just a local timer).
          const sid = r.data?.send_id || null;
          undoSendIdRef.current = sid;
          if (delay > 0 && sid) {
            // The message is ALREADY queued server-side — it WILL transmit
            // after `delay`s unless cancelled. Flip the sent guard now, not
            // in finishSendSuccess: leaving the screen mid-countdown (Escape/
            // back) ran the unmount flush with sentRef still false, which
            // re-saved the compose as a draft → same email in Sent AND Drafts.
            // cancelUndoSend() reverts this so Desfazer restores draft-ability.
            sentRef.current = true;
            // [2026-10-07 email-instant-send] Gmail model: close the composer
            // NOW; the server keeps holding the message for `delay`s and the
            // global EmailUndoBar (outside this screen) offers Desfazer.
            try {
              require('../services/emailUndo').startEmailUndo({
                sid, seconds: delay,
                restore: { to: sendTo, cc: sendCc, bcc: sendBcc, subject: sendSubject, body: sendBody, attachments: sendAttachments },
              });
              undoSendIdRef.current = null;
              finishSendSuccess({ instant: true });
              return;
            } catch {}
            // Fallback (should not happen): in-screen countdown as before.
            setUndoCountdown(delay);
            const countRef = { value: delay };
            undoIntervalRef.current = setInterval(() => {
              countRef.value -= 1;
              setUndoCountdown(countRef.value);
              if (countRef.value <= 0) clearInterval(undoIntervalRef.current);
            }, 1000);
            undoSendRef.current = setTimeout(() => {
              clearInterval(undoIntervalRef.current);
              setUndoCountdown(0);
              undoSendIdRef.current = null;
              finishSendSuccess();
            }, delay * 1000);
          } else {
            // No undo window (delay 0) — already sent, transition immediately.
            finishSendSuccess();
          }
        } else {
          setError((r && r.message) || t('compose.errorSend'));
          sendingGuardRef.current = false;
          setSending(false);
        }
      } catch (e) {
        setError(t('compose.errorConnection'));
        sendingGuardRef.current = false;
        setSending(false);
      }
    })();
  };

  const handleScheduleSend = async (isoDateString) => {
    // schedule_send não passa pelo pipeline PGP/confidential do doSend —
    // agendar com um dos toggles ligados enviaria o corpo em plaintext.
    // Bloqueia até o backend suportar (fail closed).
    if (pgpEncrypt || confidential) {
      setError(t('compose.errorScheduleProtected') || 'Agendamento não suporta PGP/confidencial. Envie agora ou desligue o recurso.');
      return;
    }
    // Commit typed-but-unchipped recipients, then wait one tick so the
    // value refs pick up the flushed state (same 60ms settle doSend gets
    // via handleSend's setTimeout) — this path never flushed even To.
    toRef.current?.flush();
    ccRef.current?.flush();
    bccRef.current?.flush();
    await new Promise(res => setTimeout(res, 60));
    const schedTo = toValueRef.current;
    const schedCc = ccValueRef.current;
    const schedBcc = bccValueRef.current;
    if (schedTo.length === 0) { setError(t('compose.errorRecipient')); return; }
    if (!body.trim() && !subject.trim()) { setError(t('compose.errorEmpty')); return; }
    // [2026-10-15 email-melhorias] O backend schedule_send grava só texto
    // (sem anexos) — o e-mail agendado saía SEM os anexos, em silêncio.
    // Fail closed até o servidor suportar att_ids no agendamento.
    if (Array.isArray(attachments) && attachments.length > 0) {
      setError(t('compose.errorScheduleAttachments'));
      return;
    }
    setError('');
    setSending(true);
    try {
      // Inclui bloco citado (reply/forward) + anexos para paridade com envio
      // imediato — antes scheduled mandava só body cru e perdia anexos.
      const sendBody = buildQuotedSendBody(body, quotedHeader, quotedHtml);
      const r = await api.apiCall('schedule_send', {
        to: contactsToString(schedTo), subject, body: sendBody,
        cc: contactsToString(schedCc), bcc: contactsToString(schedBcc),
        send_at: isoDateString,
      }, 'POST');
      if (r.success) {
        if (draftTimerRef.current) clearInterval(draftTimerRef.current);
        // [2026-10-15 email-melhorias] Agendado = não é mais rascunho: liga a
        // guarda (o flush do unmount re-salvava o e-mail em Rascunhos) e apaga
        // o rascunho autosalvo (o servidor já guarda a cópia agendada).
        sentRef.current = true;
        contentChangedRef.current = false;
        if (draftUidRef.current) {
          const staleUid = draftUidRef.current;
          draftUidRef.current = null;
          try { api.apiCall('draft_delete', { uid: staleUid }, 'POST').catch(() => {}); } catch {}
        }
        setSuccess(true);
        refresh();
        setTimeout(_leaveAfterSend, 1200);
      } else {
        setError(r.message || t('compose.errorSchedule'));
      }
    } catch (e) {
      setError(t('compose.errorConnection'));
    } finally {
      setSending(false);
    }
  };

  const handleImprove = async () => {
    if (!body.trim()) return;
    setImproving(true);
    try {
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('improve_writing', { text: body, language: 'pt-BR' });
      if (r.success && r.data?.result) {
        setBody(r.data.result);
        setAiImprovedHint(true);
        setTimeout(() => setAiImprovedHint(false), 4000);
      }
    } catch {} finally {
      setImproving(false);
    }
  };

  const handleAIDraft = (draft) => { setBody(draft); setShowAI(false); };

  const handleTemplateSelect = (template) => {
    if (template.subject) setSubject(template.subject);
    if (template.body) setBody(template.body);
  };

  const handleAddAttachment = (file) => setAttachments(prev => [...prev, file]);
  const handleRemoveAttachment = (index) => setAttachments(prev => {
    const gone = prev[index];
    if (gone && gone._akey) { try { cancelAttachUpload(gone._akey); } catch {} }
    return prev.filter((_, i) => i !== index);
  });

  // [2026-10-08 email-outbox] Gmail-style: every attachment starts uploading
  // the moment it lands in the list (picker, forward, Drive, undo/outbox
  // restore) — `send` then only references server ids. Drive refs and
  // already-uploaded items (server_id) register as done without a transfer.
  useEffect(() => {
    if (!attachments.some(a => a && !a._akey)) return;
    setAttachments(prev => prev.map(a => (a && !a._akey) ? { ...a, _akey: startAttachUpload(a) } : a));
  }, [attachments]);
  // Composer discarded (not sent / not handed to the outbox) → stop uploads.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    if (sentRef.current) return;
    (attachmentsRef.current || []).forEach(a => { if (a && a._akey) { try { cancelAttachUpload(a._akey); } catch {} } });
  }, []);

  // Body soft-cap (~100KB of text/HTML). RichTextEditor is not a plain
  // TextInput so we cap on change instead of via maxLength. We slice the raw
  // value (HTML markup included) so a runaway paste can't blow up storage.
  const handleBodyChange = useCallback((next) => {
    if (typeof next === 'string' && next.length > MAX_BODY_LEN) {
      setBody(next.slice(0, MAX_BODY_LEN));
    } else {
      setBody(next);
    }
  }, []);

  // --- Success screen ---
  if (success) {
    return (
      <View style={[s.successContainer, { backgroundColor: colors.background }]}>
        <Animated.View style={[s.successCircle, { backgroundColor: colors.successBg }]}>
          <IconCheckCircle size={48} color={colors.success} />
        </Animated.View>
        <Text style={[s.successText, { color: colors.text }]}>{t('compose.sent')}</Text>
        <Text style={[s.successSub, { color: colors.textSecondary }]}>{t('compose.redirecting')}</Text>
      </View>
    );
  }

  // --- Loading --- Show empty screen briefly while loading reply/draft data
  if (loading) {
    return (
      <View style={[s.successContainer, { backgroundColor: colors.background }]} />
    );
  }

  // Get initials for avatar
  const getInitials = (name, email) => {
    if (name && name.trim()) {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return email ? email.substring(0, 2).toUpperCase() : '?';
      return parts.length >= 2
        ? ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase()
        : parts[0].substring(0, 2).toUpperCase();
    }
    return email ? email.substring(0, 2).toUpperCase() : '?';
  };

  // ── Persistent draft status indicator ──
  // Sits in the header so the user always sees whether the draft is
  // committed. States: idle (nothing) / saving (italic grey) / saved (tick
  // + timestamp) / error.
  const renderDraftStatusIndicator = () => {
    if (draftStatus === 'idle') return null;
    let label = '';
    if (draftStatus === 'saving') {
      label = t('compose.draftSaving');
    } else if (draftStatus === 'saved' && lastSavedAt) {
      const hh = String(lastSavedAt.getHours()).padStart(2, '0');
      const mm = String(lastSavedAt.getMinutes()).padStart(2, '0');
      label = `${t('compose.draftSaved') || 'Rascunho salvo'} ${hh}:${mm}`;
    } else if (draftStatus === 'saved') {
      label = t('compose.draftSaved') || 'Rascunho salvo';
    } else if (draftStatus === 'error') {
      label = t('compose.errorConnection') || 'Erro';
    }
    // Pill styling — header sits on solid black now, raw text disappears.
    // MONOCHROME 2026: saved → white pill (the check icon + label carry the
    // "saved" meaning, no green), saving → translucent-white, error → soft-red
    // (functional). All readable on the solid black header.
    const isSaved = draftStatus === 'saved';
    const isError = draftStatus === 'error';
    // Light-header pills: neutral chip for saved/saving, soft-red for error.
    const pillBg = isError ? 'rgba(220, 38, 38, 0.10)' : colors.surfaceVariant;
    const pillBorder = isError ? 'rgba(220, 38, 38, 0.30)' : colors.border;
    const tickColor = colors.text;
    const labelColor = isError ? colors.error : colors.textSecondary;
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          marginRight: compactHeader ? 0 : 6,
          paddingHorizontal: compactHeader ? 7 : 10,
          paddingVertical: compactHeader ? 6 : 4,
          borderRadius: 12,
          flexShrink: 1,
          backgroundColor: pillBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: pillBorder,
        }}
        accessibilityRole="text"
        accessibilityLabel={label}
      >
        {isSaved && <IconCheckCircle size={12} color={tickColor} />}
        {compactHeader && draftStatus === 'saving' ? <ActivityIndicator size="small" color={colors.textSecondary} style={{ transform: [{ scale: 0.7 }] }} /> : null}
        {compactHeader && !isError ? null : (
        <Text
          numberOfLines={1}
          style={{
            fontSize: 11,
            color: labelColor,
            fontStyle: draftStatus === 'saving' ? 'italic' : 'normal',
            fontWeight: '600',
            letterSpacing: 0.2,
            maxWidth: compactHeader ? 96 : 180,
          }}
        >
          {compactHeader && isError ? '!' : label}
        </Text>
        )}
      </View>
    );
  };

  // Inline note: the backend draft (draft_save) only stores headers + body —
  // it has no MIME attachment parts. So when the user has attachments AND the
  // draft is being autosaved, warn that the attachments themselves won't be in
  // the saved draft (they must actually send the email to keep them). Avoids
  // the "I saved a draft, where did my files go?" surprise.
  const renderAttachmentDraftWarning = () => {
    if (attachments.length === 0) return null;
    const draftActive = draftStatus === 'saving' || draftStatus === 'saved' || !!draftUidRef.current;
    if (!draftActive) return null;
    const msg = t('compose.attachmentsNotSaved') || 'Anexos não são salvos no rascunho';
    return (
      <View
        style={{
          marginTop: 6,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 8,
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: 'rgba(245, 158, 11, 0.45)',
        }}
        accessibilityRole="text"
        accessibilityLabel={msg}
      >
        <Text style={{ fontSize: 11, color: colors.warning, fontWeight: '600' }}>{msg}</Text>
      </View>
    );
  };

  // ── Shared: Undo / Draft / Error bars ──
  const renderStatusBars = () => (
    <>
      {undoCountdown > 0 && (
        <Animated.View style={[s.undoBar, { backgroundColor: colors.toastBg, opacity: undoOpacity }]}>
          <View style={s.undoCountdownCircle}>
            <View style={[s.undoCircleBg, { borderColor: colors.onPrimary }]} />
            {Platform.OS === 'web' && (
              <View style={[s.undoCircleProgress, {
                background: `conic-gradient(${colors.primary} ${(undoCountdown / undoDelayRef.current) * 360}deg, transparent 0deg)`,
                WebkitMaskImage: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 3px))',
                maskImage: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 3px))',
                transition: 'background 0.3s linear',
              }]} />
            )}
            <Text style={[s.undoCountdownText, { color: colors.onPrimary }]}>{undoCountdown}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 4 }}>
            <Text style={[s.undoText, { color: colors.onPrimary }]}>{t('compose.undoSending', { n: undoCountdown })}</Text>
            <Text style={[s.undoSubText, { color: colors.onPrimary, opacity: 0.6 }]}>{t('compose.undoTapCancel')}</Text>
          </View>
          {/* toastBg inverts with the theme (dark #2A2C30 in light mode, light
              #F5F5F7 in dark mode) — ink follows via onPrimary, which inverts
              the same way. Hardcoded white text vanished in dark mode. */}
          <TouchableOpacity onPress={cancelUndoSend} style={[s.undoBtn, { backgroundColor: colors.primaryLight, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel={t('undo.button')}>
            <Text style={[s.undoBtnText, { color: colors.text }]}>{t('undo.button')}</Text>
          </TouchableOpacity>
          {/* Progress bar shrinking from right to left */}
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.08)', borderBottomLeftRadius: 16, borderBottomRightRadius: 16, overflow: 'hidden' }}>
            <View style={Platform.OS === 'web' ? {
              height: 3,
              backgroundColor: colors.primary,
              width: `${(undoCountdown / undoDelayRef.current) * 100}%`,
              transition: 'width 1s linear',
              borderRadius: 2,
            } : {
              height: 3,
              backgroundColor: colors.primary,
              width: `${(undoCountdown / undoDelayRef.current) * 100}%`,
              borderRadius: 2,
            }} />
          </View>
        </Animated.View>
      )}
      {draftSaved && !undoCountdown && (
        <Animated.View style={[s.draftBar, { backgroundColor: colors.successBg, opacity: draftOpacity }]}>
          <Text style={[s.draftText, { color: colors.success }]}>{t('compose.draftSaved')}</Text>
        </Animated.View>
      )}
      {!!error && (
        <View style={[s.errorBar, { backgroundColor: colors.errorBg }]}>
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}
      {/* Reply-All external-recipient warning — pre-send heads-up so the user
          doesn't accidentally CC a customer/competitor in a long thread. */}
      {externalWarning && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          backgroundColor: colors.surfaceVariant,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, borderLeftColor: colors.text, borderRadius: 12,
          marginHorizontal: Spacing.md, marginTop: Spacing.sm, padding: 12,
        }}>
          <Text style={{ fontSize: 13, color: colors.text, flex: 1 }}>
            {(t('compose.externalWarning') || 'Você está respondendo a {n} pessoas, incluindo {x} externos. Continuar?')
              .replace('{n}', String(externalWarning.totalCount))
              .replace('{x}', String(externalWarning.externalCount))}
            {'\n'}
            <Text style={{ fontSize: 11, color: colors.textSecondary }}>{externalWarning.externalAddrs.join(', ')}{externalWarning.externalCount > 3 ? ' …' : ''}</Text>
          </Text>
          <TouchableOpacity
            onPress={() => setExternalWarning(null)}
            style={{ paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: 8, backgroundColor: colors.primary }}
            accessibilityLabel={t('compose.externalAck') || 'OK, continuar'}
            accessibilityRole="button"
          >
            <Text style={{ color: colors.onPrimary, fontSize: 12, fontWeight: '700' }}>
              {t('compose.externalAck') || 'OK'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );

  // ── Shared: CC/BCC toggle buttons ──
  const renderCcBccToggle = () => (
    (!showCc || !showBcc) ? (
      <View style={s.ccBtns}>
        {!showCc && (
          <TouchableOpacity
            onPress={() => { animateLayout(); setShowCc(true); }}
            style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}
            accessibilityLabel={t('compose.addCc') || 'Add Cc'}
            accessibilityRole="button"
          >
            <Text style={[s.ccToggle, { color: colors.textSecondary }]}>Cc</Text>
          </TouchableOpacity>
        )}
        {!showBcc && (
          <TouchableOpacity
            onPress={() => { animateLayout(); setShowBcc(true); }}
            style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}
            accessibilityLabel={t('compose.addBcc') || 'Add Bcc'}
            accessibilityRole="button"
          >
            <Text style={[s.ccToggle, { color: colors.textSecondary }]}>{t('compose.bcc')}</Text>
          </TouchableOpacity>
        )}
      </View>
    ) : null
  );

  // ── Shared: Bottom toolbar with AI/Improve/Meet buttons ──
  const renderToolbar = (showMeet = false) => (
    <View style={[s.bottomBar, { borderTopColor: colors.borderLight, backgroundColor: colors.surface }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.toolbarInner} keyboardShouldPersistTaps="handled">
        <TouchableOpacity
          onPress={() => setShowAI(true)}
          style={[
            s.toolBtn,
            s.aiBtnHalo,
            { backgroundColor: colors.surfaceVariant, borderColor: colors.border },
          ]}
          accessibilityLabel={showMeet ? t('compose.writeWithAI') : t('compose.ai')}
          accessibilityRole="button"
        >
          <BiaIcon size={14} color={colors.primary} />
          <Text style={[s.toolBtnText, { color: colors.primary }]}>{showMeet ? t('compose.writeWithAI') : t('compose.ai')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleImprove}
          style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, borderColor: improving ? colors.text : 'transparent' }]}
          disabled={improving}
          accessibilityLabel={t('compose.improveText')}
          accessibilityRole="button"
        >
          {improving ? (
            <>
              <SpinningSparkle size={13} color={colors.primary} />
              <Text style={[s.toolBtnText, { color: colors.primary }]}>{t('compose.improving') || t('compose.improveText')}</Text>
            </>
          ) : (
            <>
              <BiaIcon size={13} color={colors.textSecondary} />
              <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>{t('compose.improveText')}</Text>
            </>
          )}
        </TouchableOpacity>
        {aiImprovedHint && (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            backgroundColor: colors.primary + '15',
            borderRadius: 12,
            paddingHorizontal: 10, paddingVertical: 4,
            marginLeft: 4, alignSelf: 'center',
          }}>
            <BiaIcon size={12} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>
              {t('compose.aiImproved') || 'Texto melhorado'}
            </Text>
          </View>
        )}
        {/* Visual divider — separates AI cluster from action toggles */}
        <View style={[s.toolDivider, { backgroundColor: colors.borderLight }]} />
        {showMeet && (
          <TouchableOpacity
            onPress={async () => {
              try {
                const r = await api.apiCall('meet_create', { title: subject || t('compose.defaultMeetTitle') }, 'POST');
                if (r.success && r.data?.room_id) {
                  const meetUrl = `https://chatyy.com.br/meet/${r.data.room_id}`; // Keep chatyy.com.br - this URL goes in the email body for recipients to click. [2026-10-15 meet-v2] rota do app (room.html?id= sem token não autenticava → sala vazia)
                  const meetBlock = `\n\n<div style="background:#F1F3F5;border:1px solid #F1F3F5;border-radius:12px;padding:16px;margin:8px 0"><strong style="font-size:15px">Chatyy Meet</strong><br/><p style="margin:8px 0;color:#64748b;font-size:13px">${t('compose.meetJoinLabel')}</p><a href="${meetUrl}" style="color:#111111;font-weight:600">${meetUrl}</a></div>\n`;
                  setBody(prev => prev + meetBlock);
                }
              } catch {}
            }}
            style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]}
            accessibilityLabel={t('compose.meet') || 'Meet'}
            accessibilityRole="button"
          >
            <IconFilm size={13} color={colors.textSecondary} />
            <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>{t('compose.meet') || 'Meet'}</Text>
          </TouchableOpacity>
        )}
        {/* Read-receipt opt-in (Confirmar leitura) */}
        <TouchableOpacity
          onPress={() => persistTrackOpens(!trackOpens)}
          style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, borderColor: trackOpens ? colors.text : 'transparent' }]}
          accessibilityLabel={t('compose.trackOpens')}
          accessibilityRole="button"
          accessibilityState={{ checked: trackOpens }}
        >
          {trackOpens ? <IconCheck size={13} color={colors.primary} /> : null}
          <Text style={[s.toolBtnText, { color: trackOpens ? colors.text : colors.textSecondary }]}>
            {t('compose.trackOpens') || 'Confirmar leitura'}
          </Text>
        </TouchableOpacity>
        {/* Visual divider — toggles cluster (read receipts + confidential) */}
        <View style={[s.toolDivider, { backgroundColor: colors.borderLight }]} />
        {/* Confidential mode toggle */}
        <TouchableOpacity
          onPress={() => setConfidentialModal(true)}
          style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, borderColor: confidential ? colors.text : 'transparent' }]}
          accessibilityLabel={t('compose.confidential') || 'Modo confidencial'}
          accessibilityRole="button"
          accessibilityState={{ checked: confidential }}
        >
          {confidential ? <IconLock size={13} color={colors.primary} /> : null}
          <Text style={[s.toolBtnText, { color: confidential ? colors.text : colors.textSecondary }]}>
            {t('compose.confidential') || 'Confidencial'}
            {confidential ? ` · ${confidentialExpiry}d` : ''}
          </Text>
        </TouchableOpacity>
        {/* PGP encryption toggle (round-6 gap-closer) */}
        <TouchableOpacity
          onPress={() => setPgpEncrypt(v => !v)}
          style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, borderColor: pgpEncrypt ? colors.text : 'transparent' }]}
          accessibilityLabel={t('compose.pgpEncrypt') || 'Criptografar com PGP'}
          accessibilityRole="button"
          accessibilityState={{ checked: pgpEncrypt }}
        >
          {pgpEncrypt ? <IconLock size={13} color={colors.primary} /> : null}
          <Text style={[s.toolBtnText, { color: pgpEncrypt ? colors.text : colors.textSecondary }]}>
            {t('compose.pgpEncrypt') || 'Criptografar'}
          </Text>
        </TouchableOpacity>
        {/* Send & Archive toggle — only meaningful when replying. Sticky pref
            persisted under send_and_archive_default. */}
        {isReply && (
          <TouchableOpacity
            onPress={() => {
              const next = !sendAndArchive;
              setSendAndArchive(next);
              if (Platform.OS === 'web') {
                try { typeof localStorage !== 'undefined' && localStorage.setItem('send_and_archive_default', next ? '1' : '0'); } catch {}
              } else {
                import('@react-native-async-storage/async-storage').then(m => {
                  m.default.setItem('send_and_archive_default', next ? '1' : '0').catch(() => {});
                }).catch(() => {});
              }
            }}
            style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, borderColor: sendAndArchive ? colors.text : 'transparent' }]}
            accessibilityLabel={t('compose.sendAndArchive') || 'Enviar e arquivar'}
            accessibilityRole="button"
            accessibilityState={{ checked: sendAndArchive }}
          >
            <IconArchive size={13} color={sendAndArchive ? colors.primary : colors.textSecondary} />
            <Text style={[s.toolBtnText, { color: sendAndArchive ? colors.text : colors.textSecondary }]}>
              {t('compose.sendAndArchive') || 'Enviar + Arquivar'}
            </Text>
          </TouchableOpacity>
        )}
        {/* URL preview insert — appears when backend returned a valid og:* card
            for the most-recent URL in the body. */}
        {(urlPreview || urlPreviewLoading) && (
          <TouchableOpacity
            onPress={insertUrlPreviewCard}
            disabled={!urlPreview}
            style={[s.toolBtn, { backgroundColor: colors.surfaceVariant, opacity: urlPreview ? 1 : 0.5 }]}
            accessibilityLabel={t('compose.insertUrlPreview') || 'Inserir preview'}
            accessibilityRole="button"
          >
            {!urlPreviewLoading && <IconLink size={13} color={colors.primary} />}
            <Text style={[s.toolBtnText, { color: colors.primary }]}>
              {urlPreviewLoading ? (t('compose.urlPreviewLoading') || 'Carregando preview...') : (t('compose.insertUrlPreview') || 'Inserir preview')}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );

  // ── Send button component ──
  // Press scale to 0.97 on press-in with spring release for a tactile,
  // weight-bearing CTA. Brand shadow already lives in s.sendBtn — the press
  // anim layers on top without touching elevation/shadow.
  const renderSendButton = (size = 'default') => (
    <SendButton
      size={size === 'default' && compactHeader ? 'compact' : size}
      sending={sending}
      onPress={handleSend}
      onLongPress={() => { if (!sending) setShowSendOptions(true); }}
      colors={colors}
      label={t('compose.send')}
    />
  );

  // Long-press Send → presets (1h / amanhã 8h / custom). Picking a preset
  // calls handleScheduleSend with the computed ISO timestamp (same path the
  // existing /schedule_send button uses).
  const SendOptionsSheet = () => {
    if (!showSendOptions) return null;
    const choose = (offsetMs, useTomorrow8) => {
      let target;
      if (useTomorrow8) {
        const t2 = new Date();
        t2.setDate(t2.getDate() + 1);
        t2.setHours(8, 0, 0, 0);
        target = t2;
      } else {
        target = new Date(Date.now() + offsetMs);
      }
      setShowSendOptions(false);
      handleScheduleSend(target.toISOString());
    };
    return (
      <View style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end',
        zIndex: 9999,
      }}>
        <TouchableOpacity
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
          activeOpacity={1}
          onPress={() => setShowSendOptions(false)}
        />
        <View style={{
          backgroundColor: colors.background, borderTopLeftRadius: 16, borderTopRightRadius: 16,
          paddingTop: 8, paddingBottom: insets.bottom + 24, paddingHorizontal: 0,
        }}>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderLight }} />
          </View>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, paddingHorizontal: 20, paddingVertical: 8, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {t('compose.scheduleSend') || 'Agendar envio'}
          </Text>
          <TouchableOpacity
            style={{ paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}
            onPress={() => { setShowSendOptions(false); handleSend(); }}
          >
            <IconSend size={18} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>{t('compose.sendNow') || 'Enviar agora'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}
            onPress={() => choose(60 * 60 * 1000, false)}
          >
            <IconClock size={18} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>{t('compose.sendIn1h') || 'Em 1 hora'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}
            onPress={() => choose(0, true)}
          >
            <IconClock size={18} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>{t('compose.sendTomorrow') || 'Amanhã às 8h'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}
            onPress={() => { setShowSendOptions(false); setShowSchedule(true); }}
          >
            <IconClock size={18} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '600' }}>{t('compose.sendCustom') || 'Escolher data e hora'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ════════════════════════════════════════════
  //  REPLY / REPLY ALL MODE
  // ════════════════════════════════════════════
  if (isReply) {
    const senderName = origMsg?.from_name || origMsg?.from || '';
    const senderEmail = origMsg?.from || '';
    const origDate = formatShortDate(origMsg?.date);
    const origSubject = origMsg?.subject || subject;

    return (
      // [2026-10-20 tg-modal] arrastar o topo p/ baixo fecha; o rascunho é salvo pelo flush da desmontagem.
      <RouteDragDismiss zone={insets.top + HEADER_HEIGHT} enabled={!!router.canGoBack?.()} onDismiss={() => router.back()}>
      <KeyboardSafeView
        style={[s.flex, { backgroundColor: colors.background }]}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + HEADER_HEIGHT : 0}
      >
        <View style={[s.container, { paddingTop: insets.top }]}>
          {/* Header — clean WHITE bar, dark iconography (2026 light) */}
          <View style={[s.header, { backgroundColor: colors.headerBgSolid, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
            <TouchableOpacity onPress={handleClose} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <IconArrowLeft size={20} color={colors.text} />
            </TouchableOpacity>
            <View style={s.headerTitleCol}>
              <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
                {isReplyAll ? t('compose.replyAll') : t('compose.reply')}
              </Text>
              <Text style={[s.headerSubject, { color: colors.textSecondary }]} numberOfLines={1}>
                {origSubject}
              </Text>
            </View>
            <View style={s.headerRight}>
              {renderDraftStatusIndicator()}
              {renderSendButton()}
            </View>
          </View>

          {renderStatusBars()}

          <ScrollView
            style={s.form}
            contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.md }}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
          >
            {/* ── Original Message Card (read-only) ── */}
            <View style={[s.origCard, { backgroundColor: colors.surface }, Platform.OS === 'web' && s.origCardWeb]}>
              <View style={s.origHeader}>
                <View style={[s.origAvatar, { backgroundColor: colors.primaryLight }]}>
                  <Text style={[s.origAvatarText, { color: colors.primary }]}>
                    {getInitials(senderName, senderEmail)}
                  </Text>
                </View>
                <View style={s.origMeta}>
                  <Text style={[s.origSender, { color: colors.text }]} numberOfLines={1}>
                    {senderName || senderEmail}
                  </Text>
                  <Text style={[s.origDate, { color: colors.textSecondary }]}>{origDate}</Text>
                </View>
              </View>

              {/* Original body preview */}
              {quotedHtml ? (
                <View style={s.origBodyWrap}>
                  {!showQuote && (
                    <Text style={[s.origSnippet, { color: colors.textSecondary }]} numberOfLines={3}>
                      {quotedHtml.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()}
                    </Text>
                  )}
                  <TouchableOpacity
                    onPress={() => setShowQuote(!showQuote)}
                    style={[s.showMoreBtn, { backgroundColor: colors.primary + '12' }]}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.showMoreText, { color: colors.textSecondary }]}>
                      {showQuote ? t('compose.hide') : '...'}
                    </Text>
                  </TouchableOpacity>
                  {showQuote && Platform.OS === 'web' && (
                    <div
                      style={{
                        fontSize: 14,
                        lineHeight: '1.6',
                        color: colors.textSecondary,
                        marginTop: 12,
                        wordBreak: 'break-word',
                        overflow: 'auto',
                        maxHeight: 500,
                      }}
                      dangerouslySetInnerHTML={{ __html: quotedHtml }}
                    />
                  )}
                  {showQuote && Platform.OS !== 'web' && (isQuoteHtmlOn() ? (
                    <QuotedHtmlView html={quotedHtml} colors={colors} isDark={isDark} />
                  ) : (
                    <Text style={[s.origFullText, { color: colors.textSecondary }]} selectable>
                      {quotedHtml.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>

            {/* ── Reply Box ── */}
            <View style={[s.replyCard, { backgroundColor: colors.surface }, Platform.OS === 'web' && s.replyCardWeb]}>
              {/* To field (compact for reply) */}
              <View style={[s.replyFieldRow, { borderBottomColor: colors.borderLight, zIndex: 30 }]}>
                <View style={s.contactFieldInner}>
                  <ContactAutocomplete
                    ref={toRef}
                    value={to}
                    onChange={setTo}
                    placeholder={t('compose.recipientPlaceholder')}
                    label={t('compose.to')}
                  />
                </View>
                {renderCcBccToggle()}
              </View>

              {showCc && (
                <View style={[s.replyFieldRow, { borderBottomColor: colors.borderLight, zIndex: 20 }]}>
                  <ContactAutocomplete ref={ccRef} value={cc} onChange={setCc} placeholder="cc@email.com" label={t('compose.cc')} />
                </View>
              )}
              {showBcc && (
                <View style={[s.replyFieldRow, { borderBottomColor: colors.borderLight, zIndex: 10 }]}>
                  <ContactAutocomplete ref={bccRef} value={bcc} onChange={setBcc} placeholder="bcc@email.com" label={t('compose.bcc')} />
                </View>
              )}

              {/* Reply body editor */}
              <View style={s.replyBodyContainer}>
                <RichTextEditor
                  value={body}
                  onChange={handleBodyChange}
                  placeholder={t('compose.replyWritePlaceholder')}
                  minHeight={180}
                />
                <AISmartCompose
                  bodyText={body}
                  subject={subject}
                  colors={colors}
                  onAccept={(text) => setBody(prev => prev + text)}
                  mode={isForward ? 'forward' : (isReply ? 'reply' : 'compose')}
                  replyContext={origMsg ? {
                    from: origMsg.from_name || origMsg.from,
                    subject: origMsg.subject,
                    body: origMsg.body_text || origMsg.body_html?.replace(/<[^>]+>/g, ' '),
                  } : null}
                />
              </View>

              {/* Attachments */}
              <View style={s.attachmentSection}>
                <AttachmentPicker
                  attachments={attachments}
                  onAdd={handleAddAttachment}
                  onRemove={handleRemoveAttachment}
                  maxFiles={10}
                  maxSize={50 * 1024 * 1024}
                />
                {renderAttachmentDraftWarning()}
              </View>

              {/* Reply toolbar */}
              {renderToolbar(false)}
            </View>
          </ScrollView>
        </View>

        <AIComposeModal visible={showAI} onClose={() => setShowAI(false)} onUseDraft={handleAIDraft} />
        <ScheduleSendModal visible={showSchedule} onClose={() => setShowSchedule(false)} onSchedule={handleScheduleSend} />
        <ConfidentialOptionsModal
          visible={confidentialModal}
          onClose={() => setConfidentialModal(false)}
          confidential={confidential}
          setConfidential={setConfidential}
          expiry={confidentialExpiry}
          setExpiry={setConfidentialExpiry}
          passcode={confidentialPasscode}
          setPasscode={setConfidentialPasscode}
          phone={confidentialPhone}
          setPhone={setConfidentialPhone}
          insetsBottom={insets.bottom}
          colors={colors}
          t={t}
        />
        <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
        <SendOptionsSheet />
      </KeyboardSafeView>
      </RouteDragDismiss>
    );
  }

  // ════════════════════════════════════════════
  //  COMPOSE / FORWARD MODE — Modern Design
  // ════════════════════════════════════════════
  return (
    // [2026-10-20 tg-modal] arrastar o topo p/ baixo fecha; o rascunho é salvo pelo flush da desmontagem.
    <RouteDragDismiss zone={insets.top + HEADER_HEIGHT} enabled={!!router.canGoBack?.()} onDismiss={() => router.back()}>
    <KeyboardSafeView
      style={[s.flex, { backgroundColor: colors.background }]}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + HEADER_HEIGHT : 0}
    >
      <View style={[s.container, { paddingTop: insets.top }]}>
        {/* ── Modern Header — clean WHITE bar, dark iconography (2026 light) ── */}
        {/* [2026-10-17 p2] celular (<480): título "Nova mensagem" saía "Nova me…"
            (rascunho + 2 ícones + Enviar comiam a barra) → barra compacta:
            padding/gaps menores, ícones 32, Enviar mais estreito, título com
            largura mínima garantida. */}
        <View style={[s.header, { flex: undefined, marginLeft: 0, backgroundColor: colors.headerBgSolid, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }, compactHeader && s.headerCompact]}>
          <TouchableOpacity onPress={handleClose} style={[s.backBtn, compactHeader && s.backBtnCompact]} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: colors.text, flex: 1, flexShrink: 1, minWidth: compactHeader ? 116 : 0, marginLeft: compactHeader ? 2 : Spacing.sm }, compactHeader && { fontSize: 16, letterSpacing: -0.5 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {isForward ? t('compose.forward') : t('compose.title')}
          </Text>
          <View style={[s.headerRight, compactHeader && { gap: 4 }]}>
            {renderDraftStatusIndicator()}
            <TouchableOpacity onPress={() => setShowSchedule(true)} style={[s.headerActionBtn, compactHeader && s.headerActionBtnCompact, { backgroundColor: colors.surfaceVariant }]} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} accessibilityRole="button" accessibilityLabel={t('compose.scheduleSend')}>
              <IconClock size={16} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowTemplates(true)} style={[s.headerActionBtn, compactHeader && s.headerActionBtnCompact, { backgroundColor: colors.surfaceVariant }]} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} accessibilityRole="button" accessibilityLabel={t('compose.templates')}>
              <IconFileText size={16} color={colors.text} />
            </TouchableOpacity>
            {renderSendButton()}
          </View>
        </View>

        {renderStatusBars()}

        {/* ── Compose Form ── */}
        <ScrollView
          style={s.form}
          contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.md }}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
        >
          <View style={[s.composeCard, { backgroundColor: colors.surface }, Platform.OS === 'web' && s.composeCardWeb]}>
            {/* From — dropdown when the user has >1 verified send-as aliases. */}
            <View style={[s.fieldRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.fieldLabel, { color: colors.textTertiary }]}>{t('compose.from')}</Text>
              {aliases.length > 1 ? (
                <View style={{ flex: 1 }}>
                  <TouchableOpacity
                    onPress={() => setShowAliasMenu(v => !v)}
                    style={[s.fromPill, { backgroundColor: colors.surfaceVariant, borderColor: 'transparent' }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('compose.fromAlias') || 'From'}
                  >
                    <View style={[s.fromDot, { backgroundColor: colors.primary }]} />
                    <Text style={[s.fromText, { color: colors.text }]} numberOfLines={1}>
                      {fromAlias || user?.email}
                    </Text>
                    {showAliasMenu
                      ? <IconChevronUp size={12} color={colors.textSecondary} style={{ marginLeft: 6 }} />
                      : <IconChevronDown size={12} color={colors.textSecondary} style={{ marginLeft: 6 }} />}
                  </TouchableOpacity>
                  {showAliasMenu && (
                    <View style={{ marginTop: 6, backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1, borderRadius: 8, overflow: 'hidden' }}>
                      {aliases.map((a) => (
                        <TouchableOpacity
                          key={a.alias_email}
                          onPress={() => { setFromAlias(a.alias_email); setShowAliasMenu(false); }}
                          style={{ paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: a.alias_email === fromAlias ? colors.primaryLight : 'transparent' }}
                        >
                          <View style={[s.fromDot, { backgroundColor: a.alias_email === fromAlias ? colors.primary : colors.borderLight }]} />
                          <Text style={{ color: colors.text, fontSize: 13, flex: 1 }} numberOfLines={1}>
                            {a.display_name ? `${a.display_name} <${a.alias_email}>` : a.alias_email}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              ) : (
                <View style={[s.fromPill, { backgroundColor: colors.surfaceVariant, borderColor: 'transparent' }]}>
                  <View style={[s.fromDot, { backgroundColor: colors.primary }]} />
                  <Text style={[s.fromText, { color: colors.text }]} numberOfLines={1}>{fromAlias || user?.email}</Text>
                </View>
              )}
            </View>

            {/* To */}
            <View style={[s.contactFieldRow, { borderBottomColor: colors.borderLight, zIndex: 30 }]}>
              <View style={s.contactFieldInner}>
                <ContactAutocomplete
                  ref={toRef}
                  value={to}
                  onChange={setTo}
                  placeholder={t('compose.recipientPlaceholder')}
                  label={t('compose.to')}
                />
              </View>
              {renderCcBccToggle()}
            </View>

            {showCc && (
              <View style={[s.contactFieldRow, { borderBottomColor: colors.borderLight, zIndex: 20 }]}>
                <ContactAutocomplete ref={ccRef} value={cc} onChange={setCc} placeholder="cc@email.com" label={t('compose.cc')} />
              </View>
            )}
            {showBcc && (
              <View style={[s.contactFieldRow, { borderBottomColor: colors.borderLight, zIndex: 10 }]}>
                <ContactAutocomplete ref={bccRef} value={bcc} onChange={setBcc} placeholder="bcc@email.com" label={t('compose.bcc')} />
              </View>
            )}

            {/* Subject — Floating-label card */}
            <SubjectField
              value={subject}
              onChangeText={setSubject}
              placeholder={t('compose.subjectPlaceholder')}
              label={t('compose.subject') || 'Assunto'}
              colors={colors}
            />

            {/* Body — Card with rich text. Subtle brand-tinted shadow gives
                the editor surface a feeling of "live focus" without needing
                JS focus state from RichTextEditor (which doesn't expose
                onFocus/onBlur). Border still rests on borderLight so it's
                not aggressive in the unfocused state. */}
            <View style={[
              s.bodyCard,
              {
                // [2026-10-13 redesign P&B] sem sombra/halo: borda fina só.
                borderColor: colors.border,
                backgroundColor: colors.surface,
              },
            ]}>
              <RichTextEditor
                value={body}
                onChange={handleBodyChange}
                placeholder={t('compose.bodyPlaceholder') || 'Comece a escrever...'}
                minHeight={quotedHtml ? 280 : 360}
                cardMode
              />
            </View>
            <View style={s.bodyMetaRow}>
              <Text style={[s.bodyMetaText, { fontSize: 12, color: colors.text, opacity: 0.55 }]}>
                {(body || '').replace(/<[^>]*>/g, '').length} {t('compose.characters') || 'caracteres'}
              </Text>
            </View>
            <AISmartCompose
              bodyText={body}
              subject={subject}
              colors={colors}
              onAccept={(text) => setBody(prev => prev + text)}
              mode={isForward ? 'forward' : 'compose'}
              replyContext={isForward && origMsg ? {
                from: origMsg.from_name || origMsg.from,
                subject: origMsg.subject,
                body: origMsg.body_text || origMsg.body_html?.replace(/<[^>]+>/g, ' '),
              } : null}
            />

            {/* Forward: quoted original (read-only, collapsible) */}
            {!!quotedHtml && (
              <View style={[s.quoteSection, { borderTopColor: colors.borderLight }]}>
                <TouchableOpacity
                  onPress={() => setShowQuote(!showQuote)}
                  style={[s.showMoreBtn, { backgroundColor: colors.primary + '12', alignSelf: 'flex-start', marginLeft: Spacing.xl, marginVertical: Spacing.sm }]}
                  activeOpacity={0.7}
                >
                  <Text style={[s.showMoreText, { color: colors.textSecondary }]}>
                    {showQuote ? t('compose.hide') : '...'}
                  </Text>
                </TouchableOpacity>
                {showQuote && (
                  <View style={s.quoteContent}>
                    {!!quotedHeader && (
                      <Text style={[s.quoteHeader, { color: colors.textTertiary }]}>{quotedHeader}</Text>
                    )}
                    {Platform.OS === 'web' ? (
                      <div
                        style={{
                          fontSize: 14, lineHeight: '1.6', color: colors.textSecondary,
                          borderLeft: '3px solid ' + (colors.borderLight || '#dadce0'),
                          paddingLeft: 16, marginTop: 8, overflow: 'auto', maxHeight: 400,
                          wordBreak: 'break-word',
                        }}
                        dangerouslySetInnerHTML={{ __html: quotedHtml }}
                      />
                    ) : isQuoteHtmlOn() ? (
                      <View style={[s.quoteBody, { borderLeftColor: colors.borderLight, paddingVertical: 0 }]}>
                        <QuotedHtmlView html={quotedHtml} colors={colors} isDark={isDark} />
                      </View>
                    ) : (
                      <View style={[s.quoteBody, { borderLeftColor: colors.borderLight }]}>
                        <Text style={[s.quoteBodyText, { color: colors.textSecondary }]} numberOfLines={50}>
                          {quotedHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}

            {/* Attachments */}
            <View style={s.attachmentSection}>
              <AttachmentPicker
                attachments={attachments}
                onAdd={handleAddAttachment}
                onRemove={handleRemoveAttachment}
                maxFiles={10}
                maxSize={50 * 1024 * 1024}
              />
              {renderAttachmentDraftWarning()}
            </View>

            {/* Bottom toolbar */}
            {renderToolbar(true)}
          </View>
        </ScrollView>
      </View>

      <AIComposeModal visible={showAI} onClose={() => setShowAI(false)} onUseDraft={handleAIDraft} />
      <ScheduleSendModal visible={showSchedule} onClose={() => setShowSchedule(false)} onSchedule={handleScheduleSend} />
      <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
      <SendOptionsSheet />

      {/* AI Leak Warning (password/CPF/card detected) */}
      {leakWarning && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.6)', justifyContent:'center', alignItems:'center', padding:20, zIndex:9999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
            <View style={{ flexDirection:'row', alignItems:'center', gap:6, marginBottom:8 }}>
              <IconLock size={18} color={colors.error} />
              <Text style={{ fontSize:18, fontWeight:'700', color:colors.error, flexShrink:1 }}>{t('compose.leakWarning') || 'Informação sensível detectada'}</Text>
            </View>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:8 }}>
              {leakWarning.warning}
            </Text>
            {leakWarning.types?.length > 0 && (
              <View style={{ flexDirection:'row', flexWrap:'wrap', gap:6, marginBottom:16 }}>
                {leakWarning.types.map((t, i) => (
                  <View key={i} style={{ backgroundColor:colors.errorBg, paddingHorizontal:8, paddingVertical:4, borderRadius:4 }}>
                    <Text style={{ fontSize:11, color:colors.error, fontWeight:'600' }}>{t}</Text>
                  </View>
                ))}
              </View>
            )}
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => { setLeakWarning(null); setSending(false); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}>
                <Text style={{ color:colors.text, fontWeight:'600' }}>{t('compose.edit') || 'Editar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setLeakWarning(null); setTimeout(() => doSend(), 60); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.error, alignItems:'center' }}>
                <Text style={{ color:'#fff', fontWeight:'600' }}>{t('compose.sendAnyway') || 'Enviar mesmo'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* AI Tone Warning */}
      {toneWarning && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.5)', justifyContent:'center', alignItems:'center', padding:20, zIndex:9999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
            <View style={{ flexDirection:'row', alignItems:'center', gap:6, marginBottom:8 }}>
              <IconAlertTriangle size={18} color={colors.error} />
              <Text style={{ fontSize:18, fontWeight:'700', color:colors.error, flexShrink:1 }}>{t('compose.toneWarning') || 'Tom detectado'}: {toneWarning.tone}</Text>
            </View>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:16 }}>
              {(t('compose.toneWarningBody') || 'Sua mensagem soa {tone} (intensidade {score}/100). Recomendamos revisar antes de enviar.')
                .replace('{tone}', toneWarning.tone === 'hostile' ? (t('compose.toneHostile') || 'hostil') : toneWarning.tone === 'angry' ? (t('compose.toneAngry') || 'irritada') : (t('compose.toneAggressive') || 'agressiva'))
                .replace('{score}', String(toneWarning.score))}
            </Text>
            {toneWarning.suggestion ? (
              <View style={{ backgroundColor:colors.background, padding:12, borderRadius:8, marginBottom:16 }}>
                <Text style={{ fontSize:12, color:colors.textSecondary, marginBottom:4 }}>{t('compose.toneSuggestion')}</Text>
                <Text style={{ fontSize:14, color:colors.text }}>{toneWarning.suggestion}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => { setToneWarning(null); setSending(false); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}>
                <Text style={{ color:colors.text, fontWeight:'600' }}>{t('compose.edit') || 'Editar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSendAnyway} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.error, alignItems:'center' }}>
                <Text style={{ color:'#fff', fontWeight:'600' }}>{t('compose.sendAnyway') || 'Enviar mesmo'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </KeyboardSafeView>
    </RouteDragDismiss>
  );
}

// ════════════════════════════════════════════
//  STYLES — Modern, Clean, Glassmorphism
// ════════════════════════════════════════════
const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },

  // ── Header ──
  // 2026 LIGHT: clean WHITE bar with a light hairline divider and a whisper of
  // elevation (background + border come from theme tokens inline). Dark text +
  // icons ride on top; black lives only in the send CTA.
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, height: 56,
    // [2026-10-13] Sem sombra: a hairline inferior (inline) separa o header.
  },
  backBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s' }, default: {} }),
  },
  headerTitleCol: { flex: 1, marginLeft: Spacing.sm },
  // Why: title weight 600→700 with deeper letter-spacing reads more confident
  // — compose header is a moment of intent, should look decisive. Subject
  // sub-label gets a touch more weight (was implicit 400) so the original
  // thread context doesn't disappear.
  headerTitle: { fontSize: 17, fontWeight: '600', letterSpacing: -0.4 },
  headerSubject: { fontSize: FontSize.xs, marginTop: 2, opacity: 0.75, fontWeight: '500', letterSpacing: -0.1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  headerActionBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s' }, default: {} }),
  },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, height: 38, borderRadius: 19, gap: 7, marginLeft: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'opacity 0.15s ease',
      },
      default: {},
    }),
  },
  sendBtnCompact: { paddingHorizontal: 12, gap: 5, marginLeft: 0, height: 36, borderRadius: 18 },
  headerCompact: { paddingHorizontal: 8 },
  backBtnCompact: { width: 38, height: 40 },
  headerActionBtnCompact: { width: 32, height: 32, borderRadius: 16 },
  sendBtnLarge: {
    paddingHorizontal: 28, height: 44, borderRadius: 22, gap: 8,
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: -0.1 },
  sendBtnTextLarge: { fontSize: 15 },
  sendBtnDisabled: { opacity: 0.4 },

  // ── Status Bars ──
  undoBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: 12, borderRadius: 16,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      },
      default: {},
    }),
  },
  undoCountdownCircle: {
    width: 32, height: 32, justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm, position: 'relative',
  },
  undoCircleBg: {
    position: 'absolute', width: 32, height: 32, borderRadius: 16,
    borderWidth: 3, opacity: 0.3,
  },
  undoCircleProgress: {
    position: 'absolute', width: 32, height: 32, borderRadius: 16,
  },
  undoCountdownText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  undoText: { fontSize: FontSize.base, fontWeight: '600', color: '#fff' },
  undoSubText: { fontSize: 11, fontWeight: '400', marginTop: 1 },
  undoBtn: { paddingHorizontal: Spacing.lg, paddingVertical: 8, borderRadius: 12 },
  undoBtnText: { fontSize: FontSize.base, fontWeight: '700' },
  draftBar: {
    paddingHorizontal: Spacing.lg, paddingVertical: 8, alignItems: 'center',
    marginHorizontal: Spacing.md, marginTop: 4, borderRadius: 10,
  },
  draftText: { fontSize: FontSize.sm, fontWeight: '500' },
  errorBar: {
    paddingHorizontal: Spacing.lg, paddingVertical: 12, marginHorizontal: Spacing.md,
    marginTop: Spacing.sm, borderRadius: 12,
  },
  errorText: { fontSize: FontSize.base, fontWeight: '500' },

  // ── Compose Card ──
  form: { flex: 1 },
  composeCard: {
    flex: 1, margin: 0, borderRadius: 0, overflow: 'hidden',
  },
  composeCardWeb: Platform.OS === 'web' ? {
    margin: 16, marginTop: 12, borderRadius: 16,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03)',
    overflow: 'visible',
  } : {},

  // ── Original Message Card (reply mode) ──
  origCard: {
    margin: 0, borderRadius: 0, overflow: 'hidden',
  },
  origCardWeb: Platform.OS === 'web' ? {
    margin: 12, marginBottom: 0, borderRadius: 16, borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
    boxShadow: '0 1px 6px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03)',
  } : {},
  origHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  origAvatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  origAvatarText: { fontSize: FontSize.sm, fontWeight: '700' },
  origMeta: { flex: 1 },
  origSender: { fontSize: FontSize.base, fontWeight: '600' },
  origDate: { fontSize: FontSize.xs, marginTop: 2, opacity: 0.6 },
  origBodyWrap: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md },
  origSnippet: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 8 },
  origFullText: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 12 },
  showMoreBtn: {
    paddingHorizontal: 14, paddingVertical: 5, borderRadius: 10, marginTop: 10,
    alignSelf: 'flex-start',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s' }, default: {} }),
  },
  showMoreText: { fontSize: FontSize.lg, fontWeight: '700', letterSpacing: 2 },

  // ── Reply Card ──
  replyCard: {
    margin: 0, borderRadius: 0, overflow: 'hidden',
    borderTopWidth: 0,
  },
  replyCardWeb: Platform.OS === 'web' ? {
    marginHorizontal: 12, marginBottom: 12, borderRadius: 16, borderTopLeftRadius: 0, borderTopRightRadius: 0,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)',
  } : {},
  replyFieldRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: Spacing.xl, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  replyBodyContainer: { paddingHorizontal: 0, paddingTop: 0, flex: 1 },

  // ── Field Rows (compose mode) ──
  fieldRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactFieldRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 20, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    position: 'relative',
  },
  contactFieldInner: { flex: 1, minWidth: 0 },
  fieldLabel: {
    minWidth: 42, fontSize: 15, fontWeight: '400', marginRight: 10,
    letterSpacing: -0.2, textTransform: 'capitalize',
  },
  fieldValue: { flex: 1, fontSize: 15, fontWeight: '400' },

  // From pill — primary-tinted recipient chip (consistency with chips on
  // Cc/Bcc rows and ContactAutocomplete). Uses primary at ~9% bg + ~25%
  // border applied inline so it tracks theme & dark-mode.
  fromPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, minHeight: 32, borderRadius: 16,
    maxWidth: '80%',
    borderWidth: StyleSheet.hairlineWidth,
  },
  fromDot: {
    width: 6, height: 6, borderRadius: 3, marginRight: 8,
  },
  fromText: { fontSize: 14, fontWeight: '500', letterSpacing: -0.15 },

  // Toolbar — visual divider between AI/improve group and toggles group.
  // Acts as a soft vertical rule so the toolbar reads as two clusters
  // instead of a wall of pills.
  toolDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    marginHorizontal: 6,
    alignSelf: 'center',
  },

  // Subject — Large and prominent
  subjectRow: {
    paddingHorizontal: 20, paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subjectInput: {
    fontSize: 18, fontWeight: '600', paddingVertical: 12,
    letterSpacing: -0.3,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },

  // CC/BCC toggles
  ccBtns: { flexDirection: 'row', gap: 6, paddingTop: 8, flexShrink: 0 },
  ccToggleBtn: {
    paddingHorizontal: 12, minHeight: 30, justifyContent: 'center', borderRadius: 15,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s' }, default: {} }),
  },
  ccToggle: { fontSize: 12, fontWeight: '600' },

  // ── Body ──
  bodyContainer: {
    paddingHorizontal: 0, paddingTop: 0, flex: 1,
    minHeight: 200,
  },
  bodyCard: {
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  bodyMetaRow: {
    paddingHorizontal: Spacing.xl + 4,
    paddingBottom: Spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  bodyMetaText: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.3,
  },

  // ── Quote Section (forward mode) ──
  quoteSection: { borderTopWidth: StyleSheet.hairlineWidth },
  quoteContent: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md },
  quoteHeader: { fontSize: FontSize.xs, lineHeight: 18, marginBottom: 4 },
  quoteBody: { borderLeftWidth: 3, paddingLeft: 16, marginTop: 8, paddingVertical: 8 },
  quoteBodyText: { fontSize: FontSize.sm, lineHeight: 20 },

  // ── Attachments ──
  attachmentSection: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },

  // ── Bottom Toolbar ──
  bottomBar: {
    borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10,
  },
  toolbarInner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, gap: 8,
  },
  // [2026-10-13 redesign P&B] Pílulas neutras; ligado = contorno na cor do
  // texto (antes: fundo primaryLight ≈ surfaceVariant → ON/OFF indistinguível).
  toolBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, minHeight: 36, borderRadius: 18,
    borderWidth: 1, borderColor: 'transparent',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'background-color 0.15s ease, border-color 0.15s ease',
      },
      default: {},
    }),
  },
  // AI primary tool button — brand-tinted halo gives the spark CTA a soft
  // glow that reads as "smart" without being loud. Border at ~20% primary
  // tracks theme via inline override.
  aiBtnHalo: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolBtnText: { fontSize: 13, fontWeight: '500', letterSpacing: -0.05 },

  // ── Success ──
  successContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  successCircle: {
    width: 88, height: 88, borderRadius: 44,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.lg,
    ...Platform.select({
      web: {
        animation: 'successPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
      },
      default: {},
    }),
  },
  successText: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  successSub: { fontSize: FontSize.base, marginTop: Spacing.xs, opacity: 0.6 },
});
