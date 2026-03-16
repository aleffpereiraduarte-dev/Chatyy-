/**
 * ComposeModal — Gmail-style floating compose window for desktop web.
 *
 * Usage in inbox.js:
 *   <ComposeModal params={composeModal} onClose={() => setComposeModal(null)} />
 *
 * `params` is an object with optional fields:
 *   { to, subject, body, cc, bcc, reply_uid, forward_uid, folder, smart_reply }
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Platform, ActivityIndicator, ScrollView, Animated,
} from 'react-native';

let DOMPurify = null;
if (Platform.OS === 'web') {
  try { DOMPurify = require('dompurify'); } catch (e) {}
}

import { useAuth } from '../context/AuthContext';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize } from '../constants/theme';
import { sendEmail, getMessage } from '../services/api';
import * as api from '../services/api';
import ContactAutocomplete from './ContactAutocomplete';
import RichTextEditor from './RichTextEditor';
import AttachmentPicker from './AttachmentPicker';
import {
  IconX, IconSend, IconChevronDown, IconChevronUp,
  IconPaperclip, IconSparkles,
} from './Icons';

const DRAFT_SAVE_INTERVAL = 5000;

// Format date for reply/forward headers
function formatGmailDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Maximize icon (text-based, safe for native)
function IconMaximize({ size = 16, color = 'currentColor' }) {
  return <Text style={{ fontSize: size, color, lineHeight: size }}>&#x26F6;</Text>;
}

// Restore icon (text-based, safe for native)
function IconRestore({ size = 16, color = 'currentColor' }) {
  return <Text style={{ fontSize: size, color, lineHeight: size }}>&#x2750;</Text>;
}

export default function ComposeModal({ params, onClose }) {
  const { user } = useAuth();
  const { refresh } = useMail();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const isReply = !!(params?.reply_uid);
  const isReplyAll = !!(params?.reply_all);
  const isForward = !!(params?.forward_uid);

  // Window state
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // Field state
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [bcc, setBcc] = useState([]);
  const [subject, setSubject] = useState(params?.subject || '');
  const [body, setBody] = useState('');
  const [quotedHtml, setQuotedHtml] = useState('');
  const [quotedHeader, setQuotedHeader] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  // UI state
  const [loading, setLoading] = useState(!!(params?.reply_uid || params?.forward_uid));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [undoCountdown, setUndoCountdown] = useState(0);

  // Refs
  const toRef = useRef(null);
  const toValueRef = useRef(to);
  const draftUidRef = useRef(null);
  const draftTimerRef = useRef(null);
  const draftSavedTimerRef = useRef(null);
  const contentChangedRef = useRef(false);
  const undoSendRef = useRef(null);
  const undoIntervalRef = useRef(null);
  const undoDelayRef = useRef(5);

  // Animated
  const undoOpacity = useRef(new Animated.Value(0)).current;
  const draftOpacity = useRef(new Animated.Value(0)).current;

  // Parse email param into contact array
  const parseEmailsParam = useCallback((val) => {
    if (!val) return [];
    const str = typeof val === 'string' ? val : String(val);
    return str.split(',').map(e => e.trim()).filter(Boolean)
      .map(email => ({ email, name: '' }));
  }, []);

  const contactsToString = useCallback((contacts) => {
    return contacts.map(c => c.email).join(', ');
  }, []);

  // Load undo delay from storage
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        const d = typeof localStorage !== 'undefined' && localStorage.getItem('undo_send_delay');
        if (d) undoDelayRef.current = parseInt(d, 10) || 5;
      } catch {}
    }
  }, []);

  // Load original message for reply/forward
  useEffect(() => {
    if (params?.to && !params?.reply_uid) {
      setTo(parseEmailsParam(params.to));
    }
    if (params?.cc) {
      setCc(parseEmailsParam(params.cc));
      setShowCc(true);
    }
    if (params?.bcc) {
      setBcc(parseEmailsParam(params.bcc));
      setShowBcc(true);
    }

    const uid = params?.reply_uid || params?.forward_uid;
    if (uid) {
      getMessage(uid, params?.folder || 'INBOX').then(r => {
        if (r.success && r.data) {
          const orig = r.data;

          if (params?.reply_uid) {
            setTo(parseEmailsParam(orig.from));

            if (params?.reply_all) {
              const allRecipients = (orig.to || '').split(',')
                .map(e => e.trim()).filter(Boolean)
                .filter(e => {
                  const clean = e.replace(/<|>/g, '').toLowerCase();
                  return user?.email && !clean.includes(user.email.toLowerCase());
                })
                .map(email => ({ email, name: '' }));
              const origCc = (orig.cc || '').split(',')
                .map(e => e.trim()).filter(Boolean)
                .filter(e => {
                  const clean = e.replace(/<|>/g, '').toLowerCase();
                  return user?.email && !clean.includes(user.email.toLowerCase());
                })
                .map(email => ({ email, name: '' }));
              const combined = [...allRecipients, ...origCc];
              if (combined.length > 0) { setCc(combined); setShowCc(true); }
            }

            const senderLabel = orig.from_name ? `${orig.from_name} <${orig.from}>` : orig.from;
            const qHeader = t('compose.replyHeader', { date: formatGmailDate(orig.date), sender: senderLabel });
            const qContent = orig.body_html || orig.body_text || '';
            setQuotedHeader(qHeader);
            setQuotedHtml(Platform.OS === 'web' && DOMPurify ? DOMPurify.sanitize(qContent) : qContent);
            setBody(params?.smart_reply || '');
          } else {
            // Forward
            const fwdBody = orig.body_html || orig.body_text || '';
            const fwdHeader = t('compose.forwardHeader', {
              from: orig.from, date: formatGmailDate(orig.date),
              subject: orig.subject, to: orig.to,
            });
            setQuotedHeader(fwdHeader);
            setQuotedHtml(Platform.OS === 'web' && DOMPurify ? DOMPurify.sanitize(fwdBody) : fwdBody);
            setBody('');
          }
        }
      }).catch(() => {}).finally(() => setLoading(false));
    } else {
      setLoading(false);
      // Load signature for new compose
      loadSignature();
    }
  }, []);

  const loadSignature = async () => {
    try {
      const { getSettings } = await import('../services/api');
      const r = await getSettings();
      const rawSig = r.success ? r.data?.signature : '';
      const sig = (rawSig && typeof rawSig === 'string' && rawSig !== 'null') ? rawSig.trim() : '';
      if (sig && !params?.reply_uid && !params?.forward_uid) {
        setBody(prev => prev + '<br><br>--<br>' + sig.replace(/\n/g, '<br>'));
      }
    } catch {}
  };

  // Draft auto-save
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

  // Keyboard shortcut refs — so event listener never goes stale
  const kbStateRef = useRef({ minimized: false });
  useEffect(() => { kbStateRef.current.minimized = minimized; }, [minimized]);
  const handleSendRef = useRef(null);
  const handleCloseRef = useRef(null);

  // Keyboard shortcut: Ctrl+Enter to send, Escape to close
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSendRef.current?.();
      }
      if (e.key === 'Escape' && !kbStateRef.current.minimized) {
        handleCloseRef.current?.();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const cancelUndoSend = useCallback(() => {
    if (undoSendRef.current) clearTimeout(undoSendRef.current);
    if (undoIntervalRef.current) clearInterval(undoIntervalRef.current);
    setUndoCountdown(0);
    setSending(false);
  }, []);

  const handleClose = () => {
    const hasContent = to.length > 0 || subject.trim() || body.trim() || attachments.length > 0;
    if (hasContent) {
      if (Platform.OS === 'web') {
        if (!window.confirm(t('compose.discardDraftConfirm'))) return;
      }
    }
    // Save draft on close if has content
    if (hasContent && contentChangedRef.current) {
      saveDraftRef.current();
    }
    onClose();
  };
  // Keep ref always up-to-date
  useEffect(() => { handleCloseRef.current = handleClose; });

  const handleSend = () => {
    toRef.current?.flush();
    setTimeout(() => doSend(), 60);
  };
  // Keep ref always up-to-date
  useEffect(() => { handleSendRef.current = handleSend; });

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
        const r = await sendEmail(
          toStr, sendSubject, sendBody, ccStr, bccStr,
          params?.reply_uid || null,
          params?.folder || 'INBOX',
          sendAttachments,
        );
        if (r.success) {
          if (draftTimerRef.current) clearInterval(draftTimerRef.current);
          setSuccess(true);
          refresh();
          setTimeout(() => onClose(), 1500);
        } else {
          setError(r.message || t('compose.errorSend'));
          setSending(false);
        }
      } catch {
        setError(t('compose.errorConnection'));
        setSending(false);
      }
    }, delay * 1000);
  };

  // Window title
  const windowTitle = isReply
    ? (isReplyAll ? t('compose.replyAll') : t('compose.reply'))
    : isForward ? t('compose.forward')
    : t('compose.title');

  // Dynamic dimensions based on maximized state
  const modalStyle = maximized
    ? {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        borderRadius: 0,
        zIndex: 1000,
      }
    : {
        position: 'fixed',
        bottom: 0,
        right: 24,
        width: 520,
        height: minimized ? 48 : 520,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        zIndex: 1000,
        overflow: 'hidden',
      };

  if (Platform.OS !== 'web') return null;

  return (
    <View style={[cm.modal, modalStyle, { backgroundColor: colors.surface }]}>
      {/* Header Bar */}
      <TouchableOpacity
        style={[cm.header, { backgroundColor: isDark ? '#2d3142' : '#404040' }]}
        onPress={() => setMinimized(prev => !prev)}
        activeOpacity={0.9}
        accessibilityRole="button"
        accessibilityLabel={minimized ? 'Expand compose window' : 'Minimize compose window'}
      >
        <Text style={cm.headerTitle} numberOfLines={1}>
          {subject ? subject : windowTitle}
        </Text>

        <View style={cm.headerBtns}>
          {/* Minimize / Restore */}
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); setMinimized(prev => !prev); }}
            style={cm.iconBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={minimized ? 'Expand' : 'Minimize'}
          >
            {minimized
              ? <IconChevronUp size={16} color="#fff" />
              : <IconChevronDown size={16} color="#fff" />
            }
          </TouchableOpacity>

          {/* Maximize / Restore */}
          {!minimized && (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation(); setMaximized(prev => !prev); }}
              style={cm.iconBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? <IconRestore size={14} color="#fff" /> : <IconMaximize size={14} color="#fff" />}
            </TouchableOpacity>
          )}

          {/* Close */}
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); handleClose(); }}
            style={cm.iconBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Close compose window"
          >
            <IconX size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {/* Body — hidden when minimized */}
      {!minimized && (
        <View style={cm.body}>
          {loading ? (
            <View style={cm.loadingWrap}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : success ? (
            <View style={cm.successWrap}>
              <Text style={[cm.successText, { color: colors.success }]}>
                {t('compose.sent')}
              </Text>
            </View>
          ) : (
            <>
              {/* Status Bars */}
              {undoCountdown > 0 && (
                <Animated.View style={[cm.statusBar, { backgroundColor: colors.toastBg, opacity: undoOpacity }]}>
                  <Text style={cm.statusBarText}>{t('compose.undoSending', { n: undoCountdown })}</Text>
                  <TouchableOpacity onPress={cancelUndoSend}>
                    <Text style={[cm.statusBarAction, { color: colors.primary }]}>{t('undo.button')}</Text>
                  </TouchableOpacity>
                </Animated.View>
              )}
              {draftSaved && !undoCountdown && (
                <Animated.View style={[cm.statusBar, { backgroundColor: colors.successBg, opacity: draftOpacity }]}>
                  <Text style={[cm.statusBarText, { color: colors.success }]}>{t('compose.draftSaved')}</Text>
                </Animated.View>
              )}
              {!!error && (
                <View style={[cm.statusBar, { backgroundColor: colors.errorBg }]}>
                  <Text style={[cm.statusBarText, { color: colors.error }]}>{error}</Text>
                  <TouchableOpacity onPress={() => setError('')}>
                    <IconX size={14} color={colors.error} />
                  </TouchableOpacity>
                </View>
              )}

              {/* Form */}
              <ScrollView style={cm.form} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
                {/* From row */}
                <View style={[cm.fieldRow, { borderBottomColor: colors.borderLight }]}>
                  <Text style={[cm.fieldLabel, { color: colors.textTertiary }]}>{t('compose.from')}</Text>
                  <Text style={[cm.fieldValue, { color: colors.textSecondary }]} numberOfLines={1}>{user?.email}</Text>
                </View>

                {/* To field */}
                <View style={[cm.contactRow, { borderBottomColor: colors.borderLight, zIndex: 30 }]}>
                  <View style={cm.contactInner}>
                    <ContactAutocomplete
                      ref={toRef}
                      value={to}
                      onChange={setTo}
                      placeholder={t('compose.recipientPlaceholder')}
                      label={t('compose.to')}
                    />
                  </View>
                  {(!showCc || !showBcc) && (
                    <View style={cm.ccBtns}>
                      {!showCc && (
                        <TouchableOpacity onPress={() => setShowCc(true)} style={[cm.ccToggle, { backgroundColor: colors.surfaceVariant }]}>
                          <Text style={[cm.ccToggleText, { color: colors.textSecondary }]}>Cc</Text>
                        </TouchableOpacity>
                      )}
                      {!showBcc && (
                        <TouchableOpacity onPress={() => setShowBcc(true)} style={[cm.ccToggle, { backgroundColor: colors.surfaceVariant }]}>
                          <Text style={[cm.ccToggleText, { color: colors.textSecondary }]}>Bcc</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>

                {showCc && (
                  <View style={[cm.contactRow, { borderBottomColor: colors.borderLight, zIndex: 20 }]}>
                    <ContactAutocomplete value={cc} onChange={setCc} placeholder="cc@email.com" label="Cc" />
                  </View>
                )}
                {showBcc && (
                  <View style={[cm.contactRow, { borderBottomColor: colors.borderLight, zIndex: 10 }]}>
                    <ContactAutocomplete value={bcc} onChange={setBcc} placeholder="bcc@email.com" label="Bcc" />
                  </View>
                )}

                {/* Subject */}
                <View style={[cm.fieldRow, { borderBottomColor: colors.borderLight }]}>
                  <Text style={[cm.fieldLabel, { color: colors.textTertiary }]}>{t('compose.subject')}</Text>
                  <TextInput
                    style={[cm.fieldInput, { color: colors.text }]}
                    value={subject}
                    onChangeText={setSubject}
                    placeholder={t('compose.subjectPlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>

                {/* Body */}
                <View style={cm.bodyContainer}>
                  <RichTextEditor
                    value={body}
                    onChange={setBody}
                    placeholder={isReply ? t('compose.replyWritePlaceholder') : t('compose.bodyPlaceholder')}
                    minHeight={maximized ? 320 : 180}
                  />
                </View>

                {/* Quoted HTML preview (reply/forward) */}
                {!!quotedHtml && (
                  <View style={[cm.quoteSection, { borderTopColor: colors.borderLight }]}>
                    {!!quotedHeader && (
                      <Text style={[cm.quoteHeader, { color: colors.textTertiary }]} numberOfLines={3}>
                        {quotedHeader}
                      </Text>
                    )}
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: '1.5',
                        color: colors.textSecondary,
                        borderLeft: '3px solid ' + (colors.borderLight || '#dadce0'),
                        paddingLeft: 12,
                        marginTop: 4,
                        overflow: 'hidden',
                        maxHeight: 100,
                        wordBreak: 'break-word',
                        opacity: 0.7,
                      }}
                      dangerouslySetInnerHTML={{ __html: quotedHtml }}
                    />
                  </View>
                )}

                {/* Attachments */}
                <View style={cm.attachSection}>
                  <AttachmentPicker
                    attachments={attachments}
                    onAdd={(f) => setAttachments(prev => [...prev, f])}
                    onRemove={(i) => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                    maxFiles={10}
                    maxSize={50 * 1024 * 1024}
                  />
                </View>

                {/* Spacer so toolbar doesn't overlap content */}
                <View style={{ height: 52 }} />
              </ScrollView>

              {/* Bottom toolbar — fixed inside modal */}
              <View style={[cm.toolbar, { borderTopColor: colors.borderLight, backgroundColor: colors.surface }]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cm.toolbarInner}>
                  <TouchableOpacity style={[cm.iconToolBtn, { backgroundColor: colors.surfaceVariant }]}>
                    <IconPaperclip size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[cm.iconToolBtn, { backgroundColor: colors.primaryLight }]}
                    onPress={async () => {
                      if (!body.trim()) return;
                      try {
                        const { aiAssist } = await import('../services/api');
                        const r = await aiAssist('improve_writing', { text: body, language: 'pt-BR' });
                        if (r.success && r.data?.result) setBody(r.data.result);
                      } catch {}
                    }}
                  >
                    <IconSparkles size={15} color={colors.primary} />
                  </TouchableOpacity>
                </ScrollView>

                {/* Send button */}
                <TouchableOpacity
                  style={[cm.sendBtn, { backgroundColor: sending ? colors.primaryMuted || colors.primary : colors.primary }]}
                  onPress={handleSend}
                  disabled={sending || success}
                  accessibilityLabel={t('compose.send') + ' (Ctrl+Enter)'}
                  accessibilityRole="button"
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <IconSend size={14} color="#fff" />
                      <Text style={cm.sendBtnText}>{t('compose.send')}</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const cm = StyleSheet.create({
  modal: {
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 8px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)',
    } : {}),
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: 14,
    flexShrink: 0,
    ...(Platform.OS === 'web' ? { cursor: 'default', userSelect: 'none' } : {}),
  },
  headerTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  headerBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },

  // Body
  body: {
    flex: 1,
    flexDirection: 'column',
    overflow: 'hidden',
  },

  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  successWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  successText: {
    fontSize: FontSize.xl,
    fontWeight: '600',
  },

  // Status bars
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    flexShrink: 0,
  },
  statusBarText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
    color: '#fff',
    flex: 1,
  },
  statusBarAction: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    marginLeft: 12,
  },

  // Form
  form: {
    flex: 1,
  },

  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactInner: {
    flex: 1,
    minWidth: 0,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '500',
    minWidth: 36,
    marginRight: 8,
    opacity: 0.7,
  },
  fieldValue: {
    flex: 1,
    fontSize: 13,
  },
  fieldInput: {
    flex: 1,
    fontSize: 13,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },

  ccBtns: {
    flexDirection: 'row',
    gap: 4,
    paddingTop: 6,
    flexShrink: 0,
  },
  ccToggle: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  ccToggleText: {
    fontSize: 11,
    fontWeight: '500',
  },

  // Body
  bodyContainer: {
    minHeight: 180,
  },

  // Quoted
  quoteSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  quoteHeader: {
    fontSize: 11,
    marginBottom: 6,
    lineHeight: 16,
  },

  // Attachments
  attachSection: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },

  // Toolbar
  toolbar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  toolbarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  iconToolBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },

  // Send button
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    height: 34,
    borderRadius: 17,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'opacity 0.15s' } : {}),
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
