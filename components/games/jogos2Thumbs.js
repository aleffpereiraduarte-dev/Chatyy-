// components/games/jogos2Thumbs.js — [jogos2 2026-10-21] miniatura AO VIVO no cartão da conversa para
// Ligue 4, Batalha Naval, Dominó e Jogo da Memória (a partida abre no painel; o cartão só mostra o resumo).
//  - Jogos2Thumb: render JS (components/games/GameInlineBoard.js → SheetThumb).
//  - jogos2NativeNodes: o mesmo desenho em nós da lista NATIVA (components/chat/nativeRowCards.js), só v/h/tx.
// Nada aqui revela informação escondida: usa a visão do PRÓPRIO jogador (meus barcos/mão) e o que é público.
import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { tr, nameOf } from '../../services/games';
import { L4_COLORS } from './boards/Ligue4Board';
import { MemoriaArt } from './boards/MemoriaBoard';

export const JOGOS2_TYPES = { ligue4: 1, naval: 1, domino: 1, memoria: 1 };

function oppName(view, me, t) {
  const seats = view.seats || [];
  const opp = seats[view.me === 0 ? 1 : 0];
  return opp ? nameOf(view, opp, me, t) : '';
}

export const Jogos2Thumb = memo(function Jogos2Thumb({ view, pal, t, me }) {
  const S = view.state || {};
  if (view.type === 'ligue4') {
    const b = typeof S.b === 'string' && S.b.length === 42 ? S.b : '.'.repeat(42);
    const c = 17; const hole = pal.dark ? '#0E0E10' : '#F2F2EF';
    return (
      <View style={{ backgroundColor: pal.dark ? '#2442B5' : '#3B5BDB', borderRadius: 10, padding: 5 }}>
        {Array.from({ length: 6 }).map((_, r) => (
          <View key={r} style={{ flexDirection: 'row' }}>
            {Array.from({ length: 7 }).map((__, k) => {
              const m = b[r * 7 + k];
              return <View key={k} style={{ width: c, height: c, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: c - 4, height: c - 4, borderRadius: c, backgroundColor: L4_COLORS[m] || hole }} /></View>;
            })}
          </View>
        ))}
      </View>
    );
  }
  if (view.type === 'memoria') {
    const cards = Array.isArray(S.cards) ? S.cards : Array(16).fill(null);
    const sc = Array.isArray(S.sc) ? S.sc : [0, 0];
    const mySeat = view.me === 1 ? 1 : 0;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 4 * 26 + 3 * 4, flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
          {cards.map((cd, i) => (
            <View key={i} style={{ width: 26, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
              backgroundColor: cd ? (pal.dark ? '#ECEAE4' : '#FFFFFF') : (pal.dark ? '#2A2A2E' : '#34343A'),
              borderWidth: cd && cd.by !== undefined ? 1.5 : 0, borderColor: cd && cd.by === view.me ? pal.ink : pal.accent }}>
              {cd ? <MemoriaArt k={cd.k} size={18} /> : null}
            </View>
          ))}
        </View>
        <View style={{ gap: 3 }}>
          <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13.5 }}>{tr(t, 'games.memoria.youN', 'Você: {n} pares', { n: sc[mySeat] || 0 })}</Text>
          <Text style={{ color: pal.sub, fontSize: 12 }} numberOfLines={1}>{`${oppName(view, me, t)}: ${sc[1 - mySeat] || 0}`}</Text>
          <Text style={{ color: pal.sub, fontSize: 12 }}>{tr(t, 'games.memoria.left', 'Faltam {n} pares', { n: S.pairs_left ?? 8 })}</Text>
        </View>
      </View>
    );
  }
  if (view.type === 'naval') {
    const shots = typeof S.my_shots === 'string' ? S.my_shots : (Array.isArray(S.shots) ? S.shots[0] : '.'.repeat(100));
    const left = Array.isArray(S.left) ? S.left : [5, 5];
    const mySeat = view.me === 1 ? 1 : 0;
    const placing = S.ph === 'place';
    const water = pal.dark ? '#13212B' : '#DCEBF4';
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 100, height: 100, borderRadius: 8, overflow: 'hidden', backgroundColor: water, flexDirection: 'row', flexWrap: 'wrap' }}>
          {Array.from({ length: 100 }).map((_, i) => {
            const s = shots[i];
            return <View key={i} style={{ width: 10, height: 10, alignItems: 'center', justifyContent: 'center' }}>{s === 'x' ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#E5484D' }} /> : s === 'o' ? <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: '#7FA3BD' }} /> : null}</View>;
          })}
        </View>
        <View style={{ gap: 3, maxWidth: 140 }}>
          {placing
            ? <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13.5 }}>{tr(t, 'games.naval.placing', 'Posicionando os barcos')}</Text>
            : <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13.5 }}>{tr(t, 'games.naval.yourShips', 'Seus barcos: {n}', { n: left[mySeat] })}</Text>}
          {!placing ? <Text style={{ color: pal.sub, fontSize: 12 }} numberOfLines={1}>{`${oppName(view, me, t)}: ${left[1 - mySeat]}`}</Text> : null}
        </View>
      </View>
    );
  }
  if (view.type === 'domino') {
    const chain = Array.isArray(S.chain) ? S.chain : [];
    const tail = chain.slice(-4);
    const counts = Array.isArray(S.counts) ? S.counts : [0, 0];
    const mySeat = view.me === 1 ? 1 : 0;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 3, backgroundColor: pal.dark ? '#14301F' : '#2F6B47', borderRadius: 10, padding: 8, minWidth: 60, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}>
          {tail.map((pr, i) => (
            <View key={i} style={{ flexDirection: 'row', borderRadius: 4, backgroundColor: '#FBFAF6', paddingHorizontal: 3, paddingVertical: 2 }}>
              <Text style={{ color: '#17171A', fontWeight: '900', fontSize: 12, width: 10, textAlign: 'center' }}>{pr[0]}</Text>
              <View style={{ width: 1, backgroundColor: '#C9C5BA', marginHorizontal: 2 }} />
              <Text style={{ color: '#17171A', fontWeight: '900', fontSize: 12, width: 10, textAlign: 'center' }}>{pr[1]}</Text>
            </View>
          ))}
        </View>
        <View style={{ gap: 3, maxWidth: 140 }}>
          {Array.isArray(S.hand) ? <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 13.5 }}>{tr(t, 'games.domino.youN', 'Você tem {n} pedras', { n: S.hand.length })}</Text> : null}
          <Text style={{ color: pal.sub, fontSize: 12 }} numberOfLines={1}>{`${oppName(view, me, t)}: ${counts[1 - mySeat] ?? 0}`}</Text>
          <Text style={{ color: pal.sub, fontSize: 12 }}>{tr(t, 'games.domino.pileN', 'Monte: {n}', { n: S.pile ?? 0 })}</Text>
        </View>
      </View>
    );
  }
  return null;
});

