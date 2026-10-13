/**
 * /import-whatsapp — Importar conversa do WhatsApp [2026-10-10 wa-import] [v2 2026-10-13]
 *
 * Entrada:
 *   • params.files  (JSON [{uri,name,mime,size}]) — vindo do compartilhar (share-receive)
 *   • params.linkEmail/linkName/originConvId — vindo do menu de uma conversa
 *   • nada → tela de explicação + "Escolher arquivo" (expo-document-picker; funciona por OTA)
 *
 * v2: a importação roda EM SEGUNDO PLANO (services/waImport/job) — sair desta tela não cancela;
 * a conversa continua utilizável (faixa "Importando do WhatsApp · N%" lá). Destino padrão de um
 * export 1:1 com um contato do Chatyy = CONTINUAÇÃO na conversa direta com a pessoa (verificada
 * no servidor por telefone/nome; senão pede confirmação explícita). Grupo / sem contato / E2EE /
 * conversa que já tem mensagens → cópia separada só sua. Resumo final + "Resumir com a Bia".
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
  IconChevronLeft,
} from '../components/Icons';
import { takeSharedText } from '../services/waImport/importer';
import * as job from '../services/waImport/job';
import { refreshImports, forgetImport } from '../services/waImport/registry';
import { waImportDelete } from '../services/waImport/api';

let ConversationSummarySheet = null;
try { ConversationSummarySheet = require('../components/chat/ConversationSummarySheet').default; } catch {}

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

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‎‏‪-‮]/g, '').toLowerCase().trim();
function nameLike(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const fx = x.split(' ')[0], fy = y.split(' ')[0];
  return fx.length >= 3 && fx === fy && (x.includes(y) || y.includes(x));
}
const convPeerEmail = (c) => c.other_email || c.contact_email || c.peer_email || '';
const convName = (c) => c.name || c.display_name || c.other_name || '';

function fmtDate(tsLocal, lang) {
  if (!tsLocal) return '';
  try {
    const d = new Date(tsLocal);
    return d.toLocaleDateString(lang || undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return tsLocal.slice(0, 10); }
}

export default function ImportWhatsAppScreen() {
  const router = useRouter();
  // [2026-10-13] Aberta pelo menu Compartilhar do WhatsApp não há tela anterior →
  // sem botão voltar. Volta se der; senão vai para as Conversas.
  const goBackSafe = useCallback(() => {
    try { if (router.canGoBack && router.canGoBack()) { router.back(); return; } } catch {}
    try { router.replace('/chat'); } catch {}
  }, [router]);
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const confirm = useConfirm();

  const [jobState, setJobState] = useState(job.getJob());
  useEffect(() => job.subscribe(setJobState), []);

  const [step, setStep] = useState(() => {
    const st = job.getJob().status;
    if (st === 'running' || st === 'paused' || st === 'done' || st === 'cancelled') return 'job';
    if (st === 'ready' && job.getPrepared()) return 'review';
    return 'intro';
  }); // intro | reading | review | job | error
  const [prep, setPrep] = useState(() => job.getPrepared());
  const [meName, setMeName] = useState(() => job.getPrepared()?.guessedMe || null);
  const [title, setTitle] = useState(() => job.getPrepared()?.title || '');
  const [link, setLink] = useState(null); // { email, name, convId? }
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [dest, setDest] = useState('direct'); // direct | copy
  const [mismatchOk, setMismatchOk] = useState(false);
  const [serverMismatch, setServerMismatch] = useState(null); // { peer_name, export_name }
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState(null); // 'copy' | null
  const [imports, setImports] = useState([]);
  const [showBia, setShowBia] = useState(false);
  const [platformTab, setPlatformTab] = useState(Platform.OS === 'android' ? 'android' : 'ios');

  const ink = colors.text;
  const sub = colors.textSecondary;
  const line = colors.border || colors.borderLight;
  const card = colors.surface || colors.background;
  const originConvId = params.originConvId ? String(params.originConvId) : '';

  useEffect(() => {
    refreshImports(true).then((l) => setImports(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (params.linkEmail) setLink({ email: String(params.linkEmail), name: String(params.linkName || params.linkEmail), convId: originConvId || '' });
  }, [params.linkEmail, params.linkName, originConvId]);

  // E2EE da conversa de destino/origem → nunca histórico em texto puro nela.
  const e2eeTarget = useMemo(() => {
    const id = link?.convId || originConvId;
    if (!id) return false;
    try { return !!require('../services/e2eeV4').isConversationE2ee(id); } catch { return false; }
  }, [link, originConvId]);

  const errText = useCallback((e) => {
    const m = String(e?.reason || e?.message || e || '');
    if (m === 'no_chat_txt') return t('waImport.errNoChat');
    if (m === 'no_messages') return t('waImport.errNoMessages');
    if (m === 'too_big' || m === 'zip_too_big' || m === 'zip_entry_too_big') return t('waImport.errTooBig');
    if (m === 'zip_bomb' || m === 'zip_too_many' || m === 'zip_bad_cd') return t('waImport.errUnsafe');
    if (/zip_/.test(m)) return t('waImport.errZip');
    if (m === 'has_messages') return t('waImport.errHasMessages');
    if (m === 'e2ee') return t('waImport.errE2ee');
    if (m === 'group_export') return t('waImport.groupToCopy');
    if (m === 'peer_imported') return t('waImport.errPeerImported', { name: e?.data?.by_name || '' });
    if (m === 'rate_limited' || m === 'too_many_imports' || e?.status === 429) return t('waImport.errRate');
    if (m === 'already_running') return t('waImport.bannerRunning', { pct: Math.round(((job.getJob().progress || {}).frac || 0) * 100) });
    if (e?.status === 401 || m === 'auth') return t('waImport.errAuth');
    return t('waImport.errGeneric');
  }, [t]);

  // Sugere o contato pelo título do arquivo (conversas 1:1 do cache local).
  const suggestLink = useCallback((p) => {
    if (params.linkEmail) return;
    const cands = [p.fileTitle, ...(p.participants || []).map((x) => x.name)].filter(Boolean);
    const convs = readLocalConversations().filter((c) => (c.type || 'direct') === 'direct' && convPeerEmail(c));
    for (const cand of cands) {
      const hit = convs.find((c) => nameLike(convName(c), cand));
      if (hit) { setLink({ email: convPeerEmail(hit), name: convName(hit), convId: String(hit.id || '') }); return; }
    }
  }, [params.linkEmail]);

  const loadFiles = useCallback(async (files) => {
    if (job.isActive()) { setError(errText({ message: 'already_running' })); setStep('error'); return; }
    setStep('reading');
    setError(''); setErrorAction(null); setServerMismatch(null); setMismatchOk(false);
    try {
      const p = await job.prepare(files, {
        localeHint: language,
        myName: user?.name || user?.display_name || '',
        myPhone: user?.verified_phone || user?.phone || '',
        peerName: params.linkName ? String(params.linkName) : '',
        originConvId,
      });
      setPrep(p);
      setTitle(p.title || '');
      setMeName(p.guessedMe);
      suggestLink(p);
      setStep('review');
    } catch (e) {
      setError(errText(e));
      setStep('error');
    }
  }, [language, user, params.linkName, originConvId, errText, suggestLink]);

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

  // ── Inteligência: quem é a outra pessoa no export / bate com o contato? ──
  const others = useMemo(() => (prep?.participants || []).filter((p) => p.name !== meName), [prep, meName]);
  const isGroupExport = others.length > 1;
  const exportPeer = others.length === 1 ? others[0].name : '';
  const localMatch = useMemo(() => {
    if (!link || !prep) return null;
    if (exportPeer && nameLike(exportPeer, link.name)) return true;
    if (prep.fileTitle && nameLike(prep.fileTitle, link.name)) return true;
    return false;
  }, [link, prep, exportPeer]);
  const directPossible = !!link && !isGroupExport && !e2eeTarget;
  const effDest = directPossible ? dest : 'copy';
  // Telefone no export → quem confere é o servidor (cadastro da pessoa); nome → confere aqui também.
  const exportPeerIsPhone = String(exportPeer).replace(/\D/g, '').length >= 8 && !/[A-Za-zÀ-ÿ]/.test(exportPeer);
  const needsConfirm = effDest === 'direct' && (!!serverMismatch || (localMatch === false && !exportPeerIsPhone));

  const resolveTargetConv = useCallback(async () => {
    if (link?.convId) return link.convId;
    const hit = readLocalConversations().find((c) => (c.type || 'direct') === 'direct' && String(convPeerEmail(c)).toLowerCase() === String(link.email).toLowerCase());
    if (hit?.id) return String(hit.id);
    const api = require('../services/api');
    const r = await api.chatCreate([link.email], '', 'direct');
    const id = r?.data?.id || r?.data?.conversation_id || r?.data?.conversation?.id;
    if (!id) throw Object.assign(new Error('start_failed'), {});
    return String(id);
  }, [link]);

  const start = useCallback(async (forceCopy) => {
    if (!prep || !meName) return;
    const useDirect = !forceCopy && effDest === 'direct';
    if (useDirect && needsConfirm && !mismatchOk) return;
    if (!useDirect && e2eeTarget && !forceCopy) {
      const ok = Platform.OS === 'web'
        ? (typeof window !== 'undefined' && window.confirm(t('waImport.errE2ee')))
        : await confirm({ title: t('waImport.title'), message: t('waImport.errE2ee'), confirmLabel: t('waImport.useCopy') });
      if (!ok) return;
    }
    setError(''); setErrorAction(null);
    let targetConversationId = null;
    try { if (useDirect) targetConversationId = await resolveTargetConv(); }
    catch (e) { setError(errText(e)); setStep('error'); return; }
    setStep('job');
    try {
      await job.start({
        meName,
        title: useDirect ? (link?.name || prep.title) : (title.trim() || prep.title),
        linkEmail: link?.email || '',
        email: user?.email || '',
        mode: useDirect ? 'direct' : 'copy',
        targetConversationId,
        peerHintName: link?.name || '',
        fileTitle: prep.fileTitle || '',
        confirmMismatch: useDirect && (mismatchOk || !!serverMismatch),
        originConvId: originConvId || targetConversationId || null,
      });
      refreshImports(true).then((l) => setImports(Array.isArray(l) ? l : [])).catch(() => {});
    } catch (e) {
      const reason = e?.reason || e?.message;
      if (reason === 'unverified') {
        setServerMismatch({ peer_name: e?.data?.peer_name || link?.name || '', export_name: e?.data?.export_name || exportPeer });
        setMismatchOk(false);
        setStep('review');
        return;
      }
      setError(errText(e));
      setErrorAction(['has_messages', 'e2ee', 'group_export', 'peer_imported'].includes(reason) ? 'copy' : null);
      setStep('error');
    }
  }, [prep, meName, effDest, needsConfirm, mismatchOk, e2eeTarget, confirm, t, resolveTargetConv, errText, link, title, user, serverMismatch, originConvId, exportPeer]);

  const openConversation = useCallback((convId, name, direct) => {
    try {
      require('../services/openConversation').openConversation({
        pathname: '/chat-conversation',
        params: direct ? { id: String(convId), name: name || '', type: 'direct', email: link?.email || '' } : { id: String(convId), name: name || '', type: 'group' },
      }, { replace: true });
    } catch {}
  }, [link]);

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

  const cancelImport = useCallback(async () => {
    const msg = t('waImport.cancelConfirm');
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(msg))
      : await confirm({ title: t('waImport.cancelImport'), message: msg, confirmLabel: t('waImport.cancelImport'), destructive: true });
    if (ok) job.cancel();
  }, [confirm, t]);

  const linkCandidates = useMemo(() => {
    if (!showLinkPicker) return [];
    return readLocalConversations()
      .filter((c) => (c.type || 'direct') === 'direct' && convPeerEmail(c))
      .slice(0, 80)
      .map((c) => ({ email: convPeerEmail(c), name: convName(c) || convPeerEmail(c), convId: String(c.id || '') }));
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

  const Note = ({ text, icon: Icon = IconLock }) => (
    <View style={[s.note, { borderColor: line }]}>
      <Icon size={16} color={ink} />
      <Text style={[s.noteText, { color: sub }]}>{text}</Text>
    </View>
  );

  const Radio = ({ on, title: tt, subtitle, onPress, disabled }) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[s.partRow, disabled && { opacity: 0.4 }]} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!disabled }}>
      <View style={[s.radio, { borderColor: ink }, on && { backgroundColor: ink }]}>{on ? <IconCheck size={12} color={colors.background} /> : null}</View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: ink, fontSize: 15 }} numberOfLines={2}>{tt}</Text>
        {subtitle ? <Text style={{ color: sub, fontSize: 12, marginTop: 2, lineHeight: 16 }}>{subtitle}</Text> : null}
      </View>
    </TouchableOpacity>
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
      <Note text={t('waImport.backgroundHint')} icon={IconRefresh} />
      <Btn label={t('waImport.pickFile')} onPress={pickFile} icon={IconFileText} />
      {imports.length > 0 && (
        <View style={{ marginTop: 24 }}>
          <Text style={[s.section, { color: sub }]}>{t('waImport.previous')}</Text>
          {imports.map((it) => (
            <View key={it.id} style={[s.impRow, { borderColor: line }]}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => openConversation(it.conversation_id, it.title, it.mode === 'direct')} accessibilityRole="button">
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
    const mismatchExport = serverMismatch?.export_name || exportPeer || prep.fileTitle || '';
    return (
      <>
        <Text style={[s.h2, { color: ink }]}>{t('waImport.reviewTitle')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line }]}>
          <Text style={{ color: ink, fontSize: 15 }}>{t('waImport.statsMessages', { n: st.total })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>{t('waImport.statsRange', { from: fmtDate(st.first, language), to: fmtDate(st.last, language) })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>
            {t('waImport.statsMedia', { n: st.mediaPresent })}{st.mediaMissing + st.mediaOmitted > 0 ? ' · ' + t('waImport.statsMediaMissing', { n: st.mediaMissing + st.mediaOmitted }) : ''}
          </Text>
          {prep.format ? <Text style={{ color: sub, fontSize: 12, marginTop: 4 }}>{t('waImport.format', { fmt: prep.format })}</Text> : null}
        </View>

        <Text style={[s.section, { color: sub }]}>{t('waImport.whoAreYou')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4 }]}>
          {prep.participants.slice(0, 50).map((p) => {
            const on = meName === p.name;
            return (
              <TouchableOpacity key={p.name} onPress={() => { setMeName(p.name); setServerMismatch(null); setMismatchOk(false); }} style={s.partRow} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <View style={[s.radio, { borderColor: ink }, on && { backgroundColor: ink }]}>{on ? <IconCheck size={12} color={colors.background} /> : null}</View>
                <Text style={{ color: ink, fontSize: 15, flex: 1 }} numberOfLines={1}>{p.name}</Text>
                {p.name === prep.guessedMe ? <Text style={[s.pill, { color: sub, borderColor: line }]}>{t('waImport.suggested')}</Text> : null}
                <Text style={{ color: sub, fontSize: 12 }}>{t('waImport.msgCount', { n: p.count })}</Text>
              </TouchableOpacity>
            );
          })}
          {prep.participants.length > 50 ? <Text style={[s.small, { color: sub, paddingHorizontal: 12 }]}>+{prep.participants.length - 50}</Text> : null}
        </View>
        {!meName ? <Text style={[s.small, { color: sub, marginBottom: 8 }]}>{t('waImport.pickMeHint')}</Text> : null}

        <Text style={[s.section, { color: sub }]}>{t('waImport.linkLabel')}</Text>
        <TouchableOpacity onPress={() => setShowLinkPicker((v) => !v)} style={[s.card, s.linkRow, { backgroundColor: card, borderColor: line }]} accessibilityRole="button">
          {link ? <IconUser size={18} color={ink} /> : <IconUsers size={18} color={ink} />}
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ color: ink, fontSize: 15 }} numberOfLines={1}>{link ? link.name : t('waImport.linkNone')}</Text>
            {link && localMatch ? <Text style={{ color: sub, fontSize: 12, marginTop: 2 }}>{t('waImport.verifiedOk', { name: link.name })}</Text> : null}
          </View>
          {link ? (
            <TouchableOpacity onPress={() => { setLink(null); setServerMismatch(null); }} hitSlop={10} accessibilityLabel={t('common.remove')}><IconX size={16} color={sub} /></TouchableOpacity>
          ) : <IconChevronRight size={18} color={sub} />}
        </TouchableOpacity>
        {showLinkPicker && (
          <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4, maxHeight: 260 }]}>
            <ScrollView nestedScrollEnabled>
              {linkCandidates.length === 0 ? <Text style={[s.small, { color: sub, padding: 12 }]}>{t('waImport.linkEmpty')}</Text> : null}
              {linkCandidates.map((c) => (
                <TouchableOpacity key={c.email} onPress={() => { setLink(c); setShowLinkPicker(false); setServerMismatch(null); setMismatchOk(false); }} style={s.partRow}>
                  <IconUser size={16} color={ink} />
                  <Text style={{ color: ink, fontSize: 15, marginLeft: 10, flex: 1 }} numberOfLines={1}>{c.name}</Text>
                  {exportPeer && nameLike(exportPeer, c.name) ? <Text style={[s.pill, { color: sub, borderColor: line }]}>{t('waImport.suggested')}</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <Text style={[s.section, { color: sub }]}>{t('waImport.destLabel')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4 }]}>
          <Radio on={effDest === 'direct'} disabled={!directPossible} onPress={() => setDest('direct')}
            title={t('waImport.destDirect', { name: link?.name || '…' })}
            subtitle={isGroupExport ? t('waImport.groupToCopy') : e2eeTarget ? t('waImport.errE2ee') : t('waImport.destDirectSub', { name: link?.name || '' })} />
          <Radio on={effDest === 'copy'} onPress={() => setDest('copy')} title={t('waImport.destCopy')} subtitle={t('waImport.destCopySub')} />
        </View>

        {effDest === 'direct' && needsConfirm ? (
          <View style={[s.card, { borderColor: ink, backgroundColor: card }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <IconAlertTriangle size={18} color={ink} />
              <Text style={{ color: ink, fontSize: 14, flex: 1, lineHeight: 19 }}>{t('waImport.verifyMismatch', { export: mismatchExport, name: link?.name || '' })}</Text>
            </View>
            <Radio on={mismatchOk} onPress={() => setMismatchOk((v) => !v)} title={t('waImport.verifyConfirm', { name: link?.name || '' })} />
          </View>
        ) : null}

        {effDest === 'copy' ? (
          <>
            <Text style={[s.section, { color: sub }]}>{t('waImport.nameLabel')}</Text>
            <TextInput
              value={title} onChangeText={setTitle} maxLength={80}
              style={[s.input, { color: ink, borderColor: line }]} placeholder="WhatsApp" placeholderTextColor={sub}
            />
            <Note text={t('waImport.privacyNote')} />
          </>
        ) : null}

        <Btn label={t('waImport.startImport')} onPress={() => start(false)} disabled={!meName || (effDest === 'direct' && needsConfirm && !mismatchOk)} icon={IconDownload} />
        <View style={{ height: 10 }} />
        <Btn label={t('common.cancel')} solid={false} onPress={() => { job.reset(); setPrep(null); setStep('intro'); }} />
      </>
    );
  };

  const etaText = (sec) => {
    if (sec == null) return '';
    if (sec < 60) return t('waImport.etaLessMin');
    return t('waImport.etaMin', { n: Math.round(sec / 60) });
  };

  const renderJob = () => {
    const j = jobState;
    const p = j.progress || {};
    const frac = Math.min(1, p.frac || 0);
    if (j.status === 'done' || j.status === 'cancelled') return renderDone();
    if (j.status === 'error') {
      return (
        <View style={{ alignItems: 'center', paddingTop: 32 }}>
          <IconAlertTriangle size={40} color={ink} />
          <Text style={{ color: ink, textAlign: 'center', marginTop: 12, fontSize: 15 }}>{errText(j.error)}</Text>
          <View style={{ height: 20, alignSelf: 'stretch' }} />
          <View style={{ alignSelf: 'stretch' }}>
            <Btn label={t('common.retry')} onPress={() => job.retry().catch(() => {})} icon={IconRefresh} />
          </View>
        </View>
      );
    }
    const verifiedLine = p.mode === 'direct' && p.verified
      ? (p.verified === 'user_confirmed' ? t('waImport.destDirect', { name: link?.name || j.title || '' }) : t('waImport.verifiedOk', { name: link?.name || j.title || '' }))
      : '';
    return (
      <View style={{ paddingTop: 24 }}>
        <Text style={[s.h2, { color: ink, textAlign: 'center' }]}>{j.status === 'paused' ? t('waImport.bannerPaused', { pct: Math.round(frac * 100) }) : t('waImport.importing')}</Text>
        {verifiedLine ? <Text style={{ color: sub, textAlign: 'center', fontSize: 13 }}>{verifiedLine}</Text> : null}
        <View style={[s.bar, { borderColor: ink }]}><View style={{ width: `${Math.round(frac * 100)}%`, height: '100%', backgroundColor: ink }} /></View>
        <Text style={{ color: ink, textAlign: 'center', fontSize: 15 }}>{t('waImport.progressMessages', { n: p.sent || 0, total: p.total || 0 })}</Text>
        {p.mediaTotal ? <Text style={{ color: sub, textAlign: 'center', fontSize: 13, marginTop: 6 }}>{t('waImport.progressMedia', { n: p.mediaDone || 0, total: p.mediaTotal })}</Text> : null}
        {j.status === 'running' && p.etaSec != null ? <Text style={{ color: sub, textAlign: 'center', fontSize: 13, marginTop: 6 }}>{etaText(p.etaSec)}</Text> : null}
        <Text style={[s.small, { color: sub, textAlign: 'center', marginTop: 16 }]}>{t('waImport.backgroundHint')}</Text>
        <View style={{ height: 20 }} />
        <Btn label={t('waImport.backToChat')} onPress={goBackSafe} icon={IconMessageSquare} />
        <View style={{ height: 10 }} />
        {j.status === 'paused'
          ? <Btn label={t('waImport.resume')} solid={false} onPress={() => job.resume()} />
          : <Btn label={t('waImport.pause')} solid={false} onPress={() => job.pause()} />}
        <View style={{ height: 10 }} />
        <Btn label={t('waImport.cancelImport')} solid={false} onPress={cancelImport} />
      </View>
    );
  };

  const renderDone = () => {
    const r = jobState.result || {};
    const sm = r.summary || {};
    const direct = r.mode === 'direct';
    const rows = [
      ['waImport.sumMessages', sm.messages], ['waImport.sumPhotos', sm.photos], ['waImport.sumVideos', sm.videos],
      ['waImport.sumAudios', sm.audios], ['waImport.sumStickers', sm.stickers], ['waImport.sumDocs', sm.docs],
      ['waImport.sumAlready', sm.alreadyThere], ['waImport.sumMissing', sm.missing], ['waImport.sumFailed', sm.failed],
      ['waImport.sumBlocked', sm.blocked],
    ].filter(([, n]) => Number(n) > 0);
    const nf = (n) => { try { return Number(n).toLocaleString(language || undefined); } catch { return String(n); } };
    const convTitle = direct ? (link?.name || jobState.title) : (title || jobState.title || prep?.title);
    return (
      <View style={{ alignItems: 'center', paddingTop: 32 }}>
        <IconCheckCircle size={48} color={ink} />
        <Text style={[s.h2, { color: ink, marginTop: 12, textAlign: 'center' }]}>{jobState.status === 'cancelled' ? t('waImport.cancelledTitle') : t('waImport.doneTitle')}</Text>
        {rows.length ? (
          <View style={[s.card, { backgroundColor: card, borderColor: line, alignSelf: 'stretch', marginTop: 12 }]}>
            {rows.map(([k, n]) => (
              <View key={k} style={s.sumRow}>
                <Text style={{ color: sub, fontSize: 14, flex: 1 }}>{t(k)}</Text>
                <Text style={{ color: ink, fontSize: 14, fontWeight: '600' }}>{nf(n)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={{ height: 16, alignSelf: 'stretch' }} />
        {r.conversationId ? (
          <View style={{ alignSelf: 'stretch' }}>
            <Btn label={t('waImport.openChat')} onPress={() => { const id = r.conversationId; job.reset(); openConversation(id, convTitle, direct); }} icon={IconMessageSquare} />
            {ConversationSummarySheet && jobState.status === 'done' ? (
              <>
                <View style={{ height: 10 }} />
                <Btn label={t('waImport.askBia')} solid={false} onPress={() => setShowBia(true)} />
              </>
            ) : null}
            <View style={{ height: 10 }} />
            <Btn label={t('common.back')} solid={false} onPress={() => { job.reset(); setPrep(null); setStep('intro'); }} />
          </View>
        ) : null}
        {showBia && ConversationSummarySheet && r.conversationId ? (
          <ConversationSummarySheet
            visible
            onClose={() => setShowBia(false)}
            conversationId={r.conversationId}
            messages={[]}
            currentEmail={user?.email || ''}
            myName={user?.name || ''}
            initialRange="last300"
            isGroup={!direct}
            colors={colors}
            isDark={isDark}
            t={t}
          />
        ) : null}
      </View>
    );
  };

  const renderError = () => (
    <View style={{ alignItems: 'center', paddingTop: 32 }}>
      <IconAlertTriangle size={40} color={ink} />
      <Text style={{ color: ink, textAlign: 'center', marginTop: 12, fontSize: 15, lineHeight: 21 }}>{error || t('waImport.errGeneric')}</Text>
      <View style={{ height: 20, alignSelf: 'stretch' }} />
      <View style={{ alignSelf: 'stretch' }}>
        {errorAction === 'copy' && prep ? <><Btn label={t('waImport.useCopy')} onPress={() => { setDest('copy'); start(true); }} icon={IconDownload} /><View style={{ height: 10 }} /></> : null}
        {prep ? <Btn label={t('common.back')} solid={errorAction !== 'copy'} onPress={() => { setStep('review'); setError(''); }} /> : <Btn label={t('waImport.pickFile')} onPress={pickFile} icon={IconFileText} />}
        {!prep ? <><View style={{ height: 10 }} /><Btn label={t('common.back')} solid={false} onPress={() => { setStep('intro'); setError(''); }} /></> : null}
      </View>
    </View>
  );

  const readingPct = Math.round((jobState.prepProgress || 0) * 100);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('waImport.title'), headerLeft: () => (
          <TouchableOpacity onPress={goBackSafe} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'} style={{ paddingRight: 8 }}>
            <IconChevronLeft size={26} color={colors.text} />
          </TouchableOpacity>
        ) })} />
      ) : (
        <ModalHeader title={t('waImport.title')} onClose={goBackSafe} />
      )}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom, maxWidth: 640, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {step === 'intro' && renderIntro()}
        {step === 'reading' && (
          <View style={{ alignItems: 'center', paddingTop: 48 }}>
            <ActivityIndicator color={ink} />
            <Text style={{ color: sub, marginTop: 12 }}>{readingPct > 2 ? t('waImport.readingPct', { pct: readingPct }) : t('waImport.reading')}</Text>
            <View style={{ height: 20 }} />
            <Btn label={t('common.cancel')} solid={false} onPress={() => { job.cancel(); setStep('intro'); }} />
          </View>
        )}
        {step === 'review' && prep && renderReview()}
        {step === 'job' && renderJob()}
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
  pill: { fontSize: 11, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1, marginRight: 8, overflow: 'hidden' },
  sumRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
});
