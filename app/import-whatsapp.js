/**
 * /import-whatsapp — Importar conversa do WhatsApp [2026-10-10 wa-import]
 *
 * Entrada:
 *   • params.files  (JSON [{uri,name,mime,size}]) — vindo do compartilhar (share-receive)
 *   • params.linkEmail/linkName — vindo do menu de uma conversa (vincula ao contato)
 *   • nada → tela de explicação + "Escolher arquivo" (expo-document-picker; funciona por OTA)
 *
 * Fluxo: explicação → leitura/parse no aparelho → revisão (quem é você, título,
 * vincular a contato) → importação em lotes com progresso → abrir a conversa.
 * Privacidade: a importação é uma cópia pessoal (só você vê; ninguém é notificado).
 */
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, ActivityIndicator, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import ModalHeader from '../components/ModalHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../components/ConfirmModal';
import {
  IconDownload, IconFileText, IconLock, IconCheck, IconCheckCircle, IconAlertTriangle,
  IconUser, IconUsers, IconMessageSquare, IconTrash, IconRefresh, IconChevronRight, IconX,
} from '../components/Icons';
import { prepareImport, runImport, takeSharedText } from '../services/waImport/importer';
import { refreshImports, forgetImport } from '../services/waImport/registry';
import { waImportDelete } from '../services/waImport/api';

