// components/games/GamePicker.js — [jogos 2026-10-18] "Jogos" no menu de anexo da conversa.
// Passo 1: escolhe o jogo. Passo 2 (só em grupo): quem joga (mín./máx. por jogo; Quiz pode ser aberto a todos).
// Cria o convite (chat_game_create) — o cartão aparece no chat e os convidados aceitam/recusam.
// [jogos 2026-10-19] Folha NATIVA (GameSheet) quando fora do painel; regras e placar = passos da própria folha.
// [jogos 2026-10-21 painel] REDESENHO (mockup aprovado preview-2026/jogos2.html):
//   - placar dos dois no topo (ScoreStrip: "Você 4 x 3 Thalissa", sequência, total) no lugar do botão "Placar";
//   - abas Jogar | Em andamento (contador) | Histórico;
//   - "Continue": partidas abertas em cartões grafite grandes com a arte do jogo; "Sua vez" branco pulsando,
//     "Vez de X" discreto; 1 partida por jogo (a mais nova — o servidor também deduplica na criação);
//   - "Jogar agora": grade 2 colunas com CAPA desenhada (GameCovers), selo NOVO, botão play; "2 jogadores"
//     (faixa min–máx só em grupo e só se min≠máx); regras no toque longo e dentro do jogo;
//   - catálogo = registro do app (GAME_TYPES) ∩ servidor (chat_game_types) → jogo novo aparece sozinho
//     quando os dois lados o têm (app sem tabuleiro nunca oferece um jogo que não sabe abrir);
//   - histórico com Venceu verde / Perdeu vermelho / Empate cinza; arrastar a linha p/ o lado esconde (UI thread).
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView as RNScrollView, ActivityIndicator, Switch, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { ScrollView as GHScrollView, Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSpring, withSequence, cancelAnimation, runOnJS, Easing,
  FadeOut, LinearTransition,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Stop, Rect, Path } from 'react-native-svg';
import { ScoreboardList, ScoreStrip } from './GameScoreboard';
import { RulesBody } from './RulesSheet';
import GameSheet, { sheetScrollFill } from './GameSheet';
import { GameCover, coverTint, continueGradient, isNewGame, COVER_ORDER, COVER_TITLE_FB, COVER_BLURB_FB } from './GameCovers';
import AvatarCircle from '../AvatarCircle';
import { IconTrash } from '../Icons';
import { gamePalette, hTap, hOk, hErr } from './fx';
import { PressScale, useRM } from './motion';
import { grafite, cardShadow } from '../../constants/theme';
import {
  GAME_TYPES, gameTitle, gameSubtitle, gameCreate, gameList, gameErrorText, gameStatusLine, gameEndBadge, gameHide, gameHideAll, gameFeature, tr,
  isMyTurn, nameOf, onAnyGameView, isInviteExpired, myStatusIn,
} from '../../services/games';

const LIMITS_FB = { damas: [2, 2], velha: [2, 2], cartas: [2, 6], quiz: [2, 20], forca: [2, 8] };
const WIN = '#2FB36B';
const LOSS = '#E5484D';

// ─── catálogo do servidor (chat_game_types) — 1×/sessão, nunca lança ─────────
let _cat = null; // { types: {type: {min, max_group, title}}, at }
let _catP = null;
function loadCatalog() {
  if (_cat && Date.now() - _cat.at < 30 * 60 * 1000) return Promise.resolve(_cat);
  if (_catP) return _catP;
  _catP = (async () => {
    try {
      const m = require('../../services/api');
      const api = m.default && m.default.apiCall ? m.default : m;
      const r = await api.apiCall('chat_game_types', {}, 'POST');
      if (r && r.success && r.data && Array.isArray(r.data.types)) {
        const types = {};
        r.data.types.forEach((x) => { if (x && x.type) types[x.type] = { min: Number(x.min) || 2, max_group: Number(x.max_group) || 2, title: x.title || null }; });
        _cat = { types, at: Date.now() };
      }
    } catch {}
    _catP = null;
    return _cat;
  })();
  return _catP;
}
function typeTitle(t, type, cat) {
  const s = gameTitle(t, type);
  if (s && s !== 'Jogo') return s;
  return COVER_TITLE_FB[type] || (cat && cat.types[type] && cat.types[type].title) || s;
}
function typeBlurb(t, type) {
  const s = gameSubtitle(t, type);
  if (s) return s;
  return tr(t, 'games.blurb.' + type, COVER_BLURB_FB[type] || '');
}
function limitsOf(type, cat) {
  const c = cat && cat.types[type];
  if (c) return [c.min, Math.max(c.min, c.max_group)];
  return LIMITS_FB[type] || [2, 2];
}

