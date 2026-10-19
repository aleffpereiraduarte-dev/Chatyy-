// app/game/[id].js — [jogos 2026-10-18] Tela do jogo (Damas, Velha, Cartas Coloridas, Quiz, Forca).
// Visual P&B premium; o SERVIDOR valida tudo (o app manda a intenção e redesenha com a visão que volta).
// Tempo real pelo evento WS game_update (services/games.js) + atualização de segurança a cada 12 s.
// Faixa de mensagens rápidas manda texto normal para a conversa.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, StyleSheet, AppState, Platform, KeyboardAvoidingView } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming, withSpring } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { IconChevronLeft } from '../../components/Icons';
import { GameTypeIcon, IconTrophy, IconRematch, IconFlagResign } from '../../components/games/GameIcons';
import { gamePalette, hWin, hErr, hTurn } from '../../components/games/fx';
import Confetti from '../../components/games/Confetti';
import RulesSheet from '../../components/games/RulesSheet';
import { loadSoundPref, soundOn, setSoundOn, onSoundPref, releaseSfx } from '../../components/games/sound';
import Svg, { Path } from 'react-native-svg';
import VelhaBoard from '../../components/games/boards/VelhaBoard';
import DamasBoard from '../../components/games/boards/DamasBoard';
import CartasBoard from '../../components/games/boards/CartasBoard';
import QuizBoard from '../../components/games/boards/QuizBoard';
import ForcaBoard from '../../components/games/boards/ForcaBoard';
import {
  getGameView, subscribeGame, gameState, gameMove, gameResign, gameRematch, gameAccept, gameDecline, gameStart, gameJoin,
  gameTitle, gameStatusLine, resultHeadline, gameErrorText, gameCardActions, gameActionLabel, nameOf, playerStatusLabel, isMyTurn, tr,
} from '../../services/games';

function TurnPill({ on, label, pal }) {
  const s = useSharedValue(1);
  useEffect(() => {
    if (on) s.value = withRepeat(withSequence(withTiming(1.06, { duration: 520 }), withTiming(1, { duration: 520 })), -1, false);
    else s.value = withTiming(1, { duration: 150 });
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[styles.pill, { backgroundColor: on ? pal.strong : pal.card, borderColor: on ? pal.strong : pal.line }, st]}>
      <Text style={{ color: on ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 13 }} numberOfLines={1}>{label}</Text>
    </Animated.View>
  );
}

function PlayersBar({ view, me, pal, t }) {
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  if (!seats.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }} style={{ flexGrow: 0, marginTop: 8 }}>
      {seats.map((e, i) => {
        const turn = view.status === 'active' && view.turn && String(view.turn).toLowerCase() === String(e).toLowerCase();
        const won = (view.winners || []).some((w) => String(w).toLowerCase() === String(e).toLowerCase());
        const out = Array.isArray(S.out) && S.out[i];
        let badge = null;
        if (view.type === 'damas') badge = <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: i === 0 ? '#FAFAFA' : '#111', borderWidth: 1.5, borderColor: '#9A9A9E' }} />;
        if (view.type === 'velha') badge = <Text style={{ color: pal.ink, fontWeight: '900', fontSize: 12 }}>{i === 0 ? 'X' : 'O'}</Text>;
        if (view.type === 'cartas') badge = <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 11.5 }}>{(S.counts || [])[i] ?? ''}</Text>;
        if (view.type === 'quiz' || view.type === 'forca') badge = <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 12 }}>{(S.sc || [])[i] || 0}</Text>;
        return (
          <View key={e} style={[styles.chip, { borderColor: turn || won ? pal.strong : pal.line, backgroundColor: turn ? pal.hl : 'transparent', opacity: out ? 0.45 : 1 }]}>
            {won ? <IconTrophy size={13} color={pal.ink} /> : null}
            <Text style={{ color: pal.ink, fontWeight: i === view.me ? '800' : '600', fontSize: 13, maxWidth: 110 }} numberOfLines={1}>{nameOf(view, e, me, t)}</Text>
            {badge}
          </View>
        );
      })}
    </ScrollView>
  );
}

