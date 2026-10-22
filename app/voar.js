// app/voar.js — [voar 2026-10-22] Brisa: tela do jogo (solo valendo ranking, ou tentativa de um DESAFIO).
// Params: game = id da partida 'voar' da conversa (desafio: mesma seed, 3 tentativas); cid = conversa de origem.
// Motor/desenho/laço: services/flyGame/*. Servidor re-joga cada partida (seed assinada + ticks) e devolve o
// resultado oficial; sem servidor = TREINO (recorde local, não vale ranking). Painéis = Views na própria tela
// (nunca Modal sobre Modal no iOS). Kill: globalThis.__chatyy_fly_game === false (a tela mostra "indisponível").
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AppState, Platform, useWindowDimensions, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import FlyCanvas, { flyCanvasSupported } from '../components/flyGame/FlyCanvas';
import ChatPickPanel from '../components/flyGame/ChatPickPanel';
import RecordCard, { shareRecord } from '../components/flyGame/RecordCard';
import { Buddy } from '../components/flyGame/BuddyArt';
import { useRM } from '../components/games/motion';
import { IconChevronLeft, IconTrophy } from '../components/games/GameIcons';
import { loadSoundPref, soundOn, setSoundOn, onSoundPref, playSfx } from '../components/games/sound';
import * as Fly from '../services/flyGame/api';

const { createRunner } = require('../services/flyGame/loop');
const E = require('../services/flyGame/engine');

function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k, vars ? { ...vars, defaultValue: fb } : fb) : fb; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}
function haptic(kind) {
  if (Platform.OS === 'web') return;
  try { if (!require('../services/hapticsPref').isHapticsEnabled()) return; } catch {}
  try {
    const H = require('expo-haptics');
    if (kind === 'flap') H.impactAsync(H.ImpactFeedbackStyle.Soft || H.ImpactFeedbackStyle.Light);
    else if (kind === 'score') H.selectionAsync();
    else if (kind === 'death') H.impactAsync(H.ImpactFeedbackStyle.Heavy);
    else if (kind === 'record') H.notificationAsync(H.NotificationFeedbackType.Success);
  } catch {}
}
function SoundGlyph({ on }) {
  const Svg = require('react-native-svg').default; const { Path } = require('react-native-svg');
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#EAF2FA" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M11 5 6 9H3v6h3l5 4z" fill="#EAF2FA" />
      {on ? <Path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" /> : <Path d="M16 9l5 6M21 9l-5 6" />}
    </Svg>
  );
}

