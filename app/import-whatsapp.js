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
 * (servidor antigo: conversa que já tem mensagens) → cópia separada só sua; servidor novo intercala
 * o histórico pela data/hora original [import-ordem 2026-10-13]. Resumo final + "Resumir com a Bia".
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
import { waImportDelete, waImportMatch } from '../services/waImport/api';
import { bestLocalMatch, nameScore, NAME_MIN_SCORE, rankCandidates, isPhoneReason } from '../services/waImport/match';
import { resolveParticipantPhones, lookupViaDiscovery } from '../services/waImport/phones'; // [wa-phone 2026-10-14]
import AvatarCircle from '../components/AvatarCircle';

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
  const [link, setLink] = useState(null); // { email, name, convId?, reason?: 'phone'|'name'|'mismatch', matched?, tail? }
  // [import-ordem 2026-10-13] wa_import_match: "quem sou eu" + com quem é a conversa (telefone/nome).
  const [matchInfo, setMatchInfo] = useState(null);
  const [meManual, setMeManual] = useState(false);
  const meManualRef = useRef(false);
  const [showMePicker, setShowMePicker] = useState(false);
  const matchSeqRef = useRef(0);
  const matchedOnceRef = useRef(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkAmbiguous, setLinkAmbiguous] = useState(false); // [wa-1a1 2026-10-14] 2+ pessoas igualmente prováveis → escolher
  // [wa-phone 2026-10-14] hashes dos telefones por autor (export/agenda) — só memória; agenda: ok|denied|unavailable|skipped
  const phonesRef = useRef(null);
  const [agendaState, setAgendaState] = useState('');
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
    // [wa-remetente 2026-10-13] aberto de dentro da conversa = escolha explícita (o aviso de número/nome divergente continua).
    if (params.linkEmail) setLink({ email: String(params.linkEmail), name: String(params.linkName || params.linkEmail), convId: originConvId || '', explicit: true });
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

  // [import-ordem 2026-10-13] Sugestão LOCAL estrita (servidor antigo / sem rede): só os autores que NÃO
  // são "eu" + título do arquivo, com pontuação mínima (Carol × Thalisa = 0 → nada sugerido; antes o
  // próprio nome do usuário entrava na busca e o 1º nome parecido de qualquer conversa ganhava).
  const suggestLink = useCallback((p, me) => {
    if (params.linkEmail) return;
    const names = [p.fileTitle, ...(p.participants || []).map((x) => x.name).filter((n) => n !== me)].filter(Boolean);
    const convs = readLocalConversations()
      .filter((c) => (c.type || 'direct') === 'direct' && convPeerEmail(c))
      .map((c) => ({ email: convPeerEmail(c), name: convName(c), convId: String(c.id || '') }));
    const hit = bestLocalMatch(names, convs);
    if (hit) setLink({ email: hit.email, name: hit.name, convId: hit.convId, reason: 'name', matched: hit.matched });
  }, [params.linkEmail]);

  // [import-ordem 2026-10-13] Servidor: telefone do export × cadastro (certeza) ou nome normalizado ×
  // nome/@ de quem tem conversa comigo; deduz "eu" (meu número / eliminação) e confirma a conversa de origem.
  const runMatch = useCallback(async (p) => {
    if (!p) return;
    const seq = ++matchSeqRef.current;
    const names = (p.participants || []).map((x) => x.name);
    // [wa-phone 2026-10-14] número > nome: remetente que já é número, ou o contato da agenda com o mesmo nome →
    // SÓ hashes sha256(E.164) vão pro servidor. Agenda negada → segue só com nome (nunca bloqueia).
    let ph = null;
    try { ph = await resolveParticipantPhones(p.participants, { t, myPhone: user?.verified_phone || user?.phone || '' }); } catch {}
    if (seq !== matchSeqRef.current) return;
    phonesRef.current = ph;
    setAgendaState(ph?.agenda || '');
    const phMe = ph?.meName && names.includes(ph.meName) ? ph.meName : null;
    let r = null;
    try {
      r = await waImportMatch({ participants: names, me: (!meManualRef.current && phMe) || p.guessedMe || undefined, file_title: p.fileTitle || '', origin_conversation_id: originConvId ? (Number(originConvId) || undefined) : undefined,
        participant_phones: ph?.participantPhones?.length ? ph.participantPhones : undefined });
    } catch {}
    if (seq !== matchSeqRef.current) return; // outro arquivo foi escolhido nesse meio-tempo
    if (!r?.success) { suggestLink(p, phMe || p.guessedMe); return; }
    const d0 = { ...(r.data || {}) };
    if (phMe && !meManualRef.current) { d0.me = phMe; d0.me_reason = 'phone'; }
    let cands0 = (d0.candidates || []).map((c) => (c.reason === 'contact_phone' && !c.phone_tail ? { ...c, phone_tail: ph?.byName?.[c.matched]?.tail || '' } : c));
    // servidor ainda sem o patch (sem phones_ok) → descoberta de contatos existente (chat_sync_contacts), se já consentida.
    if (!d0.phones_ok && ph?.consentGlobal && ph.participantPhones.length) {
      let extra = [];
      try { extra = await lookupViaDiscovery(ph.byName); } catch {}
      if (seq !== matchSeqRef.current) return;
      if (extra.length) {
        const convOf = (em) => {
          const hit = readLocalConversations().find((c) => (c.type || 'direct') === 'direct' && String(convPeerEmail(c)).toLowerCase() === em);
          return hit?.id ? Number(hit.id) || 0 : 0;
        };
        const ex = new Set(extra.map((c) => c.email));
        cands0 = [...extra.map((c) => ({ ...c, conversation_id: (cands0.find((x) => String(x.email).toLowerCase() === c.email) || {}).conversation_id || convOf(c.email) })),
          ...cands0.filter((c) => !ex.has(String(c.email).toLowerCase()))];
      }
    }
    cands0 = [...cands0.filter((c) => isPhoneReason(c.reason)), ...cands0.filter((c) => !isPhoneReason(c.reason))];
    const me = (d0.me && names.includes(d0.me) && !meManualRef.current) ? d0.me : p.guessedMe;
    // [wa-1a1 2026-10-14] a pessoa é o OUTRO autor: candidato que só bate com o MEU nome no export
    // (ex.: conta com @ "aleff_qa" × autor "Aleff") nunca é sugerido (servidor antigo ainda manda).
    const d = { ...d0, candidates: cands0.filter((c) => !me || c.reason === 'phone' || c.matched !== me) };
    setMatchInfo(d);
    if (d.me && names.includes(d.me) && !meManualRef.current) setMeName(d.me);
    if (!params.linkEmail) {
      const cs = d.candidates;
      const c = cs[0];
      const strong = (x) => x && (isPhoneReason(x.reason) || Number(x.score) >= NAME_MIN_SCORE);
      // empate entre os melhores (ou só "mesmo primeiro nome" com 2+ pessoas) → não escolhe sozinho: abre a lista.
      // [wa-phone 2026-10-14] número vence nome sem perguntar; só 2+ contas pelo NÚMERO (contato com números de pessoas diferentes) → lista.
      const tie = !!c && cs.length > 1 && (isPhoneReason(c.reason)
        ? isPhoneReason(cs[1].reason)
        : (Number(cs[1].score) >= Number(c.score) || (!strong(c) && !strong(cs[1]))));
      if (c && !tie) {
        setLinkAmbiguous(false);
        setLink({ email: c.email, name: c.name || c.email, convId: c.conversation_id ? String(c.conversation_id) : '', reason: c.reason, matched: c.matched, tail: c.phone_tail });
      } else if (tie) {
        setLinkAmbiguous(true);
        setShowLinkPicker(true);
      }
    } else if (d.origin) {
      setLink((l) => (l && String(l.email).toLowerCase() === String(d.origin.email || '').toLowerCase()
        ? { ...l, reason: d.origin.verdict, matched: d.origin.matched, tail: d.origin.phone_tail || (d.origin.verdict === 'contact_phone' ? ph?.byName?.[d.origin.matched]?.tail || '' : '') } : l));
    }
  }, [params.linkEmail, originConvId, suggestLink, t, user]);

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
      setMatchInfo(null); setMeManual(false); meManualRef.current = false; setShowMePicker(false);
      setLinkAmbiguous(false); // [wa-1a1 2026-10-14]
      phonesRef.current = null; setAgendaState(''); // [wa-phone 2026-10-14]
      matchedOnceRef.current = true;
      runMatch(p); // [import-ordem 2026-10-13]
      setStep('review');
    } catch (e) {
      setError(errText(e));
      setStep('error');
    }
  }, [language, user, params.linkName, originConvId, errText, runMatch]);

  // Voltou para a revisão de um export já preparado (job em memória) → refaz a verificação.
  useEffect(() => {
    if (matchedOnceRef.current || !prep || step !== 'review') return;
    matchedOnceRef.current = true;
    if (!matchInfo) runMatch(prep);
  }, [prep, step, matchInfo, runMatch]);

  const sharedOnce = useRef(false);
  useEffect(() => {
    if (sharedOnce.current) return;
    if (params.sharedText) {
      sharedOnce.current = true;
      const txt = takeSharedText();
      // [2026-10-20 wa-export] texto do chat + mídias soltas (iOS) → importa as duas coisas juntas
      let extra = [];
      try { const a = params.files ? JSON.parse(String(params.files)) : []; if (Array.isArray(a)) extra = a; } catch {}
      if (txt) loadFiles([{ text: txt, name: '' }, ...extra]);
      else if (extra.length) loadFiles(extra);
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
  // [wa-1a1 2026-10-14] grupo = 2+ outros autores reais OU aviso de grupo no export ("criou o grupo", "adicionou"…).
  // Remetente raro de texto colado já foi desfeito no parser (não conta como 3º participante).
  const isGroupExport = others.length > 1 || (!!prep?.isGroup && (prep?.groupSignals || 0) > 0);
  const exportPeer = others.length === 1 ? others[0].name : '';
  const localMatch = useMemo(() => {
    if (!link || !prep) return null;
    if (isPhoneReason(link.reason) || link.reason === 'name') return true; // [import-ordem 2026-10-13] confirmado no servidor [wa-phone] + agenda
    if (link.reason === 'mismatch') return false;
    if (link.reason === 'first_name') return link.explicit ? true : null; // [wa-1a1 2026-10-14] só confirmar a pessoa (1 passo)
    if (exportPeer && nameLike(exportPeer, link.name)) return true;
    if (prep.fileTitle && nameLike(prep.fileTitle, link.name)) return true;
    return false;
  }, [link, prep, exportPeer]);
  const directPossible = !!link && !isGroupExport && !e2eeTarget;
  const effDest = directPossible ? dest : 'copy';
  // Telefone no export → quem confere é o servidor (cadastro da pessoa); nome → confere aqui também.
  const exportPeerIsPhone = String(exportPeer).replace(/\D/g, '').length >= 8 && !/[A-Za-zÀ-ÿ]/.test(exportPeer);
  // [wa-remetente 2026-10-13] número no export que NÃO é o da pessoa escolhida → aviso claro antes de importar.
  const phoneMismatch = effDest === 'direct' && !!link && exportPeerIsPhone && !isPhoneReason(link.reason);
  const needsConfirm = effDest === 'direct' && (!!serverMismatch || phoneMismatch || (localMatch === false && !exportPeerIsPhone));
  // Só importa na conversa com X quando o número confirmou OU o usuário escolheu/confirmou a pessoa explicitamente.
  const personConfirmed = !!link && (isPhoneReason(link.reason) || !!link.explicit); // [wa-phone] número da agenda = sem confirmação extra

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
    if (useDirect && !personConfirmed) return; // [wa-remetente 2026-10-13]
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
        confirmMismatch: useDirect && (mismatchOk || !!serverMismatch || (link?.reason === 'first_name' && !!link?.explicit) || link?.reason === 'contact_phone'),
        // [wa-phone 2026-10-14] servidor confere os hashes SÓ contra a pessoa escolhida → verified 'phone'
        peerPhoneHashes: useDirect && isPhoneReason(link?.reason) && link?.matched ? (phonesRef.current?.byName?.[link.matched]?.hashes || []) : [],
        originConvId: originConvId || targetConversationId || null,
        // [wa-import-fase2] notificação local ao concluir com o app em 2º plano
        notifyTitle: t('waImport.doneNotifTitle'), notifyBody: t('waImport.doneNotifBody', { n: '{n}' }),
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
  }, [prep, meName, effDest, needsConfirm, mismatchOk, personConfirmed, e2eeTarget, confirm, t, resolveTargetConv, errText, link, title, user, serverMismatch, originConvId, exportPeer]);

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

  // [import-ordem 2026-10-13] sugestões do servidor (com motivo) no topo; depois as conversas locais.
  const serverCands = useMemo(() => (matchInfo?.candidates || []).map((c) => ({
    email: c.email, name: c.name || c.email, convId: c.conversation_id ? String(c.conversation_id) : '', reason: c.reason, matched: c.matched, tail: c.phone_tail,
  })), [matchInfo]);
  // [wa-remetente 2026-10-13] Lista RANQUEADA (foto, nome, motivo) + busca por nome/@/telefone entre as MINHAS
  // conversas diretas e contatos (servidor: universo fechado). Nunca escolhe sozinho alguém sem relação.
  const [pickQuery, setPickQuery] = useState('');
  const [searchRes, setSearchRes] = useState([]);
  const searchSeqRef = useRef(0);
  useEffect(() => {
    const q = pickQuery.trim();
    const seq = ++searchSeqRef.current;
    if (!showLinkPicker || q.replace(/^@/, '').length < 2) { setSearchRes([]); return undefined; }
    const tm = setTimeout(async () => {
      try {
        const r = await waImportMatch({ q });
        if (seq === searchSeqRef.current && r?.success) setSearchRes(Array.isArray(r.data?.results) ? r.data.results : []);
      } catch {}
    }, 350);
    return () => clearTimeout(tm);
  }, [pickQuery, showLinkPicker]);
  const linkCandidates = useMemo(() => {
    if (!showLinkPicker) return [];
    const local = readLocalConversations()
      .filter((c) => (c.type || 'direct') === 'direct' && convPeerEmail(c))
      .slice(0, 200)
      .map((c) => ({ email: convPeerEmail(c), name: convName(c) || convPeerEmail(c), convId: String(c.id || '') }));
    return rankCandidates({ server: matchInfo?.candidates || [], search: pickQuery.trim() ? searchRes : [], recent: matchInfo?.recent || [], local, query: pickQuery }).slice(0, 60);
  }, [showLinkPicker, matchInfo, searchRes, pickQuery]);
  const candReason = (c) => (c.reason === 'phone' ? t('waImport.matchPhone', { tail: c.tail || '' })
    : c.reason === 'contact_phone' ? t('waImport.matchContactPhone')
    : c.reason === 'name' ? t('waImport.matchName', { name: c.matched || '' })
      : c.reason === 'first_name' ? t('waImport.matchFirstName', { name: String(c.matched || '').trim().split(/\s+/)[0] })
      : c.reason === 'recent' ? t('waImport.reasonRecent')
        : (c.handle ? '@' + c.handle : ''));
  const linkReasonText = !link ? '' : link.reason === 'phone'
    ? t('waImport.matchPhone', { tail: link.tail || '' })
    : link.reason === 'contact_phone'
    ? t('waImport.matchContactPhone')
    : link.reason === 'name'
      ? t('waImport.matchName', { name: link.matched || '' })
      : link.reason === 'first_name'
        ? t('waImport.matchFirstName', { name: String(link.matched || '').trim().split(/\s+/)[0] })
      : link.reason === 'mismatch'
        ? t('waImport.matchOriginMismatch', { export: exportPeer || prep?.fileTitle || '', name: link.name })
        : (localMatch ? t('waImport.verifiedOk', { name: link.name }) : '');
  const betterCand = link?.reason === 'mismatch' ? serverCands.find((c) => String(c.email).toLowerCase() !== String(link.email).toLowerCase()) : null;
  const meConfident = !!meName && !!prep && (prep.participants || []).length === 2 && !meManual
    && (matchInfo?.me === meName || prep.guessedMe === meName);

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
        <Text style={[s.h2, { color: ink }]}>{/* [2026-10-20] "Importar conversa do WhatsApp com {Nome}" */ !isGroupExport && (prep.fileTitle || exportPeer) ? t('waImport.reviewTitleWith', { name: prep.fileTitle || exportPeer }) : t('waImport.reviewTitle')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line }]}>
          <Text style={{ color: ink, fontSize: 15 }}>{t('waImport.statsMessages', { n: st.total })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>{t('waImport.statsRange', { from: fmtDate(st.first, language), to: fmtDate(st.last, language) })}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 4 }}>
            {t('waImport.statsMedia', { n: st.mediaPresent })}{st.mediaMissing + st.mediaOmitted > 0 ? ' · ' + t('waImport.statsMediaMissing', { n: st.mediaMissing + st.mediaOmitted }) : ''}
          </Text>
          {prep.format ? <Text style={{ color: sub, fontSize: 12, marginTop: 4 }}>{t('waImport.format', { fmt: prep.format })}</Text> : null}
        </View>
        {(st.mediaOmitted || 0) > 0 && (st.mediaPresent || 0) === 0 ? (
          // [wa-import-fase2] export "sem mídia": avisa e explica como exportar de novo com mídia.
          <Note text={t('waImport.mediaOmittedHint', { n: st.mediaOmitted })} icon={IconAlertTriangle} />
        ) : null}

        {meConfident && !showMePicker ? (
          // [import-ordem 2026-10-13] quem importa é o dono da conta: deduzido (meu número / "Você" / o outro
          // autor é a pessoa da conversa) → não pergunta; só mostra e deixa trocar.
          <View style={[s.card, s.linkRow, { backgroundColor: card, borderColor: line }]}>
            <IconUser size={18} color={ink} />
            <Text style={{ color: ink, fontSize: 15, flex: 1, marginLeft: 10 }} numberOfLines={1}>{t('waImport.youAre', { name: meName })}</Text>
            <TouchableOpacity onPress={() => setShowMePicker(true)} hitSlop={10} accessibilityRole="button">
              <Text style={{ color: ink, fontSize: 14, fontWeight: '600' }}>{t('waImport.change')}</Text>
            </TouchableOpacity>
          </View>
        ) : (<>
        <Text style={[s.section, { color: sub }]}>{t('waImport.whoAreYou')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4 }]}>
          {prep.participants.slice(0, 50).map((p) => {
            const on = meName === p.name;
            return (
              <TouchableOpacity key={p.name} onPress={() => { setMeName(p.name); setMeManual(true); meManualRef.current = true; setServerMismatch(null); setMismatchOk(false); }} style={s.partRow} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <View style={[s.radio, { borderColor: ink }, on && { backgroundColor: ink }]}>{on ? <IconCheck size={12} color={colors.background} /> : null}</View>
                <Text style={{ color: ink, fontSize: 15, flex: 1 }} numberOfLines={1}>{p.name}</Text>
                {p.name === (matchInfo?.me || prep.guessedMe) ? <Text style={[s.pill, { color: sub, borderColor: line }]}>{t('waImport.suggested')}</Text> : null}
                <Text style={{ color: sub, fontSize: 12 }}>{t('waImport.msgCount', { n: p.count })}</Text>
              </TouchableOpacity>
            );
          })}
          {prep.participants.length > 50 ? <Text style={[s.small, { color: sub, paddingHorizontal: 12 }]}>+{prep.participants.length - 50}</Text> : null}
        </View>
        {!meName ? <Text style={[s.small, { color: sub, marginBottom: 8 }]}>{t('waImport.pickMeHint')}</Text> : null}
        </>)}

        <Text style={[s.section, { color: sub }]}>{t('waImport.linkLabel')}</Text>
        <TouchableOpacity onPress={() => setShowLinkPicker((v) => !v)} style={[s.card, s.linkRow, { backgroundColor: card, borderColor: line }]} accessibilityRole="button">
          {link ? <IconUser size={18} color={ink} /> : <IconUsers size={18} color={ink} />}
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ color: ink, fontSize: 15 }} numberOfLines={1}>{link ? link.name : t('waImport.linkNone')}</Text>
            {linkReasonText ? <Text style={{ color: sub, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{linkReasonText}</Text> : null}
          </View>
          {link ? (
            <TouchableOpacity onPress={() => { setLink(null); setServerMismatch(null); }} hitSlop={10} accessibilityLabel={t('common.remove')}><IconX size={16} color={sub} /></TouchableOpacity>
          ) : <IconChevronRight size={18} color={sub} />}
        </TouchableOpacity>
        {betterCand ? (
          <TouchableOpacity onPress={() => { setLink({ ...betterCand, explicit: true }); setServerMismatch(null); setMismatchOk(false); }} style={[s.card, s.linkRow, { backgroundColor: card, borderColor: ink }]} accessibilityRole="button">
            <IconUser size={18} color={ink} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ color: ink, fontSize: 15 }} numberOfLines={1}>{t('waImport.useSuggested', { name: betterCand.name })}</Text>
              <Text style={{ color: sub, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                {betterCand.reason === 'phone' ? t('waImport.matchPhone', { tail: betterCand.tail || '' }) : betterCand.reason === 'contact_phone' ? t('waImport.matchContactPhone') : t('waImport.matchName', { name: betterCand.matched || '' })}
              </Text>
            </View>
            <IconChevronRight size={18} color={sub} />
          </TouchableOpacity>
        ) : null}
        {effDest === 'direct' && link && !personConfirmed ? (
          // [wa-remetente 2026-10-13] sugestão por nome: a pessoa precisa ser confirmada (ou escolhida na lista).
          <View style={[s.card, { borderColor: ink, backgroundColor: card }]}>
            <Text style={{ color: ink, fontSize: 14, lineHeight: 19, marginBottom: 6 }}>{t('waImport.pickPersonHint')}</Text>
            <Radio on={false} onPress={() => setLink((l) => (l ? { ...l, explicit: true } : l))} title={t('waImport.confirmPerson', { name: link.name })} />
          </View>
        ) : null}
        {agendaState === 'denied' && !isPhoneReason(link?.reason) && !exportPeerIsPhone ? <Text style={[s.small, { color: sub, marginBottom: 6 }]}>{t('waImport.agendaDeniedHint')}</Text> : null}
        {showLinkPicker && linkAmbiguous && !link ? <Text style={[s.small, { color: sub, marginBottom: 6 }]}>{t('waImport.pickAmbiguous')}</Text> : null}
        {showLinkPicker && (
          <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4, maxHeight: 380 }]}>
            <TextInput
              value={pickQuery} onChangeText={setPickQuery} autoCorrect={false} autoCapitalize="none"
              placeholder={t('waImport.searchPeople')} placeholderTextColor={sub}
              style={[s.input, { color: ink, borderColor: line, marginHorizontal: 8, marginTop: 6, marginBottom: 4 }]}
              accessibilityLabel={t('waImport.searchPeople')}
            />
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {linkCandidates.length === 0 ? <Text style={[s.small, { color: sub, padding: 12 }]}>{t('waImport.linkEmpty')}</Text> : null}
              {linkCandidates.map((c) => {
                const why = candReason(c);
                const sugg = isPhoneReason(c.reason) || c.reason === 'name' || c.reason === 'first_name' || (exportPeer && nameScore(exportPeer, c.name) >= NAME_MIN_SCORE);
                return (
                  <TouchableOpacity key={c.email} onPress={() => { setLink({ ...c, explicit: true }); setShowLinkPicker(false); setPickQuery(''); setServerMismatch(null); setMismatchOk(false); }} style={s.partRow} accessibilityRole="button">
                    <AvatarCircle email={c.email} name={c.name} size={36} colors={colors} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={{ color: ink, fontSize: 15 }} numberOfLines={1}>{c.name}</Text>
                      {why ? <Text style={{ color: sub, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{why}</Text> : null}
                    </View>
                    {sugg ? <Text style={[s.pill, { color: sub, borderColor: line }]}>{t('waImport.suggested')}</Text> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        <Text style={[s.section, { color: sub }]}>{t('waImport.destLabel')}</Text>
        <View style={[s.card, { backgroundColor: card, borderColor: line, paddingVertical: 4 }]}>
          <Radio on={effDest === 'direct'} disabled={!directPossible} onPress={() => setDest('direct')}
            title={t('waImport.destDirect', { name: link?.name || '…' })}
            subtitle={isGroupExport ? t('waImport.groupToCopy') : e2eeTarget ? t('waImport.errE2ee') : t('waImport.destDirectSubDate', { name: link?.name || '' })} />
          <Radio on={effDest === 'copy'} onPress={() => setDest('copy')} title={t('waImport.destCopy')} subtitle={t('waImport.destCopySub')} />
        </View>

        {effDest === 'direct' && needsConfirm ? (
          <View style={[s.card, { borderColor: ink, backgroundColor: card }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <IconAlertTriangle size={18} color={ink} />
              <Text style={{ color: ink, fontSize: 14, flex: 1, lineHeight: 19 }}>{phoneMismatch && !serverMismatch
                ? t('waImport.verifyPhoneMismatch', { tail: String(exportPeer).replace(/\D/g, '').slice(-4), name: link?.name || '' })
                : t('waImport.verifyMismatch', { export: mismatchExport, name: link?.name || '' })}</Text>
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

        <Btn label={t('waImport.startImport')} onPress={() => start(false)} disabled={!meName || (effDest === 'direct' && ((needsConfirm && !mismatchOk) || !personConfirmed))} icon={IconDownload} />
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
