// components/games/GamePicker.js — [jogos 2026-10-18] "Jogos" no menu de anexo da conversa.
// Passo 1: escolhe o jogo (+ jogos em andamento + recentes + Placar). Passo 2 (só em grupo): quem joga
// (mín./máx. por jogo; Quiz pode ser aberto a todos). Cria o convite (chat_game_create) — o cartão
// aparece no chat e os convidados aceitam/recusam; o resto do grupo pode assistir.
// [jogos 2026-10-19] Folha NATIVA (GameSheet → UISheetPresentationController / BottomSheet: detents 62%/95% +
// grabber do sistema; web = folha deslizante). Regras e placar viram passos da própria folha (nada de folha
// sobre folha). "Recentes": partidas encerradas com o selo final (Venceu/Empate/Cancelado/Expirado/Abandonou);
// esconder uma (×) ou "Limpar" todas — só some para mim (chat_game_hide; só com o servidor v2). Háptico em tudo.
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Switch, StyleSheet, Platform } from 'react-native';
import { GameTypeIcon, IconPodium, IconGamepad } from './GameIcons';
import { ScoreboardList } from './GameScoreboard';
import { RulesBody } from './RulesSheet';
import GameSheet, { sheetScrollFill } from './GameSheet';
import AvatarCircle from '../AvatarCircle';
import { gamePalette, hTap, hOk, hErr } from './fx';
import { PressScale, useRM } from './motion';
import {
  GAME_TYPES, gameTitle, gameSubtitle, gameCreate, gameList, gameErrorText, gameStatusLine, gameEndBadge, gameHide, gameHideAll, gameFeature, tr,
} from '../../services/games';

const LIMITS = { damas: [2, 2], velha: [2, 2], cartas: [2, 6], quiz: [2, 20], forca: [2, 8] };

function XIcon({ color }) {
  return (
    <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: 14, height: 1.8, borderRadius: 1, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: 14, height: 1.8, borderRadius: 1, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
    </View>
  );
}

