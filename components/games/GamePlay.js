// components/games/GamePlay.js — [jogos 2026-10-19 inline] corpo da partida, usado em DOIS lugares:
//   - app/game/[id].js (rota antiga: deep link / app antigo) → tela cheia, como antes;
//   - components/games/GamePlaySheet.js (embedded) → folha nativa POR CIMA da conversa (cabeçalho fino com o
//     adversário + vez + fechar; regras/mais/confirmações viram painéis DENTRO da folha: nunca folha sobre folha).
// (texto original da tela abaixo)
// Tela do jogo (Damas, Velha, Cartas Coloridas, Quiz, Forca).
// Visual P&B premium; o SERVIDOR valida tudo (o app manda a intenção e redesenha com a visão que volta).
// Tempo real pelo evento WS game_update (services/games.js) + atualização de segurança a cada 12 s.
// Faixa de mensagens rápidas manda texto normal para a conversa.
// Polish 2: tablet/web largo (>= 900) = tabuleiro centralizado + painel lateral (jogadores + conversa);
// pódio animado no fim (Quiz/Forca/Cartas em grupo); "reduzir movimento" desliga pulsos e confete.
// [jogos 2026-10-19] Rodada 3 — sensação nativa + ciclo de vida completo:
//  - push da pilha nativa (swipe-back de tela cheia: app/_layout fullScreenGestureEnabled) e cabeçalho estilo
//    sistema: voltar, título + estado da vez, regras e "mais" (folha nativa com som, empate, sair).
//  - mesa com os AVATARES dos jogadores; anel de vez em volta de quem joga (com contagem quando há prazo:
//    grupo de Cartas/Forca = vez pula sozinha em afk_ms). Anel = Reanimated (UI thread); web = 1 Hz.
//  - fases com transição suave (esperando → jogando → fim), cada uma com sua tela:
//    convite (aceitar/recusar/cancelar com confirmação), cancelado/expirado/recusado, vitória/derrota/empate/abandono.
//  - empate combinado (Damas/Velha): propor, aceitar, recusar — faixa no topo do tabuleiro.
//  - revanche com o consentimento dos dois: "Revanche" → "Aguardando Ana" → abre sozinha quando ela aceita.
//  - toda confirmação é folha nativa (components/games/GameSheet: UISheetPresentationController/BottomSheet).
//  - háptico em toda interação; safe areas; tema claro/escuro.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, StyleSheet, AppState, Platform, KeyboardAvoidingView, useWindowDimensions } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedProps, withRepeat, withSequence, withTiming, withSpring, withDelay, cancelAnimation, Easing } from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { IconChevronLeft, IconChevronDown, IconX } from '../../components/Icons';
import AvatarCircle from '../../components/AvatarCircle';
import { GameTypeIcon, IconTrophy, IconRematch, IconFlagResign, IconDrawOffer, IconMore, IconBan, IconHourglass, IconCrown } from '../../components/games/GameIcons';
import { gamePalette, hWin, hErr, hTurn, hEnd, hTap, hOk, gameAccent } from '../../components/games/fx';
import Confetti from '../../components/games/Confetti';
import Podium from '../../components/games/Podium';
import { useRM, PressScale, useEnter, IS_WEB } from '../../components/games/motion';
import RulesSheet from '../../components/games/RulesSheet';
import GameSheet, { ConfirmSheet, GameSheetInlineProvider } from '../../components/games/GameSheet';
import { runAfterNativeSheet, NativeSheetKeyboardView } from '../../components/NativeSheet';
import { loadSoundPref, soundOn, setSoundOn, onSoundPref, releaseSfx } from '../../components/games/sound';
import VelhaBoard from '../../components/games/boards/VelhaBoard';
import DamasBoard from '../../components/games/boards/DamasBoard';
import CartasBoard from '../../components/games/boards/CartasBoard';
import QuizBoard from '../../components/games/boards/QuizBoard';
import ForcaBoard from '../../components/games/boards/ForcaBoard';
// [jogos2b 2026-10-21] Termo em dupla / Pedra, papel e tesoura / Stop / Desenha e Adivinha
import TermoBoard from '../../components/games/boards/TermoBoard';
import PptBoard from '../../components/games/boards/PptBoard';
import StopBoard from '../../components/games/boards/StopBoard';
import DesenhoBoard from '../../components/games/boards/DesenhoBoard';
import { NOVOS_POINTS } from '../../services/gamesNovos';
import {
  getGameView, subscribeGame, gameState, gameMove, gameResign, gameRematch, gameAccept, gameDecline, gameStart, gameJoin, gameCancel, gameDraw, gameFeature,
  gameTitle, gameStatusLine, resultHeadline, gameErrorText, gameCardActions, gameActionLabel, nameOf, playerStatusLabel, isMyTurn, tr, gameEndKind, isInviteExpired,
} from '../../services/games';

const ACircle = Animated.createAnimatedComponent(Circle);
const lc = (s) => String(s || '').toLowerCase();

function SoundIcon({ on, color }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      {on ? <Path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <Path d="M16 9.5l5 5M21 9.5l-5 5" />}
    </Svg>
  );
}
function RulesIcon({ color, size = 20 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z" /><Path d="M5 16.5a3 3 0 0 1 3-3h10.5" /><Path d="M9 8.5h6" />
    </Svg>
  );
}
function Dot({ a, k, pal }) {
  const st = useAnimatedStyle(() => ({ opacity: 0.25 + 0.75 * Math.max(0, Math.sin(Math.PI * ((a.value + k / 3) % 1))) }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.ink }, st]} />;
}
// [2026-10-20 polish] ponto que pulsa ao lado de "Sua vez" (cabeçalho do painel)
function PulseDot({ color, on, rm }) {
  const a = useSharedValue(0);
  useEffect(() => {
    if (!on || rm) { cancelAnimation(a); a.value = 0; return undefined; }
    a.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.out(Easing.quad) }), -1, false);
    return () => cancelAnimation(a);
  }, [on, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const halo = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - a.value), transform: [{ scale: 1 + 1.4 * a.value }] }));
  return (
    <View style={{ width: 8, height: 8, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: color }, halo]} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
    </View>
  );
}
function WaitingDots({ pal }) {
  const a = useSharedValue(0);
  useEffect(() => { a.value = withRepeat(withTiming(1, { duration: 1100 }), -1, false); return () => cancelAnimation(a); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>{[0, 1, 2].map((k) => <Dot key={k} a={a} k={k} pal={pal} />)}</View>;
}

/**
 * Anel de vez em volta do avatar. Com prazo (`endsAt` ms no relógio do app) o anel ESVAZIA até o fim (UI thread);
 * sem prazo = anel cheio que "respira". Web: SVG animatedProps não é confiável → atualiza 1x/s.
 */
function TurnRing({ size, active, endsAt, total, color, warn, rm }) {
  const R = size / 2 - 2; const C = 2 * Math.PI * R;
  const p = useSharedValue(1);
  const breathe = useSharedValue(1);
  const [webP, setWebP] = useState(1);
  const timed = !!(active && endsAt && total);
  useEffect(() => {
    cancelAnimation(p);
    if (!timed) { p.value = 1; return undefined; }
    const left = Math.max(0, endsAt - Date.now());
    const start = Math.min(1, left / total);
    if (IS_WEB) {
      const tick = () => setWebP(Math.max(0, Math.min(1, (endsAt - Date.now()) / total)));
      tick();
      const iv = setInterval(tick, 1000);
      return () => clearInterval(iv);
    }
    p.value = start;
    p.value = withTiming(0, { duration: left, easing: Easing.linear });
    return undefined;
  }, [timed, endsAt, total]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (active && !timed && !rm) breathe.value = withRepeat(withSequence(withTiming(0.55, { duration: 900 }), withTiming(1, { duration: 900 })), -1, false);
    else { cancelAnimation(breathe); breathe.value = 1; }
    return () => cancelAnimation(breathe);
  }, [active, timed, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const ap = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - p.value) }));
  const wrapSt = useAnimatedStyle(() => ({ opacity: breathe.value }));
  if (!active) return null;
  const col = timed && (IS_WEB ? webP : 1) < 0.25 ? warn : color;
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, wrapSt]}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        {timed ? <Circle cx={size / 2} cy={size / 2} r={R} stroke={color} strokeOpacity={0.18} strokeWidth={3} fill="none" /> : null}
        {timed && !IS_WEB
          ? <ACircle cx={size / 2} cy={size / 2} r={R} stroke={col} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={[C, C]} animatedProps={ap} />
          : <Circle cx={size / 2} cy={size / 2} r={R} stroke={col} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={[C, C]} strokeDashoffset={timed ? C * (1 - webP) : 0} />}
      </Svg>
    </Animated.View>
  );
}

