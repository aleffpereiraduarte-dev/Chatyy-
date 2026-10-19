// components/games/boards/ForcaBoard.js — [jogos 2026-10-18] Forca em turnos (grupo ou 1:1).
// A palavra NUNCA vem do servidor durante o jogo — só a máscara (`mask`), a categoria e as letras chutadas.
// Polish 2: forca com traço "à mão" (linhas levemente tortas + 2º traço fino), cada parte do boneco se
// DESENHA ao aparecer, teclas com afundar + estado acerto/erro animado, letras reveladas pulam e no fim a
// palavra vira letra a letra (verde = acertaram, vermelho = a forca venceu).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withSpring } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { hTap, hErr, hOk, hReveal } from '../fx';
import { tr, nameOf } from '../../../services/games';
import { PressScale, DrawPath, shake, pop, useRM } from '../motion';

const ROWS = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ'];
function norm(ch) { return String(ch || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }

// Traços "à mão": cada peça = traço principal + um 2º traço fino deslocado (efeito lápis).
const FRAME = [
  { d: 'M10 112.5 C 30 110.8, 52 113.2, 74 111.4', len: 70 },
  { d: 'M28.5 112 C 27.2 80, 29.4 42, 27.8 10.5', len: 106 },
  { d: 'M27 11 C 42 9.6, 54 11.8, 67 10.2', len: 44 },
  { d: 'M28.4 30 C 33 24, 38.6 17.4, 44.5 10.8', len: 30 },
  { d: 'M66.4 10.5 C 66.9 16, 65.8 22, 66.3 28.5', len: 22 },
];
const BODY = [
  { d: 'M66 28.4 C 72.6 28.2, 76.8 33.4, 76.4 38.6 C 76 44.4, 71 48.6, 65.6 48.2 C 60 47.8, 55.6 43.4, 56 37.8 C 56.4 32.4, 60.6 28.6, 66.6 28.6', len: 70 },
  { d: 'M66.2 48.4 C 65.4 60, 66.8 71, 66 82.4', len: 36 },
  { d: 'M66 57.8 C 61 62.6, 56.4 67.4, 51.6 72.6', len: 22 },
  { d: 'M66.2 57.6 C 71 62.4, 76 67.6, 80.6 72.2', len: 22 },
  { d: 'M66 82.2 C 62 88.8, 58.2 95.4, 54.2 102.4', len: 25 },
  { d: 'M66.2 82 C 70 88.6, 74.4 95.6, 78.2 102', len: 25 },
];
const FACE_DEAD = 'M61.4 35.4l3 3M64.4 35.4l-3 3M67.6 35.4l3 3M70.6 35.4l-3 3M61.6 43.6 C 64.6 42.2, 67.6 42.2, 70.6 43.6';

function Gallows({ wrong, color, sub, bad, size = 150, rm, over }) {
  const prev = useRef(wrong);
  const fresh = wrong > prev.current ? wrong : 0;
  useEffect(() => { prev.current = wrong; }, [wrong]);
  const n = Math.max(0, Math.min(6, wrong));
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120">
      {FRAME.map((f, i) => (
        <React.Fragment key={'f' + i}>
          <Path d={f.d} stroke={color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={f.d} stroke={sub} strokeWidth={1} strokeLinecap="round" fill="none" opacity={0.55} transform="translate(1.4 -1.1)" />
        </React.Fragment>
      ))}
      {BODY.slice(0, n).map((b, i) => (
        <React.Fragment key={'b' + i}>
          <DrawPath d={b.d} len={b.len + 4} stroke={n >= 6 ? bad : color} strokeWidth={3.8} strokeLinecap="round" strokeLinejoin="round" fill="none"
            animate={fresh === i + 1} duration={i === 0 ? 420 : 260} rm={rm} />
          <DrawPath d={b.d} len={b.len + 4} stroke={sub} strokeWidth={0.9} strokeLinecap="round" fill="none" opacity={0.5} transform="translate(1.2 -0.9)"
            animate={fresh === i + 1} delay={90} duration={i === 0 ? 420 : 260} rm={rm} />
        </React.Fragment>
      ))}
      {n >= 6 ? <DrawPath d={FACE_DEAD} len={40} stroke={bad} strokeWidth={2} strokeLinecap="round" fill="none" animate={fresh === 6 || !!over} delay={300} duration={360} rm={rm} /> : null}
    </Svg>
  );
}

function Key({ L, w, used, hit, can, myTurn, pal, rm, onPress }) {
  const s = useSharedValue(1);
  const wasUsed = useRef(used);
  useEffect(() => {
    if (used && !wasUsed.current) pop(s, hit ? 1.18 : 0.86, rm);
    wasUsed.current = used;
  }, [used]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const bg = hit ? pal.strong : (used ? 'transparent' : pal.card);
  return (
    <Animated.View style={st}>
      <PressScale disabled={!can} onPress={onPress} rm={rm} scaleTo={0.86}
        style={[st2.key, { width: w, backgroundColor: bg, borderWidth: used && !hit ? 1 : 0, borderColor: pal.line, opacity: used && !hit ? 0.42 : (myTurn ? 1 : 0.72) }]}
        accessibilityRole="button" accessibilityLabel={L} accessibilityState={{ disabled: !can }}>
        <Text style={{ color: hit ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 16, textDecorationLine: used && !hit ? 'line-through' : 'none' }}>{L}</Text>
      </PressScale>
    </Animated.View>
  );
}

function Slot({ ch, i, slot, pal, finished, missed, solved, rm }) {
  const f = useSharedValue(1);
  const had = useRef(!!ch);
  useEffect(() => {
    if (finished) {
      if (rm) { f.value = 1; return; }
      f.value = 0;
      f.value = withDelay(120 + i * 70, withSpring(1, { damping: 11, stiffness: 170 }));
      if (i === 0) hReveal();
    } else if (ch && !had.current) {
      if (rm) { f.value = 1; } else { f.value = 0; f.value = withDelay(i * 40, withSpring(1, { damping: 10, stiffness: 200 })); }
    }
    had.current = !!ch;
  }, [ch, finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({
    opacity: 0.2 + 0.8 * f.value,
    transform: [{ perspective: 400 }, { rotateX: `${(1 - f.value) * 90}deg` }, { translateY: (1 - f.value) * -6 }],
  }));
  const color = finished ? (missed ? pal.bad : (solved ? pal.good : pal.ink)) : pal.ink;
  return (
    <View style={{ width: slot, alignItems: 'center', borderBottomWidth: 3, borderBottomColor: finished ? color : pal.ink, marginHorizontal: 2 }}>
      <Animated.Text style={[{ color, fontSize: slot * 0.8, fontWeight: '900', height: slot * 1.15 }, st]}>{ch || ' '}</Animated.Text>
    </View>
  );
}

export default function ForcaBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const width = maxW || win.width;
  const rm = useRM();
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const guessed = new Set((S.g || []).map(norm));
  const mask = Array.isArray(S.mask) ? S.mask : [];
  const finished = view.status === 'finished';
  const [guessOpen, setGuessOpen] = useState(false);
  const [word, setWord] = useState('');
  const shakeX = useSharedValue(0);
  const prevWrong = useRef(S.wrong || 0);
  const prevG = useRef((S.g || []).length);
  const shown = new Set(mask.filter(Boolean).map(norm));
  useEffect(() => {
    const gl = (S.g || []).length;
    if ((S.wrong || 0) > prevWrong.current) { hErr(); shake(shakeX, 8, rm); }
    else if (gl > prevG.current && S.last && S.last.hit) hOk();
    prevWrong.current = S.wrong || 0;
    prevG.current = gl;
  }, [S.wrong, S.g && S.g.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const shakeSt = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }));
  const W = Math.min(width, maxW ? 640 : 520);
  const letterW = Math.min(44, (W - 32 - 6 * 6) / 7);
  const slot = Math.min(34, (W - 32) / Math.max(8, mask.length) - 4);
  const send = () => { const w = word.trim(); if (!w) return; setWord(''); setGuessOpen(false); hTap(); onMove({ a: 'word', w }); };
  const solved = finished && !S.hanged;

  return (
    <View style={{ paddingHorizontal: 16, flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
        <Animated.View style={[st2.gallows, { backgroundColor: pal.card, borderColor: pal.line }, shakeSt]}>
          <Gallows wrong={S.wrong || 0} color={pal.ink} sub={pal.sub} bad={pal.bad} size={124} rm={rm} over={finished && S.hanged} />
        </Animated.View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={[st2.cat, { borderColor: pal.line }]}><Text style={{ color: pal.ink, fontWeight: '700', fontSize: 12 }}>{S.cat}</Text></View>
          <View style={st2.lives}>
            {Array.from({ length: S.max || 6 }).map((_, k) => (
              <View key={k} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: k < (S.wrong || 0) ? pal.bad : pal.card2 }} />
            ))}
          </View>
          <Text style={{ color: pal.sub, marginTop: 5, fontSize: 12.5 }}>{tr(t, 'games.forca.errors', '{n} de {max} erros', { n: S.wrong || 0, max: S.max || 6 })}</Text>
          {seats.map((e, i) => (
            <View key={e} style={st2.scoreRow}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: S.turn === i && view.status === 'active' ? pal.strong : 'transparent', borderWidth: 1, borderColor: pal.line }} />
              <Text style={{ color: pal.ink, flex: 1, fontWeight: i === view.me ? '800' : '600' }} numberOfLines={1}>{nameOf(view, e, me, t)}</Text>
              <Text style={{ color: pal.ink, fontWeight: '800' }}>{(S.sc || [])[i] || 0}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={st2.word}>
        {mask.map((ch, i) => {
          if (ch === '-' || ch === ' ') return <View key={i} style={{ width: slot * 0.6, alignItems: 'center' }}><Text style={{ color: pal.ink, fontSize: slot * 0.8, fontWeight: '800' }}>{ch}</Text></View>;
          const letter = /[A-Za-zÀ-ÿ]/.test(ch || 'A');
          const missed = finished && letter && !!ch && !!S.hanged && !guessed.has(norm(ch)); // ninguém achou
          return <Slot key={i} ch={ch} i={i} slot={slot} pal={pal} finished={finished} missed={missed} solved={solved} rm={rm} />;
        })}
      </View>
      {view.status === 'active' ? (
        <>
          <Text style={{ color: pal.sub, textAlign: 'center', marginBottom: 8, fontSize: 13 }}>
            {myTurn ? tr(t, 'games.forca.yourTurn', 'Sua vez: escolha uma letra') : (view.me === null || view.me === undefined ? tr(t, 'games.spectating', 'Você está assistindo') : tr(t, 'games.status.turnOf', 'Vez de {name}', { name: nameOf(view, seats[S.turn], me, t) }))}
          </Text>
          {ROWS.map((row) => (
            <View key={row} style={st2.kbRow}>
              {row.split('').map((L) => {
                const used = guessed.has(L);
                const hit = used && shown.has(L);
                return (
                  <Key key={L} L={L} w={letterW} used={used} hit={hit} myTurn={myTurn} pal={pal} rm={rm}
                    can={myTurn && !used && !busy} onPress={() => { hTap(); onMove({ a: 'letter', l: L }); }} />
                );
              })}
            </View>
          ))}
          {myTurn ? (guessOpen ? (
            <View style={[st2.guessRow, { borderColor: pal.line }]}>
              <TextInput value={word} onChangeText={setWord} autoFocus autoCapitalize="characters" autoCorrect={false} placeholder={tr(t, 'games.forca.guessPh', 'Digite a palavra')}
                placeholderTextColor={pal.sub} style={{ flex: 1, color: pal.ink, fontSize: 16, paddingVertical: 8 }} onSubmitEditing={send} returnKeyType="send" />
              <PressScale onPress={send} rm={rm} style={[st2.guessBtn, { backgroundColor: pal.strong }]} accessibilityRole="button">
                <Text style={{ color: pal.onStrong, fontWeight: '800' }}>{tr(t, 'games.forca.guessSend', 'Chutar')}</Text>
              </PressScale>
            </View>
          ) : (
            <PressScale onPress={() => { hTap(); setGuessOpen(true); }} rm={rm} style={[st2.guessOpen, { borderColor: pal.strong }]} accessibilityRole="button">
              <Text style={{ color: pal.ink, fontWeight: '800' }}>{tr(t, 'games.forca.guessWord', 'Chutar a palavra inteira')}</Text>
            </PressScale>
          )) : null}
        </>
      ) : null}
    </View>
  );
}

const st2 = StyleSheet.create({
  gallows: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 4 },
  cat: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  lives: { flexDirection: 'row', gap: 4, marginTop: 10 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  word: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginVertical: 18 },
  kbRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 6 },
  key: { height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  guessOpen: { alignSelf: 'center', borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9, marginTop: 8 },
  guessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 12, padding: 4, marginTop: 8 },
  guessBtn: { borderRadius: 9, paddingHorizontal: 14, paddingVertical: 9 },
});
