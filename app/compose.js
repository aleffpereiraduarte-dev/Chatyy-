import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  LayoutAnimation, Animated, Modal, Pressable, Switch,
} from 'react-native';
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
  return html
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*(iframe|object|embed|base|meta|link|form|input|textarea|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(iframe|object|embed|base|meta|link|form|input|textarea|style)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
}
function sanitizeQuotedHtml(html) {
  if (Platform.OS !== 'web') return html;
  if (DOMPurify?.sanitize) return DOMPurify.sanitize(html);
  return _safeFallbackSanitize(html);
}
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sendEmail, getMessage, aiToneCheck, aiDetectLeak } from '../services/api';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import AIComposeModal from '../components/AIComposeModal';
import RichTextEditor from '../components/RichTextEditor';
import ContactAutocomplete from '../components/ContactAutocomplete';
import AttachmentPicker from '../components/AttachmentPicker';
import ScheduleSendModal from '../components/ScheduleSendModal';
import TemplatePickerModal from '../components/TemplatePickerModal';
import AISmartCompose from '../components/AISmartCompose';
import {
  IconX, IconSparkles, IconSend, IconCheckCircle,
  IconClock, IconFileText, IconPaperclip, IconFilm,
  IconChevronDown, IconChevronUp, IconArrowLeft,
} from '../components/Icons';

const DRAFT_SAVE_INTERVAL = 5000;

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

