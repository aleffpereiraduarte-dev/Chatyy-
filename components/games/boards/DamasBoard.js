// components/games/boards/DamasBoard.js — [jogos 2026-10-18] Damas (regras brasileiras) 8×8.
// O servidor manda `legal` = lista de caminhos completos [origem, pouso1, pouso2...] (captura
// obrigatória e de maior quantidade já aplicadas). Toque na peça → casas possíveis acendem; numa
// cadeia de capturas toque cada pouso em sequência; o lance vai quando o caminho fica completo.
// Peças animam pelo caminho (Reanimated); capturadas somem; último lance fica marcado.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Text, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, Easing } from 'react-native-reanimated';
import { IconCrown } from '../GameIcons';
import { hTap, hMove, hCapture } from '../fx';
import { tr } from '../../../services/games';

function initPieces(bd) {
  const out = [];
  for (let i = 0; i < 64; i++) { const ch = bd[i]; if (ch && ch !== '.') out.push({ id: 'p' + i, sq: i, ch }); }
  return out;
}

function Piece({ p, cell, flip, selected, hint, pal }) {
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
  const lastMv = useRef(p.mv || 0);
  useEffect(() => {
    if ((p.mv || 0) !== lastMv.current && Array.isArray(p.path) && p.path.length > 1) {
      lastMv.current = p.mv || 0;
      const steps = p.path.slice(1).map(pos);
      const d = steps.length > 1 ? 170 : 210;
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
  useEffect(() => { if (p.dead) { op.value = withTiming(0, { duration: 320 }); sc.value = withTiming(0.4, { duration: 320 }); } }, [p.dead]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sc.value = withSpring(selected ? 1.08 : 1, { damping: 14 }); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: sc.value }], opacity: op.value }));
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
          {king ? <IconCrown size={d * 0.42} color={white ? '#111111' : '#FAFAFA'} /> : null}
        </View>
      </View>
      {hint ? <View style={{ position: 'absolute', width: d + 8, height: d + 8, borderRadius: d, borderWidth: 2, borderColor: pal.strong, opacity: 0.35 }} /> : null}
    </Animated.View>
  );
}

export default function DamasBoard({ view, onMove, pal, busy, t }) {
  const { width } = useWindowDimensions();
  const S = view.state || {};
  const bd = typeof S.bd === 'string' && S.bd.length === 64 ? S.bd : '.'.repeat(64);
  const legal = Array.isArray(S.legal) ? S.legal : [];
  const flip = view.me === 1;
  const size = Math.min(width - 24, 440);
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
        next = prev.map((p) => {
          if (p === mover) return { ...p, sq: to, ch: bd[to], path: last.p, mv: (p.mv || 0) + 1 };
          if (caps.has(p.sq)) return { ...p, dead: true };
          return p;
        });
        const live = next.filter((p) => !p.dead);
        const cnt = bd.split('').filter((c) => c !== '.').length;
        if (live.length !== cnt || !live.every((p) => bd[p.sq] && bd[p.sq].toLowerCase() === p.ch.toLowerCase())) next = null;
      }
      if (next) { if (caps.size) hCapture(); else hMove(); }
    }
    const fin = next || initPieces(bd);
    setPieces(fin);
    if (fin.some((p) => p.dead)) setTimeout(() => setPieces((cur) => cur.filter((p) => !p.dead)), 380);
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
            <Piece key={p.id} p={p} cell={cell} flip={flip} pal={pal}
              selected={sel[0] === p.sq && !p.dead}
              hint={myTurn && !sel.length && origins.has(p.sq) && !p.dead} />
          ))}
        </View>
      </View>
    </View>
  );
}
