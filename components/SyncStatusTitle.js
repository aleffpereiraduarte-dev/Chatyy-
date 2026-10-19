// [2026-10-13 sync-status] Título da home que vira o status de sincronização
// (padrão WhatsApp: "Conversas" → spinner pequeno + "Conectando…"). Crossfade
// no MESMO espaço do título (sem empurrar a lista); some com fade assim que o
// estado volta a idle. A política de quando mostrar está em
// services/syncStatus.js (debounce 1,5 s, watchdog, 2º plano).
//
// Props:
//   title            texto normal ("Conversas")
//   titleStyle       estilo do título normal (fonte/cor)
//   statusTextStyle  estilo do texto de status (menor que um large title)
//   containerStyle   padding/margens do bloco
//   align            'left' | 'center'
//   announce         true numa instância só → leitor de tela anuncia (polite)
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, ActivityIndicator, AccessibilityInfo, Platform, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import useSyncStatus, { syncStatusLabel } from '../hooks/useSyncStatus';
import { IconWifiOff } from './Icons';

function SyncStatusTitle({
  title, titleStyle, statusTextStyle, containerStyle, align = 'left',
  announce = false, accessibilityRole = 'header', numberOfLines = 1,
}) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const st = useSyncStatus();
  const visible = st.kind !== 'idle';
  // Mantém o último rótulo durante o fade-out (senão o texto sumiria antes).
  const [shown, setShown] = useState(st);
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  // [2026-10-19 sync-title-overlap] Fim da animação → opacidades FIXAS (sem o
  // driver nativo). No título grande hospedado no header da lista nativa o
  // crossfade às vezes parava no meio ("Conectando…" por cima de um "Conversas"
  // meio apagado, founder 19/10). `settled` = estado já assentado; enquanto não
  // assenta, a animação manda; depois, valores estáticos 0/1.
  const [settled, setSettled] = useState(visible);
  useEffect(() => {
    if (visible) setShown(st);
    let done = false;
    const dur = visible ? 180 : 260;
    const settle = () => { if (!done) { done = true; setSettled(visible); } };
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: dur,
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => settle());
    // Rede de segurança: callback do driver nativo que nunca chega.
    const t = setTimeout(settle, dur + 120);
    return () => { done = true; clearTimeout(t); };
  }, [st, visible, anim]);
  const isSettled = settled === visible;

  const label = syncStatusLabel(shown, t) || '';

  // iOS não tem accessibilityLiveRegion → anúncio explícito (só na troca de tipo,
  // não a cada % do bootstrap).
  const lastAnnounced = useRef('');
  useEffect(() => {
    if (!announce || Platform.OS !== 'ios') return;
    const key = visible ? st.kind : 'idle';
    if (key === lastAnnounced.current) return;
    lastAnnounced.current = key;
    if (visible) { try { AccessibilityInfo.announceForAccessibility?.(syncStatusLabel(st, t) || ''); } catch {} }
  }, [announce, visible, st, t]);

  const muted = isDark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.55)';
  const titleOpacity = isSettled ? (visible ? 0 : 1) : anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const statusOpacity = isSettled ? (visible ? 1 : 0) : anim;
  const isOffline = shown.kind === 'offline';

  return (
    <View
      style={[{ justifyContent: 'center' }, containerStyle]}
      accessibilityLiveRegion={announce ? 'polite' : undefined}
    >
      <Animated.Text
        numberOfLines={numberOfLines}
        accessibilityRole={accessibilityRole}
        accessibilityElementsHidden={visible}
        importantForAccessibility={visible ? 'no-hide-descendants' : 'auto'}
        style={[{ color: colors.text }, titleStyle, { opacity: titleOpacity }]}
      >
        {title}
      </Animated.Text>
      <Animated.View
        pointerEvents="none"
        accessible={visible}
        accessibilityRole="text"
        accessibilityLabel={visible ? label : undefined}
        importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
        style={[
          StyleSheet.absoluteFill,
          containerStyle ? _padOnly(containerStyle) : null,
          {
            flexDirection: 'row', alignItems: 'center', gap: 8,
            justifyContent: align === 'center' ? 'center' : 'flex-start',
            opacity: statusOpacity,
          },
        ]}
      >
        {isOffline
          ? <IconWifiOff size={15} color={muted} />
          : <ActivityIndicator size="small" color={muted} style={{ transform: [{ scale: 0.8 }] }} />}
        <Text
          numberOfLines={1}
          style={[{ fontSize: 17, fontWeight: '600', letterSpacing: -0.3, color: colors.text, flexShrink: 1 }, statusTextStyle]}
        >
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}

// O overlay absoluto precisa respeitar o padding do container p/ alinhar com o título.
function _padOnly(style) {
  const f = StyleSheet.flatten(style) || {};
  const out = {};
  ['padding', 'paddingHorizontal', 'paddingVertical', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'paddingStart', 'paddingEnd']
    .forEach((k) => { if (f[k] != null) out[k] = f[k]; });
  return out;
}

export default React.memo(SyncStatusTitle);
