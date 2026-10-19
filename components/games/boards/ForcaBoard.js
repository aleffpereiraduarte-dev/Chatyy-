// components/games/boards/ForcaBoard.js — [jogos 2026-10-18] Forca em turnos (grupo ou 1:1).
// A palavra NUNCA vem do servidor durante o jogo — só a máscara (`mask`), a categoria e as letras chutadas.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Path, Circle, Line } from 'react-native-svg';
import { hTap, hErr, hOk } from '../fx';
import { tr, nameOf } from '../../../services/games';

const ROWS = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ'];
function norm(ch) { return String(ch || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }

function Gallows({ wrong, color, size = 150 }) {
  const parts = [
    <Circle key="h" cx="66" cy="38" r="10" stroke={color} strokeWidth="4" fill="none" />,
    <Line key="b" x1="66" y1="48" x2="66" y2="82" stroke={color} strokeWidth="4" strokeLinecap="round" />,
    <Line key="la" x1="66" y1="58" x2="52" y2="72" stroke={color} strokeWidth="4" strokeLinecap="round" />,
    <Line key="ra" x1="66" y1="58" x2="80" y2="72" stroke={color} strokeWidth="4" strokeLinecap="round" />,
    <Line key="ll" x1="66" y1="82" x2="54" y2="102" stroke={color} strokeWidth="4" strokeLinecap="round" />,
    <Line key="rl" x1="66" y1="82" x2="78" y2="102" stroke={color} strokeWidth="4" strokeLinecap="round" />,
  ];
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120">
      <Path d="M14 112h56M28 112V10h38v18" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M28 28l16-18" stroke={color} strokeWidth="4" strokeLinecap="round" />
      {parts.slice(0, Math.max(0, Math.min(6, wrong)))}
    </Svg>
  );
}

