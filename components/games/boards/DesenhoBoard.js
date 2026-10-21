// components/games/boards/DesenhoBoard.js — [jogos2b 2026-10-21] Desenha e Adivinha.
// 4 rodadas alternando quem desenha, 60 s cada (relógio do servidor). Quem desenha vê a palavra; quem
// adivinha só a categoria e o tamanho (o servidor não manda a palavra para ele antes da revelação).
// Quadro: react-native-svg + gesto (RNGH Pan). O traço VIVO roda na UI thread (Path animado, worklet);
// ao levantar o dedo os pontos (0..1000, já reduzidos) vão em lotes pelo HTTP do jogo (chat_game_move
// {a:'draw'}), em fila, ≤ 380 pontos por lote; o outro recebe pelo game_update do WS. Limite do servidor:
// 2500 pontos por rodada. Chute por teclado PRÓPRIO na tela (acerto sem acento/maiúsculas no servidor).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedProps, useAnimatedStyle, withSequence, withTiming, withSpring, runOnJS } from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';
import { tr, nameOf, gameMove, getGameView } from '../../../services/games';
import { hTap, hOk, hErr, hWin, hReveal } from '../fx';
import { PressScale, useRM } from '../motion';
import { GameKeys, useSecsLeft, useDeadlineTick, TimePill } from './novosKit';

let GH = null;
try { GH = require('react-native-gesture-handler'); } catch { GH = null; }
const IS_WEB = Platform.OS === 'web';
const APath = Animated.createAnimatedComponent(Path);
const INKS = (pal) => [pal.dark ? '#F2F2EF' : '#18181B', '#E5484D', '#2F6FEB', '#22A55B', '#F0B400', '#8B5CF6'];
const WIDTHS = [6, 12, 22, 36];
const CHUNK = 380;
const MIN_STEP = 12; // unidades (de 1000) entre pontos