export default function GamePicker({ visible, onClose, conversationId, conversationType, members, currentEmail, t, colors, isDark, onCreated, onOpenGame }) {
  const rm = useRM();
  const [step, setStep] = useState('pick'); // pick | players | score | rules
  const [type, setType] = useState(null);
  const [rulesType, setRulesType] = useState(null);
  const [sel, setSel] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [games, setGames] = useState([]);
  const isGroup = conversationType === 'group';
  const me = String(currentEmail || '').toLowerCase();
  const pal = useMemo(() => gamePalette(colors, isDark), [colors, isDark]);
  const ink = pal.ink; const sub = pal.sub; const line = pal.line;
  const canHide = gameFeature('hide');

  useEffect(() => {
    if (!visible) return undefined;
    setStep('pick'); setType(null); setSel([]); setOpen(false); setErr(''); setBusy(false);
    let alive = true;
    (async () => {
      const r = await gameList(conversationId);
      if (alive && r && r.success) setGames(Array.isArray(r.data.games) ? r.data.games : []);
    })();
    return () => { alive = false; };
  }, [visible, conversationId]);

  const others = useMemo(() => (Array.isArray(members) ? members : [])
    .filter((m) => m && m.email && String(m.email).toLowerCase() !== me)
    .map((m) => ({ e: String(m.email).toLowerCase(), n: m.name || m.display_name || String(m.email).split('@')[0] })), [members, me]);

  const nowMs = Date.now();
  const active = games.filter((g) => (g.status === 'pending' && !(g.exp && nowMs > g.exp)) || g.status === 'active');
  const recent = games.filter((g) => !active.includes(g)).slice(0, 8);

  const hideOne = useCallback(async (g) => {
    hTap();
    setGames((prev) => prev.filter((x) => x.g !== g.g)); // some na hora; o servidor confirma
    const r = await gameHide(g.g);
    if (!r || !r.success) { hErr(); setErr(gameErrorText(t, r)); }
  }, [t]);
  const hideAll = useCallback(async () => {
    hTap();
    const keep = games.filter((g) => g.status === 'pending' || g.status === 'active');
    setGames(keep);
    const r = await gameHideAll(conversationId);
    if (!r || !r.success) { hErr(); setErr(gameErrorText(t, r)); }
  }, [games, conversationId, t]);

  if (!visible) return null;
  const lim = type ? LIMITS[type] : [2, 2];
  const maxOthers = lim[1] - 1;
  const needOthers = lim[0] - 1;

  const create = async (tp, players, isOpen) => {
    setBusy(true); setErr('');
    const r = await gameCreate(conversationId, tp, players, isOpen);
    setBusy(false);
    if (r && r.success && r.data && r.data.game) { hOk(); const gv = r.data.game; onClose && onClose(); onCreated && onCreated(gv); return; }
    hErr();
    setErr(gameErrorText(t, r));
  };
  const pick = (tp) => {
    hTap();
    setType(tp); setErr('');
    if (!isGroup) { create(tp, [], false); return; }
    setSel([]); setOpen(tp === 'quiz'); setStep('players');
  };
  const toggle = (e) => {
    hTap();
    setSel((prev) => {
      if (prev.includes(e)) return prev.filter((x) => x !== e);
      if (maxOthers === 1) return [e];
      if (prev.length >= maxOthers) return prev;
      return [...prev, e];
    });
  };
  const go = (s) => { hTap(); setErr(''); setStep(s); };
  const showRules = (tp) => { hTap(); setRulesType(tp); setStep('rules'); };
  const back = () => { hTap(); setErr(''); setStep(step === 'rules' && type ? 'players' : 'pick'); };
  const openGame = (g) => { hTap(); onClose && onClose(); onOpenGame && onOpenGame(g); };
  const canInvite = open || (sel.length >= needOthers && sel.length <= maxOthers);
  const rangeText = maxOthers === needOthers
    ? tr(t, 'games.pick.exactly', 'Escolha {n} adversário', { n: needOthers })
    : tr(t, 'games.pick.range', 'Escolha de {min} a {max} pessoas', { min: needOthers, max: maxOthers });
  const title = step === 'score' ? (isGroup ? tr(t, 'games.score.title', 'Placar do grupo') : tr(t, 'games.score.titleDirect', 'Placar da conversa'))
    : step === 'players' ? gameTitle(t, type) : step === 'rules' ? tr(t, 'games.rules.button', 'Regras') : tr(t, 'games.menu', 'Jogos');

  const gameRow = (g, done) => {
    const badge = done ? gameEndBadge(t, g, currentEmail) : null;
    return (
      <View key={g.g} style={[st.activeRow, { borderColor: line, backgroundColor: done ? 'transparent' : pal.card }]}>
        <Pressable onPress={() => openGame(g)} style={st.activeMain} accessibilityRole="button"
          accessibilityLabel={`${gameTitle(t, g.type)}. ${gameStatusLine(t, g, currentEmail)}`}>
          <View style={[st.miniIcon, { backgroundColor: done ? pal.card2 : pal.strong }]}>
            <GameTypeIcon type={g.type} size={16} color={done ? ink : pal.onStrong} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: ink, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>{gameTitle(t, g.type)}</Text>
            <Text style={{ color: sub, fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>{gameStatusLine(t, g, currentEmail)}</Text>
          </View>
          {badge ? <View style={[st.badge, { backgroundColor: badge.kind === 'won' || badge.kind === 'resigned_other' ? pal.good : pal.card2 }]}>
            <Text style={{ color: badge.kind === 'won' || badge.kind === 'resigned_other' ? '#fff' : ink, fontSize: 11, fontWeight: '800' }}>{badge.label}</Text>
          </View> : null}
        </Pressable>
        {done && canHide ? (
          <Pressable onPress={() => hideOne(g)} hitSlop={10} style={st.xBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.pick.hide', 'Esconder')}>
            <XIcon color={sub} />
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <GameSheet visible onClose={onClose} bg={pal.bg} detents={[0.62, 0.95]}>
      <View style={st.headRow}>
        {step !== 'pick' ? (
          <Pressable onPress={back} hitSlop={10} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
            <Text style={{ color: ink, fontSize: 15, fontWeight: '600' }}>{tr(t, 'common.back', 'Voltar')}</Text>
          </Pressable>
        ) : <IconGamepad size={22} color={ink} />}
        <Text style={[st.title, { color: ink }]} numberOfLines={1}>{title}</Text>
        {step === 'pick' ? (
          <PressScale rm={rm} onPress={() => go('score')} style={[st.scoreBtn, { borderColor: line }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.score.title', 'Placar do grupo')}>
            <IconPodium size={15} color={ink} />
            <Text style={{ color: ink, fontSize: 12.5, fontWeight: '700' }}>{tr(t, 'games.score.short', 'Placar')}</Text>
          </PressScale>
        ) : null}
      </View>

      <ScrollView style={sheetScrollFill} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10 }} keyboardShouldPersistTaps="handled">
        {step === 'pick' ? (
          <>
            {active.length ? (
              <View style={{ marginBottom: 12 }}>
                <Text style={[st.section, { color: sub }]}>{tr(t, 'games.inProgress', 'Em andamento')}</Text>
                {active.slice(0, 5).map((g) => gameRow(g, false))}
              </View>
            ) : null}
            <View style={st.grid}>
              {GAME_TYPES.map((tp) => (
                <PressScale key={tp} rm={rm} scaleTo={0.96} disabled={busy} onPress={() => pick(tp)} onLongPress={() => showRules(tp)} style={[st.tile, { backgroundColor: pal.card }]}
                  accessibilityRole="button" accessibilityLabel={`${gameTitle(t, tp)}. ${gameSubtitle(t, tp)}`}>
                  <View style={[st.tileIcon, { backgroundColor: pal.strong }]}>
                    <GameTypeIcon type={tp} size={24} color={pal.onStrong} />
                  </View>
                  <Text style={[st.tileTitle, { color: ink }]} numberOfLines={1}>{gameTitle(t, tp)}</Text>
                  <Text style={[st.tileSub, { color: sub }]} numberOfLines={2}>{gameSubtitle(t, tp)}</Text>
                  <View style={st.tileFoot}>
                    <Text style={[st.tileMeta, { color: sub }]}>
                      {LIMITS[tp][0] === LIMITS[tp][1] ? tr(t, 'games.players.n', '{n} jogadores', { n: LIMITS[tp][0] }) : tr(t, 'games.players.range', '{min} a {max} jogadores', { min: LIMITS[tp][0], max: isGroup ? LIMITS[tp][1] : 2 })}
                    </Text>
                    <Pressable onPress={() => showRules(tp)} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'games.rules.button', 'Regras')}>
                      <Text style={{ color: ink, fontSize: 11.5, fontWeight: '700', textDecorationLine: 'underline' }}>{tr(t, 'games.rules.button', 'Regras')}</Text>
                    </Pressable>
                  </View>
                </PressScale>
              ))}
            </View>
            {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={ink} /> : null}
            {recent.length ? (
              <View style={{ marginTop: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[st.section, { color: sub, flex: 1 }]}>{tr(t, 'games.recent', 'Recentes')}</Text>
                  {canHide ? (
                    <Pressable onPress={hideAll} hitSlop={8} accessibilityRole="button">
                      <Text style={{ color: ink, fontSize: 12.5, fontWeight: '700' }}>{tr(t, 'games.pick.clear', 'Limpar')}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {recent.map((g) => gameRow(g, true))}
              </View>
            ) : null}
          </>
        ) : null}

        {step === 'players' ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[st.section, { color: sub, flex: 1 }]}>{rangeText}</Text>
              <Pressable onPress={() => showRules(type)} hitSlop={8} accessibilityRole="button">
                <Text style={{ color: ink, fontWeight: '700', fontSize: 13, textDecorationLine: 'underline' }}>{tr(t, 'games.rules.button', 'Regras')}</Text>
              </Pressable>
            </View>
            {type === 'quiz' ? (
              <View style={[st.openRow, { borderColor: line }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: ink, fontWeight: '700', fontSize: 14.5 }}>{tr(t, 'games.pick.openTitle', 'Aberto ao grupo')}</Text>
                  <Text style={{ color: sub, fontSize: 12.5 }}>{tr(t, 'games.pick.openSub', 'Quem quiser entra pelo cartão; você começa quando quiser')}</Text>
                </View>
                <Switch value={open} onValueChange={(v) => { hTap(); setOpen(v); }} trackColor={{ true: isDark ? '#fff' : '#111', false: undefined }} thumbColor={Platform.OS === 'android' ? (open && isDark ? '#111' : '#fff') : undefined} />
              </View>
            ) : null}
            {others.map((m) => {
              const on = sel.includes(m.e);
              return (
                <Pressable key={m.e} onPress={() => toggle(m.e)} style={({ pressed }) => [st.memRow, { borderBottomColor: line }, pressed && { opacity: 0.7 }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                  <AvatarCircle email={m.e} name={m.n} size={36} />
                  <Text style={{ color: ink, fontSize: 15, flex: 1 }} numberOfLines={1}>{m.n}</Text>
                  <View style={[st.check, { borderColor: on ? ink : line, backgroundColor: on ? ink : 'transparent' }]}>
                    {on ? <View style={{ width: 10, height: 5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: pal.onStrong, transform: [{ rotate: '-45deg' }, { translateY: -1 }] }} /> : null}
                  </View>
                </Pressable>
              );
            })}
            {!others.length ? <Text style={{ color: sub, marginVertical: 14 }}>{tr(t, 'games.pick.noMembers', 'Carregando membros do grupo...')}</Text> : null}
          </>
        ) : null}

        {step === 'rules' && rulesType ? <View style={{ marginHorizontal: -16 }}><RulesBody type={rulesType} t={t} pal={pal} maxH={2000} /></View> : null}
        {step === 'score' ? <ScoreboardList conversationId={conversationId} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark} /> : null}
        {err ? <Text style={[st.err]}>{err}</Text> : null}
      </ScrollView>

      {step === 'players' ? (
        <PressScale rm={rm} disabled={!canInvite || busy} onPress={() => { hTap(); create(type, sel, open); }}
          style={[st.cta, { backgroundColor: pal.strong, opacity: canInvite && !busy ? 1 : 0.4 }]} accessibilityRole="button">
          {busy ? <ActivityIndicator color={pal.onStrong} /> : (
            <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15.5 }}>
              {open && !sel.length ? tr(t, 'games.pick.createOpen', 'Criar e chamar o grupo') : tr(t, 'games.pick.invite', 'Convidar ({n})', { n: sel.length })}
            </Text>
          )}
        </PressScale>
      ) : null}
    </GameSheet>
  );
}

const st = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { paddingVertical: 2 },
  title: { flex: 1, fontSize: 19, fontWeight: '800' },
  scoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  section: { fontSize: 12.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  tile: { width: '48.5%', borderRadius: 18, padding: 12, minHeight: 146 },
  tileIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  tileTitle: { fontSize: 15.5, fontWeight: '800' },
  tileSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 6 },
  tileMeta: { fontSize: 11, fontWeight: '600' },
  activeRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, marginBottom: 6 },
  activeMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 9 },
  miniIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  badge: { borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
  xBtn: { paddingHorizontal: 12, paddingVertical: 12 },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  err: { color: '#DC2626', marginTop: 10, fontSize: 13.5, textAlign: 'center' },
  cta: { marginHorizontal: 16, marginTop: 8, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
});
