// components/games/boards/DamasBoard.js — [jogos 2026-10-18] Damas (regras brasileiras) 8×8.
// O servidor manda `legal` = lista de caminhos completos [origem, pouso1, pouso2...] (captura
// obrigatória e de maior quantidade já aplicadas). Toque na peça → casas possíveis acendem; numa
// cadeia de capturas toque cada pouso em sequência; o lance vai quando o caminho fica completo.
// Peças animam pelo caminho (Reanimated); capturadas somem; último lance fica marcado.
// Polish 2: a peça capturada estoura em partículas QUANDO a peça que captura passa por cima dela
// (atraso por passo do caminho); promoção a dama = coroa entra girando + anel dourado se expandindo.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Text, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, withDelay, Easing } from 'react-native-reanimated';
import { IconCrown } from '../GameIcons';
import { hTap, hMove, hCapture, hKing } from '../fx';
import { tr } from '../../../services/games';
import { useRM } from '../motion';

const STEP_MS = 170;
const ONE_MS = 210;
function stepMs(path) { return path && path.length > 2 ? STEP_MS : ONE_MS; }
/** Em qual passo do caminho a peça passa por cima da casa capturada (0 = primeiro salto). */
function captureStep(path, cap) {
  const cr = Math.floor(cap / 8); const cc = cap % 8;
  for (let k = 0; k + 1 < path.length; k++) {
    const r1 = Math.floor(path[k] / 8); const c1 = path[k] % 8; const r2 = Math.floor(path[k + 1] / 8); const c2 = path[k + 1] % 8;
    const dr = Math.sign(r2 - r1); const dc = Math.sign(c2 - c1);
    for (let r = r1 + dr, c = c1 + dc; r !== r2 && c !== c2; r += dr, c += dc) if (r === cr && c === cc) return k;
  }
  return 0;
}

// Partículas da captura: 1 progresso compartilhado, cada fagulha calcula posição/opacidade no worklet.
function Spark({ p, ang, dist, size, color }) {
  const st = useAnimatedStyle(() => ({
    opacity: p.value <= 0 ? 0 : 1 - p.value,
    transform: [{ translateX: Math.cos(ang) * dist * p.value }, { translateY: Math.sin(ang) * dist * p.value + 10 * p.value * p.value }, { scale: 1 - 0.6 * p.value }],
  }));
  return <Animated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color }, st]} />;
}
function Burst({ x, y, cell, delay, white, accent, onDone }) {
  const p = useSharedValue(0);
  const ring = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(delay, withTiming(1, { duration: 520, easing: Easing.out(Easing.quad) }));
    ring.value = withDelay(delay, withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) }));
    const tm = setTimeout(() => onDone && onDone(), delay + 560);
    return () => clearTimeout(tm);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sparks = useMemo(() => Array.from({ length: 12 }).map((_, i) => ({
    k: i, ang: (i / 12) * Math.PI * 2 + Math.random() * 0.4, dist: cell * (0.45 + Math.random() * 0.45), size: Math.max(3, cell * (0.07 + Math.random() * 0.06)),
    color: i % 3 === 0 ? accent : (white ? '#FAFAFA' : '#1A1A1A'),
  })), [cell]); // eslint-disable-line react-hooks/exhaustive-deps
  const ringSt = useAnimatedStyle(() => ({ opacity: ring.value <= 0 ? 0 : 0.8 * (1 - ring.value), transform: [{ scale: 0.4 + ring.value * 0.9 }] }));
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x, top: y, width: cell, height: cell, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: cell * 0.9, height: cell * 0.9, borderRadius: cell, borderWidth: 2.5, borderColor: accent }, ringSt]} />
      {sparks.map((s) => <Spark key={s.k} p={p} {...s} />)}
    </View>
  );
}

function initPieces(bd) {
  const out = [];
  for (let i = 0; i < 64; i++) { const ch = bd[i]; if (ch && ch !== '.') out.push({ id: 'p' + i, sq: i, ch }); }
  return out;
}