export default function VoarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { t } = useLanguage();
  const { user } = useAuth();
  const me = String(user?.email || '').toLowerCase();
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const rm = useRM();
  const gid = Number(params.game || 0) || null;
  const mode = gid ? 'challenge' : 'rank';

  const runnerRef = useRef(null);
  const ticketRef = useRef(null);
  const [phase, setPhase] = useState('ready'); // ready | play | dead
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(Fly.bestSync());
  const [result, setResult] = useState(null); // {status:'pending'|'ok'|'rejected'|'offline', ...}
  const [paused, setPaused] = useState(false);
  const [sound, setSound] = useState(soundOn());
  const [game, setGame] = useState(null);     // visão da partida do desafio
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(null);
  const [toast, setToast] = useState(null);   // {text, cid?, name?}
  const [shareN, setShareN] = useState(null);
  const [info, setInfo] = useState(Fly.lastInfo());
  const shareRef = useRef(null);
  const lastRunId = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const killed = Fly.flyKilled();
  const supported = flyCanvasSupported();

  useEffect(() => {
    loadSoundPref().then((v) => alive.current && setSound(v)).catch(() => {});
    const off = onSoundPref((v) => alive.current && setSound(v));
    Fly.loadBest().then((b) => alive.current && setBest(b)).catch(() => {});
    const offB = Fly.onBest((b) => alive.current && setBest(b));
    Fly.fetchInfo().then((r) => { if (alive.current && r && r.success) setInfo(r.data); }).catch(() => {});
    return () => { off(); offB(); };
  }, []);

  // desafio: carrega a partida (seed, recorde a bater, tentativas)
  const loadGame = useCallback(async () => {
    if (!gid) return null;
    try {
      const G = require('../services/games');
      const r = await G.gameState(gid);
      const v = r && r.success && r.data && r.data.game;
      if (v && alive.current) setGame(v);
      return v || null;
    } catch { return null; }
  }, [gid]);
  useEffect(() => { if (gid) loadGame(); }, [gid, loadGame]);

  const mySeat = game && Array.isArray(game.seats) ? game.seats.findIndex((e) => String(e).toLowerCase() === me) : -1;
  // visão do motor do desafio (state: seed/sc/tries/done/max_tries/ch) com reserva no info do cartão
  const S0 = (game && game.state) || {};
  const I0 = (game && game.info) || {};
  const chSc = Array.isArray(S0.sc) ? S0.sc : (Array.isArray(I0.sc) ? I0.sc : []);
  const chTries = Array.isArray(S0.tries) ? S0.tries : (Array.isArray(I0.tries) ? I0.tries : []);
  const chDone = Array.isArray(S0.done) ? S0.done : (Array.isArray(I0.done) ? I0.done : []);
  const triesUsed = mySeat >= 0 ? Number(chTries[mySeat]) || 0 : 0;
  const maxTries = Number(S0.max_tries || I0.mt) || 3;
  const myDone = mySeat >= 0 ? !!chDone[mySeat] : false;
  const chBase = S0.ch != null ? S0.ch : I0.ch;
  const target = chBase != null ? Number(chBase) : (chSc.length ? Math.max(0, ...chSc.filter((_, i) => i !== mySeat).map(Number)) : null);
  const challengeOpen = !!game && game.status === 'active' && mySeat >= 0 && !myDone;
  const challengeSeed = S0.seed != null ? Number(S0.seed) : null;

  const newRun = useCallback(() => {
    if (killed || !supported) return;
    let tk = Fly.takeTicket(mode, gid);
    ticketRef.current = tk;
    const seed = tk ? tk.seed : (mode === 'challenge' && challengeSeed != null ? challengeSeed : ((Math.random() * 4294967295) >>> 0) || 1);
    const r = createRunner({
      seed, reduceMotion: rm,
      onStart: () => { if (!alive.current) return; setPhase('play'); setScore(0); },
      onFlap: () => { haptic('flap'); },
      onScore: (s) => { if (!alive.current) return; setScore(s); haptic('score'); try { playSfx('tap'); } catch {} },
      onDeath: (d) => onDeathRef.current && onDeathRef.current(d),
    });
    runnerRef.current = r;
    setPhase('ready'); setScore(0); setResult(null); setPaused(false);
    if (!tk) { // seed do servidor ainda não chegou: troca antes do 1º toque se der tempo
      Fly.waitTicket(mode, gid, 4000).then((t2) => {
        if (!t2 || runnerRef.current !== r || r.phase !== 'ready' || ticketRef.current) return;
        if (mode === 'challenge' && challengeSeed != null && Number(t2.seed) !== challengeSeed) return;
        ticketRef.current = t2; r.seed = t2.seed >>> 0;
      }).catch(() => {});
    }
  }, [killed, supported, mode, gid, challengeSeed, rm]);

  // 1ª partida: espera a visão do desafio (seed) quando for desafio
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    if (mode === 'challenge' && !game) return;
    started.current = true;
    Fly.prefetchTickets(mode, gid, mode === 'challenge' ? 1 : 2);
    newRun();
  }, [mode, game, gid, newRun]);

  const onDeathRef = useRef(null);
  onDeathRef.current = async (d) => {
    if (!alive.current) return;
    setPhase('dead');
    haptic('death');
    try { playSfx('capture'); } catch {}
    const tk = ticketRef.current;
    ticketRef.current = null;
    if (mode === 'rank' && Fly.mergeBest(d.score)) { haptic('record'); try { playSfx('win'); } catch {} }
    if (!tk) { setResult({ status: 'offline', score: d.score }); return; }
    setResult({ status: 'pending', score: d.score });
    const r = await Fly.finishRun(tk, d);
    if (!alive.current) return;
    if (r && r.success && r.data) {
      lastRunId.current = r.data.run_id;
      setResult({ status: 'ok', score: r.data.score, rank: r.data.rank, newWeek: !!r.data.new_week_best, newAll: !!r.data.new_all_best, ranked: r.data.ranked !== false, applied: r.data.applied, gameErr: r.data.game_error });
      if (r.data.game) { setGame(r.data.game); try { require('../services/games').putGameView(r.data.game); } catch {} }
      else if (mode === 'challenge') loadGame();
    } else {
      const code = Fly.flyErrCode(r);
      setResult({ status: code === 'network' ? 'offline' : 'rejected', score: d.score, err: code });
    }
  };

  // segundo plano = pausa (o motor não anda; ao voltar, um toque continua)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && runnerRef.current && runnerRef.current.phase === 'play') { runnerRef.current.pause(); setPaused(true); }
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);

  const onTap = useCallback(() => {
    const r = runnerRef.current;
    if (!r || r.phase === 'dead' || picker) return;
    if (mode === 'challenge' && r.phase === 'ready' && !challengeOpen) return;
    if (paused) setPaused(false);
    r.tap();
  }, [paused, picker, mode, challengeOpen]);

  const again = useCallback(() => { newRun(); }, [newRun]);
  const back = useCallback(() => { try { if (router.canGoBack?.()) router.back(); else router.replace('/chat'); } catch {} }, [router]);
  const openRank = useCallback(() => { try { router.push('/voar-ranking'); } catch {} }, [router]);
  const toggleSound = useCallback(() => { setSoundOn(!sound); }, [sound]);

  const dare = useCallback(async (conv, name) => {
    if (!conv) return;
    setSending(conv.id);
    const runId = result && result.status === 'ok' && mode === 'rank' ? lastRunId.current : null;
    const r = await Fly.sendChallenge(conv.id, runId);
    if (!alive.current) return;
    setSending(null);
    if (r && r.success) { setPicker(false); haptic('score'); setToast({ text: tr(t, 'fly.dare.sent', 'Desafio enviado para {name}', { name }), cid: conv.id, name, conv }); }
    else {
      const code = Fly.flyErrCode(r);
      setToast({ text: tr(t, 'fly.err.' + code, Fly.FLY_ERR_FB[code] || tr(t, 'fly.err.generic', 'Não deu certo. Tente de novo.')) });
    }
  }, [result, mode, t]);
  const openToastConv = useCallback(() => {
    const c = toast && toast.conv; if (!c) return;
    setToast(null);
    try {
      require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { id: String(c.id), name: toast.name || '', email: c.other_email || c.contact_email || '', ...(c.type ? { type: c.type } : {}) } });
    } catch {}
  }, [toast]);
  useEffect(() => { if (!toast) return undefined; const id = setTimeout(() => alive.current && setToast(null), 4200); return () => clearTimeout(id); }, [toast]);

  const share = useCallback(async () => {
    const n = result ? result.score : score;
    setShareN(Math.max(n, 0));
    setTimeout(async () => {
      try { await shareRecord(shareRef, Math.max(best, n), t); } catch {}
      if (alive.current) setShareN(null);
    }, 120);
  }, [result, score, best, t]);

  if (killed || !supported) {
    return (
      <View style={[st.root, st.center, { paddingTop: insets.top }]}>
        <Buddy size={96} />
        <Text style={st.unavTitle}>{tr(t, 'fly.title', 'Brisa')}</Text>
        <Text style={st.unavSub}>{tr(t, 'fly.unavailable', 'O Brisa não está disponível agora.')}</Text>
        <Pressable onPress={back} style={[st.btn, st.btnGhost, { marginTop: 18, alignSelf: 'stretch', marginHorizontal: 32 }]} accessibilityRole="button"><Text style={st.btnGhostTxt}>{tr(t, 'common.back', 'Voltar')}</Text></Pressable>
      </View>
    );
  }

  const res = result || {};
  const shownScore = res.status === 'ok' ? res.score : (res.score != null ? res.score : score);
  const ranked = info ? info.ranked !== false : true;
  const canAgain = mode === 'rank' || challengeOpen;

  return (
    <View style={st.root}>
      <FlyCanvas runnerRef={runnerRef} width={W} height={H} paused={false} onTap={onTap} style={StyleSheet.absoluteFill} />

      {/* HUD */}
      <View style={[StyleSheet.absoluteFill]} pointerEvents="box-none">
        <View style={[st.top, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable onPress={back} hitSlop={8} style={st.chip} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
            <IconChevronLeft size={18} color="#EAF2FA" />
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }} pointerEvents="box-none">
            {mode === 'rank' ? (
              <Pressable onPress={openRank} hitSlop={8} style={st.chip} accessibilityRole="button" accessibilityLabel={tr(t, 'fly.rank.title', 'Ranking da semana')}>
                <IconTrophy size={16} color="#EAF2FA" />
              </Pressable>
            ) : null}
            <Pressable onPress={toggleSound} hitSlop={8} style={st.chip} accessibilityRole="switch" accessibilityState={{ checked: sound }} accessibilityLabel={tr(t, 'fly.sound', 'Som')}>
              <SoundGlyph on={sound} />
            </Pressable>
          </View>
        </View>

        {phase !== 'ready' ? (
          <Text style={[st.score, { marginTop: insets.top + 64 }]} pointerEvents="none" accessibilityLiveRegion="polite">{String(phase === 'dead' ? shownScore : score)}</Text>
        ) : null}

        {phase === 'ready' ? (
          <View style={st.ready} pointerEvents="none">
            <Text style={st.readyTitle}>{tr(t, 'fly.title', 'Brisa')}</Text>
            {mode === 'challenge' ? (
              <Text style={st.readySub}>
                {game ? (challengeOpen
                  ? tr(t, 'fly.ch.beat', 'Bata {n} · tentativa {i} de {m}', { n: target != null ? target : 0, i: Math.min(maxTries, triesUsed + 1), m: maxTries })
                  : tr(t, 'fly.ch.closed', 'Este desafio já terminou para você')) : tr(t, 'fly.loading', 'Carregando...')}
              </Text>
            ) : (
              <Text style={st.readySub}>{tr(t, 'fly.best', 'Recorde: {n}', { n: best })}</Text>
            )}
            {(mode === 'rank' || challengeOpen) ? (
              <View style={st.pill}><Text style={st.pillTxt}>{tr(t, 'fly.tapToFly', 'Toque para voar')}</Text></View>
            ) : null}
            {mode === 'rank' && !ranked ? <Text style={st.note}>{tr(t, 'fly.qaNote', 'Conta de teste: fora do ranking')}</Text> : null}
          </View>
        ) : null}

        {paused && phase === 'play' ? (
          <View style={st.pausedBox} pointerEvents="none"><Text style={st.pausedTxt}>{tr(t, 'fly.paused', 'Pausado · toque para continuar')}</Text></View>
        ) : null}

        {phase === 'dead' && !picker ? (
          <View style={[st.over, { bottom: insets.bottom + 18 }]}>
            <View style={st.row}>
              <View style={st.stat}>
                <Text style={st.statLbl}>{tr(t, 'fly.points', 'Pontos')}</Text>
                <Text style={st.statVal}>{String(shownScore)}</Text>
              </View>
              {mode === 'rank' ? (
                <View style={st.stat}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={st.statLbl}>{tr(t, 'fly.record', 'Recorde')}</Text>
                    {res.newAll || (res.status !== 'ok' && shownScore > 0 && shownScore >= best) ? <Text style={st.newBadge}>{tr(t, 'fly.new', 'NOVO')}</Text> : null}
                  </View>
                  <Text style={st.statVal}>{String(best)}</Text>
                </View>
              ) : (
                <View style={st.stat}>
                  <Text style={st.statLbl}>{tr(t, 'fly.ch.target', 'Para bater')}</Text>
                  <Text style={st.statVal}>{target != null ? String(target) : '-'}</Text>
                </View>
              )}
            </View>
            <Text style={st.status} numberOfLines={2}>
              {res.status === 'pending' ? tr(t, 'fly.checking', 'Conferindo a partida...')
                : res.status === 'offline' ? tr(t, 'fly.training', 'Treino: sem conexão, não vale ranking')
                  : res.status === 'rejected' ? tr(t, 'fly.err.' + res.err, Fly.FLY_ERR_FB[res.err] || tr(t, 'fly.err.generic', 'Não deu certo. Tente de novo.'))
                    : mode === 'challenge' ? (myDone ? tr(t, 'fly.ch.doneMine', 'Suas tentativas acabaram. O resultado aparece na conversa.') : tr(t, 'fly.ch.left', 'Tentativas: {i} de {m}', { i: triesUsed, m: maxTries }))
                      : !res.ranked ? tr(t, 'fly.qaNote', 'Conta de teste: fora do ranking')
                        : res.rank ? tr(t, 'fly.rankPos', '#{n} no ranking da semana', { n: res.rank }) : tr(t, 'fly.saved', 'Partida conferida')}
            </Text>
            {canAgain ? (
              <Pressable onPress={again} style={[st.btn, st.btnPrimary]} accessibilityRole="button">
                <Text style={st.btnPrimaryTxt}>{tr(t, 'fly.again', 'Mais uma')}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={back} style={[st.btn, st.btnPrimary]} accessibilityRole="button">
                <Text style={st.btnPrimaryTxt}>{tr(t, 'fly.backToChat', 'Voltar à conversa')}</Text>
              </Pressable>
            )}
            {mode === 'rank' ? (
              <View style={[st.row, { marginTop: 10 }]}>
                <Pressable onPress={openRank} style={[st.btn, st.btnGhost, { flex: 1 }]} accessibilityRole="button"><Text style={st.btnGhostTxt}>{tr(t, 'fly.ranking', 'Ranking')}</Text></Pressable>
                <Pressable onPress={() => setPicker(true)} style={[st.btn, st.btnGhost, { flex: 1 }]} accessibilityRole="button"><Text style={st.btnGhostTxt}>{tr(t, 'fly.dare', 'Desafiar')}</Text></Pressable>
                <Pressable onPress={share} style={[st.btn, st.btnGhost, { flex: 1 }]} accessibilityRole="button"><Text style={st.btnGhostTxt}>{tr(t, 'fly.share', 'Compartilhar')}</Text></Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {picker ? <ChatPickPanel me={me} t={t} busyId={sending} bottomInset={insets.bottom} onClose={() => setPicker(false)} onPick={dare} /> : null}

        {toast ? (
          <Pressable onPress={toast.conv ? openToastConv : () => setToast(null)} style={[st.toast, { top: insets.top + 56 }]} accessibilityRole="button">
            <Text style={st.toastTxt} numberOfLines={2}>{toast.text}</Text>
            {toast.conv ? <Text style={st.toastAct}>{tr(t, 'fly.dare.open', 'Abrir conversa')}</Text> : null}
          </Pressable>
        ) : null}
        {result && result.status === 'pending' ? <ActivityIndicator style={{ position: 'absolute', top: insets.top + 16, alignSelf: 'center' }} color="#8FD3FF" /> : null}
      </View>

      {shareN != null ? (
        <View style={st.offscreen} pointerEvents="none">
          <RecordCard ref={shareRef} score={shareN} best={Math.max(best, shareN)} t={t} />
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#141A24' },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  unavTitle: { color: '#EEF3F8', fontSize: 30, fontWeight: '800', marginTop: 12 },
  unavSub: { color: '#9AA6B6', fontSize: 15, marginTop: 6, textAlign: 'center' },
  top: { position: 'absolute', left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between' },
  chip: { height: 38, minWidth: 38, paddingHorizontal: 10, borderRadius: 19, backgroundColor: 'rgba(20,26,36,0.6)', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)' },
  score: { alignSelf: 'center', color: '#FFFFFF', fontSize: 64, fontWeight: '800', letterSpacing: -1, textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 4 }, textShadowRadius: 16, fontVariant: ['tabular-nums'] },
  ready: { position: 'absolute', left: 0, right: 0, top: '56%', alignItems: 'center' },
  readyTitle: { color: '#FFFFFF', fontSize: 44, fontWeight: '800', letterSpacing: -1 },
  readySub: { color: '#CFE0EE', fontSize: 15.5, fontWeight: '600', marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  pill: { marginTop: 14, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22, backgroundColor: 'rgba(143,211,255,0.18)' },
  pillTxt: { color: '#BFE6FF', fontWeight: '800', fontSize: 14.5 },
  note: { color: '#9AA6B6', marginTop: 10, fontSize: 12.5, fontWeight: '600' },
  pausedBox: { position: 'absolute', top: '42%', alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(20,26,36,0.75)' },
  pausedTxt: { color: '#EAF2FA', fontWeight: '700' },
  over: { position: 'absolute', left: 16, right: 16, backgroundColor: 'rgba(18,23,32,0.92)', borderRadius: 28, padding: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)' },
  row: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 18, padding: 12 },
  statLbl: { color: '#9AA6B6', fontSize: 12, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  statVal: { color: '#EEF3F8', fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 2 },
  newBadge: { backgroundColor: '#8FD3FF', color: '#0F1620', fontSize: 10.5, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 1.5, borderRadius: 8, overflow: 'hidden' },
  status: { color: '#B8C6D6', fontSize: 13.5, fontWeight: '600', marginVertical: 12, textAlign: 'center' },
  btn: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  btnPrimary: { backgroundColor: '#F3F7FB' },
  btnPrimaryTxt: { color: '#121821', fontWeight: '800', fontSize: 16.5 },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.08)' },
  btnGhostTxt: { color: '#EEF3F8', fontWeight: '700', fontSize: 14 },
  toast: { position: 'absolute', left: 16, right: 16, backgroundColor: 'rgba(243,247,251,0.97)', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  toastTxt: { flex: 1, color: '#121821', fontWeight: '700', fontSize: 14 },
  toastAct: { color: '#1F6FA8', fontWeight: '800', fontSize: 13.5 },
  offscreen: { position: 'absolute', left: -4000, top: 0 },
});
