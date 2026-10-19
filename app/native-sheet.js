// [2026-10-09 native-sheets] Rota-ponte do sheet NATIVO (formSheet do
// react-native-screens: UISheetPresentationController no iOS, BottomSheet no
// Android). Renderiza o conteúdo registrado por <NativeSheet> (components/
// NativeSheet.js). Não tem conteúdo próprio: sem id válido ela se remove.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { StackActions, useRoute } from '@react-navigation/native';
import {
  getNativeSheetEntry, subscribeNativeSheet, attachNativeSheetRoute, detachNativeSheetRoute,
  nativeSheetBoundedOn, nativeSheetHuntStopOn,
} from '../components/NativeSheet';

const _HUNT_STOP = { height: 0, width: 0 };

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
  // estava.
  // [2026-10-16 wave7] Altura = área ÚTIL do detent (o UIKit mede detents
  // custom SEM o inset inferior: sheet = fração × maximumDetentValue + home
  // indicator; o conteúdo usa nativeSheetBottomPad = só o extra no iOS):
  //   1º render: estimativa (janela − topo do detent grande − inset inferior);
  //   depois: CALIBRA medindo o topo real do sheet (measureInWindow lê o frame
  //   de modelo = final mesmo durante a animação) → exato em iOS 18 e 26
  //   (grabber não ocupa layout; iOS 26 flutuante só sobra folga, nunca corta).
  // Gate: nativeSheetBoundedOn() (components/NativeSheet.js) — ligado por
  // padrão no binário da wave 7+; kill: globalThis.__chatyy_sheet_bounded = false.
  const entry = getNativeSheetEntry(id);
  const detents = entry && Array.isArray(entry.detents) ? entry.detents : null;
  const huntStop = nativeSheetHuntStopOn();
  // [2026-10-19 sheet-layout] bounded exige o hunt-stop (sem ele o rn-screens
  // ainda força o frame do 1º ScrollView por cima da altura calculada).
  const bounded = huntStop && !!detents && detents.length > 0 && Platform.OS === 'ios' && nativeSheetBoundedOn();
  const [detIdx, setDetIdx] = useState(() => {
    const i = Number(entry && entry.initialDetent) || 0;
    return detents ? Math.max(0, Math.min(detents.length - 1, i)) : 0;
  });
  const [measured, setMeasured] = useState(null); // { [detIdx]: altura útil medida }
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wrapRef = useRef(null);
  const detIdxRef = useRef(detIdx);
  detIdxRef.current = detIdx;
  const geoRef = useRef({ h: 0, b: 0 });
  geoRef.current = { h: win.height || 0, b: (insets && insets.bottom) || 0 };
  const remeasure = useCallback(() => {
    const node = wrapRef.current;
    if (!node || typeof node.measureInWindow !== 'function') return;
    try { if (Keyboard.isVisible && Keyboard.isVisible()) return; } catch {} // teclado sobe o sheet → topo falso
    const idx = detIdxRef.current;
    try {
      node.measureInWindow((x, y) => {
        const { h: winH, b } = geoRef.current;
        if (!(y > 0) || !(winH > 0) || y > winH - 120) return;
        const v = Math.round(winH - y - b);
        if (v < 120) return;
        setMeasured((m) => ((m && Math.abs((m[idx] || 0) - v) < 1) ? m : { ...(m || {}), [idx]: v }));
      });
    } catch {}
  }, []);
  useEffect(() => {
    if (!bounded || !navigation || typeof navigation.addListener !== 'function') return undefined;
    const subs = [];
    const timers = [];
    const later = (ms) => { timers.push(setTimeout(remeasure, ms)); };
    try {
      subs.push(navigation.addListener('sheetDetentChange', (e) => {
        const i = e && e.data ? Number(e.data.index) : NaN;
        if (!Number.isInteger(i) || i < 0) return;
        detIdxRef.current = i;
        setDetIdx(i);
        if (!e.data || e.data.stable !== false) later(40);
      }));
    } catch {}
    try { subs.push(navigation.addListener('transitionEnd', () => later(0))); } catch {}
    later(520); // sem transitionEnd (alguns caminhos do formSheet) → depois da subida
    return () => {
      subs.forEach((u) => { try { typeof u === 'function' && u(); } catch {} });
      timers.forEach(clearTimeout);
    };
  }, [bounded, navigation, remeasure]);

  if (content == null) return <View />;
  if (!huntStop) return content;
  if (!bounded) {
    // fitToContents (ou bounded desligado): altura = conteúdo; só desarma a caça.
    return (
      <View collapsable={false}>
        <View collapsable={false} pointerEvents="none" style={_HUNT_STOP} />
        {content}
      </View>
    );
  }
  const di = Math.min(detIdx, detents.length - 1);
  const frac = Math.max(0.1, Math.min(1, Number(detents[di]) || 1));
  // Estimativa: detent grande começa ~10 pt abaixo da safe area de cima
  // (iOS 16–26, iPhone em retrato); maximumDetentValue exclui o inset inferior.
  const top = (insets && insets.top) || 0;
  const bottom = (insets && insets.bottom) || 0;
  const maxDetent = Math.max(320, (win.height || 0) - top - 10 - bottom);
  const est = Math.round(maxDetent * frac);
  const got = measured && measured[di];
  // Medida só vale se coerente com o detent (rotação/teclado/medida no meio do arrasto).
  // [2026-10-19 sheet-layout] encolher pela medida só até 40 pt (medida no meio da
  // subida/arrasto lê topo baixo demais → "cortava no meio" no 697); crescer até 80.
  const h = Math.max(160, (got && got - est < 80 && est - got < 40) ? got : est);
  return (
    <View ref={wrapRef} collapsable={false} style={{ height: h }} onLayout={remeasure}>
      <View collapsable={false} pointerEvents="none" style={_HUNT_STOP} />
      <View collapsable={false} style={{ flex: 1 }}>{content}</View>
    </View>
  );
}
