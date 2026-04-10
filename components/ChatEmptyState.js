/**
 * ChatEmptyState — illustrated empty states for chat-related screens.
 * Use for: no conversations, no messages, no calls, no search results, no status, etc.
 *
 * Usage:
 *   <ChatEmptyState type="no-chats" action={{ label: 'Nova conversa', onPress: () => router.push('/chat-new') }} />
 *   <ChatEmptyState type="no-messages" subtitle="Diga oi para começar" />
 */
import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import Svg, { Path, Circle, Rect, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';

function FloatWrap({ children }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, [anim]);
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  return <Animated.View style={{ transform: [{ translateY }] }}>{children}</Animated.View>;
}

function NoChats({ accent }) {
  return (
    <Svg width={160} height={160} viewBox="0 0 200 200">
      <Defs>
        <SvgGradient id="bg-c" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity="0.18" />
          <Stop offset="1" stopColor={accent} stopOpacity="0.04" />
        </SvgGradient>
      </Defs>
      <Circle cx="100" cy="100" r="92" fill="url(#bg-c)" />
      <Path d="M55 78 Q55 62 71 62 L130 62 Q146 62 146 78 L146 116 Q146 132 130 132 L96 132 L78 148 L82 132 L71 132 Q55 132 55 116 Z" fill={accent} />
      <Circle cx="80" cy="97" r="5" fill="#fff" />
      <Circle cx="100" cy="97" r="5" fill="#fff" />
      <Circle cx="120" cy="97" r="5" fill="#fff" />
      <Path d="M105 38 Q105 28 115 28 L156 28 Q166 28 166 38 L166 58 Q166 68 156 68 L135 68 L122 78 L125 68 L115 68 Q105 68 105 58 Z" fill={accent} opacity="0.4" />
    </Svg>
  );
}

function NoMessages({ accent }) {
  return (
    <Svg width={160} height={160} viewBox="0 0 200 200">
      <Defs>
        <SvgGradient id="bg-m" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity="0.2" />
          <Stop offset="1" stopColor={accent} stopOpacity="0.02" />
        </SvgGradient>
      </Defs>
      <Circle cx="100" cy="100" r="86" fill="url(#bg-m)" />
      <Path d="M40 72 Q40 56 56 56 L122 56 Q138 56 138 72 L138 92 Q138 108 122 108 L62 108 L46 124 L50 108 L56 108 Q40 108 40 92 Z" fill={accent} opacity="0.85" />
      <Path d="M75 116 Q75 100 91 100 L156 100 Q172 100 172 116 L172 136 Q172 152 156 152 L161 168 L141 152 L91 152 Q75 152 75 136 Z" fill="#fff" stroke={accent} strokeWidth="3" />
    </Svg>
  );
}

function NoCalls({ accent }) {
  return (
    <Svg width={160} height={160} viewBox="0 0 200 200">
      <Defs>
        <SvgGradient id="bg-cl" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#22c55e" stopOpacity="0.15" />
          <Stop offset="1" stopColor="#22c55e" stopOpacity="0.04" />
        </SvgGradient>
      </Defs>
      <Circle cx="100" cy="100" r="92" fill="url(#bg-cl)" />
      <Path d="M70 60 Q60 60 60 70 L60 90 Q70 110 100 130 Q130 150 140 140 L155 125 Q160 120 155 115 L135 100 Q130 95 125 100 L115 110 Q105 105 95 95 Q85 85 90 75 L100 65 Q105 60 100 55 L85 35 Q80 30 75 35 Z" fill="#22c55e" />
      <Circle cx="100" cy="100" r="62" fill="none" stroke="#22c55e" strokeWidth="2" opacity="0.4" />
      <Circle cx="100" cy="100" r="78" fill="none" stroke="#22c55e" strokeWidth="2" opacity="0.2" />
    </Svg>
  );
}

function NoSearch({ accent }) {
  return (
    <Svg width={160} height={160} viewBox="0 0 200 200">
      <Defs>
        <SvgGradient id="bg-s" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity="0.15" />
          <Stop offset="1" stopColor={accent} stopOpacity="0.03" />
        </SvgGradient>
      </Defs>
      <Circle cx="100" cy="100" r="86" fill="url(#bg-s)" />
      <Circle cx="90" cy="90" r="35" fill="none" stroke={accent} strokeWidth="8" />
      <Path d="M115 115 L150 150" stroke={accent} strokeWidth="10" strokeLinecap="round" />
    </Svg>
  );
}

function NoStatus({ accent }) {
  return (
    <Svg width={160} height={160} viewBox="0 0 200 200">
      <Defs>
        <SvgGradient id="bg-st" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#a855f7" stopOpacity="0.18" />
          <Stop offset="1" stopColor="#a855f7" stopOpacity="0.04" />
        </SvgGradient>
      </Defs>
      <Circle cx="100" cy="100" r="92" fill="url(#bg-st)" />
      <Circle cx="100" cy="100" r="55" fill="#fff" stroke="#a855f7" strokeWidth="4" strokeDasharray="10 6" />
      <Path d="M85 85 L120 100 L85 115 Z" fill="#a855f7" />
    </Svg>
  );
}

const TYPES = {
  'no-chats':    { Comp: NoChats,    title: 'Sem conversas',         subtitle: 'Comece uma nova conversa pra trocar mensagens' },
  'no-messages': { Comp: NoMessages, title: 'Comece a conversa',     subtitle: 'Diga oi e quebre o gelo!' },
  'no-calls':    { Comp: NoCalls,    title: 'Nenhuma ligacao',       subtitle: 'Seu historico de chamadas aparecera aqui' },
  'no-search':   { Comp: NoSearch,   title: 'Nada encontrado',       subtitle: 'Tente outras palavras-chave' },
  'no-status':   { Comp: NoStatus,   title: 'Nenhum status',         subtitle: 'Os status que voce e seus contatos publicarem aparecem aqui por 24h' },
};

export default function ChatEmptyState({ type = 'no-chats', title, subtitle, action, style }) {
  const { colors } = useTheme();
  const cfg = TYPES[type] || TYPES['no-chats'];
  const Illustration = cfg.Comp;
  const accent = colors.primary || '#7C3AED';
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, [fadeIn]);

  return (
    <Animated.View style={[styles.container, { opacity: fadeIn }, style]}>
      <FloatWrap>
        <Illustration accent={accent} />
      </FloatWrap>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
        {title || cfg.title}
      </Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={3}>
        {subtitle || cfg.subtitle}
      </Text>
      {action && (
        <TouchableOpacity
          onPress={action.onPress}
          style={[styles.button, { backgroundColor: accent }]}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>{action.label}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    minHeight: 400,
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    marginTop: 24,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  button: {
    marginTop: 28,
    paddingHorizontal: 32,
    paddingVertical: 13,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: 0.2,
  },
});
