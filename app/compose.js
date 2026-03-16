import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  LayoutAnimation, Animated,
} from 'react-native';
let DOMPurify = null;
if (Platform.OS === 'web') {
  try { DOMPurify = require('dompurify'); } catch (e) {}
}
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sendEmail, getMessage } from '../services/api';
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

  // --- Animated values ---
  const undoOpacity = useRef(new Animated.Value(0)).current;
  const draftOpacity = useRef(new Animated.Value(0)).current;

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
    if (params.draft_uid) {
      getMessage(params.draft_uid, 'Drafts').then(r => {
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
      }).catch(() => {}).finally(() => setLoading(false));
      return;
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
            setQuotedHtml(Platform.OS === 'web' ? DOMPurify.sanitize(qContent) : qContent);
            setBody(smartReply || '');
          } else {
            // Forward
            const fwdBody = orig.body_html || orig.body_text || '';
            const fwdHeader = t('compose.forwardHeader', { from: orig.from, date: formatGmailDate(orig.date), subject: orig.subject, to: orig.to });
            setQuotedHeader(fwdHeader);
            setQuotedHtml(Platform.OS === 'web' ? DOMPurify.sanitize(fwdBody) : fwdBody);
            setBody('');
          }
        }
      }).catch(() => {}).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    loadSignature();
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
    Animated.timing(undoOpacity, { toValue: undoCountdown > 0 ? 1 : 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [undoCountdown]);

  useEffect(() => {
    Animated.timing(draftOpacity, { toValue: draftSaved ? 1 : 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
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

  const handleSend = () => {
    toRef.current?.flush();
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
        const r = await sendEmail(toStr, sendSubject, sendBody, ccStr, bccStr, params.reply_uid || null, params.folder || 'INBOX', sendAttachments);
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
      const r = await api.apiCall('schedule_send', {
        to: contactsToString(to), subject, body,
        cc: contactsToString(cc), bcc: contactsToString(bcc),
        send_at: isoDateString,
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
        <View style={[s.successCircle, { backgroundColor: colors.successBg }]}>
          <IconCheckCircle size={40} color={colors.success} />
        </View>
        <Text style={[s.successText, { color: colors.text }]}>{t('compose.sent')}</Text>
        <Text style={[s.successSub, { color: colors.textSecondary }]}>{t('compose.redirecting')}</Text>
      </View>
    );
  }

  // --- Loading ---
  if (loading) {
    return (
      <View style={[s.successContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
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

  // ════════════════════════════════════════════
  //  REPLY / REPLY ALL MODE — Gmail-style
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
          <View style={[s.header, { backgroundColor: colors.surface }]}>
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
              <TouchableOpacity
                style={[s.sendBtn, { backgroundColor: colors.primary }, sending && s.sendBtnDisabled]}
                onPress={handleSend}
                disabled={sending}
                accessibilityLabel={t('compose.send') + ' (Ctrl+Enter)'}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <IconSend size={15} color="#fff" />
                    <Text style={s.sendBtnText}>{t('compose.send')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Undo / Draft / Error bars */}
          {undoCountdown > 0 && (
            <Animated.View style={[s.undoBar, { backgroundColor: colors.toastBg, opacity: undoOpacity }]}>
              <Text style={s.undoText}>{t('compose.undoSending', { n: undoCountdown })}</Text>
              <TouchableOpacity onPress={cancelUndoSend} style={s.undoBtn}>
                <Text style={[s.undoBtnText, { color: colors.primary }]}>{t('undo.button')}</Text>
              </TouchableOpacity>
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

              {/* Original body preview — always show collapsed snippet */}
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
                {(!showCc || !showBcc) && (
                  <View style={s.ccBtns}>
                    {!showCc && (
                      <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowCc(true); }} style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}>
                        <Text style={[s.ccToggle, { color: colors.textSecondary }]}>Cc</Text>
                      </TouchableOpacity>
                    )}
                    {!showBcc && (
                      <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowBcc(true); }} style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}>
                        <Text style={[s.ccToggle, { color: colors.textSecondary }]}>Bcc</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
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
              <View style={[s.replyToolbar, { borderTopColor: colors.borderLight }]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.toolbarInner} keyboardShouldPersistTaps="handled">
                  <TouchableOpacity onPress={() => setShowAI(true)} style={[s.toolBtn, { backgroundColor: colors.primaryLight }]}>
                    <IconSparkles size={15} color={colors.primary} />
                    <Text style={[s.toolBtnText, { color: colors.primary }]}>{t('compose.ai')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleImprove} style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]} disabled={improving}>
                    {improving ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <>
                        <IconSparkles size={14} color={colors.textSecondary} />
                        <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>{t('compose.improveText')}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              </View>
            </View>
          </ScrollView>
        </View>

        <AIComposeModal visible={showAI} onClose={() => setShowAI(false)} onUseDraft={handleAIDraft} />
        <ScheduleSendModal visible={showSchedule} onClose={() => setShowSchedule(false)} onSchedule={handleScheduleSend} />
        <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
      </KeyboardAvoidingView>
    );
  }

  // ════════════════════════════════════════════
  //  COMPOSE / FORWARD MODE
  // ════════════════════════════════════════════
  return (
    <KeyboardAvoidingView style={[s.flex, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[s.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={[s.header, { backgroundColor: colors.surface }]}>
          <TouchableOpacity onPress={handleClose} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {isForward ? t('compose.forward') : t('compose.title')}
          </Text>
          <View style={s.headerRight}>
            <TouchableOpacity onPress={() => setShowSchedule(true)} style={s.headerIconBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconClock size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowTemplates(true)} style={s.headerIconBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconFileText size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.sendBtn, { backgroundColor: colors.primary }, sending && s.sendBtnDisabled]}
              onPress={handleSend}
              disabled={sending}
              accessibilityLabel={t('compose.send') + ' (Ctrl+Enter)'}
              accessibilityRole="button"
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <IconSend size={15} color="#fff" />
                  <Text style={s.sendBtnText}>{t('compose.send')}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Undo / Draft / Error bars */}
        {undoCountdown > 0 && (
          <Animated.View style={[s.undoBar, { backgroundColor: colors.toastBg, opacity: undoOpacity }]}>
            <Text style={s.undoText}>{t('compose.undoSending', { n: undoCountdown })}</Text>
            <TouchableOpacity onPress={cancelUndoSend} style={s.undoBtn}>
              <Text style={[s.undoBtnText, { color: colors.primary }]}>{t('undo.button')}</Text>
            </TouchableOpacity>
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

        {/* Compose Card */}
        <ScrollView style={s.form} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
          <View style={[s.composeCard, { backgroundColor: colors.surface }, Platform.OS === 'web' && s.composeCardWeb]}>
            {/* From */}
            <View style={[s.fieldRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.fieldLabel, { color: colors.textTertiary }]}>{t('compose.from')}</Text>
              <Text style={[s.fieldValue, { color: colors.text }]}>{user?.email}</Text>
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
              {(!showCc || !showBcc) && (
                <View style={s.ccBtns}>
                  {!showCc && (
                    <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowCc(true); }} style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}>
                      <Text style={[s.ccToggle, { color: colors.textSecondary }]}>Cc</Text>
                    </TouchableOpacity>
                  )}
                  {!showBcc && (
                    <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowBcc(true); }} style={[s.ccToggleBtn, { backgroundColor: colors.surfaceVariant }]}>
                      <Text style={[s.ccToggle, { color: colors.textSecondary }]}>Bcc</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
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

            {/* Subject */}
            <View style={[s.fieldRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.fieldLabel, { color: colors.textTertiary }]}>{t('compose.subject')}</Text>
              <TextInput
                style={[s.fieldInput, { color: colors.text }]}
                value={subject}
                onChangeText={setSubject}
                placeholder={t('compose.subjectPlaceholder')}
                placeholderTextColor={colors.textTertiary}
              />
            </View>

            {/* Body */}
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
            <View style={[s.bottomBar, { borderTopColor: colors.borderLight }]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.toolbarInner} keyboardShouldPersistTaps="handled">
                <TouchableOpacity onPress={() => setShowAI(true)} style={[s.toolBtn, { backgroundColor: colors.primaryLight }]}>
                  <IconSparkles size={15} color={colors.primary} />
                  <Text style={[s.toolBtnText, { color: colors.primary }]}>{t('compose.writeWithAI')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleImprove} style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]} disabled={improving}>
                  {improving ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <>
                      <IconSparkles size={14} color={colors.textSecondary} />
                      <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>{t('compose.improveText')}</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const r = await api.apiCall('meet_create', { title: subject || t('compose.defaultMeetTitle') }, 'POST');
                      if (r.success && r.data?.room_id) {
                        const meetUrl = `https://chatyy.com.br/meet/room.html?id=${r.data.room_id}`;
                        const meetBlock = `\n\n<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin:8px 0"><strong style="font-size:15px">Chatyy Meet</strong><br/><p style="margin:8px 0;color:#64748b;font-size:13px">${t('compose.meetJoinLabel')}</p><a href="${meetUrl}" style="color:#2563eb;font-weight:600">${meetUrl}</a></div>\n`;
                        setBody(prev => prev + meetBlock);
                      }
                    } catch {}
                  }}
                  style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]}
                >
                  <IconFilm size={14} color={colors.textSecondary} />
                  <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>Meet</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </ScrollView>
      </View>

      <AIComposeModal visible={showAI} onClose={() => setShowAI(false)} onUseDraft={handleAIDraft} />
      <ScheduleSendModal visible={showSchedule} onClose={() => setShowSchedule(false)} onSchedule={handleScheduleSend} />
      <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
    </KeyboardAvoidingView>
  );
}

// ════════════════════════════════════════════
//  STYLES
// ════════════════════════════════════════════
const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },

  // ── Header ──
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, height: 52,
    borderBottomWidth: 0,
  },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerTitleCol: { flex: 1, marginLeft: Spacing.sm },
  headerTitle: { fontSize: 17, fontWeight: '500', letterSpacing: -0.2 },
  headerSubject: { fontSize: FontSize.xs, marginTop: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  headerIconBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s' }, default: {} }),
  },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 20, height: 36, borderRadius: 18, gap: 6, marginLeft: 2,
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'opacity 0.15s, transform 0.1s' },
      default: { elevation: 2 },
    }),
  },
  sendBtnText: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  sendBtnDisabled: { opacity: 0.4 },

  // ── Bars ──
  undoBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: 12, borderRadius: BorderRadius.md,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
  },
  undoText: { fontSize: FontSize.base, fontWeight: '500', color: '#fff' },
  undoBtn: { paddingHorizontal: Spacing.lg, paddingVertical: 6, borderRadius: BorderRadius.xxl },
  undoBtnText: { fontSize: FontSize.base, fontWeight: '700' },
  draftBar: { paddingHorizontal: Spacing.lg, paddingVertical: 6, alignItems: 'center' },
  draftText: { fontSize: FontSize.sm, fontWeight: '500' },
  errorBar: { paddingHorizontal: Spacing.lg, paddingVertical: 10, marginHorizontal: Spacing.md, marginTop: Spacing.sm, borderRadius: BorderRadius.md },
  errorText: { fontSize: FontSize.base },

  // ── Compose Card (new email / forward) ──
  form: { flex: 1 },
  composeCard: { flex: 1, margin: 0, borderRadius: 0, overflow: 'hidden' },
  composeCardWeb: Platform.OS === 'web' ? {
    margin: 16, marginTop: 8, borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.03)',
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
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  origAvatarText: { fontSize: FontSize.sm, fontWeight: '700' },
  origMeta: { flex: 1 },
  origSender: { fontSize: FontSize.base, fontWeight: '600' },
  origDate: { fontSize: FontSize.xs, marginTop: 1 },
  origBodyWrap: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md },
  origSnippet: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 8 },
  origFullText: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 12 },
  showMoreBtn: {
    paddingHorizontal: 14, paddingVertical: 4, borderRadius: BorderRadius.md, marginTop: 10,
    alignSelf: 'flex-start',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
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
  replyToolbar: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },

  // ── Field Rows (compose mode) ──
  fieldRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactFieldRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactFieldInner: { flex: 1, minWidth: 0 },
  fieldLabel: { minWidth: 40, fontSize: 14, fontWeight: '400', marginRight: 8, opacity: 0.55 },
  fieldValue: { flex: 1, fontSize: 14, fontWeight: '400' },
  fieldInput: {
    flex: 1, fontSize: 14, fontWeight: '400',
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  ccBtns: { flexDirection: 'row', gap: 6, paddingTop: 8, flexShrink: 0 },
  ccToggleBtn: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  ccToggle: { fontSize: 12, fontWeight: '500' },

  // ── Body ──
  bodyContainer: { paddingHorizontal: 0, paddingTop: 0, flex: 1 },

  // ── Quote Section (forward mode) ──
  quoteSection: { borderTopWidth: StyleSheet.hairlineWidth },
  quoteContent: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md },
  quoteHeader: { fontSize: FontSize.xs, lineHeight: 18, marginBottom: 4 },
  quoteBody: { borderLeftWidth: 3, paddingLeft: 16, marginTop: 8, paddingVertical: 8 },
  quoteBodyText: { fontSize: FontSize.sm, lineHeight: 20 },

  // ── Attachments ──
  attachmentSection: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },

  // ── Toolbars ──
  bottomBar: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
  toolbarInner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, gap: 6,
  },
  toolBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s' }, default: {} }),
  },
  toolBtnText: { fontSize: 12, fontWeight: '500' },

  // ── Success ──
  successContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  successCircle: {
    width: 80, height: 80, borderRadius: 40,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.lg,
    ...Platform.select({ web: { animation: 'slideUp 0.3s ease-out' }, default: {} }),
  },
  successText: { fontSize: FontSize.xxl, fontWeight: '600' },
  successSub: { fontSize: FontSize.base, marginTop: Spacing.xs },
});
