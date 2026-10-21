// [2026-10-21 menu-ancorado] Menu "..." ancorado no botão (WhatsApp/Telegram),
// no lugar do ActionSheet/alerta central de botões cinza.
//
//   iOS com o binário novo → UIMenu NATIVO pull-down (ChatyyContextMenuView com
//     primaryAction=true: UIButton transparente por cima do ícone, SF Symbols,
//     destrutivas em vermelho num grupo no fim). Detectado pela prop
//     "primaryAction" (nativeViewCaps) → mesmo bundle OTA no binário velho.
//   Resto (binário atual, Android, web) → popover JS ancorado no botão: cartão
//     raio 14, sombra Grafite, linhas com ícone SVG, escala a partir do canto
//     do botão. É uma View absoluta DENTRO da tela dona (nunca <Modal> — a tela
//     de contato já é Modal/folha no iOS).
//
// Uso:
//   const menu = useAnchoredMenu();
//   <View ref={menu.rootRef} style={{flex:1}}>
//     <AnchoredMenuButton menu={menu} actions={acts} label="Mais opções">{ícone}</AnchoredMenuButton>
//     ...
//     <AnchoredMenuHost menu={menu} isDark={isDark} />   ← último filho
//   </View>
// actions: [{ id, title, renderIcon?(size,color) → elemento, systemImage?, destructive?, onPress }]
// Kill switch OTA: globalThis.__chatyy_anchored_menu = false → onFallback().
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, Animated, BackHandler, useWindowDimensions } from 'react-native';
import { grafite } from '../constants/theme';

export function anchoredMenuEnabled() {
  try { if (globalThis.__chatyy_anchored_menu === false) return false; } catch {}
  return true;
}

let _nativeChecked = false;
let _nativeView = null;
function _nativeMenuView() {
  if (_nativeChecked) return _nativeView;
  _nativeChecked = true;
  _nativeView = null;
  if (Platform.OS !== 'ios') return null;
  try { if (globalThis.__chatyy_native_pulldown === false) return null; } catch {}
  try {
    const { nativeViewCaps } = require('../modules/expo-native-toolkit/src/viewCaps');
    const caps = nativeViewCaps('ChatyyContextMenuView');
    if (caps && caps.props.has('primaryAction') && caps.props.has('actions') && caps.events.has('onMenuAction')) {
      _nativeView = require('expo').requireNativeView('ChatyyContextMenuView');
    }
  } catch { _nativeView = null; }
  return _nativeView;
}
export function nativePulldownAvailable() { return !!_nativeMenuView(); }

export function useAnchoredMenu() {
  const rootRef = useRef(null);
  const [state, setState] = useState(null); // { actions, anchor:{x,y,w,h}, rootW, rootH }
  const open = useCallback((btnRef, actions) => {
    const root = rootRef.current;
    const btn = btnRef && btnRef.current;
    const show = (r, b) => setState({ actions, anchor: { x: b.x - r.x, y: b.y - r.y, w: b.w, h: b.h }, rootW: r.w, rootH: r.h });
    if (!root || !btn || typeof btn.measureInWindow !== 'function') {
      setState({ actions, anchor: null, rootW: 0, rootH: 0 });
      return;
    }
    try {
      root.measureInWindow((rx, ry, rw, rh) => {
        btn.measureInWindow((bx, by, bw, bh) => show({ x: rx || 0, y: ry || 0, w: rw || 0, h: rh || 0 }, { x: bx || 0, y: by || 0, w: bw || 0, h: bh || 0 }));
      });
    } catch { setState({ actions, anchor: null, rootW: 0, rootH: 0 }); }
  }, []);
  const close = useCallback(() => setState(null), []);
  return { rootRef, state, open, close };
}

const SF_FOR_ICON = {
  share: 'person.crop.circle', export: 'square.and.arrow.up', trash: 'trash', block: 'nosign', flag: 'exclamationmark.bubble',
  archive: 'archivebox', download: 'square.and.arrow.down', user: 'person.crop.circle', search: 'magnifyingglass',
  bell: 'bell', bellOff: 'bell.slash', pin: 'pin', logout: 'rectangle.portrait.and.arrow.right', star: 'star',
};
export function sfSymbolFor(iconName) { return SF_FOR_ICON[iconName] || null; }

