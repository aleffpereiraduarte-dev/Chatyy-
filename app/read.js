import { useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Animated, Easing, Alert, useWindowDimensions } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getMessage, deleteEmail as apiDelete, starEmail, unstarEmail, addLabel, removeLabel, getThread, archiveEmail, aiFollowupReminder } from '../services/api';
import { getMessageFromCache, getMessageFromCacheSync, saveMessageToCache } from '../services/offlineCache';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Shadow, Spacing, FontSize, BorderRadius, AnimTiming, haptic } from '../constants/theme';
import EmailReader from '../components/EmailReader';
import ThreadView from '../components/ThreadView';
import { IconChevronLeft, IconChevronRight, IconReply, IconReplyAll, IconArchive, IconTrash, IconForward, IconClock, IconWifiOff, IconRefresh } from '../components/Icons';
import SnoozePickerModal from '../components/SnoozePickerModal';
import { MessageSkeleton } from '../components/SkeletonLoader';
import { isNativeEmailBodyOn } from '../components/email/NativeEmailBody';

export default function ReadScreen() {
  const { uid, folder = 'INBOX', prevUid, nextUid } = useLocalSearchParams();
  // [2026-10-08 offline-first] Frame-1 paint from the local body cache (no
  // skeleton flash on a cache hit; works in airplane mode). The network fetch
  // below still runs and replaces it with the fresh copy.
  const [email, setEmail] = useState(() => {
    try { const c = uid ? getMessageFromCacheSync(uid, folder) : null; return c ? { ...c, seen: true, read: true } : null; } catch { return null; }
  });
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(() => !email);
  // [offline] Bumped by the "Tentar novamente" button on the offline/failed
  // state so the load effect (deps include retryEpoch) re-runs the fetch
  // without a full screen remount.
  const [retryEpoch, setRetryEpoch] = useState(0);
  // ── AI follow-up reminder ──
  // For sent emails older than 2 days with no reply, surface a yellow chip
  // suggesting a follow-up. Calls aiFollowupReminder with a single-item
  // payload and shows the suggested message preview + a "Send follow-up"
  // button that hops to /compose with the suggestion pre-filled.
  const [followupSuggestion, setFollowupSuggestion] = useState(null); // {days, suggested_message, urgency}
  const { emails, refresh, markAsRead, markAsUnread, deleteEmail: ctxDelete, archiveEmail: ctxArchive, snoozeEmail: ctxSnooze, starEmail: ctxStar, currentFolder, addLabelToEmail: ctxAddLabel, removeLabelFromEmail: ctxRemoveLabel } = useMail();
  const [showSnooze, setShowSnooze] = useState(false);
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // [2026-10-11 email-qa] Web no celular (/read só abre com tela < 768) ficava
  // SEM barra de voltar/anterior/próximo e SEM Arquivar/Adiar (só a grade do
  // leitor, que não tem Arquivar). Mesma barra do app nativo.
  const { width: _winW } = useWindowDimensions();
  const showChrome = Platform.OS !== 'web' || _winW < 768;

  // Reading progress indicator
  const scrollProgress = useRef(new Animated.Value(0)).current;

  // [2026-10-15 native-email] Deslizar na horizontal troca de e-mail (Gmail /
  // Apple Mail): ← próximo (mais antigo), → anterior. RNGH (thread nativa de
  // gestos); desliga com o corpo ampliado na pinça e no web.
  // Kill switch: globalThis.__chatyy_email_swipe = false.
  const [bodyZoomed, setBodyZoomed] = useState(false);
  const swipeX = useRef(new Animated.Value(0)).current;
  const swipeNavRef = useRef(null);

  // Entrance animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(15)).current;

  useEffect(() => {
    if (!loading && email) {
      const nd = Platform.OS !== 'web';
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: AnimTiming.slow,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: AnimTiming.entrance,
          easing: Easing.out(Easing.exp),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [loading, email]);

  const navigateToEmail = (targetUid) => {
    if (!targetUid) return;
    // uid do param chega como string; uid da lista pode ser number
    const idx = emails.findIndex(e => String(e.uid) === String(targetUid));
    const p = idx > 0 ? emails[idx - 1].uid : '';
    const n = (idx >= 0 && idx < emails.length - 1) ? emails[idx + 1].uid : '';
    router.replace(`/read?uid=${targetUid}&folder=${encodeURIComponent(folder)}&prevUid=${p}&nextUid=${n}`);
  };
  swipeNavRef.current = navigateToEmail;

  const swipeGH = useMemo(() => {
    if (Platform.OS === 'web') return null;
    // Junto com o leitor nativo (binário antigo = comportamento antigo).
    if (!isNativeEmailBodyOn()) return null;
    try { if (globalThis.__chatyy_email_swipe === false) return null; } catch {}
    try {
      const GH = require('react-native-gesture-handler');
      if (!GH?.Gesture?.Pan || !GH?.GestureDetector) return null;
      const canPrev = !!prevUid;
      const canNext = !!nextUid;
      const gesture = GH.Gesture.Pan()
        .enabled(!bodyZoomed && (canPrev || canNext))
        .activeOffsetX([-24, 24])
        .failOffsetY([-12, 12])
        .runOnJS(true)
        .onUpdate((e) => {
          const tx = e.translationX;
          // resistência quando não há e-mail daquele lado
          const allowed = (tx < 0 && canNext) || (tx > 0 && canPrev);
          swipeX.setValue(tx * (allowed ? 0.45 : 0.12));
        })
        .onEnd((e) => {
          const tx = e.translationX;
          const vx = e.velocityX;
          const goNext = canNext && (tx < -90 || (tx < -30 && vx < -650));
          const goPrev = canPrev && (tx > 90 || (tx > 30 && vx > 650));
          if (goNext || goPrev) {
            haptic.light();
            Animated.timing(swipeX, { toValue: goNext ? -60 : 60, duration: 90, useNativeDriver: true }).start(() => {
              swipeX.setValue(0);
              try { swipeNavRef.current?.(goNext ? nextUid : prevUid); } catch {}
            });
          } else {
            Animated.spring(swipeX, { toValue: 0, tension: 220, friction: 20, useNativeDriver: true }).start();
          }
        })
        .onFinalize(() => {});
      return { GH, gesture };
    } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyZoomed, prevUid, nextUid]);
  const withSwipe = (node) => (swipeGH ? <swipeGH.GH.GestureDetector gesture={swipeGH.gesture}>{node}</swipeGH.GH.GestureDetector> : node);

  // Keyboard shortcuts (web only)
  useEffect(() => {
    if (Platform.OS !== 'web' || !email) return;
    const handleKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA' || e.target?.isContentEditable) return;
      switch (e.key) {
        case 'r': handleReply(email); break;
        case 'a': handleReplyAll(email); break;
        case 'f': handleForward(); break;
        case 'e': handleArchive(); break;
        case '#': handleDelete(); break;
        case 'Escape': router.back(); break;
        case 'ArrowLeft':
        case 'j':
          if (prevUid) navigateToEmail(prevUid);
          break;
        case 'ArrowRight':
        case 'k':
          if (nextUid) navigateToEmail(nextUid);
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [email]);

  useEffect(() => {
    if (!uid) { router.back(); return; }
    let cancelled = false;
    let networkResolved = false;
    // [2026-10-11] Founder: "quando eu abro o e-mail tem que atualizar que já
    // abriu". Antes só marcava lido DEPOIS do corpo chegar da rede — abrindo
    // pelo cache e voltando antes (ou com a rede falhando) ficava "não lido"
    // pra sempre. Agora marca na hora da abertura (otimista + POST), 1× por uid.
    let markedOnOpen = false;
    try { markAsRead(uid, folder); markedOnOpen = true; } catch {}

    // [2026-09-24 abrir-rápido mobile] CACHE-FIRST: se o corpo já está no cache
    // local (prefetch da lista OU abertura anterior nesta sessão), renderiza NA
    // HORA e só depois atualiza em segundo plano com a versão da rede. Antes o
    // mobile SEMPRE mostrava o skeleton até a rede responder, mesmo com o email
    // já em mãos. `setEmail(prev => prev || cached)` garante que a rede, se
    // chegar primeiro, ganha (nunca sobrescreve fresco por cache velho).
    getMessageFromCache(uid, folder).then(cached => {
      if (cancelled || networkResolved || !cached) return;
      setEmail(prev => prev || { ...cached, seen: true, read: true });
      setLoading(false);
    }).catch(() => {});

    // Load the single message first, then try to get thread
    // [WAVE 122] 25s hard timeout so a hung IMAP fetch / dead-network
    // doesn't strand the user on the skeleton forever (user report:
    // "isso e o email quando eu vou ver o email" — skeleton infinito).
    // The finally still runs because the timeout resolves with null.
    const _timeoutMs = 25000;
    // [2026-10-11 email-qa] Limpa o timer quando a promessa resolve — antes o
    // aviso "[read.js] timeout fetching message" saía 25 s depois de TODA
    // abertura (mesmo com o e-mail carregado em 150 ms), sujando o console.
    const _withTimeout = (p, label) => {
      let tid = null;
      return Promise.race([
        p,
        new Promise((resolve) => {
          tid = setTimeout(() => {
            try { console.warn('[read.js] timeout fetching', label); } catch {}
            resolve(null);
          }, _timeoutMs);
        }),
      ]).finally(() => { if (tid) clearTimeout(tid); });
    };
    // [2026-05-26] A single transient IMAP 401 / edge timeout used to strand
    // the user on an empty reader. Retry the message fetch ONCE on a
    // null/timeout/unsuccessful first result before trusting "no email". The
    // api.js Rust-dead state is now cooldown-based, so the retry can land on a
    // healthy path (PHP fallback or recovered Rust) instead of refailing.
    const _fetchMessageWithRetry = async () => {
      let r = await _withTimeout(getMessage(uid, folder), 'message');
      if (!cancelled && !(r && r.success)) {
        r = await _withTimeout(getMessage(uid, folder).catch(() => null), 'message-retry');
      }
      return r;
    };
    // [2026-09-24 "abrir email demora MUITO"] DESACOPLA o getThread do render do
    // conteúdo. get_thread bate no PHP via Cloudflare e leva 0.8-5s; o Promise.all
    // antigo segurava o CORPO do email refém dele (era ESSE o "demora muito muito").
    // Agora: o email aparece assim que o corpo (Rust, ~0.5s) chega e o skeleton
    // some NA HORA; a thread carrega em paralelo e preenche depois, sem travar.
    const msgPromise = _fetchMessageWithRetry().then((msgResult) => {
      if (cancelled) return null;
      networkResolved = true;
      if (msgResult?.success && msgResult.data) {
        // Persiste no cache → próxima abertura (ou volta) é instantânea.
        saveMessageToCache(uid, msgResult.data, folder).catch(() => {});
        // Optimistic seen=true pro header não piscar "não lido".
        setEmail({ ...msgResult.data, seen: true, read: true });
        const wasUnread = msgResult.data.seen === false;
        if (!markedOnOpen) markAsRead(uid, folder);
        if (wasUnread) {
          import('../services/pushNotifications').then(m => m.refreshBadgeCount?.()).catch(() => {});
        }
      } else {
        // Rede falhou: NÃO apaga o que o cache-first já mostrou.
        setEmail(prev => prev || null);
      }
      // Email pronto → para o skeleton AGORA, sem esperar a thread.
      if (!cancelled) setLoading(false);
      return msgResult;
    }).catch(() => { if (!cancelled) setLoading(false); return null; });

    // Thread carrega INDEPENDENTE (nunca trava o email) e SÓ pra emails que fazem
    // parte de uma conversa (têm References/In-Reply-To). Email avulso — a maioria —
    // pula a chamada get_thread (PHP lento via CF) de vez: menos latência de fundo
    // e menos carga no PHP. Email avulso já daria thread de tamanho 1 (setThread null).
    msgPromise.then(async (msgResult) => {
      if (cancelled) return;
      const hdrs = (msgResult?.data?.headers) || {};
      const hget = (k) => hdrs[k] || hdrs[k.toLowerCase()] || hdrs[k.toUpperCase()];
      const isThreaded = !!(hget('References') || hget('In-Reply-To'));
      if (!isThreaded) { if (!cancelled) setThread(null); return; }
      const threadResult = await _withTimeout(getThread(uid, folder).catch(() => null), 'thread');
      if (cancelled) return;
      if (!(threadResult?.success && threadResult.data?.length > 1)) { setThread(null); return; }
      const opened = msgResult?.data;
      const rootSubject = opened?.subject;
      const rootFrom = opened?.from;
      const normalized = threadResult.data.map((m, i) => {
        let mm = i === 0
          ? { ...m, subject: m?.subject || rootSubject || '', from: m?.from || rootFrom || '' }
          : m;
        // get_thread só traz cabeçalhos; mescla o corpo da msg aberta em thread[0].
        if (opened && Number(mm.uid) === Number(uid) && !(mm.body_html || mm.body_text || mm.body)) {
          mm = { ...mm, body_html: opened.body_html, body_text: opened.body_text, body: opened.body, attachments: opened.attachments };
        }
        return mm;
      });
      if (!cancelled) setThread(normalized);
    });

    return () => { cancelled = true; };
  }, [uid, folder, retryEpoch]);

  // Surface AI follow-up reminder chip for sent items aged >= 2 days where
  // no reply has been received. The reminder endpoint scores urgency and
  // suggests a short follow-up message; we render a chip when the score
  // matches and the user can one-tap into compose.
  useEffect(() => {
    if (!email || folder !== 'Sent') { setFollowupSuggestion(null); return; }
    const sentAt = email.date ? new Date(email.date) : null;
    if (!sentAt || isNaN(sentAt.getTime())) { setFollowupSuggestion(null); return; }
    const daysAgo = Math.floor((Date.now() - sentAt.getTime()) / (24 * 60 * 60 * 1000));
    if (daysAgo < 2) { setFollowupSuggestion(null); return; }
    let cancelled = false;
    aiFollowupReminder([{
      to: email.to,
      subject: email.subject,
      sent_at: email.date,
      days_ago: daysAgo,
    }]).then(r => {
      if (cancelled) return;
      const fu = r?.data?.followups?.[0];
      if (fu && fu.urgency && fu.urgency !== 'low') {
        setFollowupSuggestion({ days: daysAgo, suggested_message: fu.suggested_message || '', urgency: fu.urgency });
      } else {
        setFollowupSuggestion(null);
      }
    }).catch(() => { if (!cancelled) setFollowupSuggestion(null); });
    return () => { cancelled = true; };
  }, [email?.uid, folder]);

  // In a multi-message thread the tapped message (emailData) is NOT always the
  // opened message. Compose re-fetches getMessage(reply_uid, folder) and
  // overrides to/cc/subject from THAT message — so if we hardcode the opened
  // `uid`, tapping Reply on an older thread message replied to the wrong
  // person quoting the wrong body. Target the tapped message's uid — but ONLY
  // when it carries BOTH uid and folder (IMAP uids are per-mailbox, so using a
  // tapped uid with the opened folder could fetch an unrelated message). When
  // either is missing, fall back to the opened message unchanged.
  const _replyTarget = (emailData) => {
    const m = emailData || email;
    if (m && m.uid != null && m.folder != null) return { uid: m.uid, folder: m.folder, msg: m };
    return { uid, folder, msg: m };
  };

  const handleReply = (emailData) => {
    const { uid: rUid, folder: rFolder, msg: replyEmail } = _replyTarget(emailData);
    let url = `/compose?reply_uid=${rUid}&folder=${encodeURIComponent(rFolder)}&to=${encodeURIComponent(replyEmail?.from || '')}&subject=${encodeURIComponent('Re: ' + (replyEmail?.subject || ''))}`;
    if (replyEmail?.smartReply) {
      url += `&smart_reply=${encodeURIComponent(replyEmail.smartReply)}`;
    }
    // [2026-06-05] router.REPLACE, não push: `read` e `compose` são ambos
    // presentation:'modal'. Com push, abrir Responder empilhava o modal de
    // compose POR CIMA do modal de leitura ("um módulo em cima do outro").
    // replace troca o de leitura pelo de compose — voltar cai na inbox.
    router.replace(url);
  };

  const handleReplyAll = (emailData) => {
    const { uid: rUid, folder: rFolder, msg: replyEmail } = _replyTarget(emailData);
    const allRecipients = [replyEmail?.to, replyEmail?.cc].filter(Boolean).join(',');
    let url = `/compose?reply_uid=${rUid}&reply_all=1&folder=${encodeURIComponent(rFolder)}&to=${encodeURIComponent(replyEmail?.from || '')}&cc=${encodeURIComponent(allRecipients)}&subject=${encodeURIComponent('Re: ' + (replyEmail?.subject || ''))}`;
    router.replace(url);
  };

  const handleForward = (emailData) => {
    const { uid: rUid, folder: rFolder, msg: fwdEmail } = _replyTarget(emailData);
    router.replace(`/compose?forward_uid=${rUid}&folder=${encodeURIComponent(rFolder)}&subject=${encodeURIComponent('Fwd: ' + (fwdEmail?.subject || ''))}`);
  };

  // Forward as attachment (round-6 gap-closer): drops the original .eml
  // into compose as a real attachment via the attach_eml_uid hint.
  const handleForwardAsAttachment = () => {
    router.replace(
      `/compose?attach_eml_uid=${uid}` +
      `&attach_eml_folder=${encodeURIComponent(folder)}` +
      `&subject=${encodeURIComponent('Fwd: ' + (email?.subject || ''))}`,
    );
  };

  // Email → Task (round-6 gap-closer).
  const handleAddAsTask = async () => {
    try {
      const { taskCreateFromEmail } = await import('../services/api');
      const r = await taskCreateFromEmail(uid, folder, { subject: email?.subject || '', from: email?.from_email || email?.from || '' });
      if (r?.success) {
        Alert.alert(
          t('tasks.added') || 'Tarefa criada',
          t('tasks.addedTo') || 'Veja em Configurações → Tarefas.',
          [
            { text: t('common.ok') || 'OK', style: 'default' },
            { text: t('tasks.openList') || 'Ver tarefas', onPress: () => router.push('/tasks') },
          ],
        );
      }
    } catch {}
  };

  const handleDelete = () => {
    // Gmail-grade: delete instantly with an Undo toast (no confirm dialog). The
    // context deleteEmail removes the row optimistically, shows a 5s Undo, and
    // DEFERS the real API call — all scoped to the email's REAL folder (passed
    // explicitly so a message opened from a non-current folder / cross-folder
    // search still deletes from the right mailbox). Back out immediately so it
    // feels instant; the undo lives on the list.
    ctxDelete(uid, folder);
    router.back();
  };

  const handleArchive = () => {
    ctxArchive(uid, folder); // optimistic + Undo + correct folder (same as delete)
    router.back();
  };

  const handleSnooze = () => setShowSnooze(true);
  const onSnoozePick = (iso) => {
    ctxSnooze(uid, iso, folder);
    setShowSnooze(false);
    router.back();
  };

  // [2026-10-11 email-qa] Estrela otimista E sincronizada com a lista: antes
  // esperava a API pra pintar e a linha da caixa de entrada continuava sem
  // estrela ao voltar (até o próximo refresh). Linha na lista → starEmail do
  // contexto (mesma proteção anti-revert da lista); senão, API direta.
  const handleStar = async (e) => {
    const was = !!(e?.flagged ?? email?.flagged);
    setEmail(prev => prev ? { ...prev, flagged: !was } : prev);
    const inList = String(folder) === String(currentFolder) &&
      emails.some(r => String(r.uid) === String(uid) && !!r.flagged === was);
    try {
      if (inList) {
        await ctxStar(emails.find(r => String(r.uid) === String(uid)).uid);
        return;
      }
      const r = was ? await unstarEmail(uid, folder) : await starEmail(uid, folder);
      if (!r?.success) setEmail(prev => prev ? { ...prev, flagged: was } : prev);
    } catch {
      setEmail(prev => prev ? { ...prev, flagged: was } : prev);
    }
  };

  // [2026-10-11 email-qa] Marcador: pinta NA HORA no leitor e na linha da
  // lista (antes esperava a API e a lista só mostrava o chip após refresh).
  const _rowInList = (u) => String(folder) === String(currentFolder) && emails.find(r => String(r.uid) === String(u));
  const handleAddLabel = async (emailUid, label) => {
    const u = emailUid || uid;
    setEmail(prev => prev ? { ...prev, labels: [...(prev.labels || []).filter(l => l !== label), label] } : prev);
    const row = _rowInList(u);
    try { if (row) await ctxAddLabel(row.uid, label); else await addLabel(u, label, folder); } catch {}
  };

  const handleRemoveLabel = async (emailUid, label) => {
    const u = emailUid || uid;
    setEmail(prev => prev ? { ...prev, labels: (prev.labels || []).filter(l => l !== label) } : prev);
    const row = _rowInList(u);
    try { if (row) await ctxRemoveLabel(row.uid, label); else await removeLabel(u, label, folder); } catch {}
  };

  const handleReportSpam = async (e) => {
    const { reportSpam } = await import('../services/api');
    await reportSpam(uid, folder);
    refresh();
    router.back();
  };

  const handleReportHam = async (e) => {
    const { reportHam } = await import('../services/api');
    await reportHam(uid, folder);
    refresh();
    router.back();
  };

  if (loading) {
    return (
      <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        {showChrome && (
          <View style={[s.navBar, { backgroundColor: colors.headerBgSolid, borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}>
              <IconChevronLeft size={22} color={colors.text} />
              <Text style={[s.backText, { color: colors.text }]}>{t('reader.back')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <MessageSkeleton />
      </View>
    );
  }

  // [offline] Fetch finished but we have no email AND nothing was cached:
  // the network failed and this email was never opened online, so its body
  // isn't on the device. Instead of a blank reader (the old behavior), show a
  // clear state — offline vs generic failure — with a retry. Non-destructive:
  // nothing is written to cache, and reopening online fetches the real body.
  if (!email) {
    let _online = true;
    try { _online = require('../services/networkInfo').isConnected(); } catch {}
    return (
      <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        {showChrome && (
          <View style={[s.navBar, { backgroundColor: colors.headerBgSolid, borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }} accessibilityLabel={t('reader.back')} accessibilityRole="button">
              <IconChevronLeft size={22} color={colors.text} />
              <Text style={[s.backText, { color: colors.text }]}>{t('reader.back')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceVariant }}>
            <IconWifiOff size={30} color={colors.textSecondary} />
          </View>
          <Text style={{ marginTop: 16, fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'center', letterSpacing: -0.3 }}>
            {_online ? t('reader.openFailedTitle') : t('reader.offlineTitle')}
          </Text>
          <Text style={{ marginTop: 8, fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
            {_online ? t('reader.openFailedBody') : t('reader.offlineBody')}
          </Text>
          <TouchableOpacity
            onPress={() => { setLoading(true); setRetryEpoch(e => e + 1); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, minHeight: 44, paddingHorizontal: 20, borderRadius: 12, backgroundColor: colors.primary }}
            accessibilityLabel={t('offline.retry')}
            accessibilityRole="button"
          >
            <IconRefresh size={16} color={colors.onPrimary || '#fff'} />
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.onPrimary || '#fff' }}>{t('offline.retry')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Back nav bar (mobile) — 2026 LIGHT: clean WHITE bar with a light hairline,
  // dark icons/label. Same white chrome as /chat, /inbox and compose so the
  // whole app reads as one calm light system (black lives only in accents).
  const navBar = showChrome ? (
    <View style={[s.navBar, {
      backgroundColor: colors.headerBgSolid,
      borderBottomColor: colors.border,
    }]}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }} accessibilityLabel={t('reader.back')} accessibilityRole="button">
        <IconChevronLeft size={22} color={colors.text} />
        <Text style={[s.backText, { color: colors.text }]}>{t('reader.back')}</Text>
      </TouchableOpacity>
      <View style={{ flex: 1 }} />
      <View style={s.navArrows}>
        <TouchableOpacity
          onPress={() => navigateToEmail(prevUid)}
          style={[s.navArrowBtn, !prevUid && { opacity: 0.3 }]}
          disabled={!prevUid}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
          accessibilityLabel={t('reader.prevEmail')}
          accessibilityRole="button"
        >
          <IconChevronLeft size={20} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => navigateToEmail(nextUid)}
          style={[s.navArrowBtn, !nextUid && { opacity: 0.3 }]}
          disabled={!nextUid}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
          accessibilityLabel={t('reader.nextEmail')}
          accessibilityRole="button"
        >
          <IconChevronRight size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  // Floating action bar (mobile only) with press animations.
  // Wave 3 consolidação 2026-05-08: Reply ganhou destaque pill (monochrome
  // primary action, Telegram-style hierarquia), outras ações ficam icons
  // neutros — antes os 4 tinham mesmo peso visual e poluía.
  // [2026-10-11 email-qa] 5-6 botões com rótulo não cabem em 390 px ("Arquivar"
  // cortado, Excluir fora da tela). Em tela estreita os secundários ficam só
  // com ícone (rótulo continua no accessibilityLabel), como o Gmail.
  const _barIconOnly = _winW < 440;
  const actionBar = showChrome && email ? (
    <View style={[s.actionBar, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 8, borderTopColor: colors.border }]}>
      <ActionBarButton icon={IconReply} label={t('reader.reply')} color={colors.primary} onPress={() => handleReply(email)} accessibilityLabel={t('reader.reply')} primary />
      {((email.cc && String(email.cc).trim()) || (email.to && String(email.to).split(',').filter(s => s.trim()).length > 1)) ? (
        <ActionBarButton icon={IconReplyAll} label={t('reader.replyAll')} color={colors.textSecondary} onPress={() => handleReplyAll(email)} accessibilityLabel={t('reader.replyAll')} iconOnly={_barIconOnly} />
      ) : null}
      {/* Wrap: a bare handler ref receives the press EVENT as `emailData`,
          which _replyTarget mistakes for a message (truthy, no uid) — the
          compose then opens with subject "Fwd: " and no context. */}
      <ActionBarButton icon={IconForward} label={t('reader.forward')} color={colors.textSecondary} onPress={() => handleForward(email)} accessibilityLabel={t('reader.forward')} iconOnly={_barIconOnly} />
      <ActionBarButton icon={IconClock} label={t('reader.snooze')} color={colors.textSecondary} onPress={handleSnooze} accessibilityLabel={t('reader.snooze')} iconOnly={_barIconOnly} />
      <ActionBarButton icon={IconArchive} label={t('reader.archive')} color={colors.textSecondary} onPress={handleArchive} accessibilityLabel={t('reader.archive')} iconOnly={_barIconOnly} />
      <ActionBarButton icon={IconTrash} label={t('reader.delete')} color={colors.error} onPress={handleDelete} accessibilityLabel={t('reader.delete')} iconOnly={_barIconOnly} />
    </View>
  ) : null;

  // Reading progress bar component
  const progressBar = (
    <Animated.View
      style={[
        s.progressBar,
        {
          backgroundColor: colors.primary,
          transform: [{
            scaleX: scrollProgress,
          }],
          opacity: scrollProgress.interpolate({
            inputRange: [0, 0.02, 0.98, 1],
            outputRange: [0, 1, 1, 0],
          }),
        },
      ]}
    />
  );

  // Follow-up chip rendered above the EmailReader scroll view. Yellow
  // background mirrors Gmail's "Send follow-up?" prompt; tapping the action
  // opens /compose pre-filled with the AI's suggested message. Declared
  // BEFORE the thread-view branch so both render paths can reference it.
  const followupChip = followupSuggestion ? (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.surfaceVariant, borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, borderLeftColor: colors.text, borderRadius: 10,
      marginHorizontal: 12, marginTop: 8, padding: 12,
    }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: '700', color: colors.text, fontSize: 13 }}>
          {(t('read.followupTitle') || 'Aguardando resposta há {n} dias — Enviar follow-up?').replace('{n}', String(followupSuggestion.days))}
        </Text>
        {!!followupSuggestion.suggested_message && (
          <Text numberOfLines={2} style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
            {followupSuggestion.suggested_message}
          </Text>
        )}
      </View>
      <TouchableOpacity
        onPress={() => {
          const subj = email?.subject?.startsWith('Re:') ? email.subject : 'Re: ' + (email?.subject || '');
          const params = new URLSearchParams({
            to: email?.to || '',
            subject: subj,
            smart_reply: followupSuggestion.suggested_message || '',
          });
          router.replace('/compose?' + params.toString());
        }}
        style={{ backgroundColor: colors.primary, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: 8 }}
        accessibilityLabel={t('read.followupSend') || 'Enviar follow-up'}
        accessibilityRole="button"
      >
        <Text style={{ color: colors.onPrimary, fontSize: 12, fontWeight: '700' }}>
          {t('read.followupSend') || 'Enviar'}
        </Text>
      </TouchableOpacity>
    </View>
  ) : null;

  // Show thread view if we have multiple messages in the conversation
  if (thread && thread.length > 1) {
    return (
      <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        {navBar}
        {progressBar}
        {followupChip}
        {withSwipe(<Animated.View style={{ flex: 1, transform: [{ translateX: swipeX }] }} collapsable={false}>
        <ThreadView
          thread={thread}
          email={email}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onClose={showChrome ? undefined : () => router.back()}
          // [2026-10-11 email-qa] Com a barra de baixo, o rodapé da thread
          // repetia Responder/Resp. todos/Encaminhar.
          hasActionBar={!!showChrome}
          focusUid={uid}
        />
        </Animated.View>)}
        {actionBar}
        <SnoozePickerModal visible={showSnooze} onClose={() => setShowSnooze(false)} onSnooze={onSnoozePick} />
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
      {navBar}
      {progressBar}
      {followupChip}
      {withSwipe(<Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }, { translateX: swipeX }] }} collapsable={false}>
        <EmailReader
          email={email}
          folder={folder}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onForwardAsAttachment={handleForwardAsAttachment}
          onAddAsTask={handleAddAsTask}
          onDelete={handleDelete}
          hasActionBar={!!showChrome}
          onStar={handleStar}
          onAddLabel={handleAddLabel}
          onRemoveLabel={handleRemoveLabel}
          onReportSpam={handleReportSpam}
          onReportHam={handleReportHam}
          onMarkUnread={async (e) => {
            // Context markAsUnread clears the recentlyRead protection —
            // a raw api.markUnread call was reverted to "read" on the
            // next silent merge. [deep-20260805-032549]
            await markAsUnread(uid, folder);
            refresh();
            router.back();
          }}
          // [2026-10-11 email-qa] Com a barra "Voltar" visível o X do leitor era
          // um segundo botão de fechar duplicado no topo.
          onClose={showChrome ? undefined : () => router.back()}
          onScrollProgress={(progress) => {
            scrollProgress.setValue(progress);
          }}
          onBodyZoomChange={setBodyZoomed}
        />
      </Animated.View>)}
      {actionBar}
      <SnoozePickerModal visible={showSnooze} onClose={() => setShowSnooze(false)} onSnooze={onSnoozePick} />
    </View>
  );
}

// [2026-10-15 native-email] Haptic do rodapé só no binário com o leitor nativo.
let _nativeFeel = null;
function _nativeEmailFeel() {
  if (_nativeFeel == null) { try { _nativeFeel = isNativeEmailBodyOn(); } catch { _nativeFeel = false; } }
  return _nativeFeel;
}

// Action bar button with press scale animation.
// `primary` mode renders a filled pill (Telegram-style primary CTA) — only
// the Reply uses it so the bottom bar hierarquy reads "tap aqui pra responder
// + 3 atalhos secundários" at a glance instead of "4 botões iguais".
// Polish 2026-05-13: rounded 12px container + press scale 0.97 spring + SVG-only
// (Icon component already SVG via Icons.js). Non-primary buttons get a subtle
// surface tint on press so the rounded 12 shape reads instead of floating icons.
function ActionBarButton({ icon: Icon, label, color, onPress, accessibilityLabel, primary, iconOnly }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  // Filled pill ink must follow the theme: dark primary is near-white, so a
  // hardcoded '#fff' label/icon was invisible on the Reply pill in dark mode.
  const { colors: themeColors } = useTheme();
  const onFill = themeColors.onPrimary || '#fff';

  const innerStyle = primary
    ? { backgroundColor: color, paddingHorizontal: 18, minHeight: 44, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }
    : { alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 };
  const iconColor = primary ? onFill : color;
  const textColor = primary ? onFill : color;

  return (
    <TouchableOpacity
      style={s.actionBarBtn}
      onPress={(e) => { if (_nativeEmailFeel()) haptic.light(); onPress?.(e); }}
      accessibilityLabel={accessibilityLabel || label}
      accessibilityRole="button"
      onPressIn={() => {
        Animated.spring(scaleAnim, {
          toValue: 0.97,
          tension: 320,
          friction: 12,
          useNativeDriver: true,
        }).start();
      }}
      onPressOut={() => {
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 180,
          friction: 9,
          useNativeDriver: true,
        }).start();
      }}
      activeOpacity={1}
    >
      <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, innerStyle]}>
        <Icon size={primary ? 18 : 22} color={iconColor} />
        {iconOnly ? null : (
          <Text numberOfLines={1} style={[s.actionBarLabel, { color: textColor, fontWeight: primary ? '600' : '500', marginTop: primary ? 0 : 3 }, primary && { fontSize: 15, letterSpacing: -0.1 }]}>{label}</Text>
        )}
      </Animated.View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  loader: { marginTop: 60 },
  progressBar: {
    height: 2,
    // Monochrome accent (#111111) — matches the send button and header so the
    // reading-progress strip reads as part of the one 2026 system.
    backgroundColor: '#111111',
    ...Platform.select({
      web: {
        transformOrigin: 'left',
        transition: 'opacity 0.3s ease',
      },
      default: {},
    }),
  },
  navBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 2, minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Why: back button hit area was thin (paddingVertical 6, padLeft 4) which
  // is below the 44pt iOS tap target threshold. Bumped to 10/10 + cursor on
  // web so the hit zone matches Apple HIG and the button doesn't feel
  // crammed against the edge.
  backBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingRight: Spacing.md, paddingLeft: 8,
    borderRadius: 12,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  backText: { fontSize: 17, fontWeight: '400', marginLeft: 2, letterSpacing: -0.3 },
  navArrows: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  navArrowBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  actionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      },
      default: {},
    }),
  },
  actionBarBtn: {
    alignItems: 'center', paddingVertical: 6, paddingHorizontal: 4, flexShrink: 1,
    borderRadius: 12,
  },
  actionBarLabel: { fontSize: 11, marginTop: 3, fontWeight: '500', letterSpacing: 0 },
});