function XIcon({ color }) {
  return (
    <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: 14, height: 1.8, borderRadius: 1, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: 14, height: 1.8, borderRadius: 1, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
    </View>
  );
}
function PlayGlyph({ color }) {
  return <Svg width={11} height={11} viewBox="0 0 12 12"><Path d="M3 1.5l7 4.5-7 4.5z" fill={color} /></Svg>;
}

// [jogos 2026-10-20 dock] panel = desenhado dentro do painel da conversa (GameDock), sem folha.
function PanelWrap({ children, bg }) { return <View style={{ flex: 1, backgroundColor: bg }}>{children}</View>; }

// ─── "Sua vez" pulsando (UI thread; Reduzir Movimento = parado) ─────────────
function PulseTurn({ label, rm }) {
  const o = useSharedValue(1);
  useEffect(() => {
    if (rm) { o.value = 1; return undefined; }
    o.value = withRepeat(withSequence(withTiming(0.3, { duration: 700, easing: Easing.inOut(Easing.quad) }), withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) })), -1, false);
    return () => cancelAnimation(o);
  }, [rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const dot = useAnimatedStyle(() => ({ opacity: o.value }));
  const pill = useAnimatedStyle(() => ({ transform: [{ scale: 1 + (1 - o.value) * 0.04 }] }));
  return (
    <Animated.View style={[st.turn, { backgroundColor: '#FFFFFF' }, pill]}>
      <Animated.View style={[st.turnDot, dot]} />
      <Text style={[st.turnTx, { color: '#18181B' }]} numberOfLines={1}>{label}</Text>
    </Animated.View>
  );
}

function contSub(t, g, me) {
  const info = g.info || {};
  if (g.status === 'pending') return myStatusIn(g, me) === 'invited' ? tr(t, 'games.panel.invitedYou', 'Convite para você') : tr(t, 'games.panel.invite', 'Convite enviado');
  if (g.type === 'quiz' && info.i && info.count) return tr(t, 'games.status.quizProgress', 'Pergunta {i} de {n}', { i: info.i, n: info.count });
  if (g.type === 'forca' && info.max) return tr(t, 'games.panel.errors', '{n} de {max} erros', { n: info.wrong || 0, max: info.max });
  if (g.type === 'cartas' && Array.isArray(info.counts) && info.counts.length === 2) {
    const mi = typeof g.me === 'number' ? g.me : 0;
    return tr(t, 'games.panel.cards', '{a} x {b} cartas', { a: info.counts[mi], b: info.counts[1 - mi] });
  }
  const opp = (Array.isArray(g.seats) && g.seats.length ? g.seats : (g.players || []).map((p) => p.e)).find((e) => String(e).toLowerCase() !== me);
  return opp ? tr(t, 'games.panel.with', 'com {name}', { name: nameOf(g, opp, me, t) }) : '';
}

