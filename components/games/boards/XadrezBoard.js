// components/games/boards/XadrezBoard.js — [jogos3 2026-10-22] Xadrez 8×8 com regras completas.
// O servidor valida TUDO (api/games_engine_xadrez.php): manda `legal` = {origem: [destinos]} só para quem tem
// a vez; o app desenha, acende as casas possíveis e envia {from, to, promo?}. Roque/en passant/promoção/xeque/
// mate/afogamento/repetição/50 lances/material insuficiente = servidor.
// - toque na peça → destinos acendem (ponto = casa livre, anel = captura); toque no destino = lance;
// - promoção: escolha inline sobre o tabuleiro (dama/torre/bispo/cavalo) — nada de Modal;
// - a peça do último lance desliza da origem (Reanimated, UI thread); Reduzir Movimento = aparece;
// - pretas veem o tabuleiro girado; casa do rei em xeque fica vermelha; último lance em dourado leve.
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { ChessPiece } from './chessPieces';
import { hTap, hMove, hCapture, hLast } from '../fx';
import { useRM, PressScale } from '../motion';
import { tr, nameOf } from '../../../services/games';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PROMOS = ['q', 'r', 'b', 'n'];
const SEL = 'rgba(120,170,255,0.50)';   // azul claro só no detalhe da seleção
const LASTC = 'rgba(255,205,60,0.34)';

function sqColors(dark) {
  return dark ? { L: '#7C7F87', D: '#45484F', coordL: '#45484F', coordD: '#9A9DA4' } : { L: '#ECEAE4', D: '#8E939D', coordL: '#8E939D', coordD: '#ECEAE4' };
}

const MovingPiece = memo(function MovingPiece({ ch, x, y, fx, fy, cell, rm, animate }) {
  const dx = useSharedValue(animate && !rm ? fx - x : 0);
  const dy = useSharedValue(animate && !rm ? fy - y : 0);
  useEffect(() => {
    if (animate && !rm) {
      const e = { duration: 210, easing: Easing.out(Easing.cubic) };
      dx.value = withTiming(0, e); dy.value = withTiming(0, e);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }, { translateY: dy.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x, top: y, width: cell, height: cell, alignItems: 'center', justifyContent: 'center', zIndex: animate ? 3 : 1 }, st]}>
      <ChessPiece ch={ch} size={cell * 0.9} />
    </Animated.View>
  );
});