function Piece({ p, cell, flip, selected, hint, pal, rm }) {
  const pos = (sq) => {
    let r = Math.floor(sq / 8); let c = sq % 8;
    if (flip) { r = 7 - r; c = 7 - c; }
    return { x: c * cell, y: r * cell };
  };
  const start = pos(p.sq);
  const x = useSharedValue(start.x);
  const y = useSharedValue(start.y);
  const sc = useSharedValue(1);
  const op = useSharedValue(1);
  const crown = useSharedValue(1);
  const halo = useSharedValue(0);
  const lastMv = useRef(p.mv || 0);
  const wasKing = useRef(p.ch === 'W' || p.ch === 'B');
  // (antes do efeito do lance: o "pulo" do lance não pode ser sobrescrito pelo des-selecionar)
  useEffect(() => { sc.value = withSpring(selected ? 1.08 : 1, { damping: 14 }); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((p.mv || 0) !== lastMv.current && Array.isArray(p.path) && p.path.length > 1) {
      lastMv.current = p.mv || 0;
      const steps = p.path.slice(1).map(pos);
      const d = stepMs(p.path);
      const ease = { duration: d, easing: Easing.out(Easing.cubic) };
      x.value = steps.length === 1 ? withTiming(steps[0].x, ease) : withSequence(...steps.map((s) => withTiming(s.x, ease)));
      y.value = steps.length === 1 ? withTiming(steps[0].y, ease) : withSequence(...steps.map((s) => withTiming(s.y, ease)));
      sc.value = withSequence(withTiming(1.12, { duration: 90 }), withSpring(1, { damping: 14 }));
    } else {
      const q = pos(p.sq);
      x.value = withTiming(q.x, { duration: 160 });
      y.value = withTiming(q.y, { duration: 160 });
    }
  }, [p.sq, p.mv, flip, cell]); // eslint-disable-line react-hooks/exhaustive-deps
  // promoção: espera a peça chegar (passos × duração), coroa entra girando + anel dourado
  useEffect(() => {
    const k = p.ch === 'W' || p.ch === 'B';
    if (k && !wasKing.current) {
      const wait = Array.isArray(p.path) ? (p.path.length - 1) * stepMs(p.path) : 0;
      if (rm) { crown.value = 1; } else {
        crown.value = 0;
        crown.value = withDelay(wait, withSpring(1, { damping: 8, stiffness: 160 }));
        halo.value = 0;
        halo.value = withDelay(wait, withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) }));
      }
      setTimeout(() => hKing(), wait);
    }
    wasKing.current = k;
  }, [p.ch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p.dead) return;
    const dl = p.deadDelay || 0;
    op.value = withDelay(dl, withTiming(0, { duration: 260 }));
    sc.value = withDelay(dl, withTiming(0.3, { duration: 260 }));
  }, [p.dead]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: sc.value }], opacity: op.value }));
  const crownSt = useAnimatedStyle(() => ({ opacity: crown.value > 0.05 ? 1 : 0, transform: [{ scale: crown.value }, { rotate: `${(1 - crown.value) * -180}deg` }] }));
  const haloSt = useAnimatedStyle(() => ({ opacity: halo.value <= 0 || halo.value >= 1 ? 0 : 0.9 * (1 - halo.value), transform: [{ scale: 0.8 + halo.value * 0.9 }] }));
  const white = p.ch === 'w' || p.ch === 'W';
  const king = p.ch === 'W' || p.ch === 'B';
  const d = cell * 0.78;
  const face = white ? '#FAFAFA' : '#111111';
  const rim = white ? '#BDBDBD' : '#9A9A9E';
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: cell, height: cell, alignItems: 'center', justifyContent: 'center' }, st]}>
      <View style={{
        width: d, height: d, borderRadius: d / 2, backgroundColor: face, borderWidth: Math.max(2, cell * 0.05), borderColor: selected ? '#FFD60A' : rim,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 3,
      }}>
        <View style={{ width: d * 0.62, height: d * 0.62, borderRadius: d, borderWidth: 1.5, borderColor: white ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
          {king ? <Animated.View style={crownSt}><IconCrown size={d * 0.42} color={pal.accent} /></Animated.View> : null}
        </View>
      </View>
      <Animated.View style={[{ position: 'absolute', width: d, height: d, borderRadius: d, borderWidth: 3, borderColor: pal.accent }, haloSt]} />
      {hint ? <View style={{ position: 'absolute', width: d + 8, height: d + 8, borderRadius: d, borderWidth: 2, borderColor: pal.strong, opacity: 0.35 }} /> : null}
    </Animated.View>
  );
}

