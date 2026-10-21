// components/games/boards/novosKit.js — [jogos2b 2026-10-21] peças comuns de Termo/Stop/Desenho:
//  - GameKeys: teclado PRÓPRIO na tela (QWERTY, apagar, espaço opcional, confirmar). Nada de TextInput: o teclado
//    do sistema faria o painel (GameDock) recolher e o composer brigar pelo espaço — aqui o composer fica intacto.
//  - useSecsLeft: segundos até um prazo do SERVIDOR (offset = relógio do servidor − relógio do app), 1 Hz.
//  - useDeadlineTick: pede o avanço (onTick) quando o prazo vence (o servidor confere o horário).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { hTap } from '../fx';
import { PressScale, pop } from '../motion';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
export const TERMO_GREEN = '#2FB36B';
export const TERMO_YELLOW = '#D6A419';

function BackIcon({ color }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 5.5h10.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3.5 12z" /><Path d="M11.5 9.5l5 5M16.5 9.5l-5 5" />
    </Svg>
  );
}

function Key({ label, w, h, bg, fg, onPress, disabled, rm, a11y, children }) {
  const s = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={st}>
      <PressScale disabled={disabled} rm={rm} scaleTo={0.88} onPress={() => { pop(s, 1.06, rm); onPress(); }}
        style={[k.key, { width: w, height: h, backgroundColor: bg, opacity: disabled ? 0.45 : 1 }]}
        accessibilityRole="button" accessibilityLabel={a11y || label} accessibilityState={{ disabled: !!disabled }}>
        {children || <Text style={{ color: fg, fontWeight: '800', fontSize: Math.min(17, h * 0.4) }}>{label}</Text>}
      </PressScale>
    </Animated.View>
  );
}

/**
 * Teclado da tela. `states` = {A:'g'|'y'|'x'} (Termo pinta as teclas). `onKey(L)`, `onBack()`, `onEnter()`.
 * `space` = mostra barra de espaço (Stop/Desenho). `enterLabel` = texto do botão de confirmar.
 */
export function GameKeys({ width, onKey, onBack, onEnter, enterLabel, enterDisabled, states, pal, rm, disabled, space, keyH = 44, backLabel = 'Apagar', spaceLabel = 'espaço' }) {
  const gap = 5;
  const kw = Math.floor((width - gap * 9 - 4) / 10);
  const tap = (fn) => () => { hTap(); fn(); };
  const colorOf = (L) => {
    const s = states && states[L];
    if (s === 'g') return [TERMO_GREEN, '#FFFFFF'];
    if (s === 'y') return [TERMO_YELLOW, '#FFFFFF'];
    if (s === 'x') return [pal.dark ? '#3A3A3F' : '#A9A9AE', '#FFFFFF'];
    return [pal.card2, pal.ink];
  };
  return (
    <View style={{ gap, alignItems: 'center', width }}>
      {ROWS.map((row, ri) => (
        <View key={row} style={{ flexDirection: 'row', gap }}>
          {ri === 2 && onEnter ? (
            <Key label={enterLabel || 'OK'} w={kw * 1.5 + gap / 2} h={keyH} bg={pal.strong} fg={pal.onStrong} rm={rm} disabled={disabled || enterDisabled} onPress={tap(onEnter)}>
              <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 12.5 }} numberOfLines={1} adjustsFontSizeToFit>{enterLabel || 'OK'}</Text>
            </Key>
          ) : null}
          {row.split('').map((L) => { const [bg, fg] = colorOf(L); return <Key key={L} label={L} w={kw} h={keyH} bg={bg} fg={fg} rm={rm} disabled={disabled} onPress={tap(() => onKey(L))} />; })}
          {ri === 2 ? (
            <Key label="" a11y={backLabel} w={kw * 1.5 + gap / 2} h={keyH} bg={pal.card2} fg={pal.ink} rm={rm} disabled={disabled} onPress={tap(onBack)}>
              <BackIcon color={pal.ink} />
            </Key>
          ) : null}
        </View>
      ))}
      {space ? (
        <View style={{ flexDirection: 'row', gap }}>
          <Key label={spaceLabel} a11y={spaceLabel} w={kw * 5 + gap * 4} h={Math.round(keyH * 0.82)} bg={pal.card2} fg={pal.sub} rm={rm} disabled={disabled} onPress={tap(() => onKey(' '))} />
        </View>
      ) : null}
    </View>
  );
}

/** Segundos até `deadline` (ms no relógio do servidor). */
export function useSecsLeft(deadline, offset, running) {
  const calc = () => (deadline ? Math.max(0, Math.ceil((Number(deadline) - (Date.now() + (offset || 0))) / 1000)) : 0);
  const [s, setS] = useState(calc);
  useEffect(() => {
    setS(calc());
    if (!running || !deadline) return undefined;
    const iv = setInterval(() => setS(calc()), 1000);
    return () => clearInterval(iv);
  }, [deadline, offset, running]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

/** Quando o prazo (servidor) vence, pede o avanço — no máx. 1 pedido a cada 1,5 s. */
export function useDeadlineTick(due, offset, active, onTick) {
  const last = useRef(0);
  useEffect(() => {
    if (!active || !due || !onTick) return undefined;
    const fire = () => {
      if (Date.now() + (offset || 0) < Number(due)) return;
      if (Date.now() - last.current < 1500) return;
      last.current = Date.now();
      try { onTick(); } catch {}
    };
    const left = Number(due) - (Date.now() + (offset || 0));
    const tm = setTimeout(fire, Math.max(120, Math.min(600000, left + 80)));
    const iv = setInterval(fire, 2000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, [due, offset, active, onTick]);
}

/** Pílula de tempo (fica vermelha nos últimos segundos). */
export function TimePill({ secs, pal, warnAt = 10, label }) {
  const warn = secs <= warnAt;
  const mm = Math.floor(secs / 60); const ss = secs % 60;
  return (
    <View style={[k.pill, { backgroundColor: warn ? pal.bad : pal.card2 }]} accessibilityLabel={`${secs} s`}>
      <Text style={{ color: warn ? '#FFFFFF' : pal.ink, fontWeight: '800', fontSize: 13, fontVariant: ['tabular-nums'] }}>
        {label ? label + ' ' : ''}{mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`}
      </Text>
    </View>
  );
}

const k = StyleSheet.create({
  key: { borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 11, paddingHorizontal: 9, paddingVertical: 4, minWidth: 44, alignItems: 'center' },
});
