// components/games/GamePicker.js — [jogos 2026-10-18] "Jogos" no menu de anexo da conversa.
// Passo 1: escolhe o jogo (+ jogos em andamento + Placar do grupo). Passo 2 (só em grupo): quem joga
// (mín./máx. por jogo; Quiz pode ser aberto a todos). Cria o convite (chat_game_create) — o cartão
// aparece no chat e os convidados aceitam/recusam; o resto do grupo pode assistir.
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, Switch, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GameTypeIcon, IconPodium, IconGamepad } from './GameIcons';
import { ScoreboardList } from './GameScoreboard';
import RulesSheet from './RulesSheet';
import { gamePalette } from './fx';
import {
  GAME_TYPES, gameTitle, gameSubtitle, gameCreate, gameList, gameErrorText, gameStatusLine, tr,
} from '../../services/games';

const LIMITS = { damas: [2, 2], velha: [2, 2], cartas: [2, 6], quiz: [2, 20], forca: [2, 8] };

function haptic() { try { require('expo-haptics').selectionAsync(); } catch {} }

export default function GamePicker({ visible, onClose, conversationId, conversationType, members, currentEmail, t, colors, isDark, onCreated, onOpenGame }) {
  const ins = useSafeAreaInsets();
  const [step, setStep] = useState('pick'); // pick | players | score
  const [type, setType] = useState(null);
  const [sel, setSel] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [active, setActive] = useState([]);
  const [rules, setRules] = useState(null);
  const isGroup = conversationType === 'group';
  const me = String(currentEmail || '').toLowerCase();
  const ink = colors.text || '#111';
  const sub = colors.textSecondary || '#6b7280';
  const bg = colors.background || (isDark ? '#000' : '#fff');
  const card = isDark ? '#1C1C1E' : '#F4F4F5';
  const line = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';

  useEffect(() => {
    if (!visible) return;
    setStep('pick'); setType(null); setSel([]); setOpen(false); setErr(''); setBusy(false);
    let alive = true;
    (async () => {
      const r = await gameList(conversationId);
      if (alive && r && r.success) setActive((r.data.games || []).filter((g) => g.status === 'pending' || g.status === 'active'));
    })();
    return () => { alive = false; };
  }, [visible, conversationId]);

  const others = useMemo(() => (Array.isArray(members) ? members : [])
    .filter((m) => m && m.email && String(m.email).toLowerCase() !== me)
    .map((m) => ({ e: String(m.email).toLowerCase(), n: m.name || m.display_name || String(m.email).split('@')[0] })), [members, me]);

  if (!visible) return null;
  const lim = type ? LIMITS[type] : [2, 2];
  const maxOthers = lim[1] - 1;
  const needOthers = lim[0] - 1;

  const create = async (tp, players, isOpen) => {
    setBusy(true); setErr('');
    const r = await gameCreate(conversationId, tp, players, isOpen);
    setBusy(false);
    if (r && r.success && r.data && r.data.game) { try { require('expo-haptics').notificationAsync(require('expo-haptics').NotificationFeedbackType.Success); } catch {} onCreated && onCreated(r.data.game); onClose && onClose(); return; }
    setErr(gameErrorText(t, r));
  };
  const pick = (tp) => {
    haptic();
    setType(tp); setErr('');
    if (!isGroup) { create(tp, [], false); return; }
    setSel([]); setOpen(tp === 'quiz'); setStep('players');
  };
  const toggle = (e) => {
    haptic();
    setSel((prev) => {
      if (prev.includes(e)) return prev.filter((x) => x !== e);
      if (maxOthers === 1) return [e];
      if (prev.length >= maxOthers) return prev;
      return [...prev, e];
    });
  };
  const canInvite = open || (sel.length >= needOthers && sel.length <= maxOthers);
  const rangeText = maxOthers === needOthers
    ? tr(t, 'games.pick.exactly', 'Escolha {n} adversário', { n: needOthers })
    : tr(t, 'games.pick.range', 'Escolha de {min} a {max} pessoas', { min: needOthers, max: maxOthers });

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel={tr(t, 'common.close', 'Fechar')} />
      <View style={[st.sheet, { backgroundColor: bg, paddingBottom: Math.max(ins.bottom, 14) }]}>
        <View style={st.grab} />
        <View style={st.headRow}>
          {step !== 'pick' ? (
            <Pressable onPress={() => setStep('pick')} hitSlop={10} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
              <Text style={{ color: ink, fontSize: 15, fontWeight: '600' }}>{tr(t, 'common.back', 'Voltar')}</Text>
            </Pressable>
          ) : <IconGamepad size={22} color={ink} />}
          <Text style={[st.title, { color: ink }]} numberOfLines={1}>
            {step === 'score' ? (isGroup ? tr(t, 'games.score.title', 'Placar do grupo') : tr(t, 'games.score.titleDirect', 'Placar da conversa')) : step === 'players' ? gameTitle(t, type) : tr(t, 'games.menu', 'Jogos')}
          </Text>
          {step === 'pick' ? (
            <Pressable onPress={() => { haptic(); setStep('score'); }} style={[st.scoreBtn, { borderColor: line }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.score.title', 'Placar do grupo')}>
              <IconPodium size={15} color={ink} />
              <Text style={{ color: ink, fontSize: 12.5, fontWeight: '700' }}>{tr(t, 'games.score.short', 'Placar')}</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 6 }} keyboardShouldPersistTaps="handled">
          {step === 'pick' ? (
            <>
              {active.length ? (
                <View style={{ marginBottom: 10 }}>
                  <Text style={[st.section, { color: sub }]}>{tr(t, 'games.inProgress', 'Em andamento')}</Text>
                  {active.slice(0, 4).map((g) => (
                    <Pressable key={g.g} onPress={() => { onClose && onClose(); onOpenGame && onOpenGame(g); }} style={[st.activeRow, { borderColor: line }]} accessibilityRole="button">
                      <GameTypeIcon type={g.type} size={18} color={ink} />
                      <Text style={{ color: ink, fontWeight: '700', fontSize: 14 }}>{gameTitle(t, g.type)}</Text>
                      <Text style={{ color: sub, fontSize: 13, flex: 1 }} numberOfLines={1}>{gameStatusLine(t, g, currentEmail)}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={st.grid}>
                {GAME_TYPES.map((tp) => (
                  <Pressable key={tp} disabled={busy} onPress={() => pick(tp)} onLongPress={() => setRules(tp)} style={({ pressed }) => [st.tile, { backgroundColor: card }, pressed && { transform: [{ scale: 0.97 }] }]}
                    accessibilityRole="button" accessibilityLabel={`${gameTitle(t, tp)}. ${gameSubtitle(t, tp)}`}>
                    <View style={[st.tileIcon, { backgroundColor: isDark ? '#fff' : '#111' }]}>
                      <GameTypeIcon type={tp} size={24} color={isDark ? '#111' : '#fff'} />
                    </View>
                    <Text style={[st.tileTitle, { color: ink }]} numberOfLines={1}>{gameTitle(t, tp)}</Text>
                    <Text style={[st.tileSub, { color: sub }]} numberOfLines={2}>{gameSubtitle(t, tp)}</Text>
                    <Text style={[st.tileMeta, { color: sub }]}>
                      {LIMITS[tp][0] === LIMITS[tp][1] ? tr(t, 'games.players.n', '{n} jogadores', { n: LIMITS[tp][0] }) : tr(t, 'games.players.range', '{min} a {max} jogadores', { min: LIMITS[tp][0], max: isGroup ? LIMITS[tp][1] : 2 })}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={ink} /> : null}
            </>
          ) : null}

          {step === 'players' ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[st.section, { color: sub, flex: 1 }]}>{rangeText}</Text>
                <Pressable onPress={() => setRules(type)} hitSlop={8} accessibilityRole="button">
                  <Text style={{ color: ink, fontWeight: '700', fontSize: 13, textDecorationLine: 'underline' }}>{tr(t, 'games.rules.button', 'Regras')}</Text>
                </Pressable>
              </View>
              {type === 'quiz' ? (
                <View style={[st.openRow, { borderColor: line }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: ink, fontWeight: '700', fontSize: 14.5 }}>{tr(t, 'games.pick.openTitle', 'Aberto ao grupo')}</Text>
                    <Text style={{ color: sub, fontSize: 12.5 }}>{tr(t, 'games.pick.openSub', 'Quem quiser entra pelo cartão; você começa quando quiser')}</Text>
                  </View>
                  <Switch value={open} onValueChange={(v) => { haptic(); setOpen(v); }} trackColor={{ true: '#111', false: undefined }} thumbColor={Platform.OS === 'android' ? '#fff' : undefined} />
                </View>
              ) : null}
              {others.map((m) => {
                const on = sel.includes(m.e);
                return (
                  <Pressable key={m.e} onPress={() => toggle(m.e)} style={[st.memRow, { borderBottomColor: line }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                    <View style={[st.check, { borderColor: on ? ink : line, backgroundColor: on ? ink : 'transparent' }]}>
                      {on ? <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: isDark ? '#000' : '#fff' }} /> : null}
                    </View>
                    <Text style={{ color: ink, fontSize: 15, flex: 1 }} numberOfLines={1}>{m.n}</Text>
                  </Pressable>
                );
              })}
              {!others.length ? <Text style={{ color: sub, marginVertical: 14 }}>{tr(t, 'games.pick.noMembers', 'Carregando membros do grupo...')}</Text> : null}
            </>
          ) : null}

          {step === 'score' ? <ScoreboardList conversationId={conversationId} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark} /> : null}
          {err ? <Text style={[st.err]}>{err}</Text> : null}
        </ScrollView>

        {step === 'players' ? (
          <Pressable disabled={!canInvite || busy} onPress={() => create(type, sel, open)}
            style={[st.cta, { backgroundColor: isDark ? '#fff' : '#111', opacity: canInvite && !busy ? 1 : 0.4 }]} accessibilityRole="button">
            {busy ? <ActivityIndicator color={isDark ? '#111' : '#fff'} /> : (
              <Text style={{ color: isDark ? '#111' : '#fff', fontWeight: '800', fontSize: 15.5 }}>
                {open && !sel.length ? tr(t, 'games.pick.createOpen', 'Criar e chamar o grupo') : tr(t, 'games.pick.invite', 'Convidar ({n})', { n: sel.length })}
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>
      <RulesSheet visible={!!rules} type={rules} onClose={() => setRules(null)} t={t} pal={gamePalette(colors, isDark)} />
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8 },
  grab: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 6 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  backBtn: { paddingVertical: 2 },
  title: { flex: 1, fontSize: 19, fontWeight: '800' },
  scoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  section: { fontSize: 12.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  tile: { width: '48.5%', borderRadius: 16, padding: 12, minHeight: 138 },
  tileIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  tileTitle: { fontSize: 15.5, fontWeight: '800' },
  tileSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  tileMeta: { fontSize: 11, marginTop: 6, fontWeight: '600' },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6 },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  err: { color: '#DC2626', marginTop: 10, fontSize: 13.5, textAlign: 'center' },
  cta: { marginHorizontal: 16, marginTop: 8, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
});
