// components/chat/PollVotesSheet.js — [wave13e 2026-10-16] "Ver votos" da
// enquete estilo WhatsApp: folha P&B com uma seção por opção (contagem) e quem
// votou (avatar, nome, hora), mais recente primeiro. Servidor: chat.php
// chat_poll_voters (só membros; enquete anônima → só contagens).
//
// Imperativo: openPollVotes(poll, messageId) — o host (PollVotesHost) é montado
// uma vez no app/_layout (Late overlays). Sem host montado (ou kill switch
// globalThis.__chatyy_poll_votes_sheet = false) devolve false e quem chamou cai
// no resumo antigo em Alert (pollLook.showPollVotes).
import { useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useGroupedColors } from '../settings/SettingsKit';
import AvatarCircle from '../AvatarCircle';
import { IconX } from '../Icons';
import { formatDateTime } from '../../utils/dateFormat';
import { pollStats, votesLabel } from './pollLook';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragFade } from '../ui/useDragToDismiss';

const _hosts = new Set();

function _enabled() {
  try { return globalThis.__chatyy_poll_votes_sheet !== false; } catch { return true; }
}

/** Abre a folha; false = sem host (use o fallback em Alert). */
export function openPollVotes(poll, messageId) {
  const id = Number(messageId || (poll && poll.id)) || 0;
  if (!_enabled() || !id || !_hosts.size) return false;
  const req = { poll: poll || null, id, at: Date.now() };
  _hosts.forEach((fn) => { try { fn(req); } catch {} });
  return true;
}

async function _fetchVoters(id) {
  try {
    const { apiCall } = require('../../services/api');
    const r = await apiCall('chat_poll_voters', { message_id: id }, 'GET', { swr: false });
    return r && r.success && r.data ? r.data : null;
  } catch { return null; }
}

function _tr(t, k, fb) {
  try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; }
}

export default function PollVotesHost() {
  const [req, setReq] = useState(null);
  useEffect(() => {
    _hosts.add(setReq);
    return () => { _hosts.delete(setReq); };
  }, []);
  if (!req) return null;
  return <PollVotesSheet key={req.at} req={req} onClose={() => setReq(null)} />;
}

function PollVotesSheet({ req, onClose }) {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag86 = useDragToDismiss({ onDismiss: () => { const f = onClose; if (typeof f === 'function') f(); } });
  const g = useGroupedColors();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    _fetchVoters(req.id).then((d) => {
      if (!alive) return;
      if (d) setData(d); else setFailed(true);
    });
    return () => { alive = false; };
  }, [req.id, tick]);

  const local = pollStats(req.poll || {});
  const question = String((data && data.question) || (req.poll && req.poll.question) || _tr(t, 'chat.poll', 'Enquete'));
  const options = (data && Array.isArray(data.options)) ? data.options.map((o) => String(o == null ? '' : o)) : local.rows.map((r) => r.text);
  const counts = (data && Array.isArray(data.counts)) ? data.counts : local.rows.map((r) => r.count);
  const voters = (data && data.voters) || {};
  const anon = !!(data && data.anonymous);
  const totalVoters = data ? Number(data.total_voters) || 0 : local.total;
  const tt = (k, fb) => _tr(t, k, fb);
  const youLabel = _tr(t, 'common.you', 'Você');

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot>
      <View style={s.root}>
        <DragFade drag={_drag86}><Pressable style={s.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.close', 'Fechar')} /></DragFade>
        <DragPanel drag={_drag86} style={[s.panel, { backgroundColor: g.pageBg, paddingBottom: 12 + insets.bottom }]} testID="poll-votes-sheet">
          <View style={[s.grabber, { backgroundColor: g.tertiary }]} />
          <View style={s.header}>
            <View style={s.hBtn} />
            <Text style={[s.hTitle, { color: g.text }]} numberOfLines={1}>{_tr(t, 'chat.pollVotesTitle', 'Votos da enquete')}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={s.hBtn} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.close', 'Fechar')} testID="poll-votes-close">
              <IconX size={22} color={g.ink} />
            </Pressable>
          </View>
          <DragScroll drag={_drag86}><ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}>
            <View style={[s.card, { backgroundColor: g.cardBg }]}>
              <Text style={[s.question, { color: g.text }]}>{question}</Text>
              <Text style={[s.meta, { color: g.secondary }]}>{votesLabel(totalVoters, t ? (k) => t(k) : null)}</Text>
            </View>
            {anon ? (
              <Text style={[s.note, { color: g.secondary }]}>{_tr(t, 'chat.pollAnonymous', 'Enquete anônima: ninguém vê quem votou em cada opção.')}</Text>
            ) : null}
            {!data && !failed ? <ActivityIndicator color={g.ink} style={{ marginTop: 18 }} /> : null}
            {failed ? (
              <Pressable onPress={() => setTick((n) => n + 1)} style={s.retry} accessibilityRole="button" testID="poll-votes-retry">
                <Text style={[s.note, { color: g.secondary, marginTop: 0 }]}>{_tr(t, 'chat.pollVotesFailed', 'Não foi possível carregar os votos.')}</Text>
                <Text style={[s.retryText, { color: g.ink }]}>{_tr(t, 'common.retry', 'Tentar novamente')}</Text>
              </Pressable>
            ) : null}
            {options.map((label, i) => {
              const list = Array.isArray(voters[String(i)]) ? voters[String(i)] : (Array.isArray(voters[i]) ? voters[i] : []);
              const c = Number(counts[i]) || 0;
              return (
                <View key={i} style={[s.card, { backgroundColor: g.cardBg }]}>
                  <View style={s.optHead}>
                    <Text style={[s.optText, { color: g.text }]} numberOfLines={3}>{label}</Text>
                    <Text style={[s.optCount, { color: g.secondary }]}>{votesLabel(c, t ? (k) => t(k) : null, true)}</Text>
                  </View>
                  {data && !anon && list.map((v, j) => (
                    <View key={`${v.email || j}`} style={[s.row, { borderTopColor: g.separator }]}>
                      <AvatarCircle email={v.email} uri={v.avatar || undefined} name={v.name || v.email} size={36} />
                      <Text style={[s.name, { color: g.text }]} numberOfLines={1}>{v.is_me ? youLabel : (v.name || v.email)}</Text>
                      <Text style={[s.time, { color: g.secondary }]}>{formatDateTime(v.voted_at, tt)}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </ScrollView></DragScroll>
        </DragPanel>
      </View>
      </DragSheetRoot>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { maxHeight: '86%', borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden', width: '100%', maxWidth: 640, alignSelf: 'center' },
  grabber: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 8, opacity: 0.8 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  hBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  card: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, marginTop: 12 },
  question: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  meta: { fontSize: 13, marginTop: 4 },
  note: { fontSize: 13, textAlign: 'center', marginTop: 14, lineHeight: 18 },
  retry: { alignItems: 'center', paddingVertical: 14 },
  retryText: { fontSize: 15, fontWeight: '600', marginTop: 6 },
  optHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  optText: { flex: 1, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  optCount: { fontSize: 13, fontVariant: ['tabular-nums'], marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, marginTop: 9, borderTopWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, fontSize: 15 },
  time: { fontSize: 12.5, fontVariant: ['tabular-nums'], ...(Platform.OS === 'web' ? { whiteSpace: 'nowrap' } : null) },
});