export default function ForcaBoard({ view, onMove, pal, busy, t, me }) {
  const { width } = useWindowDimensions();
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const guessed = new Set((S.g || []).map(norm));
  const mask = Array.isArray(S.mask) ? S.mask : [];
  const shown = new Set(mask.filter(Boolean).map(norm));
  const [guessOpen, setGuessOpen] = useState(false);
  const [word, setWord] = useState('');
  const shake = useSharedValue(0);
  const prevWrong = useRef(S.wrong || 0);
  useEffect(() => {
    if ((S.wrong || 0) > prevWrong.current) { hErr(); shake.value = withSequence(withTiming(-8, { duration: 50 }), withTiming(8, { duration: 70 }), withTiming(-5, { duration: 60 }), withTiming(0, { duration: 60 })); }
    else if (S.last && S.last.hit) hOk();
    prevWrong.current = S.wrong || 0;
  }, [S.wrong, S.g && S.g.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const shakeSt = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const letterW = Math.min(44, (Math.min(width, 520) - 32 - 6 * 6) / 7);
  const slot = Math.min(34, (Math.min(width, 520) - 32) / Math.max(8, mask.length) - 4);
  const send = () => { const w = word.trim(); if (!w) return; setWord(''); setGuessOpen(false); hTap(); onMove({ a: 'word', w }); };

  return (
    <View style={{ paddingHorizontal: 16, flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
        <Animated.View style={shakeSt}><Gallows wrong={S.wrong || 0} color={pal.ink} size={130} /></Animated.View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <View style={[st.cat, { borderColor: pal.line }]}><Text style={{ color: pal.ink, fontWeight: '700', fontSize: 12 }}>{S.cat}</Text></View>
          <Text style={{ color: pal.sub, marginTop: 8, fontSize: 13 }}>{tr(t, 'games.forca.errors', '{n} de {max} erros', { n: S.wrong || 0, max: S.max || 6 })}</Text>
          {seats.map((e, i) => (
            <View key={e} style={st.scoreRow}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: S.turn === i && view.status === 'active' ? pal.strong : 'transparent', borderWidth: 1, borderColor: pal.line }} />
              <Text style={{ color: pal.ink, flex: 1, fontWeight: i === view.me ? '800' : '600' }} numberOfLines={1}>{nameOf(view, e, me, t)}</Text>
              <Text style={{ color: pal.ink, fontWeight: '800' }}>{(S.sc || [])[i] || 0}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={st.word}>
        {mask.map((ch, i) => {
          const letter = /[A-Za-zÀ-ÿ]/.test(ch || 'A');
          if (ch === '-' || ch === ' ') return <View key={i} style={{ width: slot * 0.6, alignItems: 'center' }}><Text style={{ color: pal.ink, fontSize: slot * 0.8, fontWeight: '800' }}>{ch}</Text></View>;
          return (
            <View key={i} style={{ width: slot, alignItems: 'center', borderBottomWidth: 3, borderBottomColor: pal.ink, marginHorizontal: 2 }}>
              <Text style={{ color: view.status === 'finished' && !shown.has(norm(ch)) && letter ? pal.sub : pal.ink, fontSize: slot * 0.8, fontWeight: '900', height: slot * 1.15 }}>{ch || ' '}</Text>
            </View>
          );
        })}
      </View>
      {view.status === 'active' ? (
        <>
          <Text style={{ color: pal.sub, textAlign: 'center', marginBottom: 8, fontSize: 13 }}>
            {myTurn ? tr(t, 'games.forca.yourTurn', 'Sua vez: escolha uma letra') : (view.me === null || view.me === undefined ? tr(t, 'games.spectating', 'Você está assistindo') : tr(t, 'games.status.turnOf', 'Vez de {name}', { name: nameOf(view, seats[S.turn], me, t) }))}
          </Text>
          {ROWS.map((row) => (
            <View key={row} style={st.kbRow}>
              {row.split('').map((L) => {
                const used = guessed.has(L);
                const hit = used && shown.has(L);
                return (
                  <Pressable key={L} disabled={!myTurn || used || busy} onPress={() => { hTap(); onMove({ a: 'letter', l: L }); }}
                    style={({ pressed }) => [st.key, { width: letterW, backgroundColor: hit ? pal.strong : pal.card, opacity: used && !hit ? 0.35 : (myTurn ? 1 : 0.7) }, pressed && { transform: [{ scale: 0.94 }] }]}
                    accessibilityRole="button" accessibilityLabel={L} accessibilityState={{ disabled: !myTurn || used }}>
                    <Text style={{ color: hit ? pal.onStrong : pal.ink, fontWeight: '800', fontSize: 16, textDecorationLine: used && !hit ? 'line-through' : 'none' }}>{L}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          {myTurn ? (guessOpen ? (
            <View style={[st.guessRow, { borderColor: pal.line }]}>
              <TextInput value={word} onChangeText={setWord} autoFocus autoCapitalize="characters" autoCorrect={false} placeholder={tr(t, 'games.forca.guessPh', 'Digite a palavra')}
                placeholderTextColor={pal.sub} style={{ flex: 1, color: pal.ink, fontSize: 16, paddingVertical: 8 }} onSubmitEditing={send} returnKeyType="send" />
              <Pressable onPress={send} style={[st.guessBtn, { backgroundColor: pal.strong }]}><Text style={{ color: pal.onStrong, fontWeight: '800' }}>{tr(t, 'games.forca.guessSend', 'Chutar')}</Text></Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setGuessOpen(true)} style={[st.guessOpen, { borderColor: pal.strong }]} accessibilityRole="button">
              <Text style={{ color: pal.ink, fontWeight: '800' }}>{tr(t, 'games.forca.guessWord', 'Chutar a palavra inteira')}</Text>
            </Pressable>
          )) : null}
        </>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  cat: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  word: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginVertical: 18 },
  kbRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 6 },
  key: { height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  guessOpen: { alignSelf: 'center', borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9, marginTop: 8 },
  guessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 12, padding: 4, marginTop: 8 },
  guessBtn: { borderRadius: 9, paddingHorizontal: 14, paddingVertical: 9 },
});