function SoundIcon({ on, color }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      {on ? <Path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <Path d="M16 9.5l5 5M21 9.5l-5 5" />}
    </Svg>
  );
}
function RulesIcon({ color }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z" /><Path d="M5 16.5a3 3 0 0 1 3-3h10.5" /><Path d="M9 8.5h6" />
    </Svg>
  );
}
function Dot({ a, k, pal }) {
  const st = useAnimatedStyle(() => ({ opacity: 0.25 + 0.75 * Math.max(0, Math.sin(Math.PI * ((a.value + k / 3) % 1))) }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: pal.ink }, st]} />;
}
function WaitingDots({ pal }) {
  const a = useSharedValue(0);
  useEffect(() => { a.value = withRepeat(withTiming(1, { duration: 1100 }), -1, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>{[0, 1, 2].map((k) => <Dot key={k} a={a} k={k} pal={pal} />)}</View>;
}

function ResultPanel({ view, me, pal, t, onRematch, onOpenRematch, busy }) {
  const s = useSharedValue(0.6);
  useEffect(() => { s.value = withSpring(1, { damping: 9, stiffness: 160 }); if ((view.winners || []).some((w) => String(w).toLowerCase() === me)) hWin(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const rk = Array.isArray(view.ranking) ? view.ranking : [];
  const showSc = view.type === 'quiz' || view.type === 'forca' || view.type === 'cartas';
  const seat = view.me !== null && view.me !== undefined;
  return (
    <View style={[styles.result, { backgroundColor: pal.card, borderColor: pal.line }]}>
      <Animated.View style={[styles.trophy, { backgroundColor: pal.strong }, st]}><IconTrophy size={30} color={pal.onStrong} /></Animated.View>
      <Text style={{ color: pal.ink, fontSize: 18, fontWeight: '900', textAlign: 'center', marginTop: 10 }}>{resultHeadline(t, view, me)}</Text>
      {view.type === 'forca' && view.state && view.state.word ? <Text style={{ color: pal.sub, marginTop: 4 }}>{tr(t, 'games.forca.wordWas', 'A palavra era {w}', { w: view.state.word })}</Text> : null}
      {rk.length > 1 ? (
        <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
          {rk.slice(0, 6).map((r, i) => (
            <View key={r.e} style={[styles.rankRow, { borderTopColor: pal.line }]}>
              <Text style={{ color: i === 0 ? pal.ink : pal.sub, fontWeight: '900', width: 22 }}>{i + 1}</Text>
              <Text style={{ color: pal.ink, flex: 1, fontWeight: i === 0 ? '800' : '600' }} numberOfLines={1}>{nameOf(view, r.e, me, t)}</Text>
              {showSc ? <Text style={{ color: pal.sub, fontWeight: '700' }}>{view.type === 'cartas' ? tr(t, 'games.cartas.nCards', '{n} cartas', { n: r.sc }) : tr(t, 'games.points', '{n} pts', { n: r.sc })}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {view.rematch_id ? (
        <Pressable onPress={onOpenRematch} style={[styles.cta, { backgroundColor: pal.strong }]} accessibilityRole="button">
          <IconRematch size={18} color={pal.onStrong} />
          <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{tr(t, 'games.act.openRematch', 'Ver revanche')}</Text>
        </Pressable>
      ) : seat ? (
        <Pressable onPress={onRematch} disabled={busy} style={[styles.cta, { backgroundColor: pal.strong, opacity: busy ? 0.5 : 1 }]} accessibilityRole="button">
          <IconRematch size={18} color={pal.onStrong} />
          <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{gameActionLabel(t, 'rematch')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const QUICK = [
  ['games.quick.nice', 'Boa jogada!'], ['games.quick.yourTurn', 'Sua vez!'], ['games.quick.close', 'Quase!'],
  ['games.quick.gg', 'Boa partida!'], ['games.quick.rematch', 'Bora uma revanche?'],
];

export default function GameScreen() {
  const params = useLocalSearchParams();
  const gid = Number(params.id);
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const me = String((user && user.email) || '').toLowerCase();
  const ins = useSafeAreaInsets();
  const pal = useMemo(() => gamePalette(colors, isDark), [colors, isDark]);
  const [view, setView] = useState(() => getGameView(gid));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [chatText, setChatText] = useState('');
  const offRef = useRef(0);
  const toastT = useRef(null);
  const wasMyTurn = useRef(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [sfx, setSfx] = useState(soundOn());
  const [celebrate, setCelebrate] = useState(false);
  const prevStatus = useRef(view ? view.status : null);
  useEffect(() => { loadSoundPref().then(setSfx).catch(() => {}); const off = onSoundPref(setSfx); return () => { off(); releaseSfx(); }; }, []);
  // confete quando a partida termina COM vencedor enquanto a tela está aberta
  useEffect(() => {
    const st = view && view.status;
    if (st === 'finished' && prevStatus.current === 'active' && (view.winners || []).length && !view.draw) {
      setCelebrate(true);
      const tm = setTimeout(() => setCelebrate(false), 3800);
      prevStatus.current = st;
      return () => clearTimeout(tm);
    }
    prevStatus.current = st;
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

  useEffect(() => subscribeGame(gid, (v) => setView(v)), [gid]);
  useEffect(() => { setView(getGameView(gid)); refresh(); }, [gid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view && view.now && view._rx) offRef.current = view.now - view._rx; }, [view]);
  useEffect(() => {
    const iv = setInterval(() => { const v = getGameView(gid); if (v && (v.status === 'active' || v.status === 'pending') && !isMyTurn(v, me)) refresh(); }, 12000);
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
  const act = useCallback(async (a) => {
    const v = getGameView(gid);
    if (!v) return;
    setBusy(true);
    let r = null;
    if (a === 'accept') r = await gameAccept(gid);
    else if (a === 'join') r = await gameJoin(gid);
    else if (a === 'decline') r = await gameDecline(gid);
    else if (a === 'start') r = await gameStart(gid);
    else if (a === 'cancel' || a === 'resign') r = await gameResign(gid);
    else if (a === 'rematch') r = await gameRematch(gid);
    setBusy(false);
    if (r && !r.success) { hErr(); say(gameErrorText(t, r)); return; }
    if (a === 'rematch' && r && r.data) {
      const nv = r.data.rematch || r.data.game;
      if (nv && nv.g && nv.g !== gid) router.replace({ pathname: '/game/[id]', params: { id: String(nv.g), cid: String(nv.conversation_id || params.cid || '') } });
    }
  }, [gid, t, say, router, params.cid]);
  const confirmResign = useCallback(() => {
    const v = getGameView(gid);
    const multi = v && (v.type === 'quiz' || v.type === 'forca' || (v.seats || []).length > 2);
    const title = multi ? tr(t, 'games.leaveTitle', 'Sair da partida?') : tr(t, 'games.resignTitle', 'Desistir da partida?');
    const body = multi ? tr(t, 'games.leaveBody', 'Os outros continuam jogando.') : tr(t, 'games.resignBody', 'A vitória vai para o outro jogador.');
    try {
      require('../../services/alerts').safeAlert(title, body, [
        { text: tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
        { text: multi ? tr(t, 'games.leave', 'Sair') : tr(t, 'games.resign', 'Desistir'), style: 'destructive', onPress: () => act('resign') },
      ]);
    } catch { act('resign'); }
  }, [gid, t, act]);
  const sendQuick = useCallback(async (text) => {
    const cid = Number((view && view.conversation_id) || params.cid);
    const msg = String(text || '').trim();
    if (!cid || !msg) return;
    try {
      const api = require('../../services/api');
      const r = await api.chatSend(cid, msg, 'text');
      say(r && r.success ? tr(t, 'games.quick.sent', 'Mensagem enviada') : tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.'));
    } catch { say(tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.')); }
  }, [view, params.cid, t, say]);

  const back = () => { try { if (router.canGoBack()) { router.back(); return; } } catch {} router.replace('/chat'); };
  const header = (
    <View style={[styles.header, { paddingTop: ins.top + 6 }]}>
      <Pressable onPress={back} hitSlop={12} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
        <IconChevronLeft size={26} color={pal.ink} />
      </Pressable>
      {view ? <GameTypeIcon type={view.type} size={20} color={pal.ink} /> : null}
      <Text style={{ color: pal.ink, fontSize: 18, fontWeight: '800', flex: 1 }} numberOfLines={1}>{view ? gameTitle(t, view.type) : tr(t, 'games.menu', 'Jogos')}</Text>
      <Pressable onPress={() => setSoundOn(!sfx)} hitSlop={8} style={styles.iconBtn} accessibilityRole="switch" accessibilityState={{ checked: sfx }} accessibilityLabel={tr(t, 'games.sound', 'Som')}>
        <SoundIcon on={sfx} color={pal.ink} />
      </Pressable>
      {view ? (
        <Pressable onPress={() => setRulesOpen(true)} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'games.rules.button', 'Regras')}>
          <RulesIcon color={pal.ink} />
        </Pressable>
      ) : null}
      {view && view.status === 'active' && view.me !== null && view.me !== undefined ? (
        <Pressable onPress={confirmResign} hitSlop={10} style={[styles.resign, { borderColor: pal.line }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.resign', 'Desistir')}>
          <IconFlagResign size={16} color={pal.ink} />
          <Text style={{ color: pal.ink, fontSize: 12.5, fontWeight: '700' }}>{(view.type === 'quiz' || view.type === 'forca') ? tr(t, 'games.leave', 'Sair') : tr(t, 'games.resign', 'Desistir')}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (!view) {
    return (
      <View style={[styles.fill, { backgroundColor: pal.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        {header}
        <View style={styles.center}>{loadErr ? <Text style={{ color: pal.sub }}>{loadErr}</Text> : <ActivityIndicator color={pal.ink} />}</View>
      </View>
    );
  }

  const status = gameStatusLine(t, view, me);
  const myTurn = isMyTurn(view, me);
  let board = null;
  if (view.status === 'active' || view.status === 'finished') {
    const P = { view, onMove, pal, busy, t, me, offset: offRef.current, onTick };
    if (view.type === 'velha') board = <VelhaBoard {...P} />;
    else if (view.type === 'damas') board = <DamasBoard {...P} />;
    else if (view.type === 'cartas') board = <CartasBoard {...P} />;
    else if (view.type === 'quiz') board = view.status === 'active' ? <QuizBoard {...P} /> : null;
    else if (view.type === 'forca') board = <ForcaBoard {...P} />;
  }
  const pendingActs = view.status === 'pending' ? gameCardActions(view, me) : [];

  return (
    <KeyboardAvoidingView style={[styles.fill, { backgroundColor: pal.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      {header}
      <View style={styles.statusRow}>
        <TurnPill on={myTurn} label={status} pal={pal} />
        {view.spectator && view.status === 'active' ? <Text style={{ color: pal.sub, fontSize: 12.5 }}>{tr(t, 'games.spectating', 'Você está assistindo')}</Text> : null}
      </View>
      <PlayersBar view={view} me={me} pal={pal} t={t} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingBottom: 12, width: '100%', maxWidth: 680, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {view.status === 'pending' ? (
          <View style={[styles.result, { backgroundColor: pal.card, borderColor: pal.line }]}>
            <GameTypeIcon type={view.type} size={34} color={pal.ink} />
            <Text style={{ color: pal.ink, fontSize: 17, fontWeight: '800', marginTop: 10, textAlign: 'center' }}>{status}</Text>
            <WaitingDots pal={pal} />
            <View style={{ alignSelf: 'stretch', marginTop: 10 }}>
              {(view.players || []).map((p) => (
                <View key={p.e} style={[styles.rankRow, { borderTopColor: pal.line }]}>
                  <Text style={{ color: pal.ink, flex: 1, fontWeight: '600' }} numberOfLines={1}>{nameOf(view, p.e, me, t)}</Text>
                  <Text style={{ color: pal.sub, fontSize: 12.5 }}>{playerStatusLabel(t, p.s)}</Text>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, alignSelf: 'stretch' }}>
              {pendingActs.map((a) => {
                const prim = a === 'accept' || a === 'join' || a === 'start';
                return (
                  <Pressable key={a} disabled={busy} onPress={() => act(a)} style={[styles.btn, prim ? { backgroundColor: pal.strong } : { borderWidth: 1, borderColor: pal.line }]} accessibilityRole="button">
                    <Text style={{ color: prim ? pal.onStrong : pal.ink, fontWeight: '800' }}>{gameActionLabel(t, a)}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        {view.status === 'cancelled' ? <Text style={[styles.centerTx, { color: pal.sub }]}>{status}</Text> : null}
        {board}
        {view.status === 'finished' ? (
          <ResultPanel view={view} me={me} pal={pal} t={t} busy={busy} onRematch={() => act('rematch')}
            onOpenRematch={() => router.replace({ pathname: '/game/[id]', params: { id: String(view.rematch_id), cid: String(view.conversation_id || '') } })} />
        ) : null}
      </ScrollView>
      {celebrate ? <Confetti /> : null}
      <RulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} type={view.type} t={t} pal={pal} />
      {toast ? <View pointerEvents="none" style={[styles.toast, { backgroundColor: pal.strong, bottom: ins.bottom + 76 }]}><Text style={{ color: pal.onStrong, fontWeight: '700' }}>{toast}</Text></View> : null}
      <View style={[styles.chatStrip, { borderTopColor: pal.line, paddingBottom: Math.max(ins.bottom, 8) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} keyboardShouldPersistTaps="handled">
          {QUICK.map(([k, fb]) => (
            <Pressable key={k} onPress={() => sendQuick(tr(t, k, fb))} style={[styles.quick, { borderColor: pal.line }]} accessibilityRole="button">
              <Text style={{ color: pal.ink, fontSize: 13, fontWeight: '600' }}>{tr(t, k, fb)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={[styles.inputRow, { backgroundColor: pal.card }]}>
          <TextInput value={chatText} onChangeText={setChatText} placeholder={tr(t, 'games.quick.placeholder', 'Mensagem para a conversa')} placeholderTextColor={pal.sub}
            style={{ flex: 1, color: pal.ink, fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 9 : 5 }} returnKeyType="send"
            onSubmitEditing={() => { const x = chatText; setChatText(''); sendQuick(x); }} />
          <Pressable onPress={() => { const x = chatText; setChatText(''); sendQuick(x); }} disabled={!chatText.trim()} style={[styles.sendBtn, { backgroundColor: chatText.trim() ? pal.strong : pal.card2 }]}
            accessibilityRole="button" accessibilityLabel={tr(t, 'games.quick.send', 'Enviar')}>
            <Text style={{ color: chatText.trim() ? pal.onStrong : pal.sub, fontWeight: '800', fontSize: 13 }}>{tr(t, 'games.quick.send', 'Enviar')}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerTx: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 6 },
  backBtn: { padding: 2 },
  iconBtn: { padding: 6 },
  resign: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, marginTop: 2 },
  pill: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, maxWidth: '78%' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  result: { margin: 16, borderRadius: 20, borderWidth: 1, padding: 18, alignItems: 'center' },
  trophy: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12, marginTop: 16 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  toast: { position: 'absolute', alignSelf: 'center', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 9 },
  chatStrip: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 8 },
  quick: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, borderRadius: 18, paddingLeft: 14, paddingRight: 4, paddingVertical: 3 },
  sendBtn: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
});