export default function DamasBoard({ view, onMove, pal, busy, t, maxW }) {
  const win = useWindowDimensions();
  const width = maxW || win.width;
  const rm = useRM();
  const [bursts, setBursts] = useState([]);
  const S = view.state || {};
  const bd = typeof S.bd === 'string' && S.bd.length === 64 ? S.bd : '.'.repeat(64);
  const legal = Array.isArray(S.legal) ? S.legal : [];
  const flip = view.me === 1;
  const size = Math.min(width - 24, maxW ? 620 : 440);
  const cell = size / 8;
  const [sel, setSel] = useState([]);
  const [pieces, setPieces] = useState(() => initPieces(bd));
  const prevBd = useRef(bd);
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;

  // novo tabuleiro do servidor → move a peça do último lance pelo caminho; capturadas somem
  useEffect(() => {
    if (bd === prevBd.current) return;
    prevBd.current = bd;
    setSel([]);
    const last = S.last;
    const prev = piecesRef.current.filter((p) => !p.dead);
    let next = null;
    if (last && Array.isArray(last.p) && last.p.length >= 2) {
      const from = last.p[0]; const to = last.p[last.p.length - 1];
      const caps = new Set(last.c || []);
      const mover = prev.find((p) => p.sq === from);
      if (mover) {
        const sm = stepMs(last.p);
        next = prev.map((p) => {
          if (p === mover) return { ...p, sq: to, ch: bd[to], path: last.p, mv: (p.mv || 0) + 1 };
          if (caps.has(p.sq)) return { ...p, dead: true, deadDelay: rm ? 0 : Math.round((captureStep(last.p, p.sq) + 0.55) * sm) };
          return p;
        });
        const live = next.filter((p) => !p.dead);
        const cnt = bd.split('').filter((c) => c !== '.').length;
        if (live.length !== cnt || !live.every((p) => bd[p.sq] && bd[p.sq].toLowerCase() === p.ch.toLowerCase())) next = null;
      }
      if (next) {
        if (caps.size) {
          hCapture();
          const dead = next.filter((p) => p.dead);
          if (!rm) {
            const pos = (sq) => { let r = Math.floor(sq / 8); let c = sq % 8; if (flip) { r = 7 - r; c = 7 - c; } return { x: c * cell, y: r * cell }; };
            setBursts((b) => b.concat(dead.map((p) => ({ id: p.id + ':' + Date.now(), ...pos(p.sq), delay: p.deadDelay || 0, white: p.ch === 'w' || p.ch === 'W' }))));
          }
          // 2ª batida no meio da cadeia de capturas (cada peça "cai" na hora)
          dead.slice(1).forEach((p) => setTimeout(() => hCapture(), p.deadDelay || 0));
        } else hMove();
      }
    }
    const fin = next || initPieces(bd);
    setPieces(fin);
    const maxDl = fin.reduce((m, p) => (p.dead ? Math.max(m, p.deadDelay || 0) : m), -1);
    if (maxDl >= 0) setTimeout(() => setPieces((cur) => cur.filter((p) => !p.dead)), maxDl + 300);
  }, [bd]); // eslint-disable-line react-hooks/exhaustive-deps

  const origins = useMemo(() => new Set(legal.map((p) => p[0])), [legal]);
  const cont = useMemo(() => legal.filter((p) => sel.length && sel.every((s, i) => p[i] === s)), [legal, sel]);
  const targets = useMemo(() => new Set(cont.map((p) => p[sel.length]).filter((x) => x !== undefined)), [cont, sel]);
  const lastSet = useMemo(() => new Set(S.last && Array.isArray(S.last.p) ? S.last.p : []), [S.last]);
  const capSet = useMemo(() => new Set(S.last && Array.isArray(S.last.c) ? S.last.c : []), [S.last]);
  const isCapture = legal.length > 0 && !!S.must_capture;

  const tap = (sq) => {
    if (busy) return;
    if (origins.has(sq) && (!sel.length || sel.length === 1)) { hTap(); setSel(sel[0] === sq ? [] : [sq]); return; }
    if (targets.has(sq)) {
      const ns = [...sel, sq];
      const exact = cont.find((p) => p.length === ns.length && p.every((v, i) => v === ns[i]));
      const more = cont.some((p) => p.length > ns.length && ns.every((v, i) => p[i] === v));
      hTap();
      if (exact && !more) { setSel(ns); onMove({ path: ns }); return; }
      setSel(ns);
      return;
    }
    if (sel.length) setSel([]);
  };

  const squares = [];
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = flip ? 7 - vr : vr; const c = flip ? 7 - vc : vc;
      const sq = r * 8 + c;
      const dark = ((r + c) & 1) === 1;
      const isT = targets.has(sq);
      const isSel = sel.includes(sq);
      squares.push(
        <Pressable key={sq} onPress={() => tap(sq)} disabled={!dark}
          accessibilityLabel={`${String.fromCharCode(97 + c)}${8 - r}`}
          style={{ position: 'absolute', left: vc * cell, top: vr * cell, width: cell, height: cell, backgroundColor: dark ? pal.boardDark : pal.boardLight, alignItems: 'center', justifyContent: 'center' }}>
          {dark && lastSet.has(sq) ? <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,214,10,0.22)' }} /> : null}
          {dark && capSet.has(sq) ? <View style={{ position: 'absolute', width: cell * 0.3, height: cell * 0.3, borderRadius: cell, borderWidth: 2, borderColor: 'rgba(255,90,90,0.75)' }} /> : null}
          {isSel && sel.length > 1 ? <View style={{ position: 'absolute', width: cell * 0.36, height: cell * 0.36, borderRadius: cell, backgroundColor: 'rgba(255,214,10,0.55)' }} /> : null}
          {isT ? <View style={{ width: cell * (isCapture ? 0.5 : 0.28), height: cell * (isCapture ? 0.5 : 0.28), borderRadius: cell, backgroundColor: isCapture ? 'transparent' : 'rgba(255,214,10,0.85)', borderWidth: isCapture ? 3 : 0, borderColor: 'rgba(255,214,10,0.9)' }} /> : null}
        </Pressable>,
      );
    }
  }
  const myTurn = legal.length > 0;
  return (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      <View style={{ height: 22, justifyContent: 'center' }}>
        {myTurn && isCapture ? <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13 }}>{tr(t, 'games.damas.mustCapture', 'Captura obrigatória')}</Text> : null}
      </View>
      <View style={{ width: size + 10, height: size + 10, padding: 5, borderRadius: 14, backgroundColor: pal.frame }}>
        <View style={{ width: size, height: size, borderRadius: 9, overflow: 'hidden' }}>
          {squares}
          {pieces.map((p) => (
            <Piece key={p.id} p={p} cell={cell} flip={flip} pal={pal} rm={rm}
              selected={sel[0] === p.sq && !p.dead}
              hint={myTurn && !sel.length && origins.has(p.sq) && !p.dead} />
          ))}
          {bursts.map((b) => (
            <Burst key={b.id} x={b.x} y={b.y} cell={cell} delay={b.delay} white={b.white} accent={pal.accent}
              onDone={() => setBursts((cur) => cur.filter((z) => z.id !== b.id))} />
          ))}
        </View>
      </View>
    </View>
  );
}
