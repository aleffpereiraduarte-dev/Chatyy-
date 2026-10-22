// components/flyGame/RecordCard.js — [voar 2026-10-22] cartão "Meu recorde no Brisa" para compartilhar.
// Desenhado em SVG (personagem e céu do jogo) e capturado como PNG (react-native-view-shot, já no binário)
// → folha de compartilhar do sistema (expo-sharing). Web: Web Share API com texto (ou copia o texto).
import React, { forwardRef } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect, Circle } from 'react-native-svg';
import { Buddy } from './BuddyArt';
import { PAL } from '../../services/flyGame/renderer';

function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k, vars ? { ...vars, defaultValue: fb } : fb) : fb; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}

const RecordCard = forwardRef(function RecordCard({ score, best, t }, ref) {
  return (
    <View ref={ref} collapsable={false} style={st.card}>
      <Svg style={StyleSheet.absoluteFill} width={360} height={450} viewBox="0 0 360 450">
        <Defs>
          <LinearGradient id="rc" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={PAL.sky0} /><Stop offset="0.55" stopColor={PAL.sky1} /><Stop offset="1" stopColor={PAL.sky3} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={360} height={450} fill="url(#rc)" />
        <Circle cx={290} cy={70} r={22} fill={PAL.moon} />
        <Circle cx={298} cy={64} r={20} fill={PAL.sky0} opacity={0.92} />
        <Circle cx={60} cy={60} r={1.6} fill={PAL.star} /><Circle cx={140} cy={36} r={1.2} fill={PAL.star} /><Circle cx={220} cy={110} r={1.4} fill={PAL.star} />
        <Rect x={0} y={392} width={360} height={58} fill={PAL.ground} />
        <Rect x={0} y={392} width={360} height={2} fill={PAL.groundLip} />
      </Svg>
      <View style={st.inner}>
        <Buddy size={120} tilt={-14} wing={0.9} />
        <Text style={st.game}>{tr(t, 'fly.title', 'Brisa')}</Text>
        <Text style={st.lbl}>{tr(t, 'fly.share.myRecord', 'Meu recorde')}</Text>
        <Text style={st.n}>{String(best)}</Text>
        <Text style={st.cta}>{tr(t, 'fly.share.cta', 'Consegue bater? Jogue no Chatyy')}</Text>
      </View>
    </View>
  );
});

export async function shareRecord(ref, best, t) {
  const text = tr(t, 'fly.share.text', 'Meu recorde no Brisa é {n}. Consegue bater? Jogue no Chatyy.', { n: best });
  if (Platform.OS === 'web') {
    try { if (navigator.share) { await navigator.share({ text }); return true; } } catch { return false; }
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
  try {
    const { captureRef } = require('react-native-view-shot');
    const uri = await captureRef(ref, { format: 'png', quality: 1, result: 'tmpfile' });
    const S = require('expo-sharing');
    if (await S.isAvailableAsync()) { await S.shareAsync(uri, { mimeType: 'image/png', dialogTitle: tr(t, 'fly.share', 'Compartilhar'), UTI: 'public.png' }); return true; }
  } catch {}
  try { const { Share } = require('react-native'); await Share.share({ message: text }); return true; } catch {}
  return false;
}

const st = StyleSheet.create({
  card: { width: 360, height: 450, borderRadius: 32, overflow: 'hidden', backgroundColor: '#141A24' },
  inner: { flex: 1, alignItems: 'center', paddingTop: 54 },
  game: { color: '#FFFFFF', fontSize: 34, fontWeight: '800', letterSpacing: -0.8, marginTop: 4 },
  lbl: { color: '#CFE0EE', fontSize: 14, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginTop: 14 },
  n: { color: '#FFFFFF', fontSize: 72, fontWeight: '900', letterSpacing: -2, marginTop: -2, fontVariant: ['tabular-nums'] },
  cta: { color: '#BFE6FF', fontSize: 14.5, fontWeight: '700', marginTop: 6 },
});

export default RecordCard;