function readLocalConversations() {
  try {
    const cs = require('../services/chatStore');
    const l = cs.getConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  try {
    const sc = require('../services/smartChatCache');
    const l = sc.getCachedConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  return [];
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function fmtDate(tsLocal, lang) {
  if (!tsLocal) return '';
  try {
    const d = new Date(tsLocal);
    return d.toLocaleDateString(lang || undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return tsLocal.slice(0, 10); }
}

export default function ImportWhatsAppScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const confirm = useConfirm();

  const [step, setStep] = useState('intro'); // intro | reading | review | importing | done | error
  const [prep, setPrep] = useState(null);
  const [meName, setMeName] = useState(null);
  const [title, setTitle] = useState('');
  const [link, setLink] = useState(null); // { email, name }
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [imports, setImports] = useState([]);
  const cancelRef = useRef({ cancelled: false });
  const [platformTab, setPlatformTab] = useState(Platform.OS === 'android' ? 'android' : 'ios');

  const ink = colors.text;
  const sub = colors.textSecondary;
  const line = colors.border || colors.borderLight;
  const card = colors.surface || colors.background;

  useEffect(() => {
    refreshImports(true).then((l) => setImports(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (params.linkEmail) setLink({ email: String(params.linkEmail), name: String(params.linkName || params.linkEmail) });
  }, [params.linkEmail, params.linkName]);

  const errText = useCallback((e) => {
    const m = String(e?.message || e || '');
    if (m === 'no_chat_txt') return t('waImport.errNoChat');
    if (m === 'no_messages') return t('waImport.errNoMessages');
    if (/zip_/.test(m)) return t('waImport.errZip');
    if (e?.status === 401 || m === 'auth') return t('waImport.errAuth');
    return t('waImport.errGeneric');
  }, [t]);

  const loadFiles = useCallback(async (files) => {
    setStep('reading');
    setError('');
    try {
      const p = await prepareImport(files, { localeHint: language, myName: user?.name || user?.display_name || '' });
      setPrep(p);
      setTitle(p.title || '');
      setMeName(p.guessedMe);
      // Sugere vincular ao contato com o mesmo nome do título (conversas 1:1 do cache local).
      if (!params.linkEmail) {
        const tt = norm(p.title);
        const hit = tt ? readLocalConversations().find((c) => (c.type || 'direct') === 'direct' && norm(c.name || c.display_name || c.other_name) === tt && (c.other_email || c.contact_email)) : null;
        if (hit) setLink({ email: hit.other_email || hit.contact_email, name: hit.name || hit.display_name || hit.other_name });
      }
      setStep('review');
    } catch (e) {
      setError(errText(e));
      setStep('error');
    }
  }, [language, user, params.linkEmail, errText]);

  // Arquivos vindos do compartilhar.
  const sharedOnce = useRef(false);
  useEffect(() => {
    if (sharedOnce.current) return;
    if (params.sharedText) {
      sharedOnce.current = true;
      const txt = takeSharedText();
      if (txt) loadFiles([{ text: txt, name: '' }]);
      return;
    }
    if (!params.files) return;
    sharedOnce.current = true;
    try {
      const arr = JSON.parse(String(params.files));
      if (Array.isArray(arr) && arr.length) loadFiles(arr);
    } catch {}
  }, [params.files, params.sharedText, loadFiles]);

  const pickFile = useCallback(async () => {
    try {
      const DocumentPicker = require('expo-document-picker');
      const r = await DocumentPicker.getDocumentAsync({
        type: Platform.OS === 'ios' ? ['public.zip-archive', 'public.plain-text', 'public.item'] : ['application/zip', 'text/plain', '*/*'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (r?.canceled || !r?.assets?.length) return;
      const files = r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType || '', size: a.size || 0, file: a.file }));
      loadFiles(files);
    } catch (e) {
      setError(t('waImport.errGeneric'));
      setStep('error');
    }
  }, [loadFiles, t]);

  const start = useCallback(async () => {
    if (!prep) return;
    if (!meName) return;
    cancelRef.current = { cancelled: false };
    setStep('importing');
    setProgress({ phase: 'messages', sent: 0, total: prep.messages.length, mediaDone: 0, mediaTotal: prep.stats.mediaPresent });
    let keep = null;
    try {
      try { keep = require('expo-keep-awake'); await keep.activateKeepAwakeAsync?.('wa-import'); } catch { keep = null; }
      const r = await runImport(prep, { meName, title: title.trim() || prep.title, linkEmail: link?.email || '', email: user?.email || '' }, setProgress, cancelRef.current);
      setResult(r);
      setStep(r.cancelled ? 'review' : 'done');
      refreshImports(true).then((l) => setImports(Array.isArray(l) ? l : [])).catch(() => {});
    } catch (e) {
      setError(errText(e));
      setStep('error');
    } finally {
      try { keep?.deactivateKeepAwake?.('wa-import'); } catch {}
    }
  }, [prep, meName, title, link, user, errText]);

  useEffect(() => () => { try { cancelRef.current.cancelled = true; } catch {} try { prep?.close?.(); } catch {} }, [prep]);

  const openConversation = useCallback((convId, name) => {
    try {
      router.replace({ pathname: '/chat-conversation', params: { id: String(convId), name: name || '', type: 'group' } });
    } catch {}
  }, [router]);

  const deleteImport = useCallback(async (item) => {
    const msg = t('waImport.deleteConfirm');
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(msg))
      : await confirm({ title: t('waImport.delete'), message: msg, confirmLabel: t('waImport.delete'), destructive: true });
    if (!ok) return;
    const r = await waImportDelete(item.id);
    if (r?.success) {
      forgetImport(item.id);
      setImports((l) => l.filter((x) => x.id !== item.id));
    }
  }, [confirm, t]);

  const linkCandidates = useMemo(() => {
    if (!showLinkPicker) return [];
    return readLocalConversations()
      .filter((c) => (c.type || 'direct') === 'direct' && (c.other_email || c.contact_email))
      .slice(0, 80)
      .map((c) => ({ email: c.other_email || c.contact_email, name: c.name || c.display_name || c.other_name || c.other_email }));
  }, [showLinkPicker]);

  // ── UI pieces ──────────────────────────────────────────────────────────
  const Btn = ({ label, onPress, solid = true, disabled, icon: Icon }) => (
    <TouchableOpacity
      onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={[s.btn, solid ? { backgroundColor: ink } : { borderWidth: 1, borderColor: ink }, disabled && { opacity: 0.4 }]}
    >
      {Icon ? <Icon size={18} color={solid ? colors.background : ink} /> : null}
      <Text style={[s.btnText, { color: solid ? colors.background : ink, marginLeft: Icon ? 8 : 0 }]}>{label}</Text>
    </TouchableOpacity>
  );

  const Step = ({ n, text }) => (
    <View style={s.stepRow}>
      <View style={[s.stepNum, { borderColor: ink }]}><Text style={{ color: ink, fontWeight: '700', fontSize: 13 }}>{n}</Text></View>
      <Text style={[s.stepText, { color: ink }]}>{text}</Text>
    </View>
  );

  const PrivacyNote = () => (
    <View style={[s.note, { borderColor: line }]}>
      <IconLock size={16} color={ink} />
      <Text style={[s.noteText, { color: sub }]}>{t('waImport.privacyNote')}</Text>
    </View>
  );

  const renderIntro = () => (
    <>
      <View style={s.hero}>
        <View style={[s.heroIcon, { borderColor: ink }]}><IconDownload size={28} color={ink} /></View>
        <Text style={[s.h1, { color: ink }]}>{t('waImport.title')}</Text>
        <Text style={[s.lead, { color: sub }]}>{t('waImport.lead')}</Text>
      </View>
      <View style={[s.tabs, { borderColor: line }]}>
        {['ios', 'android'].map((p) => (
          <TouchableOpacity key={p} onPress={() => setPlatformTab(p)} style={[s.tab, platformTab === p && { backgroundColor: ink }]} accessibilityRole="tab" accessibilityState={{ selected: platformTab === p }}>
            <Text style={{ color: platformTab === p ? colors.background : ink, fontWeight: '600', fontSize: 13 }}>{p === 'ios' ? 'iPhone' : 'Android'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={[s.card, { backgroundColor: card, borderColor: line }]}>
        <Step n={1} text={platformTab === 'ios' ? t('waImport.stepIos1') : t('waImport.stepAndroid1')} />
        <Step n={2} text={t('waImport.step2')} />
        <Step n={3} text={platformTab === 'ios' ? t('waImport.stepIos3') : t('waImport.stepAndroid3')} />
        <Step n={4} text={t('waImport.step4')} />
      </View>
      <PrivacyNote />
      <Btn label={t('waImport.pickFile')} onPress={pickFile} icon={IconFileText} />
      {imports.length > 0 && (
        <View style={{ marginTop: 24 }}>
          <Text style={[s.section, { color: sub }]}>{t('waImport.previous')}</Text>
          {imports.map((it) => (
            <View key={it.id} style={[s.impRow, { borderColor: line }]}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => openConversation(it.conversation_id, it.title)} accessibilityRole="button">
                <Text style={{ color: ink, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{it.title}</Text>
                <Text style={{ color: sub, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                  {it.status === 'done'
                    ? t('waImport.prevDone', { n: it.imported_messages })
                    : t('waImport.prevRunning', { n: it.imported_messages, total: it.total_messages })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteImport(it)} hitSlop={10} accessibilityLabel={t('waImport.delete')} style={{ padding: 6 }}>
                <IconTrash size={18} color={sub} />
              </TouchableOpacity>
              <IconChevronRight size={18} color={sub} />
            </View>
          ))}
          <Text style={[s.small, { color: sub }]}>{t('waImport.resumeHint')}</Text>
        </View>
      )}
    </>
  );

  const renderReview = () => {
    const st = prep.stats;
    return (
      <>
        <Text style={[s.h2, { color: ink }]}>{t('waImport.reviewTitle')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line }]}>
          <Text style={{ color: ink, fontSize: 15 }}>{t('waImport.statsMessages', { n: st.total })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>{t('waImport.statsRange', { from: fmtDate(st.first, language), to: fmtDate(st.last, language) })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>
            {t('waImport.statsMedia', { n: st.mediaPresent })}{st.mediaMissing + st.mediaOmitted > 0 ? ' · ' + t('waImport.statsMediaMissing', { n: st.mediaMissing + st.mediaOmitted }) : ''}
          </Text>
        </View>

        <Text style={[s.section, { color: sub }]}>{t('waImport.nameLabel')}</Text>
        <TextInput
          value={title} onChangeText={setTitle} maxLength={80}
          style={[s.input, { color: ink, borderColor: line }]} placeholder="WhatsApp" placeholderTextColor={sub}
        />

        <Text style={[s.section, { color: sub }]}>{t('waImport.whoAreYou')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4 }]}>
          {prep.participants.slice(0, 50).map((p) => {
            const on = meName === p.name;
            return (
              <TouchableOpacity key={p.name} onPress={() => setMeName(p.name)} style={s.partRow} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <View style={[s.radio, { borderColor: ink }, on && { backgroundColor: ink }]}>{on ? <IconCheck size={12} color={colors.background} /> : null}</View>
                <Text style={{ color: ink, fontSize: 15, flex: 1 }} numberOfLines={1}>{p.name}</Text>
                <Text style={{ color: sub, fontSize: 12 }}>{t('waImport.msgCount', { n: p.count })}</Text>
              </TouchableOpacity>
            );
          })}
          {prep.participants.length > 50 ? <Text style={[s.small, { color: sub, paddingHorizontal: 12 }]}>+{prep.participants.length - 50}</Text> : null}
        </View>
        {!meName ? <Text style={[s.small, { color: sub }]}>{t('waImport.pickMeHint')}</Text> : null}

        <Text style={[s.section, { color: sub }]}>{t('waImport.linkLabel')}</Text>
        <TouchableOpacity onPress={() => setShowLinkPicker((v) => !v)} style={[s.card, s.linkRow, { backgroundColor: card, borderColor: line }]} accessibilityRole="button">
          {link ? <IconUser size={18} color={ink} /> : <IconUsers size={18} color={ink} />}
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ color: ink, fontSize: 15 }} numberOfLines={1}>{link ? link.name : t('waImport.linkNone')}</Text>
            <Text style={{ color: sub, fontSize: 12, marginTop: 2 }}>{t('waImport.linkHint')}</Text>
          </View>
          {link ? (
            <TouchableOpacity onPress={() => setLink(null)} hitSlop={10} accessibilityLabel={t('common.remove')}><IconX size={16} color={sub} /></TouchableOpacity>
          ) : <IconChevronRight size={18} color={sub} />}
        </TouchableOpacity>
        {showLinkPicker && (
          <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4, maxHeight: 260 }]}>
            <ScrollView nestedScrollEnabled>
              {linkCandidates.length === 0 ? <Text style={[s.small, { color: sub, padding: 12 }]}>{t('waImport.linkEmpty')}</Text> : null}
              {linkCandidates.map((c) => (
                <TouchableOpacity key={c.email} onPress={() => { setLink(c); setShowLinkPicker(false); }} style={s.partRow}>
                  <IconUser size={16} color={ink} />
                  <Text style={{ color: ink, fontSize: 15, marginLeft: 10, flex: 1 }} numberOfLines={1}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <PrivacyNote />
        <Btn label={t('waImport.startImport')} onPress={start} disabled={!meName} icon={IconDownload} />
        <View style={{ height: 10 }} />
        <Btn label={t('common.cancel')} solid={false} onPress={() => { try { prep?.close?.(); } catch {} setPrep(null); setStep('intro'); }} />
      </>
    );
  };

  const renderImporting = () => {
    const p = progress || {};
    const frac = p.total ? Math.min(1, (p.sent || 0) / p.total) : 0;
    return (
      <View style={{ paddingTop: 24 }}>
        <Text style={[s.h2, { color: ink, textAlign: 'center' }]}>{t('waImport.importing')}</Text>
        <View style={[s.bar, { borderColor: ink }]}><View style={{ width: `${Math.round(frac * 100)}%`, height: '100%', backgroundColor: ink }} /></View>
        <Text style={{ color: ink, textAlign: 'center', fontSize: 15 }}>{t('waImport.progressMessages', { n: p.sent || 0, total: p.total || 0 })}</Text>
        {p.mediaTotal ? <Text style={{ color: sub, textAlign: 'center', fontSize: 13, marginTop: 6 }}>{t('waImport.progressMedia', { n: p.mediaDone || 0, total: p.mediaTotal })}</Text> : null}
        <Text style={[s.small, { color: sub, textAlign: 'center', marginTop: 16 }]}>{t('waImport.keepOpen')}</Text>
        <View style={{ height: 20 }} />
        <Btn label={t('waImport.pause')} solid={false} onPress={() => { cancelRef.current.cancelled = true; }} />
      </View>
    );
  };

  const renderDone = () => (
    <View style={{ alignItems: 'center', paddingTop: 32 }}>
      <IconCheckCircle size={48} color={ink} />
      <Text style={[s.h2, { color: ink, marginTop: 12, textAlign: 'center' }]}>{t('waImport.doneTitle')}</Text>
      <Text style={{ color: sub, textAlign: 'center', marginTop: 6 }}>{t('waImport.doneBody', { n: prep?.messages?.length || 0 })}</Text>
      {result?.skippedMedia || result?.failedMedia ? (
        <Text style={[s.small, { color: sub, textAlign: 'center' }]}>{t('waImport.doneMediaSkipped', { n: (result.skippedMedia || 0) + (result.failedMedia || 0) })}</Text>
      ) : null}
      <View style={{ height: 24, alignSelf: 'stretch' }} />
      <View style={{ alignSelf: 'stretch' }}>
        <Btn label={t('waImport.openChat')} onPress={() => openConversation(result.conversationId, title || prep?.title)} icon={IconMessageSquare} />
      </View>
    </View>
  );

  const renderError = () => (
    <View style={{ alignItems: 'center', paddingTop: 32 }}>
      <IconAlertTriangle size={40} color={ink} />
      <Text style={{ color: ink, textAlign: 'center', marginTop: 12, fontSize: 15 }}>{error || t('waImport.errGeneric')}</Text>
      <View style={{ height: 20, alignSelf: 'stretch' }} />
      <View style={{ alignSelf: 'stretch' }}>
        {prep ? <Btn label={t('common.retry')} onPress={start} icon={IconRefresh} /> : <Btn label={t('waImport.pickFile')} onPress={pickFile} icon={IconFileText} />}
        <View style={{ height: 10 }} />
        <Btn label={t('common.back')} solid={false} onPress={() => { setStep(prep ? 'review' : 'intro'); setError(''); }} />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('waImport.title') })} />
      ) : (
        <ModalHeader title={t('waImport.title')} onClose={() => router.back()} />
      )}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom, maxWidth: 640, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {step === 'intro' && renderIntro()}
        {step === 'reading' && (
          <View style={{ alignItems: 'center', paddingTop: 48 }}>
            <ActivityIndicator color={ink} />
            <Text style={{ color: sub, marginTop: 12 }}>{t('waImport.reading')}</Text>
          </View>
        )}
        {step === 'review' && prep && renderReview()}
        {step === 'importing' && renderImporting()}
        {step === 'done' && renderDone()}
        {step === 'error' && renderError()}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 12 },
  heroIcon: { width: 64, height: 64, borderRadius: 32, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  h1: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  h2: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  lead: { fontSize: 14, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, overflow: 'hidden', marginTop: 16, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginBottom: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 },
  stepNum: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 },
  stepText: { flex: 1, fontSize: 14, lineHeight: 20 },
  note: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginBottom: 16, gap: 8 },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18, marginLeft: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 12 },
  btnText: { fontSize: 15, fontWeight: '700' },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 8, marginBottom: 8 },
  small: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  impRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 8, fontSize: 15, marginBottom: 12 },
  partRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  linkRow: { flexDirection: 'row', alignItems: 'center' },
  bar: { height: 8, borderWidth: 1, borderRadius: 4, overflow: 'hidden', marginVertical: 16 },
});