/** Cadeira na mesa: avatar + anel de vez + nome + selo do jogo (peça, marca, cartas, pontos). */
function Seat({ e, i, view, me, pal, t, rm, compact, offset }) {
  const S = view.state || {};
  const turn = view.status === 'active' && view.turn && lc(view.turn) === lc(e);
  const won = view.status === 'finished' && (view.winners || []).some((w) => lc(w) === lc(e));
  const out = Array.isArray(S.out) && S.out[i];
  const left = Array.isArray(view.left) && view.left.includes(lc(e));
  const sz = compact ? 40 : 46;
  let badge = null;
  if (view.type === 'damas') badge = <View style={[st.pieceDot, { backgroundColor: i === 0 ? '#F4F1EA' : '#151517', borderColor: i === 0 ? '#B9B4A8' : '#5A5A60' }]} />;
  if (view.type === 'velha') badge = <Text style={{ color: pal.ink, fontWeight: '900', fontSize: 12 }}>{i === 0 ? 'X' : 'O'}</Text>;
  if (view.type === 'cartas') badge = <Text style={{ color: pal.sub, fontWeight: '800', fontSize: 11.5 }}>{tr(t, 'games.cartas.nShort', '{n} c.', { n: (S.counts || [])[i] ?? 0 })}</Text>;
  if (view.type === 'quiz' || view.type === 'forca') badge = <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 11.5 }}>{(S.sc || [])[i] || 0}</Text>;
  if (NOVOS_POINTS[view.type]) badge = <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 11.5 }}>{(S.sc || [])[i] || 0}</Text>; // [jogos2b]
  // prazo da vez (só grupo de Cartas/Forca): ts (servidor) + afk_ms, convertido p/ o relógio do app
  const endsAt = turn && view.afk_ms && view.ts ? Number(view.ts) + Number(view.afk_ms) - (offset || 0) : null;
  return (
    <View style={[st.seat, { opacity: out || left ? 0.42 : 1 }]} accessibilityLabel={`${nameOf(view, e, me, t)}${turn ? '. ' + tr(t, 'games.status.playingNow', 'Jogando agora') : ''}`}>
      <View style={{ width: sz + 8, height: sz + 8, alignItems: 'center', justifyContent: 'center' }}>
        <TurnRing size={sz + 8} active={turn} endsAt={endsAt} total={view.afk_ms} color={pal.accent} warn={pal.bad} rm={rm} />
        <View style={{ borderRadius: sz, borderWidth: won ? 2 : 0, borderColor: pal.accent }}>
          <AvatarCircle email={e} name={nameOf(view, e, '', t)} size={sz} />
        </View>
        {won ? <View style={[st.crownTag, { backgroundColor: pal.accent }]}><IconCrown size={11} color="#111" /></View> : null}
      </View>
      <Text style={[st.seatName, { color: pal.ink, fontWeight: i === view.me ? '800' : '600' }]} numberOfLines={1}>{nameOf(view, e, me, t)}</Text>
      <View style={st.seatBadge}>{badge}</View>
    </View>
  );
}

function Table({ view, me, pal, t, rm, vertical, offset }) {
  const seats = Array.isArray(view.seats) && view.seats.length ? view.seats : (view.players || []).filter((p) => p.s === 'accepted').map((p) => p.e);
  if (!seats.length) return null;
  const two = seats.length === 2 && !vertical;
  if (two) {
    return (
      <View style={st.tableTwo}>
        <Seat e={seats[0]} i={0} view={view} me={me} pal={pal} t={t} rm={rm} offset={offset} />
        <View style={[st.vs, { backgroundColor: pal.card, borderColor: pal.line }]}><Text style={{ color: pal.sub, fontWeight: '900', fontSize: 11, letterSpacing: 1 }}>VS</Text></View>
        <Seat e={seats[1]} i={1} view={view} me={me} pal={pal} t={t} rm={rm} offset={offset} />
      </View>
    );
  }
  if (vertical) {
    return <View style={{ gap: 6, marginTop: 6 }}>{seats.map((e, i) => <Seat key={e} e={e} i={i} view={view} me={me} pal={pal} t={t} rm={rm} compact offset={offset} />)}</View>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 4, alignItems: 'flex-start', minWidth: '100%', justifyContent: 'center' }}>
      {seats.map((e, i) => <Seat key={e} e={e} i={i} view={view} me={me} pal={pal} t={t} rm={rm} compact offset={offset} />)}
    </ScrollView>
  );
}

/** Faixa de proposta de empate (Damas/Velha). */
function DrawBanner({ view, me, pal, t, busy, onDraw, rm }) {
  const enter = useEnter(view.draw_offer || 'none', rm, { dy: -10 });
  if (view.status !== 'active' || !view.draw_offer || view.me === null || view.me === undefined) return null;
  const mine = lc(view.draw_offer) === me;
  return (
    <Animated.View style={[st.drawBanner, { backgroundColor: pal.card, borderColor: pal.line }, enter]}>
      <IconDrawOffer size={20} color={pal.ink} />
      <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 14, flex: 1 }} numberOfLines={2}>
        {mine ? tr(t, 'games.draw.waiting', 'Você propôs empate. Aguardando resposta') : tr(t, 'games.draw.offered', '{name} propôs empate', { name: nameOf(view, view.draw_offer, me, t) })}
      </Text>
      {mine ? (
        <PressScale rm={rm} disabled={busy} onPress={() => onDraw('cancel')} style={[st.miniBtn, { borderColor: pal.line, borderWidth: 1 }]} accessibilityRole="button">
          <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13 }}>{tr(t, 'games.draw.withdraw', 'Retirar')}</Text>
        </PressScale>
      ) : (
        <>
          <PressScale rm={rm} disabled={busy} onPress={() => onDraw('decline')} style={[st.miniBtn, { borderColor: pal.line, borderWidth: 1 }]} accessibilityRole="button">
            <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13 }}>{tr(t, 'games.act.decline', 'Recusar')}</Text>
          </PressScale>
          <PressScale rm={rm} disabled={busy} onPress={() => onDraw('accept')} style={[st.miniBtn, { backgroundColor: pal.strong }]} accessibilityRole="button">
            <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 13 }}>{tr(t, 'games.act.accept', 'Aceitar')}</Text>
          </PressScale>
        </>
      )}
    </Animated.View>
  );
}

