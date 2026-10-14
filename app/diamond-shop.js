// /diamond-shop — Loja de Diamantes (tela cheia).
//
// [2026-10-13 diamantes-religados] Reescrita P&B sobre DiamondStorePanel:
// iOS = só compra in-app (3.1.1, sem atalho de cartão/web); Android = só Play
// Billing ("Em breve" sem catálogo); web = cartão via Stripe. Preço local da
// loja, "Em breve" quando o produto não veio, "Restaurar compras pendentes".
// Atalhos: Carteira (histórico) e Meus ganhos.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, StatusBar } from 'react-native';
import { useRouter, Redirect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft } from '../components/Icons';
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
  const title = tr(t, 'diamondShop.title', 'Loja de Diamantes');
  const walletLabel = tr(t, 'diamondShop.wallet', 'Carteira');

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : (insets.top || 0) + 6 }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark, title,
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push('/wallet')} hitSlop={10} accessibilityRole="button">
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{walletLabel}</Text>
            </TouchableOpacity>
          ),
        })} />
      ) : (
        <View style={styles.headBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headTitle, { color: colors.text }]}>{title}</Text>
          <TouchableOpacity onPress={() => router.push('/wallet')} style={styles.headerLinkBtn} accessibilityRole="button">
            <Text style={[styles.headerLinkText, { color: colors.text }]}>{walletLabel}</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <DiamondStorePanel />
        <TouchableOpacity onPress={() => router.push('/wallet')} style={styles.link} accessibilityRole="button">
          <Text style={[styles.linkText, { color: colors.text }]}>{tr(t, 'diamondShop.viewHistory2', 'Ver histórico de transações')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 10 },
  backBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '800' },
  headerLinkBtn: { paddingHorizontal: 8, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerLinkText: { fontSize: 14, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingBottom: 40, width: '100%', maxWidth: 560, alignSelf: 'center' },
  link: { marginTop: 18, paddingVertical: 12, alignItems: 'center', minHeight: 44 },
  linkText: { fontSize: 14, fontWeight: '700' },
});
