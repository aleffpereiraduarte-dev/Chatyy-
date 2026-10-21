// components/games/boards/NavalBoard.js — [jogos2 2026-10-21] Batalha Naval 10×10 (2 jogadores).
// Servidor autoritativo (api/games_engine_naval.php) e com ESTADO OCULTO: a visão traz só os MEUS barcos,
// os tiros dos dois e os barcos do outro já afundados — nunca onde estão os barcos dele.
// Fases:
//  1) Posicionar (os dois ao mesmo tempo): frota 5-4-3-3-2 começa aleatória; "Aleatório" sorteia outra,
//     tocar num barco seleciona, "Girar" vira na horizontal/vertical, tocar numa casa vazia leva o barco
//     selecionado para lá. "Pronto" manda {a:'place', ships} (o servidor valida).
//  2) Tiros alternados: mar do adversário grande (toque = tiro, {a:'fire', cell}); meu mar pequeno embaixo.
//     Tiro novo = respingo (água) ou explosão (acerto) na UI thread; afundou = contorno do barco + háptico forte.
// Reduzir Movimento: sem respingo/explosão.
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, Easing } from 'react-native-reanimated';
import { hTap, hMove, hCapture, hKing, hNope } from '../fx';
import { useRM, PressScale } from '../motion';
import { tr, nameOf } from '../../../services/games';

const N = 10;
const FLEET = [5, 4, 3, 3, 2];
const HIT = '#E5484D';

