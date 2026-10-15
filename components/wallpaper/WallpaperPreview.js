// components/wallpaper/WallpaperPreview.js — [2026-10-15 native-wallpaper]
//
// Prévia em TELA CHEIA antes de aplicar (Telegram): o fundo real (nativo
// quando disponível, animando), bolhas de exemplo com a cor derivada do tema,
// alternância claro/escuro, padrão, movimento (paralaxe), desfoque da foto,
// cor das bolhas e "Aplicar em" (claro e escuro / só claro / só escuro).
// Renderizado como camada por cima da folha do seletor (mesmo <Modal>).
import React, { useState, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, Switch, ScrollView, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ChatWallpaper from './ChatWallpaper';
import { buildValue, bubbleFor, themeById, PATTERN_IDS } from './wallpaperSpec';
import { IconX, IconSun, IconMoon, IconCheck } from '../Icons';
import PressableScale from '../PressableScale';

const OWN_BG = { light: '#111111', dark: '#333336' };
const OTHER_BG = { light: '#EEEEF0', dark: '#1C1C1E' };

function Bubble({ own, text, dark, value }) {
  const tint = own ? bubbleFor(value, dark) : null;
  const bg = own ? (tint ? tint.bg : OWN_BG[dark ? 'dark' : 'light']) : OTHER_BG[dark ? 'dark' : 'light'];
  const color = own ? '#FFFFFF' : (dark ? '#F5F5F7' : '#111111');
  const meta = own ? 'rgba(255,255,255,0.62)' : (dark ? 'rgba(245,245,247,0.5)' : 'rgba(0,0,0,0.42)');
  return (
    <View style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '78%', marginVertical: 3, marginHorizontal: 12 }}>
      <View style={{ backgroundColor: bg, borderRadius: 18, borderBottomRightRadius: own ? 6 : 18, borderBottomLeftRadius: own ? 18 : 6, paddingHorizontal: 13, paddingVertical: 8, flexDirection: 'row', alignItems: 'flex-end' }}>
        <Text style={{ color, fontSize: 16, lineHeight: 21, flexShrink: 1 }}>{text}</Text>
        <Text style={{ color: meta, fontSize: 11, marginLeft: 8, marginBottom: 1 }}>{own ? '10:42' : '10:41'}</Text>
      </View>
    </View>
  );
}

