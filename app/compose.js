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
  const headerScale = useRef(new Animated.Value(0)).current;

  // Entrance animation
  useEffect(() => {
    Animated.spring(headerScale, { toValue: 1, tension: 60, friction: 10, useNativeDriver: Platform.OS !== 'web' }).start();
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
            setQuotedHtml(Platform.OS === 'web' ? (DOMPurify?.sanitize ? DOMPurify.sanitize(qContent) : qContent) : qContent);
            setBody(smartReply || '');
          } else {
            // Forward
            const fwdBody = orig.body_html || orig.body_text || '';
            const fwdHeader = t('compose.forwardHeader', { from: orig.from, date: formatGmailDate(orig.date), subject: orig.subject, to: orig.to });
            setQuotedHeader(fwdHeader);
            setQuotedHtml(Platform.OS === 'web' ? (DOMPurify?.sanitize ? DOMPurify.sanitize(fwdBody) : fwdBody) : fwdBody);
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
          >
            <Text style={[s.ccToggle, { color: colors.primary }]}>Cc</Text>
          </TouchableOpacity>
        )}
        {!showBcc && (
          <TouchableOpacity
            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowBcc(true); }}
            style={[s.ccToggleBtn, { backgroundColor: colors.primaryLight }]}
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
        <TouchableOpacity onPress={() => setShowAI(true)} style={[s.toolBtn, { backgroundColor: colors.primaryLight }]}>
          <IconSparkles size={14} color={colors.primary} />
          <Text style={[s.toolBtnText, { color: colors.primary }]}>{showMeet ? t('compose.writeWithAI') : t('compose.ai')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleImprove} style={[s.toolBtn, { backgroundColor: colors.surfaceVariant }]} disabled={improving}>
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
          >
            <IconFilm size={13} color={colors.textSecondary} />
            <Text style={[s.toolBtnText, { color: colors.textSecondary }]}>Meet</Text>
          </TouchableOpacity>
        )}
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
        <TemplatePickerModal visible={showTemplates} onClose={() => setShowTemplates(false)} onSelect={handleTemplateSelect} />
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
  headerTitle: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  headerSubject: { fontSize: FontSize.xs, marginTop: 2, opacity: 0.7 },
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