function ContinueCard({ g, t, me, rm, wide, cat, onPress }) {
  const mine = isMyTurn(g, me);
  const line = gameStatusLine(t, g, me);
  const [c0, c1] = continueGradient(g.type);
  const title = typeTitle(t, g.type, cat);
  const sub = contSub(t, g, me);
  const gid = `cg${g.g}`;
  return (
    <PressScale rm={rm} scaleTo={0.97} onPress={onPress} style={[st.cc, wide ? st.ccWide : null]}
      accessibilityRole="button" accessibilityLabel={`${title}. ${sub}. ${line}`}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={c0} />
            <Stop offset="1" stopColor={c1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gid})`} />
      </Svg>
      <View style={st.ccArt} pointerEvents="none"><GameCover type={g.type} size={120} color="#FFFFFF" opacity={0.9} /></View>
      <Text style={st.ccTitle} numberOfLines={1}>{title}</Text>
      {sub ? <Text style={st.ccSub} numberOfLines={1}>{sub}</Text> : null}
      <View style={{ flexDirection: 'row', marginTop: 12 }}>
        {mine ? <PulseTurn label={tr(t, 'games.status.yourTurn', 'Sua vez')} rm={rm} /> : (
          <View style={[st.turn, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
            <Text style={[st.turnTx, { color: '#FFFFFF' }]} numberOfLines={1}>{line}</Text>
          </View>
        )}
      </View>
    </PressScale>
  );
}

function GameTile({ type, t, G, isDark, rm, busy, cat, isGroup, onPick, onRules }) {
  const lim = limitsOf(type, cat);
  const hi = isGroup ? lim[1] : 2;
  const lo = Math.min(lim[0], hi);
  const meta = lo === hi ? tr(t, 'games.players.n', '{n} jogadores', { n: hi }) : tr(t, 'games.players.range', '{min} a {max} jogadores', { min: lo, max: hi });
  const title = typeTitle(t, type, cat);
  const blurb = typeBlurb(t, type);
  const nu = isNewGame(type);
  return (
    <PressScale rm={rm} scaleTo={0.96} disabled={busy} onPress={onPick} onLongPress={onRules} delayLongPress={380}
      style={[st.tile, { backgroundColor: G.surface }, cardShadow(isDark)]}
      accessibilityRole="button" accessibilityLabel={`${title}${nu ? '. ' + tr(t, 'games.panel.new', 'Novo') : ''}. ${blurb}. ${meta}`}
      accessibilityHint={tr(t, 'games.panel.tileHint', 'Toque para convidar. Toque longo mostra as regras')}
      accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: tr(t, 'games.rules.button', 'Regras') }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'longpress') onRules(); else onPick(); }}>
      <View style={[st.cover, { backgroundColor: coverTint(type, isDark) }]}>
        {nu ? <View style={st.newBadge}><Text style={st.newTx}>{tr(t, 'games.panel.newBadge', 'NOVO')}</Text></View> : null}
        <GameCover type={type} size={70} color={G.text} />
      </View>
      <View style={st.tileIn}>
        <Text style={[st.tileTitle, { color: G.text }]} numberOfLines={1}>{title}</Text>
        <Text style={[st.tileSub, { color: G.muted }]} numberOfLines={2}>{blurb}</Text>
        <View style={st.tileFoot}>
          <Text style={[st.tileMeta, { color: G.muted }]} numberOfLines={1}>{meta}</Text>
          <View style={[st.play, { backgroundColor: isDark ? '#F2F2EF' : '#34343A' }]}><PlayGlyph color={isDark ? '#0E0E10' : '#FFFFFF'} /></View>
        </View>
      </View>
    </PressScale>
  );
}

// ─── linha do histórico: arrastar p/ o lado esconde (RNGH + Reanimated, UI thread) ──
function SwipeRow({ enabled, onDelete, rm, label, children, G }) {
  const x = useSharedValue(0);
  const w = useSharedValue(360);
  const delRef = useRef(onDelete);
  useEffect(() => { delRef.current = onDelete; }, [onDelete]);
  const fire = useCallback(() => { try { delRef.current && delRef.current(); } catch {} }, []);
  const pan = useMemo(() => Gesture.Pan()
    .enabled(!!enabled)
    .activeOffsetX([-14, 14])
    .failOffsetY([-10, 10])
    .onUpdate((e) => { 'worklet'; x.value = e.translationX; })
    .onEnd((e) => {
      'worklet';
      const far = Math.abs(x.value) > w.value * 0.33 || Math.abs(e.velocityX) > 900;
      if (far) {
        const dir = (x.value || e.velocityX) < 0 ? -1 : 1;
        x.value = withTiming(dir * (w.value + 40), { duration: rm ? 1 : 170 }, (fin) => { 'worklet'; if (fin) runOnJS(fire)(); });
      } else x.value = withSpring(0, { damping: 20, stiffness: 260 });
    }), [enabled, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const front = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const back = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.abs(x.value) / 60) }));
  const inL = useAnimatedStyle(() => ({ opacity: x.value > 0 ? 1 : 0 }));
  const inR = useAnimatedStyle(() => ({ opacity: x.value < 0 ? 1 : 0 }));
  if (!enabled) return <View>{children}</View>;
  return (
    <View onLayout={(e) => { w.value = e.nativeEvent.layout.width || 360; }} style={{ overflow: 'hidden' }}>
      <Animated.View style={[StyleSheet.absoluteFill, st.swBack, back]} pointerEvents="none">
        <Animated.View style={[st.swIn, inL]}><IconTrash size={18} color="#FFFFFF" /><Text style={st.swTx}>{label}</Text></Animated.View>
        <Animated.View style={[st.swIn, inR]}><Text style={st.swTx}>{label}</Text><IconTrash size={18} color="#FFFFFF" /></Animated.View>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ backgroundColor: G.bg }, front]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

function badgeColors(kind, G, isDark) {
  if (kind === 'won' || kind === 'resigned_other') return { bg: 'rgba(47,179,107,0.15)', fg: isDark ? '#4CD08A' : '#1F8A50' };
  if (kind === 'lost') return { bg: 'rgba(229,72,77,0.12)', fg: isDark ? '#FF6B6F' : '#C83A3F' };
  return { bg: G.surface2, fg: G.text };
}

const TAB_KEYS = ['play', 'open', 'hist'];

export default function GamePicker({ visible, onClose, conversationId, conversationType, members, currentEmail, t, colors, isDark, onCreated, onOpenGame, panel = false }) {
  const rm = useRM();
  const { width: winW } = useWindowDimensions();
  const [step, setStep] = useState('pick'); // pick | players | score | rules
  const [tab, setTab] = useState('play');
  const [type, setType] = useState(null);
  const [rulesType, setRulesType] = useState(null);
  const [sel, setSel] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [games, setGames] = useState([]);
  const [cat, setCat] = useState(_cat);
  const [scoreKey, setScoreKey] = useState(0);
  const isGroup = conversationType === 'group';
  const me = String(currentEmail || '').toLowerCase();
  const pal = useMemo(() => gamePalette(colors || {}, !!isDark), [colors, isDark]);
  const G = grafite(!!isDark);
  const canHide = gameFeature('hide');

  useEffect(() => {
    if (!visible) return undefined;
    setStep('pick'); setTab('play'); setType(null); setSel([]); setOpen(false); setErr(''); setBusy(false);
    let alive = true;
    (async () => {
      const r = await gameList(conversationId);
      if (alive && r && r.success) setGames(Array.isArray(r.data.games) ? r.data.games : []);
    })();
    loadCatalog().then((c) => { if (alive && c) setCat(c); });
    return () => { alive = false; };
  }, [visible, conversationId]);

  // ao vivo: lance/aceite/fim desta conversa atualiza o "Continue" e o histórico sem recarregar
  useEffect(() => {
    if (!visible) return undefined;
    return onAnyGameView((v) => {
      try {
        if (!v || !v.g || String(v.conversation_id) !== String(conversationId)) return;
        setGames((prev) => {
          const i = prev.findIndex((x) => x.g === v.g);
          if (i < 0) return [v, ...prev];
          const n = prev.slice(); n[i] = { ...prev[i], ...v }; return n;
        });
        if (v.status === 'finished') setScoreKey((k) => k + 1);
      } catch {}
    });
  }, [visible, conversationId]);

  const others = useMemo(() => (Array.isArray(members) ? members : [])
    .filter((m) => m && m.email && String(m.email).toLowerCase() !== me)
    .map((m) => ({ e: String(m.email).toLowerCase(), n: m.name || m.display_name || String(m.email).split('@')[0] })), [members, me]);

  const nowMs = Date.now();
  const sorted = useMemo(() => games.slice().sort((a, b) => Number(b.g) - Number(a.g)), [games]);
  const isOpenG = (g) => (g.status === 'pending' && !isInviteExpired(g, nowMs)) || g.status === 'active';
  // 1 partida aberta por jogo (a mais nova); as repetidas antigas não aparecem
  const active = [];
  const seenType = {};
  sorted.forEach((g) => { if (isOpenG(g) && !seenType[g.type]) { seenType[g.type] = 1; active.push(g); } });
  // minha vez primeiro
  active.sort((a, b) => Number(isMyTurn(b, me)) - Number(isMyTurn(a, me)));
  const recent = sorted.filter((g) => !isOpenG(g)).slice(0, 20);

  // catálogo: registro do app ∩ servidor (sem catálogo = registro do app)
  const types = useMemo(() => {
    const reg = Array.isArray(GAME_TYPES) ? GAME_TYPES.slice() : [];
    const list = cat && cat.types && Object.keys(cat.types).length ? reg.filter((x) => cat.types[x]) : reg;
    const pos = (x) => { const i = COVER_ORDER.indexOf(x); return i < 0 ? 100 + reg.indexOf(x) : i; };
    return list.sort((a, b) => pos(a) - pos(b));
  }, [cat]);

  const hideOne = useCallback(async (g) => {
    hTap();
    setGames((prev) => prev.filter((x) => x.g !== g.g)); // some na hora; o servidor confirma
    const r = await gameHide(g.g);
    if (!r || !r.success) { hErr(); setErr(gameErrorText(t, r)); }
  }, [t]);
  const hideAll = useCallback(async () => {
    hTap();
    setGames((prev) => prev.filter((g) => g.status === 'pending' || g.status === 'active'));
    const r = await gameHideAll(conversationId);
    if (!r || !r.success) { hErr(); setErr(gameErrorText(t, r)); }
  }, [conversationId, t]);

  if (!visible) return null;
  const lim = type ? limitsOf(type, cat) : [2, 2];
  const maxOthers = lim[1] - 1;
  const needOthers = lim[0] - 1;

  const openGame = (g) => { hTap(); onClose && onClose(); onOpenGame && onOpenGame(g); };
  const create = async (tp, players, isOpen) => {
    setBusy(true); setErr('');
    const r = await gameCreate(conversationId, tp, players, isOpen);
    setBusy(false);
    if (r && r.success && r.data && r.data.game) {
      const gv = r.data.game;
      // servidor devolveu a partida que já estava aberta (mesmo jogo) → abre ela em vez de criar outra
      if (r.data.existing) { openGame(gv); return; }
      hOk(); onClose && onClose(); onCreated && onCreated(gv); return;
    }
    hErr();
    setErr(gameErrorText(t, r));
  };
  const pick = (tp) => {
    hTap();
    setType(tp); setErr('');
    const ex = active.find((g) => g.type === tp);
    if (ex && !isGroup) { openGame(ex); return; } // já tem uma desse jogo aberta: continua nela
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
  const canInvite = open || (sel.length >= needOthers && sel.length <= maxOthers);
  const rangeText = maxOthers === needOthers
    ? tr(t, 'games.pick.exactly', 'Escolha {n} adversário', { n: needOthers })
    : tr(t, 'games.pick.range', 'Escolha de {min} a {max} pessoas', { min: needOthers, max: maxOthers });
  const title = step === 'score' ? (isGroup ? tr(t, 'games.score.title', 'Placar do grupo') : tr(t, 'games.score.titleDirect', 'Placar da conversa'))
    : step === 'players' ? typeTitle(t, type, cat) : step === 'rules' ? tr(t, 'games.rules.button', 'Regras') : tr(t, 'games.menu', 'Jogos');

  const tabLabel = { play: tr(t, 'games.panel.tabPlay', 'Jogar'), open: tr(t, 'games.inProgress', 'Em andamento'), hist: tr(t, 'games.panel.tabHistory', 'Histórico') };
  const myTurns = active.filter((g) => isMyTurn(g, me)).length;
  const cardW = Math.min(280, Math.max(220, Math.round(winW * 0.64)));

  const HScroll = panel ? GHScrollView : RNScrollView;
  const contRow = active.length ? (
    <HScroll horizontal showsHorizontalScrollIndicator={false} style={st.contScroll} contentContainerStyle={st.contRow}>
      {active.map((g) => (
        <View key={g.g} style={{ width: cardW }}>
          <ContinueCard g={g} t={t} me={me} rm={rm} cat={cat} onPress={() => openGame(g)} />
        </View>
      ))}
    </HScroll>
  ) : null;

  const histRow = (g) => {
    const badge = gameEndBadge(t, g, currentEmail);
    const bc = badgeColors(badge && badge.kind, G, isDark);
    const label = tr(t, 'games.panel.delete', 'Apagar');
    return (
      <Animated.View key={g.g} exiting={rm ? undefined : FadeOut.duration(160)} layout={rm ? undefined : LinearTransition.duration(200)}>
        <SwipeRow enabled={canHide && panel} rm={rm} G={G} label={label} onDelete={() => hideOne(g)}>
          <Pressable onPress={() => openGame(g)} style={({ pressed }) => [st.h, { borderBottomColor: G.line }, pressed && { opacity: 0.7 }]}
            accessibilityActions={canHide ? [{ name: 'delete', label }] : undefined}
            onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') hideOne(g); }}
            accessibilityRole="button" accessibilityLabel={`${typeTitle(t, g.type, cat)}. ${gameStatusLine(t, g, currentEmail)}${badge ? '. ' + badge.label : ''}`}>
            <View style={[st.hIc, { backgroundColor: coverTint(g.type, isDark) }]}><GameCover type={g.type} size={26} color={G.text} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: G.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{typeTitle(t, g.type, cat)}</Text>
              <Text style={{ color: G.muted, fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>{gameStatusLine(t, g, currentEmail)}</Text>
            </View>
            {badge ? <View style={[st.res, { backgroundColor: bc.bg }]}><Text style={{ color: bc.fg, fontSize: 12, fontWeight: '800' }}>{badge.label}</Text></View> : null}
          </Pressable>
        </SwipeRow>
      </Animated.View>
    );
  };

  const Wrap = panel ? PanelWrap : GameSheet;
  const Scroll = panel ? GHScrollView : RNScrollView;
  return (
    <Wrap visible onClose={onClose} bg={panel ? G.bg : pal.bg} detents={[0.62, 0.95]}>
      <View style={st.headRow}>
        {step !== 'pick' ? (
          <Pressable onPress={back} hitSlop={10} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
            <Text style={{ color: G.text, fontSize: 15, fontWeight: '600' }}>{tr(t, 'common.back', 'Voltar')}</Text>
          </Pressable>
        ) : null}
        <Text style={[step === 'pick' ? st.titleBig : st.title, { color: G.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
        {panel ? (
          <Pressable onPress={() => { hTap(); onClose && onClose(); }} hitSlop={10} style={[st.closeBtn, { backgroundColor: G.surface2 }]} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
            <XIcon color={G.text} />
          </Pressable>
        ) : null}
      </View>

      {step === 'pick' ? (
        <View style={st.tabs} accessibilityRole="tablist">
          {TAB_KEYS.map((k) => {
            const on = tab === k;
            const n = k === 'open' ? active.length : 0;
            return (
              <Pressable key={k} onPress={() => { if (!on) { hTap(); setTab(k); } }} style={[st.tab, { backgroundColor: on ? (isDark ? '#F2F2EF' : '#34343A') : G.surface2 }]}
                accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={n ? `${tabLabel[k]}, ${n}` : tabLabel[k]}>
                <Text style={[st.tabTx, { color: on ? (isDark ? '#0E0E10' : '#FFFFFF') : G.text }]}>{tabLabel[k]}</Text>
                {n ? <View style={[st.tabN, { backgroundColor: myTurns ? LOSS : (on ? (isDark ? '#0E0E10' : '#FFFFFF') : G.muted) }]}>
                  <Text style={{ color: myTurns ? '#fff' : (on ? (isDark ? '#F2F2EF' : '#34343A') : '#fff'), fontSize: 11, fontWeight: '800' }}>{n}</Text>
                </View> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Scroll style={panel ? { flex: 1 } : sheetScrollFill} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {step === 'pick' ? (
          <>
            <ScoreStrip conversationId={conversationId} conversationType={conversationType} members={members} currentEmail={currentEmail}
              t={t} isDark={isDark} refreshKey={scoreKey} onPress={() => go('score')} />
            {tab === 'play' ? (
              <>
                {contRow ? <Text style={[st.section, { color: G.muted }]}>{tr(t, 'games.panel.continue', 'Continue')}</Text> : null}
                {contRow}
                <Text style={[st.section, { color: G.muted }]}>{tr(t, 'games.panel.playNow', 'Jogar agora')}</Text>
                <View style={st.grid}>
                  {types.map((tp) => (
                    <GameTile key={tp} type={tp} t={t} G={G} isDark={!!isDark} rm={rm} busy={busy} cat={cat} isGroup={isGroup}
                      onPick={() => pick(tp)} onRules={() => showRules(tp)} />
                  ))}
                </View>
                {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={G.text} /> : null}
              </>
            ) : null}
            {tab === 'open' ? (
              <>
                <Text style={[st.section, { color: G.muted }]}>{tr(t, 'games.inProgress', 'Em andamento')}</Text>
                {active.length ? active.map((g) => (
                  <View key={g.g} style={{ marginBottom: 10 }}>
                    <ContinueCard g={g} t={t} me={me} rm={rm} cat={cat} wide onPress={() => openGame(g)} />
                  </View>
                )) : <Text style={[st.empty, { color: G.muted }]}>{tr(t, 'games.panel.noOpen', 'Nenhuma partida em andamento. Escolha um jogo em Jogar.')}</Text>}
              </>
            ) : null}
            {tab === 'hist' ? (
              <>
                <View style={[st.sectionRow]}>
                  <Text style={[st.section, { color: G.muted, flex: 1 }]}>{tr(t, 'games.panel.last', 'Últimas partidas')}</Text>
                  {canHide && recent.length ? (
                    <Pressable onPress={hideAll} hitSlop={8} accessibilityRole="button" style={{ marginTop: 14 }}>
                      <Text style={{ color: G.text, fontSize: 12.5, fontWeight: '700' }}>{tr(t, 'games.pick.clear', 'Limpar')}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {recent.length ? recent.map(histRow) : <Text style={[st.empty, { color: G.muted }]}>{tr(t, 'games.panel.noHistory', 'As partidas encerradas aparecem aqui.')}</Text>}
                {recent.length && canHide && panel ? <Text style={[st.swipeHint, { color: G.muted }]}>{tr(t, 'games.panel.swipeHint', 'Arraste uma partida para o lado para apagar')}</Text> : null}
              </>
            ) : null}
          </>
        ) : null}

        {step === 'players' ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[st.section, { color: G.muted, flex: 1 }]}>{rangeText}</Text>
              <Pressable onPress={() => showRules(type)} hitSlop={8} accessibilityRole="button" style={[st.rulesChip, { backgroundColor: G.surface2 }]}>
                <Text style={{ color: G.text, fontWeight: '700', fontSize: 12.5 }}>{tr(t, 'games.rules.button', 'Regras')}</Text>
              </Pressable>
            </View>
            {type === 'quiz' ? (
              <View style={[st.openRow, { borderColor: G.line }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: G.text, fontWeight: '700', fontSize: 14.5 }}>{tr(t, 'games.pick.openTitle', 'Aberto ao grupo')}</Text>
                  <Text style={{ color: G.muted, fontSize: 12.5 }}>{tr(t, 'games.pick.openSub', 'Quem quiser entra pelo cartão; você começa quando quiser')}</Text>
                </View>
                <Switch value={open} onValueChange={(v) => { hTap(); setOpen(v); }} trackColor={{ true: isDark ? '#fff' : '#111', false: undefined }} thumbColor={Platform.OS === 'android' ? (open && isDark ? '#111' : '#fff') : undefined} />
              </View>
            ) : null}
            {others.map((m) => {
              const on = sel.includes(m.e);
              return (
                <Pressable key={m.e} onPress={() => toggle(m.e)} style={({ pressed }) => [st.memRow, { borderBottomColor: G.line }, pressed && { opacity: 0.7 }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                  <AvatarCircle email={m.e} name={m.n} size={36} />
                  <Text style={{ color: G.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{m.n}</Text>
                  <View style={[st.check, { borderColor: on ? G.text : G.line, backgroundColor: on ? G.text : 'transparent' }]}>
                    {on ? <View style={{ width: 10, height: 5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: pal.onStrong, transform: [{ rotate: '-45deg' }, { translateY: -1 }] }} /> : null}
                  </View>
                </Pressable>
              );
            })}
            {!others.length ? <Text style={{ color: G.muted, marginVertical: 14 }}>{tr(t, 'games.pick.noMembers', 'Carregando membros do grupo...')}</Text> : null}
          </>
        ) : null}

        {step === 'rules' && rulesType ? <View style={{ marginHorizontal: -16 }}><RulesBody type={rulesType} t={t} pal={pal} maxH={2000} /></View> : null}
        {step === 'score' ? <ScoreboardList conversationId={conversationId} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark} /> : null}
        {err ? <Text style={[st.err]}>{err}</Text> : null}
      </Scroll>

      {step === 'players' ? (
        <PressScale rm={rm} disabled={!canInvite || busy} onPress={() => { hTap(); create(type, sel, open); }}
          style={[st.cta, { backgroundColor: isDark ? '#F2F2EF' : '#34343A', opacity: canInvite && !busy ? 1 : 0.4 }]} accessibilityRole="button">
          {busy ? <ActivityIndicator color={isDark ? '#0E0E10' : '#fff'} /> : (
            <Text style={{ color: isDark ? '#0E0E10' : '#fff', fontWeight: '800', fontSize: 15.5 }}>
              {open && !sel.length ? tr(t, 'games.pick.createOpen', 'Criar e chamar o grupo') : tr(t, 'games.pick.invite', 'Convidar ({n})', { n: sel.length })}
            </Text>
          )}
        </PressScale>
      ) : null}
    </Wrap>
  );
}

const st = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10 },
  backBtn: { paddingVertical: 2 },
  title: { flex: 1, fontSize: 19, fontWeight: '800' },
  titleBig: { flex: 1, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 10 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999 },
  tabTx: { fontSize: 13.5, fontWeight: '700' },
  tabN: { minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 14, marginBottom: 8, marginHorizontal: 2 },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-start' },
  contScroll: { marginHorizontal: -16 },
  contRow: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  cc: { borderRadius: 22, padding: 14, overflow: 'hidden', minHeight: 112 },
  ccWide: { minHeight: 104 },
  ccArt: { position: 'absolute', right: -14, top: -10 },
  ccTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 17, marginRight: 84 },
  ccSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2, marginRight: 84 },
  turn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, maxWidth: '100%' },
  turnDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: WIN },
  turnTx: { fontSize: 12.5, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  tile: { width: '48.5%', borderRadius: 22, overflow: 'hidden' },
  cover: { height: 92, alignItems: 'center', justifyContent: 'center' },
  newBadge: { position: 'absolute', top: 9, left: 9, backgroundColor: '#FFFFFF', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  newTx: { color: '#18181B', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.3 },
  tileIn: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  tileTitle: { fontSize: 15, fontWeight: '800' },
  tileSub: { fontSize: 12.5, marginTop: 2, lineHeight: 16, minHeight: 32 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  tileMeta: { fontSize: 11.5, fontWeight: '600', flexShrink: 1 },
  play: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  h: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  hIc: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  res: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  swBack: { backgroundColor: LOSS, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  swIn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swTx: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  swipeHint: { fontSize: 12, textAlign: 'center', marginTop: 10 },
  empty: { fontSize: 14, textAlign: 'center', marginTop: 18, paddingHorizontal: 18, lineHeight: 19 },
  rulesChip: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5, marginTop: 6 },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  err: { color: '#DC2626', marginTop: 10, fontSize: 13.5, textAlign: 'center' },
  cta: { marginHorizontal: 16, marginTop: 8, marginBottom: 8, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
});