// ─── frota local (posicionamento) ───────────────────────────────────────────
function shipCells(r, c, len, vert) {
  const out = [];
  for (let k = 0; k < len; k++) out.push(vert ? (r + k) * N + c : r * N + c + k);
  return out;
}
function fits(r, c, len, vert, taken) {
  if (r < 0 || c < 0) return false;
  if (vert ? r + len > N : c + len > N) return false;
  for (const x of shipCells(r, c, len, vert)) if (taken.has(x)) return false;
  return true;
}
export function randomFleet() {
  for (let tries = 0; tries < 50; tries++) {
    const taken = new Set(); const ships = []; let ok = true;
    for (const len of FLEET) {
      let placed = false;
      for (let k = 0; k < 200 && !placed; k++) {
        const vert = Math.random() < 0.5;
        const r = Math.floor(Math.random() * N); const c = Math.floor(Math.random() * N);
        if (fits(r, c, len, vert, taken)) { const cells = shipCells(r, c, len, vert); cells.forEach((x) => taken.add(x)); ships.push(cells); placed = true; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  return [shipCells(0, 0, 5, false), shipCells(2, 0, 4, false), shipCells(4, 0, 3, false), shipCells(6, 0, 3, false), shipCells(8, 0, 2, false)];
}
const isVert = (cells) => cells.length > 1 && cells[1] - cells[0] === N;

// ─── efeitos de tiro ────────────────────────────────────────────────────────
function ShotFx({ x, y, cell, hit, rm }) {
  const p = useSharedValue(0);
  useEffect(() => { if (!rm) p.value = withTiming(1, { duration: hit ? 520 : 460, easing: Easing.out(Easing.cubic) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ring = useAnimatedStyle(() => ({ opacity: p.value <= 0 || p.value >= 1 ? 0 : 1 - p.value, transform: [{ scale: 0.3 + p.value * (hit ? 2.4 : 1.8) }] }));
  const core = useAnimatedStyle(() => ({ opacity: p.value <= 0 || p.value >= 1 ? 0 : (1 - p.value) * 0.9, transform: [{ scale: 0.6 + p.value * 0.9 }] }));
  if (rm) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x, top: y, width: cell, height: cell, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: cell, height: cell, borderRadius: cell, borderWidth: 2, borderColor: hit ? HIT : '#5AA9E6' }, ring]} />
      {hit ? <Animated.View style={[{ position: 'absolute', width: cell * 0.9, height: cell * 0.9, borderRadius: cell, backgroundColor: '#FFB020' }, core]} /> : null}
    </View>
  );
}

// ─── um mar (grade) ─────────────────────────────────────────────────────────
// shots: string 100 ('.', 'o' água, 'x' acerto) · ships: [[casas]] desenhados (meus) · sunk: [[casas]] afundados (contorno)
const Sea = memo(function Sea({ size, pal, shots, ships, sunk, sel, onCell, canTap, fx, label, rm, mini, t }) {
  const cell = size / N;
  const water = pal.dark ? '#13212B' : '#DCEBF4';
  const lineC = pal.dark ? 'rgba(120,170,210,0.16)' : 'rgba(40,100,150,0.14)';
  const shipC = pal.dark ? '#C9CED6' : '#34343A';
  const sunkSet = useMemo(() => { const s = new Set(); (sunk || []).forEach((sh) => sh.forEach((x) => s.add(x))); return s; }, [sunk]);
  const shipMap = useMemo(() => { const m = new Map(); (ships || []).forEach((sh, i) => sh.forEach((x) => m.set(x, i))); return m; }, [ships]);
  const cells = [];
  for (let i = 0; i < N * N; i++) {
    const r = Math.floor(i / N); const c = i % N;
    const sh = shots ? shots[i] : '.';
    const si = shipMap.has(i) ? shipMap.get(i) : -1;
    const sunkHere = sunkSet.has(i);
    let inner = null;
    if (sh === 'x') inner = <View style={{ width: cell * 0.56, height: cell * 0.56, borderRadius: cell, backgroundColor: HIT }} />;
    else if (sh === 'o') inner = <View style={{ width: cell * 0.24, height: cell * 0.24, borderRadius: cell, backgroundColor: pal.dark ? '#6C8BA3' : '#7FA3BD' }} />;
    const bg = si >= 0 ? (sel === si ? pal.accent : shipC) : (sunkHere ? (pal.dark ? '#3A2224' : '#F3D3D4') : 'transparent');
    const can = canTap && canTap(i);
    const Cmp = onCell ? Pressable : View;
    cells.push(
      <Cmp key={i} {...(onCell ? { onPress: () => onCell(i), disabled: !can && !(ships && ships.length), accessibilityRole: 'button', accessibilityLabel: `${String.fromCharCode(65 + r)}${c + 1}${sh === 'x' ? ' · ' + tr(t, 'games.naval.hit', 'acerto') : sh === 'o' ? ' · ' + tr(t, 'games.naval.water', 'água') : ''}` } : {})}
        style={{ position: 'absolute', left: c * cell, top: r * cell, width: cell, height: cell, alignItems: 'center', justifyContent: 'center', backgroundColor: bg,
          borderRadius: si >= 0 || sunkHere ? Math.max(2, cell * 0.22) : 0, borderWidth: sunkHere ? 1.5 : 0, borderColor: HIT, transform: si >= 0 ? [{ scale: 0.9 }] : undefined }}>
        {inner}
      </Cmp>,
    );
  }
  return (
    <View>
      {label ? <Text style={[st.seaLabel, { color: pal.sub, fontSize: mini ? 11 : 12 }]}>{label}</Text> : null}
      <View style={{ width: size, height: size, borderRadius: mini ? 10 : 14, overflow: 'hidden', backgroundColor: water, borderWidth: StyleSheet.hairlineWidth, borderColor: lineC }}>
        {Array.from({ length: N - 1 }).map((_, k) => <View key={'v' + k} pointerEvents="none" style={{ position: 'absolute', left: (k + 1) * cell, top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: lineC }} />)}
        {Array.from({ length: N - 1 }).map((_, k) => <View key={'h' + k} pointerEvents="none" style={{ position: 'absolute', top: (k + 1) * cell, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: lineC }} />)}
        {cells}
        {fx ? <ShotFx key={fx.k} x={(fx.cell % N) * cell} y={Math.floor(fx.cell / N) * cell} cell={cell} hit={fx.hit} rm={rm} /> : null}
      </View>
    </View>
  );
});

function Btn({ label, onPress, primary, pal, disabled, rm }) {
  return (
    <PressScale rm={rm} disabled={disabled} onPress={onPress} scaleTo={0.95}
      style={[st.btn, primary ? { backgroundColor: pal.strong } : { borderWidth: 1, borderColor: pal.line }, disabled && { opacity: 0.45 }]} accessibilityRole="button">
      <Text style={{ color: primary ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 14 }}>{label}</Text>
    </PressScale>
  );
}

function Placement({ size, pal, t, rm, busy, onMove }) {
  const [ships, setShips] = useState(() => randomFleet());
  const [sel, setSel] = useState(-1);
  const rotate = () => {
    if (sel < 0) { hNope(); return; }
    const cur = ships[sel]; const vert = isVert(cur);
    const r = Math.floor(cur[0] / N); const c = cur[0] % N;
    const taken = new Set(); ships.forEach((sh, i) => { if (i !== sel) sh.forEach((x) => taken.add(x)); });
    if (!fits(r, c, cur.length, !vert, taken)) { hNope(); return; }
    hTap();
    setShips(ships.map((sh, i) => (i === sel ? shipCells(r, c, cur.length, !vert) : sh)));
  };
  const onCell = (i) => {
    const hitShip = ships.findIndex((sh) => sh.includes(i));
    if (hitShip >= 0) { hTap(); setSel(hitShip === sel ? -1 : hitShip); return; }
    if (sel < 0) return;
    const cur = ships[sel]; const vert = isVert(cur);
    const taken = new Set(); ships.forEach((sh, k) => { if (k !== sel) sh.forEach((x) => taken.add(x)); });
    const r = Math.floor(i / N); const c = i % N;
    if (!fits(r, c, cur.length, vert, taken)) { hNope(); return; }
    hMove();
    setShips(ships.map((sh, k) => (k === sel ? shipCells(r, c, cur.length, vert) : sh)));
  };
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={[st.title, { color: pal.ink }]}>{tr(t, 'games.naval.placeTitle', 'Posicione seus barcos')}</Text>
      <Text style={[st.sub, { color: pal.sub }]}>{sel >= 0 ? tr(t, 'games.naval.placeMove', 'Toque numa casa para mover ou em Girar') : tr(t, 'games.naval.placeHint', 'Toque num barco para mover ou girar')}</Text>
      <Sea t={t} size={size} pal={pal} ships={ships} sel={sel} onCell={onCell} canTap={() => true} rm={rm} />
      <View style={st.btnRow}>
        <Btn pal={pal} rm={rm} label={tr(t, 'games.naval.random', 'Aleatório')} onPress={() => { hTap(); setSel(-1); setShips(randomFleet()); }} />
        <Btn pal={pal} rm={rm} label={tr(t, 'games.naval.rotate', 'Girar')} onPress={rotate} disabled={sel < 0} />
        <Btn pal={pal} rm={rm} primary disabled={busy} label={tr(t, 'games.naval.ready', 'Pronto')} onPress={() => { hTap(); onMove({ a: 'place', ships }); }} />
      </View>
    </View>
  );
}

export default function NavalBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const rm = useRM();
  const S = view.state || {};
  const width = Math.min((maxW || win.width) - 32, 380, Math.round(win.height * 0.42)); // painel: cabe sem rolar muito
  const meSeat = view.me !== null && view.me !== undefined ? view.me : null;
  const oppSeat = meSeat === null ? null : 1 - meSeat;
  const oppE = (view.seats || [])[oppSeat === null ? 1 : oppSeat];
  const oppName = oppE ? nameOf(view, oppE, me, t) : '';
  // efeito do tiro mais novo (só se a tela já estava aberta)
  const ready = useRef(false);
  const lastK = useRef(view.state ? view.state.moves : 0);
  const [fx, setFx] = useState(null);
  useEffect(() => { ready.current = true; }, []);
  const L = S.last;
  const mv = S.moves || 0;
  useEffect(() => {
    if (!ready.current || mv === lastK.current) { lastK.current = mv; return; }
    lastK.current = mv;
    if (L && L.a === 'fire' && Number.isInteger(L.cell)) {
      setFx({ k: mv, cell: L.cell, hit: !!L.hit, mine: L.by === meSeat });
      if (L.sunk) hKing(); else if (L.hit) hCapture(); else hMove();
    }
  }, [mv]); // eslint-disable-line react-hooks/exhaustive-deps

  if (meSeat !== null && S.ph === 'place' && S.need_place && view.status === 'active') {
    return <View style={{ marginTop: 6 }}><Placement size={width} pal={pal} t={t} rm={rm} busy={busy} onMove={onMove} /></View>;
  }
  if (meSeat === null) {
    // espectador: só os tiros
    const sc = Array.isArray(S.shots) ? S.shots : [];
    const sk = Array.isArray(S.sunk_cells) ? S.sunk_cells : [[], []];
    const half = Math.min((width - 12) / 2, 170);
    const names = (view.seats || []).map((e) => nameOf(view, e, me, t));
    return (
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 10 }}>
        <Sea t={t} size={half} pal={pal} shots={sc[1]} sunk={sk[0]} label={tr(t, 'games.naval.seaOf', 'Mar de {name}', { name: names[0] || '' })} rm={rm} mini />
        <Sea t={t} size={half} pal={pal} shots={sc[0]} sunk={sk[1]} label={tr(t, 'games.naval.seaOf', 'Mar de {name}', { name: names[1] || '' })} rm={rm} mini />
      </View>
    );
  }
  const myShots = typeof S.my_shots === 'string' ? S.my_shots : '.'.repeat(N * N);
  const theirShots = typeof S.their_shots === 'string' ? S.their_shots : '.'.repeat(N * N);
  const myTurn = !!S.my_turn && view.status === 'active';
  const left = Array.isArray(S.left) ? S.left : [5, 5];
  const placing = S.ph === 'place';
  const mini = Math.min(Math.round(width * 0.42), 150);
  let headline;
  if (view.status !== 'active') headline = '';
  else if (placing) headline = tr(t, 'games.naval.waitPlace', 'Aguardando {name} posicionar os barcos', { name: oppName });
  else if (myTurn) headline = tr(t, 'games.naval.yourShot', 'Sua vez: escolha onde atirar');
  else headline = tr(t, 'games.status.turnOf', 'Vez de {name}', { name: oppName });
  let lastLine = '';
  if (L && L.a === 'fire') {
    const mine = L.by === meSeat;
    if (L.sunk) lastLine = mine ? tr(t, 'games.naval.youSunk', 'Você afundou um barco de {n}!', { n: L.sunk }) : tr(t, 'games.naval.theySunk', '{name} afundou seu barco de {n}', { name: oppName, n: L.sunk });
    else if (L.hit) lastLine = mine ? tr(t, 'games.naval.youHit', 'Acertou!') : tr(t, 'games.naval.theyHit', '{name} acertou seu barco', { name: oppName });
    else lastLine = mine ? tr(t, 'games.naval.youMiss', 'Água') : tr(t, 'games.naval.theyMiss', '{name} acertou a água', { name: oppName });
  }
  return (
    <View style={{ alignItems: 'center', marginTop: 6 }}>
      {headline ? <Text style={[st.title, { color: myTurn ? pal.ink : pal.sub }]}>{headline}</Text> : null}
      {lastLine ? <Text style={[st.sub, { color: L && L.hit ? HIT : pal.sub }]}>{lastLine}</Text> : null}
      {placing ? (
        <Sea t={t} size={width} pal={pal} ships={S.my_ships || []} label={tr(t, 'games.naval.yourSea', 'Seu mar')} rm={rm} />
      ) : (
        <>
          <Sea t={t} size={width} pal={pal} shots={myShots} sunk={S.their_sunk || []} rm={rm}
            label={tr(t, 'games.naval.targetSea', 'Mar de {name} · {n} barcos', { name: oppName, n: left[oppSeat] })}
            onCell={(i) => { if (!myTurn || busy || myShots[i] !== '.') { if (myTurn && myShots[i] !== '.') hNope(); return; } hTap(); onMove({ a: 'fire', cell: i }); }}
            canTap={(i) => myTurn && !busy && myShots[i] === '.'}
            fx={fx && fx.mine ? fx : null} />
          <View style={st.bottomRow}>
            <Sea t={t} size={mini} pal={pal} ships={S.my_ships || []} shots={theirShots} sunk={S.my_sunk || []} rm={rm} mini
              label={tr(t, 'games.naval.yourSeaN', 'Seu mar · {n} barcos', { n: left[meSeat] })} fx={fx && !fx.mine ? fx : null} />
            <View style={{ flex: 1, gap: 6, paddingTop: 18 }}>
              {FLEET.map((len, i) => {
                const sunkMine = (S.my_sunk || []).some((sh) => sh.length === len && (S.my_ships || [])[i] && sh[0] === S.my_ships[i][0]);
                return (
                  <View key={i} style={{ flexDirection: 'row', gap: 2, opacity: sunkMine ? 0.3 : 1 }}>
                    {Array.from({ length: len }).map((_, k) => <View key={k} style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: sunkMine ? HIT : (pal.dark ? '#C9CED6' : '#34343A') }} />)}
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  title: { fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 2 },
  sub: { fontSize: 12.5, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  seaLabel: { fontWeight: '700', marginBottom: 5, marginLeft: 2 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignSelf: 'stretch', paddingHorizontal: 16 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  bottomRow: { flexDirection: 'row', gap: 14, marginTop: 12, alignSelf: 'stretch', paddingHorizontal: 16, alignItems: 'flex-start' },
});