/** Espelho na lista nativa: N = { vstack, hstack, text }, P = cores do cartão. Devolve nó ou null. */
export function jogos2NativeNodes(v, N, P, tf, me) {
  const { vstack, hstack, text } = N;
  const S = v.state || {};
  const opp = (() => { const s = v.seats || []; const e = s[v.me === 0 ? 1 : 0]; try { return e ? nameOf(v, e, me, tf) : ''; } catch { return ''; } })();
  const mySeat = v.me === 1 ? 1 : 0;
  const info = (lines) => vstack(lines.filter(Boolean), { fl: 1, g: 3 });
  if (v.type === 'ligue4') {
    const b = typeof S.b === 'string' && S.b.length === 42 ? S.b : '.'.repeat(42);
    const hole = P.dark ? '#0E0E10' : '#F2F2EF';
    const rows = [];
    for (let r = 0; r < 6; r++) {
      const cells = [];
      for (let k = 0; k < 7; k++) cells.push(vstack([vstack([], { w: 13, h: 13, r: 7, bg: L4_COLORS[b[r * 7 + k]] || hole })], { w: 17, h: 17, al: 'c', jc: 'c' }));
      rows.push(hstack(cells, {}));
    }
    return vstack([vstack(rows, { bg: P.dark ? '#2442B5' : '#3B5BDB', r: 10, p: [5, 5, 5, 5] })], { w: -1, al: 'c', a: 'game:play' });
  }
  if (v.type === 'memoria') {
    const cards = Array.isArray(S.cards) ? S.cards : Array(16).fill(null);
    const sc = Array.isArray(S.sc) ? S.sc : [0, 0];
    const rows = [];
    for (let r = 0; r < 4; r++) {
      const cs = [];
      for (let k = 0; k < 4; k++) {
        const cd = cards[r * 4 + k];
        cs.push(vstack([], { w: 20, h: 24, r: 5, bg: cd ? (cd.by === v.me ? P.ink : P.accentSolid) : (P.dark ? '#2A2A2E' : '#34343A'), op: cd ? 0.85 : 1 }));
      }
      rows.push(hstack(cs, { g: 4 }));
    }
    return hstack([
      vstack(rows, { g: 4 }),
      info([
        text(tr(tf, 'games.memoria.youN', 'Você: {n} pares', { n: sc[mySeat] || 0 }), { fs: 13.5, fw: 800, c: P.ink }),
        text(`${opp}: ${sc[1 - mySeat] || 0}`, { fs: 12, c: P.sub }),
        text(tr(tf, 'games.memoria.left', 'Faltam {n} pares', { n: S.pairs_left ?? 8 }), { fs: 12, c: P.sub }),
      ]),
    ], { w: -1, g: 14, al: 'c', a: 'game:play' });
  }
  if (v.type === 'naval') {
    const shots = typeof S.my_shots === 'string' ? S.my_shots : (Array.isArray(S.shots) ? S.shots[0] : '.'.repeat(100));
    const left = Array.isArray(S.left) ? S.left : [5, 5];
    const placing = S.ph === 'place';
    const rows = [];
    for (let r = 0; r < 10; r++) {
      const cs = [];
      for (let k = 0; k < 10; k++) {
        const s = shots[r * 10 + k];
        cs.push(vstack(s === 'x' ? [vstack([], { w: 6, h: 6, r: 3, bg: '#E5484D' })] : (s === 'o' ? [vstack([], { w: 3, h: 3, r: 2, bg: '#7FA3BD' })] : []), { w: 9, h: 9, al: 'c', jc: 'c' }));
      }
      rows.push(hstack(cs, {}));
    }
    return hstack([
      vstack(rows, { bg: P.dark ? '#13212B' : '#DCEBF4', r: 8, p: [2, 2, 2, 2] }),
      info([
        text(placing ? tr(tf, 'games.naval.placing', 'Posicionando os barcos') : tr(tf, 'games.naval.yourShips', 'Seus barcos: {n}', { n: left[mySeat] }), { fs: 13.5, fw: 800, c: P.ink }),
        placing ? null : text(`${opp}: ${left[1 - mySeat]}`, { fs: 12, c: P.sub }),
      ]),
    ], { w: -1, g: 14, al: 'c', a: 'game:play' });
  }
  if (v.type === 'domino') {
    const chain = Array.isArray(S.chain) ? S.chain : [];
    const counts = Array.isArray(S.counts) ? S.counts : [0, 0];
    const tiles = chain.slice(-4).map((pr) => hstack([
      text(String(pr[0]), { fs: 12, fw: 900, c: '#17171A', w: 10, ta: 'c' }),
      vstack([], { w: 1, h: 14, bg: '#C9C5BA' }),
      text(String(pr[1]), { fs: 12, fw: 900, c: '#17171A', w: 10, ta: 'c' }),
    ], { bg: '#FBFAF6', r: 4, p: [2, 3, 2, 3], g: 2, al: 'c' }));
    return hstack([
      hstack(tiles.length ? tiles : [text('·', { fs: 14, c: '#FFFFFF' })], { bg: P.dark ? '#14301F' : '#2F6B47', r: 10, p: [8, 8, 8, 8], g: 3, al: 'c' }),
      info([
        Array.isArray(S.hand) ? text(tr(tf, 'games.domino.youN', 'Você tem {n} pedras', { n: S.hand.length }), { fs: 13.5, fw: 800, c: P.ink }) : null,
        text(`${opp}: ${counts[1 - mySeat] ?? 0}`, { fs: 12, c: P.sub }),
        text(tr(tf, 'games.domino.pileN', 'Monte: {n}', { n: S.pile ?? 0 }), { fs: 12, c: P.sub }),
      ]),
    ], { w: -1, g: 14, al: 'c', a: 'game:play' });
  }
  return null;
}