// Confidential mode options sheet — bottom sheet with expiry options +
// optional passcode + recipient phone (for SMS). Wired in the toolbar.
function ConfidentialOptionsModal({ visible, onClose, confidential, setConfidential, expiry, setExpiry, passcode, setPasscode, phone, setPhone, colors, t }) {
  const opts = [
    { d: 1,   label: t?.('compose.confidential1d') || '1 dia' },
    { d: 7,   label: t?.('compose.confidential1w') || '1 semana' },
    { d: 30,  label: t?.('compose.confidential1m') || '1 mês' },
    { d: 180, label: t?.('compose.confidential6m') || '6 meses' },
  ];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 14, paddingBottom: 36, paddingHorizontal: 18 }}
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
                      <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '600', fontSize: 13 }}>{o.label}</Text>
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
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text }}
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
                    style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text }}
                  />
                </>
              )}
            </>
          )}
          <TouchableOpacity onPress={onClose}
            style={{ backgroundColor: colors.primary, paddingVertical: 13, borderRadius: 12, alignItems: 'center', marginTop: 18 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
              {t?.('common.done') || 'Pronto'}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function ComposeScreen() {
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const { refresh } = useMail();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

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

  // --- UI state ---
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [improving, setImproving] = useState(false);
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
  const undoIntervalRef = useRef(null);
  const undoDelayRef = useRef(5);

  // --- Refs ---
  const toRef = useRef(null);
  const toValueRef = useRef(to);

  // --- Draft auto-save ---
  const [draftSaved, setDraftSaved] = useState(false);
  const draftUidRef = useRef(null);
  const draftTimerRef = useRef(null);
  const draftSavedTimerRef = useRef(null);
  const contentChangedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

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
    return str.split(',')
      .map(e => e.trim())
      .filter(Boolean)
      .map(email => ({ email, name: '' }));
  }, []);

  // Load undo send delay
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        const d = typeof localStorage !== 'undefined' && localStorage.getItem('undo_send_delay');
        if (d) undoDelayRef.current = parseInt(d, 10) || 5;
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('undo_send_delay').then(d => {
          if (d) undoDelayRef.current = parseInt(d, 10) || 5;
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
            setBody(draft.body_html || draft.body_text || draft.body);
          }
          draftUidRef.current = params.draft_uid;
        }
      }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }

    if (params.to && !params.reply_uid) {
      setTo(parseEmailsParam(params.to));
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
        if (r.success && r.data) {
          const orig = r.data;
          setOrigMsg(orig);

          if (params.reply_uid) {
            setTo(parseEmailsParam(orig.from));

            // Reply All: add all recipients + original CC to CC field
            if (params.reply_all) {
              const allRecipients = (orig.to || '').split(',')
                .map(e => e.trim()).filter(Boolean)
                .filter(e => {
                  const clean = e.replace(/<|>/g, '').toLowerCase();
                  return user?.email && !clean.includes(user.email.toLowerCase());
                })
                .map(email => ({ email: email.trim(), name: '' }));

              const origCc = (orig.cc || '').split(',')
                .map(e => e.trim()).filter(Boolean)
                .filter(e => {
                  const clean = e.replace(/<|>/g, '').toLowerCase();
                  return user?.email && !clean.includes(user.email.toLowerCase());
                })
                .map(email => ({ email: email.trim(), name: '' }));

              const combined = [...allRecipients, ...origCc];
              if (combined.length > 0) {
                setCc(combined);
                setShowCc(true);
              }
            }

            const smartReply = params.smart_reply || '';
            const senderLabel = orig.from_name ? `${orig.from_name} <${orig.from}>` : orig.from;
            const qHeader = t('compose.replyHeader', { date: formatGmailDate(orig.date), sender: senderLabel });
            const qContent = orig.body_html || orig.body_text || '';
            setQuotedHeader(qHeader);
            setQuotedHtml(sanitizeQuotedHtml(qContent));
            setBody(smartReply || '');
          } else {
            // Forward
            const fwdBody = orig.body_html || orig.body_text || '';
            const fwdHeader = t('compose.forwardHeader', { from: orig.from, date: formatGmailDate(orig.date), subject: orig.subject, to: orig.to });
            setQuotedHeader(fwdHeader);
            setQuotedHtml(sanitizeQuotedHtml(fwdBody));
            setBody('');
          }
        }
      }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    } else {
      setLoading(false);
    }
    loadSignature();
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

  const saveDraft = useCallback(async () => {
    if (!contentChangedRef.current) return;
    contentChangedRef.current = false;
    try {
      const r = await api.apiCall('draft_save', {
        subject, to: contactsToString(to), cc: contactsToString(cc),
        bcc: contactsToString(bcc), body,
        draft_uid: draftUidRef.current || undefined,
      }, 'POST');
      if (!mountedRef.current) return;
      if (r.success && r.data?.draft_uid) draftUidRef.current = r.data.draft_uid;
      setDraftSaved(true);
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
      draftSavedTimerRef.current = setTimeout(() => setDraftSaved(false), 2000);
    } catch {}
  }, [subject, to, cc, bcc, body, contactsToString]);

  useEffect(() => { toValueRef.current = to; }, [to]);
  useEffect(() => { contentChangedRef.current = true; }, [to, cc, bcc, subject, body]);

  const saveDraftRef = useRef(saveDraft);
  useEffect(() => { saveDraftRef.current = saveDraft; }, [saveDraft]);

  useEffect(() => {
    draftTimerRef.current = setInterval(() => saveDraftRef.current(), DRAFT_SAVE_INTERVAL);
    return () => {
      if (draftTimerRef.current) clearInterval(draftTimerRef.current);
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
      // Clean up undo send timers on unmount to prevent sending after navigation
      if (undoSendRef.current) clearTimeout(undoSendRef.current);
      if (undoIntervalRef.current) clearInterval(undoIntervalRef.current);
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
    setUndoCountdown(0);
    setSending(false);
  }, []);

  const handleClose = () => {
    const hasContent = body.trim() || attachments.length > 0 || (!isReply && !isForward && (to.length > 0 || subject.trim()));
    if (hasContent) {
      if (Platform.OS === 'web') {
        if (window.confirm(t('compose.discardDraftConfirm'))) router.back();
      } else {
        Alert.alert(t('compose.discard'), t('compose.discardDraftConfirm'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('compose.discard'), style: 'destructive', onPress: () => router.back() },
        ]);
      }
    } else {
      router.back();
    }
  };

  const [toneWarning, setToneWarning] = useState(null); // {tone, score, suggestion}
  const [leakWarning, setLeakWarning] = useState(null); // {types, warning}
  const [toneCheckedHash, setToneCheckedHash] = useState('');

  const handleSend = async () => {
    // Guard contra duplo envio enquanto AI checks rodam — antes podia
    // disparar várias chamadas simultâneas em taps rápidos.
    if (sending) return;
    toRef.current?.flush();
    const plainBody = (body || '').replace(/<[^>]+>/g, ' ').trim();
    const hash = subject + '|' + plainBody;
    if (plainBody.length > 10 && hash !== toneCheckedHash) {
      try {
        // Run leak + tone in parallel
        const [leakRes, toneRes] = await Promise.all([
          aiDetectLeak(plainBody.slice(0, 3000)).catch(() => null),
          plainBody.length > 30 ? aiToneCheck(plainBody.slice(0, 2000)).catch(() => null) : Promise.resolve(null),
        ]);
        if (leakRes?.success && leakRes.data?.has_secret) {
          setLeakWarning({
            types: leakRes.data.types || [],
            warning: leakRes.data.warning || 'Detectamos informacao sensivel',
          });
          setToneCheckedHash(hash);
          return;
        }
        if (toneRes?.success && toneRes.data?.warning && (toneRes.data?.score || 0) >= 70) {
          setToneWarning({
            tone: toneRes.data.tone || 'hostile',
            score: toneRes.data.score,
            suggestion: toneRes.data.suggestion || '',
          });
          setToneCheckedHash(hash);
          return;
        }
      } catch {}
      setToneCheckedHash(hash);
    }
    setTimeout(() => doSend(), 60);
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
    const currentTo = toValueRef.current;
    if (currentTo.length === 0) { setError(t('compose.errorRecipient')); return; }
    if (!body.trim() && !subject.trim()) { setError(t('compose.errorEmpty')); return; }

    const delay = undoDelayRef.current;
    setError('');
    setSending(true);
    setUndoCountdown(delay);

    const countRef = { value: delay };
    undoIntervalRef.current = setInterval(() => {
      countRef.value -= 1;
      setUndoCountdown(countRef.value);
      if (countRef.value <= 0) clearInterval(undoIntervalRef.current);
    }, 1000);

    const sendTo = toValueRef.current;
    const sendCc = [...cc];
    const sendBcc = [...bcc];
    const sendSubject = subject;
    // Build final body: user's reply + quoted original
    let sendBody = body;
    if (quotedHtml) {
      const qh = quotedHeader
        ? `<p style="color:#5f6368;font-size:13px">${quotedHeader.replace(/\n/g, '<br/>')}</p>`
        : '';
      sendBody = body + `<br/><br/>${qh}<blockquote style="border-left:3px solid #dadce0;padding-left:16px;margin:8px 0 0 0;color:#5f6368">${quotedHtml}</blockquote>`;
    }
    const sendAttachments = [...attachments];

    undoSendRef.current = setTimeout(async () => {
      clearInterval(undoIntervalRef.current);
      setUndoCountdown(0);
      try {
        const toStr = contactsToString(sendTo);
        const ccStr = contactsToString(sendCc);
        const bccStr = contactsToString(sendBcc);
        // Confidential mode: stash the real body server-side and replace
        // the email body with a "view confidential" link before sending.
        let finalBody = sendBody;
        if (confidential) {
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
                <a href="${cr.data.view_url}" style="display:inline-block;padding:10px 18px;background:#7C3AED;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${t('compose.confidentialView') || 'Visualizar email confidencial'}</a>
              </div>`;
            }
          } catch {}
        }
        const r = await sendEmail(toStr, sendSubject, finalBody, ccStr, bccStr, params.reply_uid || null, params.folder || 'INBOX', sendAttachments, { trackOpens });
        if (r.success) {
          if (draftTimerRef.current) clearInterval(draftTimerRef.current);
          setSuccess(true);
          if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          refresh();
          setTimeout(() => router.back(), 1200);
        } else {
          setError(r.message || t('compose.errorSend'));
          setSending(false);
        }
      } catch (e) {
        setError(t('compose.errorConnection'));
        setSending(false);
      }
    }, delay * 1000);
  };

  const handleScheduleSend = async (isoDateString) => {
    if (to.length === 0) { setError(t('compose.errorRecipient')); return; }
    if (!body.trim() && !subject.trim()) { setError(t('compose.errorEmpty')); return; }
    setError('');
    setSending(true);
    try {
      // Inclui bloco citado (reply/forward) + anexos para paridade com envio
      // imediato — antes scheduled mandava só body cru e perdia anexos.
      let sendBody = body;
      if (quotedHtml) {
        const qh = quotedHeader
          ? `<p style="color:#5f6368;font-size:13px">${quotedHeader.replace(/\n/g, '<br/>')}</p>`
          : '';
        sendBody = body + `<br/><br/>${qh}<blockquote style="border-left:3px solid #dadce0;padding-left:16px;margin:8px 0 0 0;color:#5f6368">${quotedHtml}</blockquote>`;
      }
      const r = await api.apiCall('schedule_send', {
        to: contactsToString(to), subject, body: sendBody,
        cc: contactsToString(cc), bcc: contactsToString(bcc),
        send_at: isoDateString,
        attachments,
      }, 'POST');
      if (r.success) {
        if (draftTimerRef.current) clearInterval(draftTimerRef.current);
        setSuccess(true);
        refresh();
        setTimeout(() => router.back(), 1200);
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
      if (r.success && r.data?.result) setBody(r.data.result);
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
  const handleRemoveAttachment = (index) => setAttachments(prev => prev.filter((_, i) => i !== index));

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

  // ── Shared: Undo / Draft / Error bars ──
  const renderStatusBars = () => (
    <>
      {undoCountdown > 0 && (
        <Animated.View style={[s.undoBar, { backgroundColor: colors.toastBg, opacity: undoOpacity }]}>
          <View style={s.undoCountdownCircle}>
            <View style={[s.undoCircleBg, { borderColor: 'rgba(255,255,255,0.15)' }]} />
            {Platform.OS === 'web' && (
              <View style={[s.undoCircleProgress, {
                background: `conic-gradient(${colors.primary} ${(undoCountdown / undoDelayRef.current) * 360}deg, transparent 0deg)`,
                WebkitMaskImage: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 3px))',
                maskImage: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 3px))',
                transition: 'background 0.3s linear',
              }]} />
            )}
            <Text style={s.undoCountdownText}>{undoCountdown}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 4 }}>
            <Text style={s.undoText}>{t('compose.undoSending', { n: undoCountdown })}</Text>
            <Text style={[s.undoSubText, { color: 'rgba(255,255,255,0.6)' }]}>{t('compose.undoTapCancel')}</Text>
          </View>
          <TouchableOpacity onPress={cancelUndoSend} style={[s.undoBtn, { backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }]}>
            <Text style={[s.undoBtnText, { color: '#fff' }]}>{t('undo.button')}</Text>
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
    </>
  );

  // ── Shared: CC/BCC toggle buttons ──
  const renderCcBccToggle = () => (
    (!showCc || !showBcc) ? (
      <View style={s.ccBtns}>
        {!showCc && (
          <TouchableOpacity
            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowCc(true); }}
            style={[s.ccToggleBtn, { backgroundColor: colors.primaryLight }]}
            accessibilityLabel={t('compose.addCc') || 'Add Cc'}
            accessibilityRole="button"
          >
            <Text style={[s.ccToggle, { color: colors.primary }]}>Cc</Text>
          </TouchableOpacity>
        )}
        {!showBcc && (
          <TouchableOpacity
            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowBcc(true); }}
            style={[s.ccToggleBtn, { backgroundColor: colors.primaryLight }]}
            accessibilityLabel={t('compose.addBcc') || 'Add Bcc'}
            accessibilityRole="button"
          >
            <Text style={[s.ccToggle, { color: colors.primary }]}>Bcc</Text>
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
          style={[s.toolBtn, { backgroundColor: colors.primaryLight }]}
          accessibilityLabel={showMeet ? t('compose.writeWithAI') : t('compose.ai')}
          accessibilityRole="button"
        >
          <IconSparkles size={14} color={colors.primary} />
          <Text style={[s.toolBtnText, { color: colors.primary }]}>{showMeet ? t('compose.writeWithAI') : t('compose.ai')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleImprove}
          style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]}
          disabled={improving}
          accessibilityLabel={t('compose.improveText')}
          accessibilityRole="button"
        >
          {improving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <>
              <IconSparkles size={13} color={colors.textSecondary} />
              <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>{t('compose.improveText')}</Text>
            </>
          )}
        </TouchableOpacity>
        {showMeet && (
          <TouchableOpacity
            onPress={async () => {
              try {
                const r = await api.apiCall('meet_create', { title: subject || t('compose.defaultMeetTitle') }, 'POST');
                if (r.success && r.data?.room_id) {
                  const meetUrl = `https://chatyy.com.br/meet/room.html?id=${r.data.room_id}`; // Keep chatyy.com.br - this URL goes in the email body for recipients to click
                  const meetBlock = `\n\n<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin:8px 0"><strong style="font-size:15px">Chatyy Meet</strong><br/><p style="margin:8px 0;color:#64748b;font-size:13px">${t('compose.meetJoinLabel')}</p><a href="${meetUrl}" style="color:#2563eb;font-weight:600">${meetUrl}</a></div>\n`;
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
          style={[s.toolBtn, { backgroundColor: trackOpens ? colors.primaryLight : colors.surfaceVariant }]}
          accessibilityLabel={t('compose.trackOpens')}
          accessibilityRole="button"
          accessibilityState={{ checked: trackOpens }}
        >
          <Text style={[s.toolBtnText, { color: trackOpens ? colors.primary : colors.textSecondary }]}>
            {trackOpens ? '✓ ' : ''}{t('compose.trackOpens') || 'Confirmar leitura'}
          </Text>
        </TouchableOpacity>
        {/* Confidential mode toggle */}
        <TouchableOpacity
          onPress={() => setConfidentialModal(true)}
          style={[s.toolBtn, { backgroundColor: confidential ? colors.primaryLight : colors.surfaceVariant }]}
          accessibilityLabel={t('compose.confidential') || 'Modo confidencial'}
          accessibilityRole="button"
          accessibilityState={{ checked: confidential }}
        >
          <Text style={[s.toolBtnText, { color: confidential ? colors.primary : colors.textSecondary }]}>
            {confidential ? '🔒 ' : ''}{t('compose.confidential') || 'Confidencial'}
            {confidential ? ` · ${confidentialExpiry}d` : ''}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );

  // ── Send button component ──
  const renderSendButton = (size = 'default') => (
    <TouchableOpacity
      style={[
        s.sendBtn,
        size === 'large' && s.sendBtnLarge,
        { backgroundColor: colors.primary },
        sending && s.sendBtnDisabled,
      ]}
      onPress={handleSend}
      onLongPress={() => { if (!sending) setShowSendOptions(true); }}
      delayLongPress={350}
      disabled={sending}
      accessibilityLabel={t('compose.send') + ' (Ctrl+Enter)'}
      accessibilityRole="button"
    >
      {sending ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <>
          <IconSend size={size === 'large' ? 18 : 15} color="#fff" />
          <Text style={[s.sendBtnText, size === 'large' && s.sendBtnTextLarge]}>{t('compose.send')}</Text>
        </>
      )}
    </TouchableOpacity>
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
          paddingTop: 8, paddingBottom: 24, paddingHorizontal: 0,
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
      <KeyboardAvoidingView style={[s.flex, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.container, { paddingTop: insets.top }]}>
          {/* Header */}
          <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
            <TouchableOpacity onPress={handleClose} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <IconArrowLeft size={20} color={colors.textSecondary} />
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
              {renderSendButton()}
            </View>
          </View>

          {renderStatusBars()}

          <ScrollView style={s.form} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
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
                  <Text style={[s.origDate, { color: colors.textTertiary }]}>{origDate}</Text>
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
                    style={[s.showMoreBtn, { backgroundColor: colors.surfaceVariant }]}
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
                  {showQuote && Platform.OS !== 'web' && (
                    <Text style={[s.origFullText, { color: colors.textSecondary }]} selectable>
                      {quotedHtml.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()}
                    </Text>
                  )}
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
                  <ContactAutocomplete value={cc} onChange={setCc} placeholder="cc@email.com" label="Cc" />
                </View>
              )}
              {showBcc && (
                <View style={[s.replyFieldRow, { borderBottomColor: colors.borderLight, zIndex: 10 }]}>
                  <ContactAutocomplete value={bcc} onChange={setBcc} placeholder="bcc@email.com" label="Bcc" />
                </View>
              )}

              {/* Reply body editor */}
              <View style={s.replyBodyContainer}>
                <RichTextEditor
                  value={body}
                  onChange={setBody}
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
          colors={colors}
          t={t}
        />
        <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
        <SendOptionsSheet />
      </KeyboardAvoidingView>
    );
  }

  // ════════════════════════════════════════════
  //  COMPOSE / FORWARD MODE — Modern Design
  // ════════════════════════════════════════════
  return (
    <KeyboardAvoidingView style={[s.flex, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[s.container, { paddingTop: insets.top }]}>
        {/* ── Modern Header ── */}
        <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
          <TouchableOpacity onPress={handleClose} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {isForward ? t('compose.forward') : t('compose.title')}
          </Text>
          <View style={s.headerRight}>
            <TouchableOpacity onPress={() => setShowSchedule(true)} style={[s.headerActionBtn, { backgroundColor: colors.surfaceVariant }]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconClock size={16} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowTemplates(true)} style={[s.headerActionBtn, { backgroundColor: colors.surfaceVariant }]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconFileText size={16} color={colors.textSecondary} />
            </TouchableOpacity>
            {renderSendButton()}
          </View>
        </View>

        {renderStatusBars()}

        {/* ── Compose Form ── */}
        <ScrollView style={s.form} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
          <View style={[s.composeCard, { backgroundColor: colors.surface }, Platform.OS === 'web' && s.composeCardWeb]}>
            {/* From */}
            <View style={[s.fieldRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.fieldLabel, { color: colors.textTertiary }]}>{t('compose.from')}</Text>
              <View style={[s.fromPill, { backgroundColor: colors.surfaceVariant }]}>
                <View style={[s.fromDot, { backgroundColor: colors.primary }]} />
                <Text style={[s.fromText, { color: colors.text }]} numberOfLines={1}>{user?.email}</Text>
              </View>
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
                <ContactAutocomplete value={cc} onChange={setCc} placeholder="cc@email.com" label="Cc" />
              </View>
            )}
            {showBcc && (
              <View style={[s.contactFieldRow, { borderBottomColor: colors.borderLight, zIndex: 10 }]}>
                <ContactAutocomplete value={bcc} onChange={setBcc} placeholder="bcc@email.com" label="Bcc" />
              </View>
            )}

            {/* Subject — Prominent */}
            <View style={[s.subjectRow, { borderBottomColor: colors.borderLight }]}>
              <TextInput
                style={[s.subjectInput, { color: colors.text }]}
                value={subject}
                onChangeText={setSubject}
                placeholder={t('compose.subjectPlaceholder')}
                placeholderTextColor={colors.textTertiary}
              />
            </View>

            {/* Body — Clean editing area */}
            <View style={s.bodyContainer}>
              <RichTextEditor
                value={body}
                onChange={setBody}
                placeholder={t('compose.bodyPlaceholder')}
                minHeight={quotedHtml ? 200 : 320}
              />
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
            </View>

            {/* Forward: quoted original (read-only, collapsible) */}
            {!!quotedHtml && (
              <View style={[s.quoteSection, { borderTopColor: colors.borderLight }]}>
                <TouchableOpacity
                  onPress={() => setShowQuote(!showQuote)}
                  style={[s.showMoreBtn, { backgroundColor: colors.surfaceVariant, alignSelf: 'flex-start', marginLeft: Spacing.xl, marginVertical: Spacing.sm }]}
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
            <Text style={{ fontSize:18, fontWeight:'700', color:'#dc2626', marginBottom:8 }}>🔒 {t('compose.leakWarning') || 'Informação sensível detectada'}</Text>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:8 }}>
              {leakWarning.warning}
            </Text>
            {leakWarning.types?.length > 0 && (
              <View style={{ flexDirection:'row', flexWrap:'wrap', gap:6, marginBottom:16 }}>
                {leakWarning.types.map((t, i) => (
                  <View key={i} style={{ backgroundColor:'#fee2e2', paddingHorizontal:8, paddingVertical:4, borderRadius:4 }}>
                    <Text style={{ fontSize:11, color:'#991b1b', fontWeight:'600' }}>{t}</Text>
                  </View>
                ))}
              </View>
            )}
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => { setLeakWarning(null); setSending(false); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}>
                <Text style={{ color:colors.text, fontWeight:'600' }}>{t('compose.edit') || 'Editar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setLeakWarning(null); setTimeout(() => doSend(), 60); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:'#dc2626', alignItems:'center' }}>
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
            <Text style={{ fontSize:18, fontWeight:'700', color:'#ef4444', marginBottom:8 }}>⚠️ {t('compose.toneWarning') || 'Tom detectado'}: {toneWarning.tone}</Text>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:16 }}>
              {(t('compose.toneWarningBody') || 'Sua mensagem soa {tone} (intensidade {score}/100). Recomendamos revisar antes de enviar.')
                .replace('{tone}', toneWarning.tone === 'hostile' ? (t('compose.toneHostile') || 'hostil') : toneWarning.tone === 'angry' ? (t('compose.toneAngry') || 'irritada') : (t('compose.toneAggressive') || 'agressiva'))
                .replace('{score}', String(toneWarning.score))}
            </Text>
            {toneWarning.suggestion ? (
              <View style={{ backgroundColor:colors.background, padding:12, borderRadius:8, marginBottom:16 }}>
                <Text style={{ fontSize:12, color:colors.textSecondary, marginBottom:4 }}>Sugestão:</Text>
                <Text style={{ fontSize:14, color:colors.text }}>{toneWarning.suggestion}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => { setToneWarning(null); setSending(false); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}>
                <Text style={{ color:colors.text, fontWeight:'600' }}>{t('compose.edit') || 'Editar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSendAnyway} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:'#ef4444', alignItems:'center' }}>
                <Text style={{ color:'#fff', fontWeight:'600' }}>{t('compose.sendAnyway') || 'Enviar mesmo'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// ════════════════════════════════════════════
//  STYLES — Modern, Clean, Glassmorphism
// ════════════════════════════════════════════
const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },

  // ── Header ──
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, height: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      },
      default: {},
    }),
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s' }, default: {} }),
  },
  headerTitleCol: { flex: 1, marginLeft: Spacing.sm },
  // Why: title weight 600→700 with deeper letter-spacing reads more confident
  // — compose header is a moment of intent, should look decisive. Subject
  // sub-label gets a touch more weight (was implicit 400) so the original
  // thread context doesn't disappear.
  headerTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.4 },
  headerSubject: { fontSize: FontSize.xs, marginTop: 2, opacity: 0.75, fontWeight: '500', letterSpacing: -0.1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  headerActionBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s' }, default: {} }),
  },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 20, height: 38, borderRadius: 19, gap: 7, marginLeft: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)',
      },
      default: { elevation: 3 },
    }),
  },
  sendBtnLarge: {
    paddingHorizontal: 28, height: 44, borderRadius: 22, gap: 8,
  },
  sendBtnText: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
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
  },
  contactFieldInner: { flex: 1, minWidth: 0 },
  fieldLabel: {
    minWidth: 42, fontSize: 13, fontWeight: '500', marginRight: 10,
    letterSpacing: 0.2, textTransform: 'capitalize',
  },
  fieldValue: { flex: 1, fontSize: 14, fontWeight: '400' },

  // From pill
  fromPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    maxWidth: '80%',
  },
  fromDot: {
    width: 8, height: 8, borderRadius: 4, marginRight: 8,
  },
  fromText: { fontSize: 13, fontWeight: '500' },

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
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s' }, default: {} }),
  },
  ccToggle: { fontSize: 12, fontWeight: '600' },

  // ── Body ──
  bodyContainer: {
    paddingHorizontal: 0, paddingTop: 0, flex: 1,
    minHeight: 200,
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
  toolBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      },
      default: {},
    }),
  },
  toolBtnText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },

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
        boxShadow: '0 8px 32px rgba(22, 163, 74, 0.2)',
      },
      default: {},
    }),
  },
  successText: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  successSub: { fontSize: FontSize.base, marginTop: Spacing.xs, opacity: 0.6 },
});