/** Convite (esperando): avatares, quem falta, ações. */
function WaitingPanel({ view, me, pal, t, busy, rm, onAct, wide }) {
  const acts = gameCardActions(view, me);
  const expired = isInviteExpired(view);
  const hoursLeft = view.exp ? Math.max(0, Math.round((Number(view.exp) - Date.now()) / 3600000)) : null;
  return (
    <View style={[st.panel, { backgroundColor: pal.card, borderColor: pal.line }, wide && st.panelWide]}>
      <View style={[st.heroIcon, { backgroundColor: pal.strong }]}><GameTypeIcon type={view.type} size={30} color={pal.onStrong} /></View>
      <Text style={[st.heroTitle, { color: pal.ink }]}>{gameStatusLine(t, view, me)}</Text>
      {!expired ? <WaitingDots pal={pal} /> : null}
      {hoursLeft !== null && !expired ? <Text style={{ color: pal.sub, fontSize: 12.5, marginTop: 8 }}>{tr(t, 'games.invite.expiresIn', 'O convite vale por mais {n} h', { n: Math.max(1, hoursLeft) })}</Text> : null}
      <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
        {(view.players || []).map((p) => (
          <View key={p.e} style={[st.rankRow, { borderTopColor: pal.line }]}>
            <AvatarCircle email={p.e} name={p.n || p.e} size={32} />
            <Text style={{ color: pal.ink, flex: 1, fontWeight: '600', marginLeft: 10 }} numberOfLines={1}>{nameOf(view, p.e, me, t)}</Text>
            <View style={[st.pstatus, { backgroundColor: p.s === 'accepted' ? pal.strong : pal.card2 }]}>
              <Text style={{ color: p.s === 'accepted' ? pal.onStrong : pal.sub, fontSize: 11.5, fontWeight: '700' }}>{playerStatusLabel(t, p.s)}</Text>
            </View>
          </View>
        ))}
      </View>
      {acts.length ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16, alignSelf: 'stretch' }}>
          {acts.map((a) => {
            const prim = a === 'accept' || a === 'join' || a === 'start';
            return (
              <PressScale key={a} disabled={busy} rm={rm} scaleTo={0.96} onPress={() => onAct(a)} style={[st.btn, prim ? { backgroundColor: pal.strong } : { borderWidth: 1, borderColor: pal.line }]} accessibilityRole="button">
                <Text style={{ color: prim ? pal.onStrong : (a === 'cancel' || a === 'decline' ? pal.bad : pal.ink), fontWeight: '800' }}>{gameActionLabel(t, a, view, me)}</Text>
              </PressScale>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** Convite encerrado sem jogo: cancelado / recusado / expirado. */
function ClosedPanel({ view, me, pal, t, busy, rm, onAct, wide }) {
  const kind = gameEndKind(view, me);
  const wasPlayer = (view.players || []).some((p) => lc(p.e) === me);
  const Icon = kind === 'expired' ? IconHourglass : IconBan;
  const head = kind === 'expired' ? tr(t, 'games.end.expired', 'Convite expirado') : kind === 'declined' ? tr(t, 'games.end.declined', 'Convite recusado') : tr(t, 'games.end.cancelled', 'Convite cancelado');
  return (
    <View style={[st.panel, { backgroundColor: pal.card, borderColor: pal.line }, wide && st.panelWide]}>
      <View style={[st.heroIcon, { backgroundColor: pal.card2 }]}><Icon size={30} color={pal.ink} /></View>
      <Text style={[st.heroTitle, { color: pal.ink }]}>{head}</Text>
      <Text style={{ color: pal.sub, marginTop: 6, textAlign: 'center' }}>{gameStatusLine(t, view, me)}</Text>
      {kind === 'expired' ? <Text style={{ color: pal.sub, marginTop: 4, fontSize: 12.5, textAlign: 'center' }}>{tr(t, 'games.end.expiredSub', 'Ninguém respondeu em 24 horas.')}</Text> : null}
      {wasPlayer ? (
        <PressScale onPress={() => onAct('rematch')} disabled={busy} rm={rm} style={[st.cta, { backgroundColor: pal.strong, opacity: busy ? 0.5 : 1 }]} accessibilityRole="button">
          <IconRematch size={18} color={pal.onStrong} />
          <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{tr(t, 'games.act.inviteAgain', 'Convidar de novo')}</Text>
        </PressScale>
      ) : null}
    </View>
  );
}

/** Fim de partida: vitória / derrota / empate / abandono, com pódio e revanche (consentimento dos dois). */
function ResultPanel({ view, me, pal, t, onAct, onOpenRematch, busy, rm, fresh, wide }) {
  const s = useSharedValue(rm ? 1 : 0.4);
  const glow = useSharedValue(0);
  useEffect(() => {
    if (!rm) {
      s.value = withSpring(1, { damping: 8, stiffness: 150 });
      glow.value = withDelay(200, withRepeat(withSequence(withTiming(1, { duration: 1400 }), withTiming(0.35, { duration: 1400 })), -1, false));
    }
    const seat = view.me !== null && view.me !== undefined;
    if (fresh && seat) { const k = gameEndKind(view, me); if (k === 'won' || k === 'resigned_other') hWin(); else hEnd(); }
    return () => cancelAnimation(glow);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const iconSt = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const glowSt = useAnimatedStyle(() => ({ opacity: glow.value, transform: [{ scale: 1 + glow.value * 0.18 }] }));
  const kind = gameEndKind(view, me);
  const rk = Array.isArray(view.ranking) ? view.ranking : [];
  const showSc = view.type === 'quiz' || view.type === 'forca' || view.type === 'cartas';
  const seat = view.me !== null && view.me !== undefined;
  const scoreTx = (r) => (view.type === 'cartas' ? tr(t, 'games.cartas.nCards', '{n} cartas', { n: r.sc }) : tr(t, 'games.points', '{n} pts', { n: r.sc }));
  const podium = showSc && rk.length >= 2 && !view.draw && !(view.type === 'forca' && view.hanged) && (view.type !== 'cartas' || rk.length >= 3);
  const rest = podium ? rk.slice(3, 8) : rk.slice(0, 6);
  const off = podium ? 3 : 0;
  const HERO = {
    won: [tr(t, 'games.end.won', 'Vitória!'), pal.accent], resigned_other: [tr(t, 'games.end.won', 'Vitória!'), pal.accent],
    lost: [tr(t, 'games.end.lost', 'Não foi desta vez'), pal.card2], draw: [tr(t, 'games.end.draw', 'Empate'), pal.card2],
    abandoned: [tr(t, 'games.end.abandoned', 'Você abandonou'), pal.card2], hanged: [tr(t, 'games.end.hanged', 'A forca venceu'), pal.card2],
    winner: [tr(t, 'games.end.over', 'Fim de partida'), pal.card2], over: [tr(t, 'games.end.over', 'Fim de partida'), pal.card2],
  }[kind] || [tr(t, 'games.end.over', 'Fim de partida'), pal.card2];
  const happy = kind === 'won' || kind === 'resigned_other';
  const heroIcon = happy ? <IconTrophy size={34} color="#111" />
    : kind === 'draw' ? <IconDrawOffer size={34} color={pal.ink} />
    : kind === 'abandoned' ? <IconFlagResign size={32} color={pal.ink} />
    : <IconTrophy size={32} color={pal.ink} />;
  // revanche: pendente minha → aguardando; pendente do outro → aceitar; aceita → abre
  const rs = view.rematch_st;
  const mineReq = rs === 'pending' && lc(view.rematch_by) === me;
  const theirReq = rs === 'pending' && view.rematch_by && lc(view.rematch_by) !== me;
  const other = (view.seats || []).find((e) => lc(e) !== me);
  return (
    <View style={[st.panel, { backgroundColor: pal.card, borderColor: pal.line }, wide && st.panelWide]}>
      <View style={{ width: 92, height: 92, alignItems: 'center', justifyContent: 'center' }}>
        {happy ? <Animated.View style={[st.glow, { backgroundColor: pal.accentSoft }, glowSt]} /> : null}
        <Animated.View style={[st.trophy, { backgroundColor: HERO[1] }, iconSt]}>{heroIcon}</Animated.View>
      </View>
      <Text style={[st.heroBig, { color: pal.ink }]}>{HERO[0]}</Text>
      <Text style={{ color: pal.sub, fontSize: 14.5, fontWeight: '600', textAlign: 'center', marginTop: 4 }}>{resultHeadline(t, view, me)}</Text>
      {view.type === 'forca' && view.state && view.state.word ? <Text style={{ color: pal.sub, marginTop: 4 }}>{tr(t, 'games.forca.wordWas', 'A palavra era {w}', { w: view.state.word })}</Text> : null}
      {podium ? <Podium pal={pal} rows={rk.map((r) => ({ e: r.e, name: nameOf(view, r.e, me, t), score: scoreTx(r) }))} /> : null}
      {rk.length > 1 && rest.length ? (
        <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
          {rest.map((r, k) => {
            const i = k + off;
            const isWin = (view.winners || []).some((w) => lc(w) === lc(r.e));
            const isLeft = Array.isArray(view.left) && view.left.includes(lc(r.e));
            return (
              <View key={r.e} style={[st.rankRow, { borderTopColor: pal.line }]}>
                <Text style={{ color: i === 0 ? pal.ink : pal.sub, fontWeight: '900', width: 22 }}>{i + 1}</Text>
                <AvatarCircle email={r.e} name={r.n || r.e} size={30} />
                <Text style={{ color: pal.ink, flex: 1, fontWeight: isWin ? '800' : '600', marginLeft: 10 }} numberOfLines={1}>{nameOf(view, r.e, me, t)}</Text>
                {isLeft ? <Text style={{ color: pal.sub, fontSize: 12, marginRight: 8 }}>{tr(t, 'games.badge.abandoned', 'Abandonou')}</Text> : null}
                {showSc ? <Text style={{ color: pal.sub, fontWeight: '700' }}>{scoreTx(r)}</Text> : (isWin ? <IconCrown size={16} color={pal.accent} /> : null)}
              </View>
            );
          })}
        </View>
      ) : null}
      {rs === 'active' && view.rematch_id ? (
        <PressScale onPress={() => { hTap(); onOpenRematch(); }} rm={rm} style={[st.cta, { backgroundColor: pal.strong }]} accessibilityRole="button">
          <IconRematch size={18} color={pal.onStrong} />
          <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{tr(t, 'games.act.openRematch', 'Ver revanche')}</Text>
        </PressScale>
      ) : mineReq ? (
        <View style={{ alignItems: 'center', marginTop: 16 }}>
          <View style={[st.cta, { backgroundColor: pal.card2, marginTop: 0 }]}>
            <ActivityIndicator size="small" color={pal.ink} />
            <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 14.5 }}>{tr(t, 'games.rematch.waiting', 'Aguardando {name} aceitar', { name: other ? nameOf(view, other, me, t) : tr(t, 'games.rematch.others', 'os outros') })}</Text>
          </View>
          {view.rematch_id ? (
            <Pressable onPress={() => { hTap(); onOpenRematch(); }} hitSlop={8} style={{ marginTop: 10 }} accessibilityRole="button">
              <Text style={{ color: pal.sub, fontWeight: '700', textDecorationLine: 'underline' }}>{tr(t, 'games.act.openRematch', 'Ver revanche')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : seat || (view.ranking || []).some((r) => lc(r.e) === me) ? (
        <View style={{ alignSelf: 'stretch', marginTop: 16, gap: 8 }}>
          {theirReq ? <Text style={{ color: pal.ink, textAlign: 'center', fontWeight: '700' }}>{tr(t, 'games.rematch.asked', '{name} quer uma revanche', { name: nameOf(view, view.rematch_by, me, t) })}</Text> : null}
          <PressScale onPress={() => onAct('rematch')} disabled={busy} rm={rm} style={[st.cta, { backgroundColor: pal.strong, opacity: busy ? 0.5 : 1, marginTop: 0, alignSelf: 'center' }]} accessibilityRole="button">
            <IconRematch size={18} color={pal.onStrong} />
            <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{gameActionLabel(t, 'rematch', view, me)}</Text>
          </PressScale>
          {rs === 'cancelled' ? <Text style={{ color: pal.sub, textAlign: 'center', fontSize: 12.5 }}>{tr(t, 'games.rematch.declined', 'A revanche não foi aceita')}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const QUICK = [
  ['games.quick.nice', 'Boa jogada!'], ['games.quick.yourTurn', 'Sua vez!'], ['games.quick.close', 'Quase!'],
  ['games.quick.gg', 'Boa partida!'], ['games.quick.rematch', 'Bora uma revanche?'],
];

// [jogos 2026-10-20 dock] docked = dentro do painel da conversa (components/games/GameDock: acima do composer,
// conversa visível e rolável): altura dockH, sem faixa de assentos (o cabeçalho já mostra adversário/vez),
// botão recolher (onCollapse) e frases rápidas mandadas pelo envio da conversa (onSendText).
export default function GamePlay({ gid: gidProp, cid: cidProp, embedded: embeddedProp = false, onClose, onOpenGame, docked = false, dockH = 0, onCollapse, onSendText }) {
  const embedded = embeddedProp || docked;
  const gid = Number(gidProp);
  const params = { cid: cidProp };
  const router = useRouter();
  // embedded: folha fecha e reabre sem trocar de tela → o "fechar" e a revanche passam pelo dono
  const runAfter = embedded ? (fn) => fn() : runAfterNativeSheet;
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const me = lc(user && user.email);
  const ins = useSafeAreaInsets();
  const pal = useMemo(() => gamePalette(colors, isDark), [colors, isDark]);
  const { width: winW0, height: winH } = useWindowDimensions();
  const [boxW, setBoxW] = useState(0);
  // na folha (iPad = formSheet estreito) a largura útil é a da folha, não a da janela
  const winW = embedded ? (boxW || Math.min(winW0, 620)) : winW0;
  const rm = useRM();
  const [view, setView] = useState(() => getGameView(gid));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [chatText, setChatText] = useState('');
  const offRef = useRef(0);
  const toastT = useRef(null);
  const wasMyTurn = useRef(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(null); // {title, body, icon, actions}
  const [sfx, setSfx] = useState(soundOn());
  const [celebrate, setCelebrate] = useState(false);
  const prevStatus = useRef(view ? view.status : null);
  const prevRematch = useRef(view ? view.rematch_st : null);
  // viu a partida em andamento nesta tela → o fim é "ao vivo" (som de vitória/fim só nesse caso)
  const sawActive = useRef(false);
  if (view && view.status === 'active') sawActive.current = true;
  useEffect(() => { loadSoundPref().then(setSfx).catch(() => {}); const off = onSoundPref(setSfx); return () => { off(); releaseSfx(); }; }, []);
  // confete quando EU venço enquanto a tela está aberta
  useEffect(() => {
    const stt = view && view.status;
    if (stt === 'finished' && prevStatus.current === 'active') {
      const k = gameEndKind(view, me);
      if (k === 'won' || k === 'resigned_other') {
        setCelebrate(true);
        const tm = setTimeout(() => setCelebrate(false), 3800);
        prevStatus.current = stt;
        return () => clearTimeout(tm);
      }
    }
    prevStatus.current = stt;
    return undefined;
  }, [view && view.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((m) => {
    setToast(m);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(''), 2400);
  }, []);
  const refresh = useCallback(async () => {
    const r = await gameState(gid);
    if (!r.success && !getGameView(gid)) setLoadErr(gameErrorText(t, r));
  }, [gid, t]);
  const openGame = useCallback((id, cid) => {
    if (onOpenGame) { try { onOpenGame(Number(id), cid || params.cid); } catch {} return; }
    try { router.replace({ pathname: '/game/[id]', params: { id: String(id), cid: String(cid || params.cid || '') } }); } catch {}
  }, [router, params.cid, onOpenGame]);

  useEffect(() => subscribeGame(gid, (v) => setView(v)), [gid]);
  useEffect(() => { setView(getGameView(gid)); refresh(); }, [gid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view && view.now && view._rx) offRef.current = view.now - view._rx; }, [view]);
  useEffect(() => {
    const iv = setInterval(() => { const v = getGameView(gid); if (v && (v.status === 'active' || v.status === 'pending' || (v.rematch_st === 'pending')) && !isMyTurn(v, me)) refresh(); }, 12000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    // reconectou o WS → retoma do estado do servidor (pode ter perdido lances)
    let offWs = null;
    try { offWs = require('../../services/websocket').default.on('connection', (e) => { if (e && (e.status === 'authenticated' || e.status === 'connected')) refresh(); }); } catch {}
    return () => { clearInterval(iv); try { sub.remove(); } catch {} try { offWs && offWs(); } catch {} };
  }, [gid, me, refresh]);
  useEffect(() => {
    const mine = isMyTurn(view, me);
    if (mine && !wasMyTurn.current) hTurn();
    wasMyTurn.current = mine;
  }, [view, me]);
  // a outra pessoa aceitou a revanche que eu pedi → abre a revanche sozinha
  useEffect(() => {
    const rs = view && view.rematch_st;
    if (rs === 'active' && prevRematch.current === 'pending' && view.rematch_id && lc(view.rematch_by) === me) { hOk(); openGame(view.rematch_id, view.conversation_id); }
    prevRematch.current = rs;
  }, [view && view.rematch_st]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = useCallback(async (move) => {
    const v = getGameView(gid);
    if (!v || busy) return false;
    setBusy(true);
    const r = await gameMove(gid, v.v, move);
    setBusy(false);
    if (!r.success) {
      const code = String(r.message || '');
      if (code !== 'nothing_to_do') { hErr(); say(gameErrorText(t, r)); }
      return false;
    }
    return true;
  }, [gid, busy, t, say]);
  const onTick = useCallback(async () => {
    const v = getGameView(gid);
    if (!v || v.status !== 'active') return;
    if (v.me !== null && v.me !== undefined) await gameMove(gid, v.v, { a: 'tick' });
    else await gameState(gid);
  }, [gid]);
  const run = useCallback(async (a) => {
    const v = getGameView(gid);
    if (!v) return;
    setBusy(true);
    let r = null;
    if (a === 'accept') r = await gameAccept(gid);
    else if (a === 'join') r = await gameJoin(gid);
    else if (a === 'decline') r = await gameDecline(gid);
    else if (a === 'start') r = await gameStart(gid);
    else if (a === 'cancel') r = await gameCancel(gid);
    else if (a === 'resign') r = await gameResign(gid);
    else if (a === 'rematch') r = await gameRematch(gid);
    else if (a.startsWith('draw_')) r = await gameDraw(gid, a.slice(5));
    setBusy(false);
    if (r && !r.success) { hErr(); say(gameErrorText(t, r)); return; }
    if (a === 'accept' || a === 'join' || a === 'start' || a === 'draw_offer') hOk();
    if (a === 'draw_offer') say(tr(t, 'games.draw.sent', 'Proposta de empate enviada'));
    if (a === 'rematch' && r && r.data) {
      const nv = r.data.rematch || r.data.game;
      if (nv && nv.g && nv.g !== gid) openGame(nv.g, nv.conversation_id);
    }
  }, [gid, t, say, openGame]);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  // ações com confirmação (folha nativa); o resto vai direto
  const onAct = useCallback((a) => {
    hTap();
    const v = getGameView(gid);
    if (!v) return;
    if (a === 'cancel') {
      setConfirm({
        title: tr(t, 'games.confirm.cancelTitle', 'Cancelar o convite?'), body: tr(t, 'games.confirm.cancelBody', 'O cartão na conversa vai mostrar que a partida foi cancelada.'),
        icon: <IconBan size={26} color={pal.ink} />,
        actions: [{ label: tr(t, 'games.confirm.cancelYes', 'Cancelar convite'), kind: 'destructive', onPress: () => { setConfirm(null); run('cancel'); } },
          { label: tr(t, 'games.confirm.keep', 'Manter'), onPress: () => setConfirm(null) }],
      });
      return;
    }
    if (a === 'decline') {
      setConfirm({
        title: tr(t, 'games.confirm.declineTitle', 'Recusar o convite?'), body: tr(t, 'games.confirm.declineBody', '{name} vai saber que você não vai jogar agora.', { name: nameOf(v, v.by, me, t) }),
        icon: <GameTypeIcon type={v.type} size={26} color={pal.ink} />,
        actions: [{ label: tr(t, 'games.act.decline', 'Recusar'), kind: 'destructive', onPress: () => { setConfirm(null); run('decline'); } },
          { label: tr(t, 'games.act.accept', 'Aceitar'), kind: 'primary', onPress: () => { setConfirm(null); run('accept'); } }],
      });
      return;
    }
    run(a);
  }, [gid, t, pal, me, run]);
  const confirmLeave = useCallback(() => {
    hTap();
    const v = getGameView(gid);
    if (!v) return;
    const multi = v.type === 'quiz' || ((v.seats || []).length > 2);
    setConfirm({
      title: multi ? tr(t, 'games.leaveTitle', 'Sair da partida?') : tr(t, 'games.resignTitle', 'Desistir da partida?'),
      body: multi ? tr(t, 'games.leaveBody', 'Os outros continuam jogando.') : tr(t, 'games.resignBody', 'A vitória vai para o outro jogador e o cartão mostra que você abandonou.'),
      icon: <IconFlagResign size={26} color={pal.bad} />,
      actions: [{ label: multi ? tr(t, 'games.leave', 'Sair') : tr(t, 'games.resign', 'Desistir'), kind: 'destructive', onPress: () => { setConfirm(null); run('resign'); } },
        { label: tr(t, 'games.confirm.keepPlaying', 'Continuar jogando'), onPress: () => setConfirm(null) }],
    });
  }, [gid, t, pal, run]);
  const confirmDraw = useCallback(() => {
    hTap();
    setConfirm({
      title: tr(t, 'games.draw.offerTitle', 'Propor empate?'), body: tr(t, 'games.draw.offerBody', 'Se aceitar, a partida termina empatada. Você pode retirar a proposta.'),
      icon: <IconDrawOffer size={26} color={pal.ink} />,
      actions: [{ label: tr(t, 'games.draw.offer', 'Propor empate'), kind: 'primary', onPress: () => { setConfirm(null); run('draw_offer'); } },
        { label: tr(t, 'common.cancel', 'Cancelar'), onPress: () => setConfirm(null) }],
    });
  }, [t, pal, run]);
  const sendQuick = useCallback(async (text) => {
    const cid = Number((view && view.conversation_id) || params.cid);
    const msg = String(text || '').trim();
    if (!cid || !msg) return;
    if (onSendText) { try { if (onSendText(msg) !== false) { hTap(); return; } } catch {} }
    try {
      const api = require('../../services/api');
      const r = await api.chatSend(cid, msg, 'text');
      if (r && r.success) hTap(); else hErr();
      // docked: a conversa está visível logo acima — a mensagem aparece nela (sem aviso)
      if (!(docked && r && r.success)) say(r && r.success ? tr(t, 'games.quick.sent', 'Mensagem enviada') : tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.'));
    } catch { say(tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.')); }
  }, [view, params.cid, t, say, onSendText, docked]);

  const back = () => { hTap(); if (onClose) { try { onClose(); } catch {} return; } try { if (router.canGoBack()) { router.back(); return; } } catch {} router.replace('/chat'); };
  const isPlayer = !!view && view.me !== null && view.me !== undefined;
  const playing = !!view && view.status === 'active' && isPlayer;
  const canDraw = playing && view.can_offer_draw && gameFeature('draw') && !view.draw_offer;
  const status = view ? gameStatusLine(t, view, me) : '';
  const myTurn = isMyTurn(view, me);
  // folha: cabeçalho fino = avatar do adversário + nome + vez + regras/mais + fechar
  const opp = view ? ((view.seats && view.seats.length ? view.seats : (view.players || []).map((p) => p.e)).find((e) => lc(e) !== me) || view.by) : null;
  const acc = view ? gameAccent(view.type) : pal.ink;
  const header = docked ? (
    // [2026-10-20 dock-imersivo] UMA linha: avatar pequeno · vez (ponto pulsando) · ícones soltos
    <View style={[st.dHeader, { borderBottomColor: pal.line, backgroundColor: pal.bg }]}>
      {opp ? <AvatarCircle email={opp} name={nameOf(view, opp, '', t)} size={22} /> : (view ? <GameTypeIcon type={view.type} size={18} color={pal.ink} /> : null)}
      {myTurn ? <PulseDot color={pal.ink} on rm={rm} /> : null}
      <Text style={{ flex: 1, color: myTurn ? pal.ink : pal.sub, fontSize: 13.5, fontWeight: myTurn ? '800' : '600' }} numberOfLines={1}>
        {view ? (view.spectator && view.status === 'active' ? `${status} · ${tr(t, 'games.watching', 'assistindo')}` : status) : tr(t, 'games.menu', 'Jogos')}
      </Text>
      {view ? (
        <Pressable onPress={() => { hTap(); setRulesOpen(true); }} hitSlop={8} style={st.dBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.rules.button', 'Regras')}>
          <RulesIcon color={pal.sub} size={18} />
        </Pressable>
      ) : null}
      <Pressable onPress={() => { hTap(); setMoreOpen(true); }} hitSlop={8} style={st.dBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.more', 'Mais opções')}>
        <IconMore size={18} color={pal.sub} />
      </Pressable>
      {onCollapse ? (
        <Pressable onPress={() => { hTap(); onCollapse(); }} hitSlop={8} style={st.dBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.dock.collapse', 'Recolher')}>
          <IconChevronDown size={19} color={pal.sub} />
        </Pressable>
      ) : null}
      <Pressable onPress={back} hitSlop={8} style={st.dBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
        <IconX size={15} color={pal.sub} />
      </Pressable>
    </View>
  ) : embedded ? (
    // [2026-10-20 polish] cabeçalho limpo: avatar com anel na cor do jogo quando é a minha vez, nome do jogo,
    // vez com ponto pulsando, ações discretas (regras/mais/recolher/fechar em círculos pequenos)
    <View style={[st.sHeader, { borderBottomColor: pal.line, backgroundColor: pal.bg }]}>
      <View style={[st.sAv, { borderColor: myTurn ? acc : 'transparent' }]}>
        {opp ? <AvatarCircle email={opp} name={nameOf(view, opp, '', t)} size={34} /> : (
          <View style={[st.sAvIcon, { backgroundColor: pal.strong }]}>{view ? <GameTypeIcon type={view.type} size={18} color={pal.onStrong} /> : null}</View>
        )}
        {view ? <View style={[st.sAvBadge, { backgroundColor: acc, borderColor: pal.bg }]}><GameTypeIcon type={view.type} size={9} color="#FFFFFF" /></View> : null}
      </View>
      <View style={{ flex: 1, paddingHorizontal: 10 }}>
        <Text style={[st.sTitle, { color: pal.ink }]} numberOfLines={1}>
          {view ? (opp && (view.seats || []).length <= 2 ? `${gameTitle(t, view.type)} · ${nameOf(view, opp, me, t)}` : gameTitle(t, view.type)) : tr(t, 'games.menu', 'Jogos')}
        </Text>
        {view ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            {myTurn ? <PulseDot color={acc} on rm={rm} /> : null}
            <Text style={[st.hSub, { color: myTurn ? pal.ink : pal.sub, fontWeight: myTurn ? '800' : '600' }]} numberOfLines={1}>
              {view.spectator && view.status === 'active' ? `${status} · ${tr(t, 'games.watching', 'assistindo')}` : status}
            </Text>
          </View>
        ) : null}
      </View>
      {view ? (
        <Pressable onPress={() => { hTap(); setRulesOpen(true); }} hitSlop={6} style={[st.sBtn, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.rules.button', 'Regras')}>
          <RulesIcon color={pal.ink} size={16} />
        </Pressable>
      ) : null}
      <Pressable onPress={() => { hTap(); setMoreOpen(true); }} hitSlop={6} style={[st.sBtn, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.more', 'Mais opções')}>
        <IconMore size={18} color={pal.ink} />
      </Pressable>
      {onCollapse ? (
        <Pressable onPress={() => { hTap(); onCollapse(); }} hitSlop={6} style={[st.sBtn, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.dock.collapse', 'Recolher')}>
          <IconChevronDown size={18} color={pal.ink} />
        </Pressable>
      ) : null}
      <Pressable onPress={back} hitSlop={6} style={[st.sBtn, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
        <IconX size={14} color={pal.ink} />
      </Pressable>
    </View>
  ) : (
    <View style={[st.header, { paddingTop: ins.top + 4, borderBottomColor: pal.line, backgroundColor: pal.bg }]}>
      <Pressable onPress={back} hitSlop={12} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
        <IconChevronLeft size={28} color={pal.ink} />
      </Pressable>
      <View style={st.hCenter}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {view ? <GameTypeIcon type={view.type} size={15} color={pal.ink} /> : null}
          <Text style={[st.hTitle, { color: pal.ink }]} numberOfLines={1}>{view ? gameTitle(t, view.type) : tr(t, 'games.menu', 'Jogos')}</Text>
        </View>
        {view ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
            {myTurn ? <View style={[st.turnDot, { backgroundColor: pal.accent }]} /> : null}
            <Text style={[st.hSub, { color: myTurn ? pal.ink : pal.sub, fontWeight: myTurn ? '800' : '600' }]} numberOfLines={1}>
              {view.spectator && view.status === 'active' ? `${status} · ${tr(t, 'games.watching', 'assistindo')}` : status}
            </Text>
          </View>
        ) : null}
      </View>
      {view ? (
        <Pressable onPress={() => { hTap(); setRulesOpen(true); }} hitSlop={8} style={st.iconBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.rules.button', 'Regras')}>
          <RulesIcon color={pal.ink} />
        </Pressable>
      ) : null}
      <Pressable onPress={() => { hTap(); setMoreOpen(true); }} hitSlop={8} style={st.iconBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.more', 'Mais opções')}>
        <IconMore size={22} color={pal.ink} />
      </Pressable>
    </View>
  );
  const moreSheet = (
    <GameSheet visible={moreOpen} onClose={() => setMoreOpen(false)} bg={pal.bg} webMaxW={460}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
        <Text style={[st.sheetTitle, { color: pal.ink }]}>{view ? gameTitle(t, view.type) : tr(t, 'games.menu', 'Jogos')}</Text>
        <Pressable onPress={() => { hTap(); setSoundOn(!sfx); }} style={[st.menuRow, { borderBottomColor: pal.line }]} accessibilityRole="switch" accessibilityState={{ checked: sfx }}>
          <SoundIcon on={sfx} color={pal.ink} />
          <Text style={[st.menuTx, { color: pal.ink }]}>{tr(t, 'games.sound', 'Som')}</Text>
          <Text style={{ color: pal.sub, fontWeight: '700' }}>{sfx ? tr(t, 'games.on', 'Ligado') : tr(t, 'games.off', 'Desligado')}</Text>
        </Pressable>
        <Pressable onPress={() => { hTap(); setMoreOpen(false); runAfter(() => setRulesOpen(true)); }} style={[st.menuRow, { borderBottomColor: pal.line }]} accessibilityRole="button">
          <RulesIcon color={pal.ink} />
          <Text style={[st.menuTx, { color: pal.ink }]}>{tr(t, 'games.rules.button', 'Regras')}</Text>
        </Pressable>
        {canDraw ? (
          <Pressable onPress={() => { setMoreOpen(false); runAfter(confirmDraw); }} style={[st.menuRow, { borderBottomColor: pal.line }]} accessibilityRole="button">
            <IconDrawOffer size={20} color={pal.ink} />
            <Text style={[st.menuTx, { color: pal.ink }]}>{tr(t, 'games.draw.offer', 'Propor empate')}</Text>
          </Pressable>
        ) : null}
        {playing ? (
          <Pressable onPress={() => { setMoreOpen(false); runAfter(confirmLeave); }} style={[st.menuRow, { borderBottomColor: 'transparent' }]} accessibilityRole="button">
            <IconFlagResign size={20} color={pal.bad} />
            <Text style={[st.menuTx, { color: pal.bad }]}>{(view.type === 'quiz' || (view.seats || []).length > 2) ? tr(t, 'games.leave', 'Sair da partida') : tr(t, 'games.resign', 'Desistir')}</Text>
          </Pressable>
        ) : null}
      </View>
    </GameSheet>
  );

  // fase (para a transição suave entre esperando → jogando → fim)
  const phase = !view ? 'loading' : view.status === 'pending' ? (isInviteExpired(view) ? 'closed' : 'waiting') : view.status === 'cancelled' ? 'closed' : view.status;
  const enterSt = useEnter(phase, rm, { dy: 18, duration: 320 });

  if (!view) {
    return (
      <GameSheetInlineProvider on={embedded}>
      <View style={[st.fill, { backgroundColor: pal.bg }]}>
        {embedded ? null : <Stack.Screen options={{ headerShown: false }} />}
        {header}
        <View style={st.center}>{loadErr ? <Text style={{ color: pal.sub }}>{loadErr}</Text> : <ActivityIndicator color={pal.ink} />}</View>
        {moreSheet}
      </View>
      </GameSheetInlineProvider>
    );
  }

  // largo (tablet/web): tabuleiro no centro + painel lateral com jogadores e a conversa
  const wide = !embedded && winW >= 900;
  const colW = wide ? Math.min(winW - SIDE_W - 32, 820) : winW;
  const fitH = docked && dockH > 0 ? Math.max(170, dockH - 40 - 36 - 12) : Math.max(300, winH - ins.top - ins.bottom - 230);
  let board = null;
  if (view.status === 'active' || view.status === 'finished') {
    const sq = view.type === 'damas' || view.type === 'velha';
    const P = { view, onMove, pal, busy, t, me, offset: offRef.current, onTick, maxW: wide ? (sq ? Math.min(colW, fitH) : colW) : (docked ? (sq ? Math.min(winW - 8, fitH) : winW) : (sq ? Math.min(winW, fitH + 40) : (embedded ? winW : undefined))) };
    if (view.type === 'velha') board = <VelhaBoard {...P} />;
    else if (view.type === 'damas') board = <DamasBoard {...P} />;
    else if (view.type === 'cartas') board = <CartasBoard {...P} />;
    else if (view.type === 'quiz') board = view.status === 'active' ? <QuizBoard {...P} /> : null;
    else if (view.type === 'forca') board = <ForcaBoard {...P} />;
    else if (view.type === 'termo') board = <TermoBoard {...P} />; // [jogos2b]
    else if (view.type === 'ppt') board = <PptBoard {...P} />;
    else if (view.type === 'stop') board = <StopBoard {...P} />;
    else if (view.type === 'desenho') board = <DesenhoBoard {...P} />;
  }
  const sendTyped = () => { const x = chatText; setChatText(''); sendQuick(x); };
  // Cartas: os adversários já sentam em volta da mesa dentro do tabuleiro (avatares + leque) → sem faixa duplicada
  const showTable = !docked && ((view.status === 'active' && view.type !== 'cartas') || view.status === 'finished');

  const content = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingBottom: 12, width: '100%', maxWidth: wide ? colW : 680, alignSelf: 'center', justifyContent: wide || phase !== 'active' ? 'center' : undefined }} keyboardShouldPersistTaps="handled">
      <Animated.View style={[{ flexGrow: 1, justifyContent: phase !== 'active' ? 'center' : undefined }, enterSt]}>
        {phase === 'waiting' ? <WaitingPanel view={view} me={me} pal={pal} t={t} busy={busy} rm={rm} onAct={onAct} wide={wide} /> : null}
        {phase === 'closed' ? <ClosedPanel view={view} me={me} pal={pal} t={t} busy={busy} rm={rm} onAct={onAct} wide={wide} /> : null}
        {phase === 'active' ? <DrawBanner view={view} me={me} pal={pal} t={t} busy={busy} rm={rm} onDraw={(op) => { hTap(); run('draw_' + op); }} /> : null}
        {board}
        {phase === 'finished' ? (
          <ResultPanel view={view} me={me} pal={pal} t={t} busy={busy} rm={rm} fresh={sawActive.current} onAct={onAct} wide={wide}
            onOpenRematch={() => openGame(view.rematch_id, view.conversation_id)} />
        ) : null}
      </Animated.View>
    </ScrollView>
  );
  const quickChips = QUICK.map(([k, fb]) => (
    <PressScale key={k} rm={rm} scaleTo={0.95} onPress={() => { hTap(); sendQuick(tr(t, k, fb)); }} style={[docked ? st.dQuick : st.quick, { borderColor: pal.line }]} accessibilityRole="button">
      <Text style={{ color: docked ? pal.sub : pal.ink, fontSize: docked ? 12.5 : 13, fontWeight: '600' }}>{tr(t, k, fb)}</Text>
    </PressScale>
  ));
  const inputRow = (
    <View style={[st.inputRow, { backgroundColor: pal.card }]}>
      <TextInput value={chatText} onChangeText={setChatText} placeholder={tr(t, 'games.quick.placeholder', 'Mensagem para a conversa')} placeholderTextColor={pal.sub}
        style={{ flex: 1, color: pal.ink, fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 9 : 5 }} returnKeyType="send" onSubmitEditing={sendTyped} />
      <PressScale onPress={() => { hTap(); sendTyped(); }} disabled={!chatText.trim()} rm={rm} style={[st.sendBtn, { backgroundColor: chatText.trim() ? pal.strong : pal.card2 }]}
        accessibilityRole="button" accessibilityLabel={tr(t, 'games.quick.send', 'Enviar')}>
        <Text style={{ color: chatText.trim() ? pal.onStrong : pal.sub, fontWeight: '800', fontSize: 13 }}>{tr(t, 'games.quick.send', 'Enviar')}</Text>
      </PressScale>
    </View>
  );
  const overlays = (
    <>
      {celebrate && !rm ? <Confetti dark={isDark} /> : null}
      <RulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} type={view.type} t={t} pal={pal} />
      {moreSheet}
      <ConfirmSheet visible={!!confirm} onClose={closeConfirm} pal={pal} title={confirm && confirm.title} body={confirm && confirm.body} icon={confirm && confirm.icon} actions={confirm && confirm.actions} />
      {toast ? <View pointerEvents="none" style={[st.toast, { backgroundColor: pal.strong, bottom: embedded ? 70 : ins.bottom + 96 }]}><Text style={{ color: pal.onStrong, fontWeight: '700' }}>{toast}</Text></View> : null}
    </>
  );

  if (wide) {
    return (
      <KeyboardAvoidingView style={[st.fill, { backgroundColor: pal.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {embedded ? null : <Stack.Screen options={{ headerShown: false }} />}
        {header}
        <View style={st.wideRow}>
          <View style={st.wideMain}>{content}</View>
          <View style={[st.side, { width: SIDE_W, borderLeftColor: pal.line, paddingBottom: Math.max(ins.bottom, 12), paddingRight: ins.right }]}>
            <Text style={[st.sideTitle, { color: pal.sub }]}>{tr(t, 'games.side.players', 'JOGADORES')}</Text>
            <ScrollView style={{ flexGrow: 0, maxHeight: '45%' }} contentContainerStyle={{ paddingHorizontal: 14 }}>
              {showTable ? <Table view={view} me={me} pal={pal} t={t} rm={rm} vertical offset={offRef.current} /> : null}
            </ScrollView>
            <View style={{ flex: 1 }} />
            <Text style={[st.sideTitle, { color: pal.sub }]}>{tr(t, 'games.side.chat', 'CONVERSA')}</Text>
            <View style={st.quickWrap}>{quickChips}</View>
            <View style={{ marginTop: 8 }}>{inputRow}</View>
          </View>
        </View>
        {overlays}
      </KeyboardAvoidingView>
    );
  }

  if (embedded) {
    // folha por cima da conversa: sem campo de texto (a conversa está logo embaixo) — só as frases rápidas
    const Root = IS_WEB || docked ? View : NativeSheetKeyboardView;
    return (
      <GameSheetInlineProvider on>
        <Root style={[st.fill, { backgroundColor: pal.bg }]}>
          {header}
          {showTable ? <View style={{ paddingTop: 8 }}><Table view={view} me={me} pal={pal} t={t} rm={rm} offset={offRef.current} /></View> : null}
          <View style={{ flex: 1 }} onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w > 0 && Math.abs(w - boxW) > 1) setBoxW(w); }}>{content}</View>
          <View style={[docked ? st.dChips : st.chatStrip, { borderTopColor: pal.line, paddingBottom: docked ? 5 : (Platform.OS === 'ios' ? 10 : Math.max(ins.bottom, 8) + 4), backgroundColor: pal.bg }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} keyboardShouldPersistTaps="handled">
              {quickChips}
            </ScrollView>
          </View>
          {overlays}
        </Root>
      </GameSheetInlineProvider>
    );
  }

  return (
    <KeyboardAvoidingView style={[st.fill, { backgroundColor: pal.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {embedded ? null : <Stack.Screen options={{ headerShown: false }} />}
      {header}
      {showTable ? <View style={{ paddingTop: 8, paddingLeft: ins.left, paddingRight: ins.right }}><Table view={view} me={me} pal={pal} t={t} rm={rm} offset={offRef.current} /></View> : null}
      <View style={{ flex: 1, paddingLeft: ins.left, paddingRight: ins.right }}>{content}</View>
      {overlays}
      <View style={[st.chatStrip, { borderTopColor: pal.line, paddingBottom: Math.max(ins.bottom, 8), backgroundColor: pal.bg }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} keyboardShouldPersistTaps="handled">
          {quickChips}
        </ScrollView>
        {inputRow}
      </View>
    </KeyboardAvoidingView>
  );
}

const SIDE_W = 320;
const st = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { paddingHorizontal: 2, paddingVertical: 2 },
  hCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  hTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  hSub: { fontSize: 12.5 },
  turnDot: { width: 7, height: 7, borderRadius: 4 },
  iconBtn: { padding: 7 },
  tableTwo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 16 },
  vs: { width: 30, height: 30, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  seat: { alignItems: 'center', width: 92 },
  seatName: { fontSize: 13, marginTop: 4, maxWidth: 92 },
  seatBadge: { height: 18, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  pieceDot: { width: 13, height: 13, borderRadius: 7, borderWidth: 1.5 },
  crownTag: { position: 'absolute', top: -2, right: 0, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  drawBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 6, marginBottom: 4, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10 },
  miniBtn: { borderRadius: 11, paddingHorizontal: 12, paddingVertical: 7 },
  wideRow: { flex: 1, flexDirection: 'row' },
  wideMain: { flex: 1, paddingHorizontal: 16 },
  side: { borderLeftWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  sideTitle: { fontSize: 11.5, fontWeight: '800', letterSpacing: 0.6, paddingHorizontal: 14, marginTop: 8 },
  quickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, marginTop: 8 },
  panel: { margin: 16, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 20, alignItems: 'center' },
  panelWide: { maxWidth: 540, alignSelf: 'center', width: '100%' },
  heroIcon: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 18, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  heroBig: { fontSize: 26, fontWeight: '900', marginTop: 4, textAlign: 'center', letterSpacing: -0.4 },
  glow: { position: 'absolute', width: 92, height: 92, borderRadius: 46 },
  trophy: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  pstatus: { borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12, marginTop: 16 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  toast: { position: 'absolute', alignSelf: 'center', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 9 },
  chatStrip: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 8 },
  quick: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, borderRadius: 18, paddingLeft: 14, paddingRight: 4, paddingVertical: 3 },
  sendBtn: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
  sheetTitle: { fontSize: 18, fontWeight: '800', marginBottom: 6 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth },
  menuTx: { flex: 1, fontSize: 16, fontWeight: '600' },
  sHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: 10, paddingTop: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  sAv: { borderWidth: 2, borderRadius: 22, padding: 1.5 },
  sAvIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  sAvBadge: { position: 'absolute', right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, height: 40, borderBottomWidth: StyleSheet.hairlineWidth },
  dBtn: { paddingHorizontal: 7, paddingVertical: 6 },
  dChips: { paddingTop: 5, paddingBottom: 5 },
  dQuick: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 10, paddingVertical: 4 },
  sBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
});
