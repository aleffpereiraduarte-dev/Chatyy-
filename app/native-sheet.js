// [2026-10-09 native-sheets] Rota-ponte do sheet NATIVO (formSheet do
// react-native-screens: UISheetPresentationController no iOS, BottomSheet no
// Android). Renderiza o conteúdo registrado por <NativeSheet> (components/
// NativeSheet.js). Não tem conteúdo próprio: sem id válido ela se remove.
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { View } from 'react-native';
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

  if (content == null) return <View />;
  return content;
}
