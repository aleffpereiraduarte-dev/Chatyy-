// HomeGreeting — header bonito pra home page do Chatyy.
//
// Layout horizontal (WhatsApp/iOS-style): avatar à esquerda, bloco texto no
// centro com saudação dinâmica + status do user, e duas ações compactas
// (busca, câmera) à direita. Animação suave de entrada (fade + slide).
//
// Sem purple glow — user pediu pra deixar a página principal mais bonita
// mas reclamou de gradientes carregados, então usamos só uma surface flat
// com um hairline divider em baixo pra separar do chat list.

import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Easing,
  Platform,
} from 'react-native';

import AvatarCircle from './AvatarCircle';
import { IconSearch, IconCamera } from './Icons';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { displayNameFor } from '../services/displayName';

function firstNameOf(user) {
  if (!user) return '';
  const full = displayNameFor(user) || '';
  // Primeiro token "humano" — ignora handles tipo "@itsneres" e fragmentos
  // que começam com símbolo. Mantém acentos (Á-ú) e dígitos pra evitar perda
  // de nomes legítimos (ex.: "Maria2").
  const parts = String(full)
    .split(/\s+/)
    .map(p => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9'-]*$/.test(p)) return p;
  }
  return parts[0] || '';
}

function greetingKeyForHour(hour) {
  // 5-11 manhã, 12-17 tarde, 18-22 noite, 23-4 madrugada.
  if (hour >= 5 && hour <= 11) return 'home.greeting.morning';
  if (hour >= 12 && hour <= 17) return 'home.greeting.afternoon';
  if (hour >= 18 && hour <= 22) return 'home.greeting.evening';
  return 'home.greeting.night';
}

export default function HomeGreeting({
  user,
  onSearchPress,
  onCameraPress,
  onAvatarPress,
}) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  // Saudação calculada uma vez no mount; se o user ficar com a home aberta
  // virando o dia, recalculamos via interval leve (60s) sem re-renderizar
  // nada além do label quando a faixa horária muda.
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(-10)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, slide]);

  const firstName = useMemo(() => firstNameOf(user), [user]);

  // useMemo recalcula só quando troca de hora cheia — sem listener custoso.
  // Caller pode forçar refresh remontando o componente.
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return t(greetingKeyForHour(h), { name: firstName || '' }).trim();
  }, [firstName, t]);

  // Status: respeita user.status (com emoji vindo do user — OK por regra)
  // ou user.bio; senão usa fallback i18n. Trunca em 80 chars pra não vazar
  // pra 2ª linha.
  const statusText = useMemo(() => {
    const raw =
      (user && (user.status || user.bio || user.about)) || '';
    const cleaned = String(raw).trim();
    if (cleaned) {
      return cleaned.length > 80 ? cleaned.slice(0, 79) + '…' : cleaned;
    }
    return t('home.greeting.howAreYou');
  }, [user, t]);

  const handleAvatar = () => {
    if (typeof onAvatarPress === 'function') onAvatarPress();
  };
  const handleSearch = () => {
    if (typeof onSearchPress === 'function') onSearchPress();
  };
  const handleCamera = () => {
    if (typeof onCameraPress === 'function') onCameraPress();
  };

  const iconColor = colors.text;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderBottomColor: colors.borderLight,
          opacity: fade,
          transform: [{ translateY: slide }],
        },
      ]}
      accessibilityRole="header"
    >
      {/* Avatar à esquerda — anel sutil pra dar elegância sem pesar. */}
      <Pressable
        onPress={handleAvatar}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('home.greeting.howAreYou')}
        style={({ pressed }) => [
          styles.avatarWrap,
          { opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View
          style={[
            styles.avatarRing,
            { borderColor: colors.borderLight },
          ]}
        >
          <AvatarCircle
            name={displayNameFor(user)}
            email={user?.email}
            uri={user?.avatar_url}
            size={56}
          />
        </View>
      </Pressable>

      {/* Bloco de texto — saudação + status/recado curto. */}
      <View style={styles.textBlock}>
        <Text
          style={[styles.greeting, { color: colors.text }]}
          numberOfLines={1}
          allowFontScaling
        >
          {greeting}
        </Text>
        <Text
          style={[styles.status, { color: colors.textSecondary }]}
          numberOfLines={1}
          allowFontScaling
        >
          {statusText}
        </Text>
      </View>

      {/* Ações compactas à direita. */}
      <View style={styles.actions}>
        <Pressable
          onPress={handleSearch}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={({ pressed }) => [
            styles.actionBtn,
            {
              backgroundColor: pressed
                ? colors.surfaceVariant || colors.borderLight
                : 'transparent',
            },
          ]}
        >
          <IconSearch size={22} color={iconColor} />
        </Pressable>
        <Pressable
          onPress={handleCamera}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Camera"
          style={({ pressed }) => [
            styles.actionBtn,
            {
              backgroundColor: pressed
                ? colors.surfaceVariant || colors.borderLight
                : 'transparent',
            },
          ]}
        >
          <IconCamera size={22} color={iconColor} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    // Pequena sombra só no web pra dar uma elevação suave. iOS/Android
    // ficam flat — o hairline borderBottom já separa do conteúdo abaixo.
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 1px 0 rgba(0,0,0,0.02)' }
      : null),
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatarRing: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  greeting: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  status: {
    fontSize: 13,
    marginTop: 2,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
});