function ptsToD(p) {
  if (!p || p.length < 2) return '';
  let d = `M${p[0]} ${p[1]}`;
  if (p.length === 2) return d + ` L${p[0] + 0.5} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += ` L${p[i]} ${p[i + 1]}`;
  return d;
}

function UndoIcon({ color }) {
  return <Svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><Path d="M9 14L4 9l5-5" /><Path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Svg>;
}
function TrashIcon({ color }) {
  return <Svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><Path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5h6V7" /></Svg>;
}

/** Quadro de desenho. `canDraw` = sou quem desenha nesta rodada. */
function Canvas({ size, strokes, pal, canDraw, color, width, onStroke }) {
  const live = useSharedValue('');
  const pts = useSharedValue([]);
  const [webLive, setWebLive] = useState('');
  const k = 1000 / size;
  const finish = useCallback((arr) => { live.value = ''; setWebLive(''); onStroke(arr); }, [onStroke, live]);
  const gesture = useMemo(() => {
    if (!GH || !canDraw) return null;
    return GH.Gesture.Pan().minDistance(0).maxPointers(1)
      .onBegin((e) => {
        'worklet';
        const x = Math.round(Math.max(0, Math.min(1000, e.x * k))); const y = Math.round(Math.max(0, Math.min(1000, e.y * k)));
        pts.value = [x, y];
        live.value = `M${x} ${y} L${x + 0.5} ${y}`;
        if (IS_WEB) runOnJS(setWebLive)(live.value);
      })
      .onUpdate((e) => {
        'worklet';
        const a = pts.value;
        const n = a.length;
        const x = Math.round(Math.max(0, Math.min(1000, e.x * k))); const y = Math.round(Math.max(0, Math.min(1000, e.y * k)));
        if (n >= 2) { const dx = x - a[n - 2]; const dy = y - a[n - 1]; if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) return; }
        if (n >= 2 * 1200) return; // traço gigante: corta (o servidor tem teto por rodada)
        pts.value = a.concat([x, y]);
        live.value = `${live.value} L${x} ${y}`;
        if (IS_WEB) runOnJS(setWebLive)(live.value);
      })
      .onFinalize(() => {
        'worklet';
        const a = pts.value;
        pts.value = [];
        if (a && a.length >= 2) runOnJS(finish)(a.slice());
      });
  }, [canDraw, k, finish, pts, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const ap = useAnimatedProps(() => ({ d: live.value || 'M-10 -10' }));
  const inks = INKS(pal);
  const art = (
    <View style={{ width: size, height: size, borderRadius: 18, overflow: 'hidden', backgroundColor: pal.dark ? '#1A1A1D' : '#FFFFFF', borderWidth: 1, borderColor: pal.line }} collapsable={false}>
      <Svg width={size} height={size} viewBox="0 0 1000 1000" pointerEvents="none">
        <Rect x="0" y="0" width="1000" height="1000" fill="transparent" />
        {strokes.map((s, i) => (
          <Path key={i} d={ptsToD(s.p)} stroke={inks[s.c] || inks[0]} strokeWidth={WIDTHS[s.w] || WIDTHS[1]} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}
        {canDraw ? (IS_WEB
          ? (webLive ? <Path d={webLive} stroke={inks[color]} strokeWidth={WIDTHS[width]} strokeLinecap="round" strokeLinejoin="round" fill="none" /> : null)
          : <APath animatedProps={ap} stroke={inks[color]} strokeWidth={WIDTHS[width]} strokeLinecap="round" strokeLinejoin="round" fill="none" />) : null}
      </Svg>
    </View>
  );
  if (!gesture) return art;
  return <GH.GestureDetector gesture={gesture}>{art}</GH.GestureDetector>;
}

function RevealCard({ S, pal, t, rm, isDrawer, oppName, meSeat }) {
  const s = useSharedValue(rm ? 1 : 0.6);
  useEffect(() => { if (!rm) s.value = withSequence(withTiming(1.08, { duration: 220 }), withSpring(1, { damping: 10, stiffness: 180 })); }, [S.r]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }], opacity: Math.min(1, s.value) }));
  const got = S.got;
  const myPts = got ? (isDrawer ? got.dp : got.gp) : 0;
  return (
    <Animated.View style={[sx.reveal, { backgroundColor: got ? pal.strong : pal.card2 }, st]}>
      <Text style={{ color: got ? pal.onStrong : pal.ink, fontSize: 13, fontWeight: '700' }}>
        {got ? (isDrawer ? tr(t, 'games.desenho.theyGot', '{name} acertou!', { name: oppName }) : (meSeat === null || meSeat === undefined ? tr(t, 'games.desenho.gotIt', 'Acertou!') : tr(t, 'games.desenho.youGot', 'Você acertou!'))) : tr(t, 'games.desenho.timeUp', 'Ninguém acertou')}
      </Text>
      <Text style={{ color: got ? pal.onStrong : pal.ink, fontSize: 24, fontWeight: '900', marginTop: 2 }}>{String(S.word || '').toUpperCase()}</Text>
      {got && meSeat !== null && meSeat !== undefined ? <Text style={{ color: got ? pal.onStrong : pal.ink, fontSize: 13, fontWeight: '800', marginTop: 2 }}>+{myPts}</Text> : null}
    </Animated.View>
  );
}

export default function DesenhoBoard({ view, onMove, pal, busy, t, me, maxW, offset, onTick }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const W = Math.min(maxW || win.width, 560) - 24;
  const meSeat = view.me;
  const isPlayer = meSeat !== null && meSeat !== undefined;
  const oSeat = isPlayer ? 1 - meSeat : 1;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const oppName = seats[oSeat] ? nameOf(view, seats[oSeat], me, t) : '';
  const active = view.status === 'active';
  const ph = S.ph || 'draw';
  const isDrawer = isPlayer && S.drawer === meSeat;
  const drawing = active && ph === 'draw';
  const [color, setColor] = useState(0);
  const [width, setWidth] = useState(1);
  const [guess, setGuess] = useState('');
  const [note, setNote] = useState('');
  const sc = Array.isArray(S.sc) ? S.sc : [0, 0];

  // prazos
  const secs = useSecsLeft(S.dl, offset, drawing);
  const due = ph === 'draw' ? Number(S.dl) + 1500 : ph === 'reveal' ? Number(S.rv) : 0;
  useDeadlineTick(due, offset, active, onTick);
  const prevPh = useRef(ph);
  useEffect(() => {
    if (ph === 'reveal' && prevPh.current === 'draw') { if (S.got) { if (isDrawer || isPlayer) hWin(); } else hReveal(); }
    if (ph === 'draw' && prevPh.current === 'reveal') { hTap(); setGuess(''); setNote(''); }
    prevPh.current = ph;
  }, [ph]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── fila de traços (quem desenha) ────────────────────────────────────────
  const [pending, setPending] = useState([]); // traços ainda não confirmados pelo servidor
  const queue = useRef([]);
  const sending = useRef(false);
  const idRef = useRef(Date.now() % 100000);
  const roundRef = useRef(S.r);
  roundRef.current = S.r;
  const pump = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length) {
        const batch = []; let n = 0;
        while (queue.current.length && n + queue.current[0].p.length / 2 <= CHUNK) { const s = queue.current.shift(); n += s.p.length / 2; batch.push(s); }
        if (!batch.length) batch.push(queue.current.shift());
        const v = getGameView(view.g);
        if (!v || v.status !== 'active') { queue.current = []; break; }
        const r = await gameMove(view.g, v.v, { a: 'draw', r: roundRef.current, s: batch });
        if (!r || !r.success) {
          const code = String((r && r.message) || '');
          if (code === 'drawing_full') { hErr(); setNote(tr(t, 'games.desenho.full', 'Quadro cheio: desfaça ou limpe')); }
          const ids = new Set(batch.map((b) => b.id));
          setPending((p) => p.filter((x) => !ids.has(x.id)));
          if (code === 'stale_round' || code === 'not_accepting' || code === 'not_drawer') { queue.current = []; break; }
        }
      }
    } finally { sending.current = false; }
  }, [view.g, t]);
  const onStroke = useCallback((arr) => {
    if (!isDrawer || !drawing) return;
    const id = ++idRef.current;
    const pieces = [];
    for (let i = 0; i < arr.length; i += (CHUNK - 1) * 2) {
      const sl = arr.slice(Math.max(0, i - 2), i + CHUNK * 2); // repete o último ponto: as partes se ligam
      if (sl.length >= 2) pieces.push({ id, c: color, w: width, p: sl });
      if (i + CHUNK * 2 >= arr.length) break;
    }
    setPending((p) => p.concat(pieces));
    queue.current.push(...pieces);
    pump();
  }, [isDrawer, drawing, color, width, pump]);
  // confirmado pelo servidor → sai do pendente; rodada nova → zera
  const server = Array.isArray(S.strokes) ? S.strokes : [];
  const serverIds = useMemo(() => new Set(server.map((s) => s.id)), [server]);
  useEffect(() => { setPending((p) => (p.length ? p.filter((x) => !serverIds.has(x.id)) : p)); }, [serverIds]);
  useEffect(() => { setPending([]); queue.current = []; }, [S.r]);
  const strokes = isDrawer ? server.concat(pending) : server;

  const sendGuess = async () => {
    const g = guess.trim();
    if (!g || !drawing || isDrawer || !isPlayer) return;
    const ok = await onMove({ a: 'guess', r: S.r, w: g });
    if (ok) {
      const v = getGameView(view.g); const L = v && v.state && Array.isArray(v.state.guesses) ? v.state.guesses[v.state.guesses.length - 1] : null;
      if (L && L.ok) hOk(); else if (L && L.close) { hTap(); setNote(tr(t, 'games.desenho.close', 'Quase! Está perto')); } else hErr();
      setGuess('');
    }
  };
  const tool = (a) => { hTap(); if (a === 'skip') onMove({ a: 'skip', r: S.r }); else { queue.current = []; setPending([]); onMove({ a, r: S.r }); } };

  // tamanhos (painel ~64% da tela): quadro + teclado (quem chuta) ou ferramentas (quem desenha)
  const availH = Math.max(300, Math.min(win.height * 0.64, win.height - 300) - 90);
  const keyH = availH < 520 ? 34 : 40;
  const below = isDrawer ? 48 : (keyH * 3 + 10 + 70);
  const size = Math.max(150, Math.min(W, availH - below - 44));
  const inks = INKS(pal);
  const mask = Array.isArray(S.mask) ? S.mask : [];
  const guesses = Array.isArray(S.guesses) ? S.guesses : [];
  const word = S.word ? String(S.word).toUpperCase() : '';
  const a = isPlayer ? sc[meSeat] : sc[0]; const b = isPlayer ? sc[oSeat] : sc[1];

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 8, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 14.5 }} numberOfLines={1}>
            {isDrawer && drawing ? tr(t, 'games.desenho.draw', 'Desenhe: {w}', { w: word }) : (drawing ? (isPlayer ? tr(t, 'games.desenho.guessIt', 'O que {name} está desenhando?', { name: oppName }) : tr(t, 'games.desenho.watching', 'Desenhando...')) : tr(t, 'games.desenho.roundN', 'Rodada {r} de {n}', { r: (S.r || 0) + 1, n: S.rounds || 3 }))}
          </Text>
          <Text style={{ color: pal.sub, fontSize: 12.5 }} numberOfLines={1}>
            {tr(t, 'games.desenho.sub', '{cat} · rodada {r} de {n} · {a} x {b}', { cat: S.cat || '', r: (S.r || 0) + 1, n: S.rounds || 3, a, b })}
          </Text>
        </View>
        {drawing ? <TimePill secs={secs} pal={pal} /> : null}
      </View>
      <View>
        <Canvas size={size} strokes={strokes} pal={pal} canDraw={isDrawer && drawing} color={color} width={width} onStroke={onStroke} />
        {ph === 'reveal' || (!active && S.word) ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <RevealCard S={S} pal={pal} t={t} rm={rm} isDrawer={isDrawer} oppName={oppName} meSeat={meSeat} />
          </View>
        ) : null}
      </View>
      {isDrawer && drawing ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch', justifyContent: 'center' }}>
          {inks.map((c, i) => (
            <Pressable key={i} onPress={() => { hTap(); setColor(i); }} hitSlop={4} accessibilityRole="button" accessibilityLabel={tr(t, 'games.desenho.color', 'Cor {n}', { n: i + 1 })} accessibilityState={{ selected: color === i }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c, borderWidth: color === i ? 3 : 1, borderColor: color === i ? pal.ink : pal.line }} />
            </Pressable>
          ))}
          <Pressable onPress={() => { hTap(); setWidth((w) => (w + 1) % WIDTHS.length); }} hitSlop={4} style={[sx.tool, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.desenho.width', 'Espessura')}>
            <View style={{ width: 4 + width * 4, height: 4 + width * 4, borderRadius: 12, backgroundColor: pal.ink }} />
          </Pressable>
          <Pressable onPress={() => tool('undo')} hitSlop={4} style={[sx.tool, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.desenho.undo', 'Desfazer')}><UndoIcon color={pal.ink} /></Pressable>
          <Pressable onPress={() => tool('clear')} hitSlop={4} style={[sx.tool, { backgroundColor: pal.card }]} accessibilityRole="button" accessibilityLabel={tr(t, 'games.desenho.clear', 'Limpar')}><TrashIcon color={pal.ink} /></Pressable>
          <PressScale onPress={() => tool('skip')} rm={rm} style={[sx.skip, { borderColor: pal.line }]} accessibilityRole="button">
            <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 12.5 }}>{tr(t, 'games.desenho.skip', 'Pular')}</Text>
          </PressScale>
        </View>
      ) : null}
      {!isDrawer && drawing && isPlayer ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'center', minHeight: 26 }}>
            {guess ? <Text style={{ color: pal.ink, fontSize: 19, fontWeight: '900', letterSpacing: 2 }}>{guess}<Text style={{ color: pal.sub }}>|</Text></Text>
              : mask.map((ch, i) => <View key={i} style={{ width: ch === ' ' ? 10 : 14, height: 20, borderBottomWidth: ch ? 0 : 2.5, borderBottomColor: pal.sub, alignItems: 'center' }}>{ch === '-' ? <Text style={{ color: pal.sub }}>-</Text> : null}</View>)}
          </View>
          {guesses.length || note ? (
            <Text style={{ color: note ? pal.ink : pal.sub, fontSize: 12.5, fontWeight: note ? '800' : '500', textAlign: 'center' }} numberOfLines={1}>
              {note || guesses.slice(-4).map((g) => g.t).filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <GameKeys width={W} pal={pal} rm={rm} keyH={keyH} space disabled={busy}
            onKey={(k) => { setNote(''); setGuess((g) => (k === ' ' ? (g && !g.endsWith(' ') ? g + ' ' : g) : (g + k).slice(0, 30))); }}
            onBack={() => setGuess((g) => g.slice(0, -1))}
            onEnter={sendGuess} enterLabel={tr(t, 'games.desenho.guess', 'Chutar')} enterDisabled={!guess.trim()}
            backLabel={tr(t, 'games.keys.back', 'Apagar')} spaceLabel={tr(t, 'games.keys.space', 'espaço')} />
        </>
      ) : null}
      {isDrawer && drawing && guesses.length ? (
        <Text style={{ color: pal.sub, fontSize: 12.5, textAlign: 'center' }} numberOfLines={1}>
          {tr(t, 'games.desenho.theirGuesses', 'Chutes: {list}', { list: guesses.slice(-4).map((g) => g.t).filter(Boolean).join(' · ') })}
        </Text>
      ) : null}
      {note && isDrawer ? <Text style={{ color: pal.bad, fontSize: 12.5, fontWeight: '700' }}>{note}</Text> : null}
    </View>
  );
}

const sx = StyleSheet.create({
  tool: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  skip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  reveal: { borderRadius: 20, paddingHorizontal: 22, paddingVertical: 14, alignItems: 'center', minWidth: 180 },
});
