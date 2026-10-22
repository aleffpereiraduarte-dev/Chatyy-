// components/flyGame/FlyHero.js — [voar 2026-10-22] atalhos do Brisa: faixa no topo do seletor de jogos
// (FlyHero) e pílula na home de Conversas (FlyPill). Só aparecem com o app liberado (kill
// globalThis.__chatyy_fly_game=false) E o servidor respondendo (chat_game_fly_info). Abrem a rota /voar
// depois que a folha nativa descer (nunca tela sobre folha no iOS).
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect, Circle } from 'react-native-svg';
import { Buddy } from './BuddyArt';
import { PAL } from '../../services/flyGame/renderer';
import { flyAvailable, probeFly, onFlyCap, flyKilled, bestSync, loadBest, onBest, flyBadge } from '../../services/flyGame/api';

function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k, vars ? { ...vars, defaultValue: fb } : fb) : fb; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}
export function useFlyAvailable() {
  const [on, setOn] = useState(flyAvailable());
  useEffect(() => {
    if (flyKilled()) return undefined;
    let alive = true;
    const off = onFlyCap((v) => alive && setOn(!!v && !flyKilled()));
    probeFly().then((v) => alive && setOn(!!v && !flyKilled())).catch(() => {});
    return () => { alive = false; off(); };
  }, []);
  return on;
}
export function openFly(router, after) {
  const go = () => { try { (router || require('expo-router').router).push('/voar'); } catch {} };
  if (after) { try { require('../NativeSheet').runAfterNativeSheet(go); return; } catch {} }
  go();
}

export function FlyHero({ t, onOpen }) {
  const on = useFlyAvailable();
  const [best, setBest] = useState(bestSync());
  useEffect(() => { loadBest().then(setBest).catch(() => {}); return onBest(setBest); }, []);
  if (!on) return null;
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [st.hero, pressed && { transform: [{ scale: 0.985 }] }]} accessibilityRole="button"
      accessibilityLabel={tr(t, 'fly.hero.a11y', 'Brisa, jogo de voar sozinho com ranking da semana')}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 40">
        <Defs><LinearGradient id="flyh" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={PAL.sky0} /><Stop offset="1" stopColor={PAL.sky2} /></LinearGradient></Defs>
        <Rect x={0} y={0} width={100} height={40} fill="url(#flyh)" />
        <Circle cx={88} cy={9} r={3} fill={PAL.moon} />
        <Rect x={0} y={36} width={100} height={4} fill={PAL.ground} />
      </Svg>
      <Buddy size={58} tilt={-10} wing={0.8} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={st.title}>{tr(t, 'fly.title', 'Brisa')}</Text>
          <Text style={st.badge}>{tr(t, 'fly.new', 'NOVO')}</Text>
        </View>
        <Text style={st.sub} numberOfLines={2}>{tr(t, 'fly.hero.sub', 'Voe com um toque. Ranking da semana.')}</Text>
        {best > 0 ? <Text style={st.best}>{tr(t, 'fly.best', 'Recorde: {n}', { n: best })}</Text> : null}
      </View>
      <View style={st.play}><Text style={st.playTxt}>{tr(t, 'fly.play', 'Jogar')}</Text></View>
    </Pressable>
  );
}

export function FlyPill({ t, isDark, color, router }) {
  const on = useFlyAvailable();
  if (!on) return null;
  return (
    <Pressable onPress={() => openFly(router, false)} hitSlop={4} accessibilityRole="button" accessibilityLabel={tr(t, 'fly.title', 'Brisa')}
      style={({ pressed }) => [st.pill, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f2' }, pressed && { opacity: 0.75 }, Platform.OS === 'web' && { cursor: 'pointer' }]}>
      <Buddy size={20} tilt={-8} wing={0.6} />
      <Text style={[st.pillTxt, { color }]} numberOfLines={1}>{tr(t, 'fly.title', 'Brisa')}</Text>
    </Pressable>
  );
}

/** Selo no perfil: top da semana no Brisa (só depois da revisão do prêmio no admin). */
export function FlyProfileBadge({ email, th }) {
  const on = useFlyAvailable();
  const [b, setB] = useState(null);
  useEffect(() => {
    if (!on || !email) return undefined;
    let alive = true;
    flyBadge(email).then((v) => alive && setB(v)).catch(() => {});
    return () => { alive = false; };
  }, [on, email]);
  if (!on || !b || !b.rank) return null;
  const label = b.rank <= 3 ? `Top ${b.rank} · Brisa` : `Top 10 · Brisa`;
  return (
    <View style={[st.badgeRow, { backgroundColor: (th && th.card) || 'rgba(143,211,255,0.14)' }]} accessible accessibilityLabel={label}>
      <Buddy size={18} tilt={-8} wing={0.6} />
      <Text style={[st.badgeTxt, { color: (th && th.text) || '#111' }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center', marginTop: 8, paddingLeft: 6, paddingRight: 10, height: 26, borderRadius: 13 },
  badgeTxt: { fontSize: 12.5, fontWeight: '700' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, padding: 14, paddingLeft: 10, borderRadius: 22, overflow: 'hidden', backgroundColor: PAL.sky1 },
  title: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', letterSpacing: -0.3 },
  badge: { backgroundColor: '#8FD3FF', color: '#0F1620', fontSize: 10, fontWeight: '900', paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 7, overflow: 'hidden' },
  sub: { color: '#CFE0EE', fontSize: 13, fontWeight: '600', marginTop: 2 },
  best: { color: '#BFE6FF', fontSize: 12, fontWeight: '800', marginTop: 3 },
  play: { height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: '#F3F7FB', alignItems: 'center', justifyContent: 'center' },
  playTxt: { color: '#121821', fontWeight: '800', fontSize: 14 },
  pill: { height: 30, paddingLeft: 6, paddingRight: 12, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 4 },
  pillTxt: { fontSize: 13.5, fontWeight: '600', letterSpacing: -0.1 },
});