/** Botão "..." — nativo (UIMenu pull-down) quando houver; senão abre o popover JS. */
export function AnchoredMenuButton({ menu, actions, label, style, hitSlop = 6, onFallback, children }) {
  const btnRef = useRef(null);
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && a.id && a.title);
  const actsRef = useRef(list);
  actsRef.current = list;
  const Native = anchoredMenuEnabled() ? _nativeMenuView() : null;
  const onNative = useCallback((e) => {
    const id = e && e.nativeEvent && e.nativeEvent.id;
    const a = actsRef.current.find((x) => String(x.id) === String(id));
    if (a && typeof a.onPress === 'function') setTimeout(() => { try { a.onPress(); } catch {} }, 0);
  }, []);
  if (Native) {
    return (
      <View style={style} accessibilityElementsHidden={false}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
        </View>
        <Native
          style={StyleSheet.absoluteFill}
          primaryAction
          buttonLabel={label || ''}
          menuTitle=""
          menuEnabled
          actions={list.map((a) => ({ id: String(a.id), title: String(a.title), systemImage: a.systemImage || null, destructive: !!a.destructive, disabled: false, checked: false }))}
          onMenuAction={onNative}
        />
      </View>
    );
  }
  return (
    <Pressable
      ref={btnRef}
      onPress={() => {
        if (!anchoredMenuEnabled() && typeof onFallback === 'function') { onFallback(); return; }
        try { require('../services/haptics').HapticsCompat.selectionAsync(); } catch {}
        menu.open(btnRef, list);
      }}
      hitSlop={hitSlop}
      style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !!menu.state }}
    >
      {children}
    </Pressable>
  );
}

const MENU_W = 248;
const ROW_H = 46;

/** Popover JS — renderize como ÚLTIMO filho da View raiz (menu.rootRef). */
export function AnchoredMenuHost({ menu, isDark }) {
  const st0 = menu.state;
  const [shown, setShown] = useState(st0);
  const anim = useRef(new Animated.Value(0)).current;
  const pendingRef = useRef(null);
  const win = useWindowDimensions();
  const g = grafite(!!isDark);

  useEffect(() => {
    if (st0) {
      setShown(st0);
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 320, mass: 0.7 }).start();
    } else if (shown) {
      Animated.timing(anim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
        setShown(null);
        const fn = pendingRef.current;
        pendingRef.current = null;
        if (fn) { try { fn(); } catch {} }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st0]);

  const closeFn = menu.close;
  useEffect(() => {
    if (!st0 || Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { closeFn(); return true; });
    return () => { try { sub.remove(); } catch {} };
  }, [st0, closeFn]);

  if (!shown) return null;
  const acts = shown.actions || [];
  const normal = acts.filter((a) => !a.destructive);
  const danger = acts.filter((a) => a.destructive);
  const rootW = shown.rootW || win.width;
  const a = shown.anchor;
  const top = a ? a.y + a.h + 6 : 8;
  const right = a ? Math.max(8, rootW - (a.x + a.w) + 2) : 12;
  const width = Math.min(MENU_W, rootW - 24);
  const danger_ = '#E5484D';
  const cardBg = isDark ? g.surface2 : g.surface;
  const shadow = Platform.OS === 'web'
    ? { boxShadow: isDark ? '0 14px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)' : '0 14px 36px rgba(24,24,27,0.16), 0 2px 8px rgba(24,24,27,0.08)' }
    : { boxShadow: isDark ? '0px 14px 36px rgba(0,0,0,0.55)' : '0px 14px 36px rgba(24,24,27,0.16), 0px 2px 8px rgba(24,24,27,0.08)', elevation: 12 };
  const pick = (it) => {
    pendingRef.current = typeof it.onPress === 'function' ? it.onPress : null;
    menu.close();
  };
  const row = (it, i, arr, isDanger) => {
    const color = isDanger ? danger_ : g.text;
    const icon = typeof it.renderIcon === 'function' ? it.renderIcon(20, color) : null;
    return (
      <Pressable
        key={String(it.id)}
        onPress={() => pick(it)}
        accessibilityRole="menuitem"
        accessibilityLabel={it.title}
        style={({ pressed }) => [s.row, { backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.07)' : 'rgba(24,24,27,0.05)') : 'transparent' }]}
      >
        <Text style={[s.rowTxt, { color }]} numberOfLines={1}>{it.title}</Text>
        {icon}
        {i < arr.length - 1 ? <View style={[s.sep, { backgroundColor: g.line }]} /> : null}
      </Pressable>
    );
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={closeFn} accessible={false} importantForAccessibility="no">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.28)' : 'rgba(24,24,27,0.08)', opacity: anim }]} />
      </Pressable>
      <Animated.View
        accessibilityViewIsModal
        style={[
          s.card, shadow,
          { top, right, width, backgroundColor: cardBg, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(24,24,27,0.05)' },
          { opacity: anim, transformOrigin: 'top right', transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }) }] },
        ]}
      >
        {normal.map((it, i, arr) => row(it, i, arr, false))}
        {normal.length && danger.length ? <View style={[s.gap, { backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : g.bg }]} /> : null}
        {danger.map((it, i, arr) => row(it, i, arr, true))}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { position: 'absolute', borderRadius: 14, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, paddingVertical: 0 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
  rowTxt: { flex: 1, fontSize: 16, fontWeight: '400', letterSpacing: -0.2 },
  sep: { position: 'absolute', left: 16, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  gap: { height: 7 },
});
