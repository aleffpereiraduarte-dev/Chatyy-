// [2026-10-09 native-sheets] Rota-ponte do sheet NATIVO (formSheet do
// react-native-screens: UISheetPresentationController no iOS, BottomSheet no
// Android). Renderiza o conteúdo registrado por <NativeSheet> (components/
// NativeSheet.js). Não tem conteúdo próprio: sem id válido ela se remove.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { StackActions, useRoute } from '@react-navigation/native';
import {
  getNativeSheetEntry, subscribeNativeSheet, attachNativeSheetRoute, detachNativeSheetRoute,
} from '../components/NativeSheet';

export default function NativeSheetRoute() {
  const params = useLocalSearchParams();
  const id = String(params?.id || '');
  const navigation = useNavigation();
  const route = useRoute();
  const routeKeyRef = useRef(route?.key);
  routeKeyRef.current = route?.key;
  const poppedRef = useRef(false);

  const subscribe = useCallback((fn) => subscribeNativeSheet(id, fn), [id]);
  const getSnap = useCallback(() => getNativeSheetEntry(id)?.content ?? null, [id]);
  const content = useSyncExternalStore(subscribe, getSnap, getSnap);

  const popSelf = useCallback(() => {
    if (poppedRef.current) return;
    poppedRef.current = true;
    try {
      const state = navigation.getState?.();
      const key = routeKeyRef.current;
      if (state && key && Array.isArray(state.routes) && state.routes.some((r) => r.key === key)) {
        navigation.dispatch({ ...StackActions.pop(), source: key, target: state.key });
      }
    } catch {}
  }, [navigation]);

  useEffect(() => {
    const ok = attachNativeSheetRoute(id, popSelf);
    if (!ok) popSelf();
    return () => { detachNativeSheetRoute(id); };
  }, [id, popSelf]);

  // [2026-10-16 poll-wa] iOS + detents numéricos ([0.6, 1], [1]…): o
  // react-native-screens 4.23 posiciona o conteúdo do formSheet SEM bottom
  // (altura = conteúdo) e "caça" um ScrollView (1º filho em cadeia / filho
  // direto) p/ forçar o frame dele = sheet inteiro em (0,0) → lista cobrindo o
  // cabeçalho, sem padding, rodapé flutuando (painel Apps [hotfix-3], criar
  // enquete 16/10). Aqui o conteúdo ganha ALTURA REAL do detent atual (flex:1
  // volta a funcionar, ScrollView rola dentro do próprio layout Yoga) e um 1º
  // filho vazio que desarma a caça (nada é forçado). fitToContents fica como
  // estava. OPT-IN até testar no iPhone: globalThis.__chatyy_sheet_bounded = true.
  const entry = getNativeSheetEntry(id);
  const detents = entry && Array.isArray(entry.detents) ? entry.detents : null;
  const bounded = !!detents && detents.length > 0 && Platform.OS === 'ios' && _boundedOn();
  const [detIdx, setDetIdx] = useState(() => {
    const i = Number(entry && entry.initialDetent) || 0;
    return detents ? Math.max(0, Math.min(detents.length - 1, i)) : 0;
  });
  useEffect(() => {
    if (!bounded || !navigation || typeof navigation.addListener !== 'function') return undefined;
    try {
      return navigation.addListener('sheetDetentChange', (e) => {
        const i = e && e.data ? Number(e.data.index) : NaN;
        if (Number.isInteger(i) && i >= 0) setDetIdx(i);
      });
    } catch { return undefined; }
  }, [bounded, navigation]);
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (content == null) return <View />;
  if (!bounded) return content;
  const frac = Number(detents[Math.min(detIdx, detents.length - 1)]) || 1;
  // Detent "grande" do UIKit: topo do sheet = safe area de cima (iOS 26) ou
  // +10 pt (iOS ≤ 18). Detent custom = fração dessa altura máxima.
  const largeH = Math.max(320, (win.height || 0) - ((insets && insets.top) || 0) - (_iosMajor() >= 26 ? 0 : 10));
  const h = Math.max(160, Math.round(largeH * Math.max(0.1, Math.min(1, frac))));
  return (
    <View collapsable={false} style={{ height: h }}>
      <View collapsable={false} pointerEvents="none" style={{ height: 0 }} />
      <View collapsable={false} style={{ flex: 1 }}>{content}</View>
    </View>
  );
}

function _boundedOn() {
  try { return globalThis.__chatyy_sheet_bounded === true; } catch { return false; }
}
function _iosMajor() {
  try { return parseInt(String(Platform.Version), 10) || 0; } catch { return 0; }
}