function CapRow({ caps, diff, pal, h }) {
  const sorted = String(caps || '').split('').filter(Boolean).sort((a, b) => (VAL[b.toLowerCase()] || 0) - (VAL[a.toLowerCase()] || 0));
  return (
    <View style={{ height: h, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' }}>
      {sorted.map((c, i) => <View key={i} style={{ marginRight: -h * 0.32 }}><ChessPiece ch={c} size={h} /></View>)}
      {diff > 0 ? <Text style={{ color: pal.sub, fontWeight: '800', fontSize: 12, marginLeft: sorted.length ? h * 0.45 : 0 }}>+{diff}</Text> : null}
    </View>
  );
}

function endText(t, xend) {
  if (xend === 'mate') return tr(t, 'games.xadrez.end.mate', 'Xeque-mate');
  if (xend === 'stalemate') return tr(t, 'games.xadrez.end.stalemate', 'Afogamento: empate');
  if (xend === 'threefold') return tr(t, 'games.xadrez.end.threefold', 'Tripla repetição: empate');
  if (xend === 'fifty') return tr(t, 'games.xadrez.end.fifty', 'Regra dos 50 lances: empate');
  if (xend === 'material') return tr(t, 'games.xadrez.end.material', 'Material insuficiente: empate');
  return '';
}

export default function XadrezBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const b = typeof S.b === 'string' && S.b.length === 64 ? S.b : '.'.repeat(64);
  // {origem: [destinos]} — o PHP vira lista quando as origens são 0..n-1 seguidas: índice da lista = casa, serve igual
  const legal = S.legal && typeof S.legal === 'object' ? S.legal : {};
  const seat = view.me === 0 || view.me === 1 ? view.me : null;
  const flip = seat === 1;
  const width = maxW || win.width;
  const outer = Math.max(200, Math.min(width - 16, 460) - 70);
  const cell = outer / 8;
  const C = sqColors(!!pal.dark);
  const [sel, setSel] = useState(-1);
  const [promo, setPromo] = useState(null); // {from, to}
  const myTurn = view.status === 'active' && seat !== null && S.turn === seat && Object.keys(legal).length > 0;
  const last = S.last && Number.isInteger(S.last.f) ? S.last : null;
  const moves = Number(S.moves) || 0;

  // tabuleiro novo do servidor: limpa seleção + som/háptico do lance (não na abertura)
  const seenMoves = useRef(moves);
  useEffect(() => {
    if (moves === seenMoves.current) return;
    seenMoves.current = moves;
    setSel(-1); setPromo(null);
    if (!last) return;
    if (S.chk >= 0) hLast(); else if (last.cap) hCapture(); else hMove();
  }, [moves]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mountedMoves] = useState(moves); // abrir a partida não anima o último lance

  const targets = useMemo(() => new Set(sel >= 0 && Array.isArray(legal[String(sel)]) ? legal[String(sel)] : []), [sel, legal]);
  const pos = (sq) => { let r = Math.floor(sq / 8); let c = sq % 8; if (flip) { r = 7 - r; c = 7 - c; } return { x: c * cell, y: r * cell }; };

  const tap = (sq) => {
    if (busy || !myTurn || promo) return;
    if (legal[String(sq)]) { hTap(); setSel(sel === sq ? -1 : sq); return; }
    if (sel >= 0 && targets.has(sq)) {
      const p = b[sel];
      const isPawn = p === 'P' || p === 'p';
      const row = Math.floor(sq / 8);
      if (isPawn && (row === 0 || row === 7)) { hTap(); setPromo({ from: sel, to: sq }); return; }
      hTap();
      onMove({ from: sel, to: sq });
      return;
    }
    if (sel >= 0) setSel(-1);
  };
  const doPromo = (k) => {
    if (!promo) return;
    hTap();
    const m = { from: promo.from, to: promo.to, promo: k };
    setPromo(null);
    onMove(m);
  };

  const squares = [];
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = flip ? 7 - vr : vr; const c = flip ? 7 - vc : vc;
      const sq = r * 8 + c;
      const light = ((r + c) & 1) === 0;
      const isT = targets.has(sq);
      const occupied = b[sq] !== '.' || (isT && (b[sel] === 'P' || b[sel] === 'p') && c !== sel % 8);
      squares.push(
        <Pressable key={sq} onPress={() => tap(sq)}
          accessibilityRole="button" accessibilityLabel={`${String.fromCharCode(97 + c)}${8 - r}`}
          style={{ position: 'absolute', left: vc * cell, top: vr * cell, width: cell, height: cell, backgroundColor: light ? C.L : C.D, alignItems: 'center', justifyContent: 'center' }}>
          {last && (sq === last.f || sq === last.t) ? <View style={[StyleSheet.absoluteFill, { backgroundColor: LASTC }]} /> : null}
          {S.chk === sq ? <View style={{ position: 'absolute', width: cell * 0.96, height: cell * 0.96, borderRadius: cell, backgroundColor: 'rgba(229,72,77,0.55)' }} /> : null}
          {sel === sq ? <View style={[StyleSheet.absoluteFill, { backgroundColor: SEL }]} /> : null}
          {isT ? (occupied
            ? <View style={{ position: 'absolute', width: cell * 0.92, height: cell * 0.92, borderRadius: cell, borderWidth: Math.max(2.5, cell * 0.08), borderColor: 'rgba(20,20,24,0.32)' }} />
            : <View style={{ width: cell * 0.3, height: cell * 0.3, borderRadius: cell, backgroundColor: 'rgba(20,20,24,0.30)' }} />) : null}
          {vc === 0 ? <Text style={[st.coordR, { color: light ? C.coordL : C.coordD, fontSize: Math.max(8, cell * 0.2) }]}>{8 - r}</Text> : null}
          {vr === 7 ? <Text style={[st.coordF, { color: light ? C.coordL : C.coordD, fontSize: Math.max(8, cell * 0.2) }]}>{String.fromCharCode(97 + c)}</Text> : null}
        </Pressable>,
      );
    }
  }
  const pieces = [];
  for (let sq = 0; sq < 64; sq++) {
    const ch = b[sq];
    if (ch === '.') continue;
    const p = pos(sq);
    const isMoved = last && sq === last.t && moves !== mountedMoves;
    const fp = last ? pos(last.f) : p;
    pieces.push(<MovingPiece key={isMoved ? 'mv' + moves : sq + ch} ch={ch} x={p.x} y={p.y} fx={fp.x} fy={fp.y} cell={cell} rm={rm} animate={!!isMoved} />);
  }

  // capturas e diferença de material (cap[0] = o que as brancas comeram)
  const caps = Array.isArray(S.cap) ? S.cap : ['', ''];
  const matOf = (s) => String(s || '').split('').reduce((a, c) => a + (VAL[c.toLowerCase()] || 0), 0);
  const mySide = seat === null ? 0 : seat;
  const oppSide = 1 - mySide;
  const diff = matOf(caps[mySide]) - matOf(caps[oppSide]);
  const capH = Math.max(14, Math.round(cell * 0.36));

  let hint = '';
  let strong = false;
  if (view.status === 'active') {
    const oppE = (view.seats || [])[oppSide];
    if (seat !== null && S.turn === seat) { hint = S.chk >= 0 ? tr(t, 'games.xadrez.checkYou', 'Xeque! Proteja o rei') : tr(t, 'games.xadrez.yourTurn', 'Sua vez: toque numa peça'); strong = true; }
    else if (seat !== null) hint = tr(t, 'games.status.turnOf', 'Vez de {name}', { name: nameOf(view, view.turn || oppE, me, t) });
    else hint = S.turn === 0 ? tr(t, 'games.xadrez.whiteToMove', 'Vez das brancas') : tr(t, 'games.xadrez.blackToMove', 'Vez das pretas');
  } else if (S.xend) { hint = endText(t, S.xend); strong = true; }
  const hist = Array.isArray(S.hist) ? S.hist : [];
  const histTx = hist.slice(-10).map((m, i, arr) => { const k = hist.length - arr.length + i; return (k % 2 === 0 ? `${k / 2 + 1}. ` : '') + m; }).join('  ');
  const myColor = seat === 1 ? tr(t, 'games.xadrez.black', 'pretas') : tr(t, 'games.xadrez.white', 'brancas');

  return (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      <View style={{ width: outer }}><CapRow caps={caps[oppSide]} diff={-diff} pal={pal} h={capH} /></View>
      <View style={{ width: outer, height: outer, borderRadius: 10, overflow: 'hidden', marginVertical: 4,
        shadowColor: '#000', shadowOpacity: pal.dark ? 0.45 : 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 6 }}
        accessibilityLabel={tr(t, 'games.title.xadrez', 'Xadrez')}>
        {squares}
        {pieces}
        {promo ? (
          <View style={[StyleSheet.absoluteFill, st.promoWrap]}>
            <View style={[st.promoBox, { backgroundColor: pal.card, borderColor: pal.line }]}>
              <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 14, marginBottom: 8 }}>{tr(t, 'games.xadrez.promoTitle', 'Promover para')}</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {PROMOS.map((k) => (
                  <PressScale key={k} rm={rm} onPress={() => doPromo(k)} style={[st.promoBtn, { width: cell * 1.15, height: cell * 1.15, backgroundColor: pal.card2 }]}
                    accessibilityRole="button" accessibilityLabel={tr(t, 'games.xadrez.piece.' + k, { q: 'Dama', r: 'Torre', b: 'Bispo', n: 'Cavalo' }[k])}>
                    <ChessPiece ch={seat === 1 ? k : k.toUpperCase()} size={cell * 0.95} />
                  </PressScale>
                ))}
              </View>
              <Pressable onPress={() => { hTap(); setPromo(null); }} hitSlop={8} style={{ marginTop: 10 }} accessibilityRole="button">
                <Text style={{ color: pal.sub, fontWeight: '700' }}>{tr(t, 'games.xadrez.promoCancel', 'Cancelar')}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
      <View style={{ width: outer }}><CapRow caps={caps[mySide]} diff={diff} pal={pal} h={capH} /></View>
      {hint ? <Text style={{ color: strong ? (S.chk >= 0 && view.status === 'active' ? pal.bad : pal.ink) : pal.sub, fontWeight: strong ? '800' : '600', fontSize: 14, marginTop: 6 }}>{hint}</Text> : null}
      {seat !== null && view.status === 'active' && moves < 2 ? <Text style={{ color: pal.sub, fontSize: 12, marginTop: 2 }}>{tr(t, 'games.xadrez.youPlay', 'Você joga com as {color}', { color: myColor })}</Text> : null}
      {histTx ? <Text style={{ color: pal.sub, fontSize: 12, marginTop: 4, width: outer, textAlign: 'center', fontVariant: ['tabular-nums'] }} numberOfLines={1} ellipsizeMode="head">{histTx}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  coordR: { position: 'absolute', left: 2, top: 1, fontWeight: '700' },
  coordF: { position: 'absolute', right: 3, bottom: 0, fontWeight: '700' },
  promoWrap: { backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  promoBox: { borderRadius: 16, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  promoBtn: { borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