export default function WallpaperPreview({ spec, appDark, t, onCancel, onApply }) {
  const insets = useSafeAreaInsets();
  const [s, setS] = useState(() => (spec ? { ...spec } : null));
  const [dark, setDark] = useState(!!appDark);
  const [target, setTarget] = useState('both'); // 'both' | 'light' | 'dark'
  useEffect(() => { setS(spec ? { ...spec } : null); }, [spec]);

  const value = useMemo(() => buildValue(s), [s]);
  const theme = s && s.t ? themeById(s.t) : null;
  const ink = dark ? '#FFFFFF' : '#111111';
  const inkInv = dark ? '#000000' : '#FFFFFF';
  const cardBg = dark ? 'rgba(28,28,30,0.94)' : 'rgba(255,255,255,0.95)';
  const sub = dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
  const line = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const tr = (k, d) => (t && t(k)) || d;
  const set = (patch) => setS((prev) => ({ ...(prev || {}), ...patch }));

  const ToggleRow = ({ label, value: on, onChange }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: line }}>
      <Text style={{ flex: 1, color: ink, fontSize: 15, fontWeight: '500' }}>{label}</Text>
      <Switch value={!!on} onValueChange={onChange}
        trackColor={{ true: ink, false: dark ? '#3A3A3C' : '#D1D1D6' }}
        thumbColor={Platform.OS === 'android' ? (on ? inkInv : '#F4F4F5') : undefined}
        ios_backgroundColor={dark ? '#3A3A3C' : '#D1D1D6'} />
    </View>
  );

  const Seg = ({ value: v, label }) => {
    const on = target === v;
    return (
      <TouchableOpacity onPress={() => setTarget(v)} activeOpacity={0.8}
        style={{ flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: on ? ink : 'transparent' }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', color: on ? inkInv : ink }}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const patternNow = theme ? (typeof s.p === 'string' ? s.p : theme.pattern) : null;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: dark ? '#000000' : '#FFFFFF' }]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <ChatWallpaper value={value} isDark={dark} autoplay={theme ? 2400 : 0} />
      </View>

      {/* barra superior */}
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
        <PressableScale onPress={onCancel} scaleTo={0.9} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: cardBg, alignItems: 'center', justifyContent: 'center' }}>
          <IconX size={20} color={ink} />
        </PressableScale>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ backgroundColor: cardBg, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 6 }}>
            <Text style={{ color: ink, fontSize: 15, fontWeight: '700' }}>{tr('chatConv.wallpaperPreview', 'Prévia')}</Text>
          </View>
        </View>
        <PressableScale onPress={() => setDark((d) => !d)} scaleTo={0.9} haptic="select" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: cardBg, alignItems: 'center', justifyContent: 'center' }}>
          {dark ? <IconSun size={20} color={ink} /> : <IconMoon size={20} color={ink} />}
        </PressableScale>
      </View>

      {/* bolhas de exemplo */}
      <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 12 }}>
        <Bubble own={false} dark={dark} value={value} text={tr('chatConv.wallpaperSample1', 'Oi! O que achou do novo fundo?')} />
        <Bubble own dark={dark} value={value} text={tr('chatConv.wallpaperSample2', 'Ficou lindo!')} />
      </View>

      {/* controles */}
      <View style={{ backgroundColor: cardBg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 14, paddingBottom: Math.max(insets.bottom, 12) + 4 }}>
        {theme ? (
          <>
            <Text style={{ color: sub, fontSize: 12.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 8 }}>{tr('chatConv.wallpaperPattern', 'Padrão')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 10 }}>
              {['', ...PATTERN_IDS].map((pid) => {
                const on = (patternNow || '') === pid;
                return (
                  <PressableScale key={pid || 'none'} onPress={() => set({ p: pid })} scaleTo={0.92} haptic="select"
                    style={{ width: 50, height: 50, borderRadius: 13, marginRight: 10, overflow: 'hidden', borderWidth: on ? 2.5 : StyleSheet.hairlineWidth, borderColor: on ? ink : line }}>
                    <ChatWallpaper value={buildValue({ t: s.t, p: pid })} isDark={dark} preview patternScale={0.3} motion={false} animate={false} />
                    {!pid ? (
                      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
                        <View style={{ width: 30, height: 2, backgroundColor: ink, opacity: 0.55, transform: [{ rotate: '-45deg' }] }} />
                      </View>
                    ) : null}
                  </PressableScale>
                );
              })}
            </ScrollView>
          </>
        ) : null}
        {s && (s.t || s.img) ? (
          <ToggleRow label={tr('chatConv.wallpaperMotion', 'Efeito de movimento')} value={!!s.m} onChange={(v) => set({ m: v ? 1 : 0 })} />
        ) : null}
        {s && s.img ? (
          <ToggleRow label={tr('chatConv.wallpaperBlur', 'Desfocar')} value={!!s.bl} onChange={(v) => set({ bl: v ? 1 : 0 })} />
        ) : null}
        {theme && theme.bubble ? (
          <ToggleRow label={tr('chatConv.wallpaperBubbleTint', 'Bolhas na cor do tema')} value={s.bb !== 0} onChange={(v) => set({ bb: v ? 1 : 0 })} />
        ) : null}

        <Text style={{ color: sub, fontSize: 12.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 10, marginBottom: 8 }}>{tr('chatConv.wallpaperApplyTo', 'Aplicar em')}</Text>
        <View style={{ flexDirection: 'row', backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', borderRadius: 11, padding: 3, marginBottom: 14 }}>
          <Seg value="both" label={tr('chatConv.wallpaperApplyBoth', 'Claro e escuro')} />
          <Seg value="light" label={tr('chatConv.wallpaperModeLight', 'Claro')} />
          <Seg value="dark" label={tr('chatConv.wallpaperModeDark', 'Escuro')} />
        </View>
        <PressableScale onPress={() => onApply && onApply(s, target)} scaleTo={0.97} haptic="medium"
          style={{ backgroundColor: ink, borderRadius: 13, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' }}>
          <IconCheck size={17} color={inkInv} strokeWidth={3} />
          <Text style={{ color: inkInv, fontWeight: '700', fontSize: 16, marginLeft: 8 }}>{tr('chatConv.wallpaperApply', 'Aplicar')}</Text>
        </PressableScale>
      </View>
    </View>
  );
}
