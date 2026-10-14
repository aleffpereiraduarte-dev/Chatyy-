// /diamond-shop — Loja de Diamantes (tela cheia).
//
// [2026-10-14 carteira-v3] Mesmo acabamento da Carteira: fundo agrupado,
// herói grafite, grade de pacotes (DiamondStorePanel/useDiamondStore).
// iOS = só compra in-app (3.1.1, sem atalho de cartão/web); Android = só Play
// Billing ("Em breve" sem catálogo); web = cartão via Stripe. Preço local da
// loja, "Restaurar compras pendentes". Atalho: Carteira (histórico).

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import { useLanguage } from '../context/LanguageContext';
import { IconChevronRight } from '../components/Icons';
import { TopBar, useSurface, PressableScale, Type, Space, Layout } from '../components/ui';
import DiamondStorePanel from '../components/diamonds/DiamondStorePanel';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

export default function DiamondShopScreen() {
  if (!DIAMONDS_ENABLED) return <Redirect href="/chat" />;
  return <DiamondShop />;
}

function DiamondShop() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const s = useSurface();
  const title = tr(t, 'diamondShop.title', 'Loja de Diamantes');
  const walletLabel = tr(t, 'diamondShop.wallet', 'Carteira');
  const goWallet = () => { try { router.push('/wallet'); } catch {} };

  return (
    <View style={[styles.container, { backgroundColor: s.bgGrouped }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark, title,
          headerRight: () => (
            <TouchableOpacity onPress={goWallet} hitSlop={10} accessibilityRole="button">
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{walletLabel}</Text>
            </TouchableOpacity>
          ),
        })} />
      ) : (
        <TopBar
          title={title}
          onBack={() => { try { router.back(); } catch {} }}
          maxWidth={Layout.contentMaxWidth}
          right={(
            <PressableScale onPress={goWallet} hitSlop={10} accessibilityRole="button" style={styles.headerLinkBtn}>
              <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{walletLabel}</Text>
            </PressableScale>
          )}
        />
      )}

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: Math.max(Space.xxxl, (insets.bottom || 0) + Space.xl) }]}
        showsVerticalScrollIndicator={false}
      >
        <DiamondStorePanel />
        <PressableScale onPress={goWallet} haptic="light" accessibilityRole="link"
          style={[styles.link, { backgroundColor: s.surface, borderColor: s.border }]}>
          <Text style={[Type.callout, { color: s.text, fontWeight: '600', flex: 1 }]}>{tr(t, 'diamondShop.viewHistory2', 'Ver histórico de transações')}</Text>
          <IconChevronRight size={18} color={s.textSecondary} />
        </PressableScale>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerLinkBtn: { paddingHorizontal: Space.sm, height: 44, alignItems: 'center', justifyContent: 'center' },
  body: { padding: Layout.gutter, width: '100%', maxWidth: Layout.contentMaxWidth, alignSelf: 'center' },
  link: { marginTop: Space.xl, minHeight: 52, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg },
});
