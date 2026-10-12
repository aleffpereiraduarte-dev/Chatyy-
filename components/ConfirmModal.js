// ConfirmModal — diálogo de confirmação do design system de overlays.
// [2026-10-12 overlays] Tokens únicos (constants/theme Overlay): cartão raio 16,
// fundo elevado no escuro, backdrop 0.4 que FADE + cartão com mola (escala
// 0.94→1), título 17/600, mensagem 14, botões 44px raio 10, destrutivo vermelho
// do sistema. Agora aceita `buttons` (Alert.alert-compatível, 1..N botões):
// 1 = OK, 2 = lado a lado, 3+ = empilhados.
//
// API:
//   1) Componente:
//      <ConfirmModal visible onClose onConfirm title message confirmLabel destructive />
//   2) Hook (Promise):
//      const confirm = useConfirm();
//      if (await confirm({ title, message, confirmLabel: 'Apagar', destructive: true })) { ... }
//   3) Imperativo (fora de componente): utils/confirm.js → confirmAsync /
//      alertAsync / showDialog — o ConfirmProvider registra o host lá.
//
// iOS/Android: useConfirm usa o diálogo NATIVO do sistema (Alert.alert).
// Web: este cartão. O Provider fica montado uma vez em app/_layout.js.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, Pressable, Animated, Platform, Alert, StyleSheet, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Overlay, overlayColors, OverlayShadow } from '../constants/theme';
import { registerDialogHost } from '../utils/confirm';

function DialogButton({ label, kind, onPress, oc, flex }) {
  const [hover, setHover] = useState(false);
  const bg = kind === 'destructive' ? oc.danger : kind === 'primary' ? oc.primaryButton : oc.neutralButton;
  const fg = kind === 'destructive' ? '#ffffff' : kind === 'primary' ? oc.onPrimaryButton : oc.text;
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: flex ? 1 : undefined,
        height: Overlay.dialogButtonHeight,
        borderRadius: 10,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        opacity: pressed ? 0.75 : (hover ? 0.88 : 1),
        ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
      })}
    >
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: kind === 'neutral' ? '500' : '600', color: fg }}>{label}</Text>
    </Pressable>
  );
}

export default function ConfirmModal({
  visible,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  icon = null,
  buttons = null, // [{ text, style: 'cancel'|'destructive'|'default', onPress }] → onSelect(index)
  onSelect,
}) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const oc = overlayColors(colors, !!isDark);
  const scale = useRef(new Animated.Value(0.94)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      scale.setValue(0.94);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...Overlay.spring }),
        Animated.timing(opacity, { toValue: 1, duration: Overlay.enterMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
    }
  }, [visible, scale, opacity]);

  const ok = confirmLabel || t?.('common.confirm') || 'Confirmar';
  const no = cancelLabel || t?.('common.cancel') || 'Cancelar';

  // Botões normalizados: [{label, kind, run}]
  let btns;
  if (Array.isArray(buttons) && buttons.length) {
    const nonCancel = buttons.filter((b) => b && b.style !== 'cancel').length;
    btns = buttons.map((b, i) => ({
      label: b?.text || t?.('common.ok') || 'OK',
      kind: b?.style === 'destructive' ? 'destructive'
        : b?.style === 'cancel' ? 'neutral'
          : (buttons.length === 1 || (nonCancel === 1 && i === buttons.length - 1)) ? 'primary' : 'neutral',
      run: () => { onSelect ? onSelect(i) : onClose?.(); },
    }));
  } else {
    btns = [
      { label: no, kind: 'neutral', run: () => onClose?.() },
      { label: ok, kind: destructive ? 'destructive' : 'primary', run: () => { onConfirm?.(); onClose?.(); } },
    ];
  }
  // 3+ botões, ou rótulo longo que cortaria lado a lado → empilhados (padrão iOS).
  const stacked = btns.length > 2 || btns.some((b) => String(b.label || '').length > 13);
  if (stacked && btns.length === 2) btns = [btns[1], btns[0]]; // ação principal em cima

  return (
    <Modal visible={!!visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${Overlay.backdrop})`, opacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={no} />
      </Animated.View>
      <View pointerEvents="box-none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Animated.View
          accessibilityViewIsModal
          accessibilityRole="alert"
          style={[{
            opacity,
            transform: [{ scale }],
            width: '100%',
            maxWidth: Overlay.dialogMaxWidth,
            backgroundColor: oc.sheetBg,
            borderRadius: Overlay.dialogRadius,
            paddingTop: 22,
            paddingHorizontal: 20,
            paddingBottom: 16,
          }, OverlayShadow]}
        >
          {icon ? (
            <View style={{ alignItems: 'center', marginBottom: 12 }}>
              <View style={{
                width: 52, height: 52, borderRadius: 26,
                backgroundColor: destructive ? oc.dangerTint : oc.neutralButton,
                alignItems: 'center', justifyContent: 'center',
              }}>
                {icon}
              </View>
            </View>
          ) : null}
          {title ? (
            <Text style={{ fontSize: Overlay.titleSize, fontWeight: Overlay.titleWeight, color: oc.text, textAlign: 'center', letterSpacing: -0.3, marginBottom: message ? 6 : 18 }}>
              {title}
            </Text>
          ) : null}
          {message ? (
            <Text style={{ fontSize: 14, color: oc.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 20 }}>
              {message}
            </Text>
          ) : null}
          <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8 }}>
            {btns.map((b, i) => (
              <DialogButton key={i} label={b.label} kind={b.kind} onPress={b.run} oc={oc} flex={!stacked} />
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─── Provider + hook ────────────────────────────────────────────────────────
// Uma instância no root. useConfirm() → Promise<boolean>. Também registra o
// host imperativo de utils/confirm.js (showDialog/confirmAsync/alertAsync).

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState({ visible: false, opts: {} });
  const resolverRef = useRef(null);
  const queueRef = useRef([]);

  const showNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return;
    resolverRef.current = next.resolver;
    setState({ visible: true, opts: next.opts });
  }, []);

  const { t } = useLanguage() || {};

  // Enfileira um diálogo genérico; resolve com o índice do botão (-1 = dispensado).
  const enqueue = useCallback((opts) => new Promise((resolve) => {
    queueRef.current.push({ opts: opts || {}, resolver: resolve });
    if (!resolverRef.current) showNext();
  }), [showNext]);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    // Nativo: diálogo do SISTEMA (UIAlertController / Material AlertDialog).
    if (Platform.OS !== 'web') {
      const o = opts || {};
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; resolve(v); };
      try {
        Alert.alert(
          o.title || '',
          o.message || undefined,
          [
            { text: o.cancelLabel || t?.('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => done(false) },
            { text: o.confirmLabel || t?.('common.confirm') || 'Confirmar', style: o.destructive ? 'destructive' : 'default', onPress: () => done(true) },
          ],
          { cancelable: true, onDismiss: () => done(false) },
        );
        return;
      } catch { /* cai no cartão */ }
    }
    enqueue({ ...(opts || {}), _mode: 'confirm' }).then((idx) => resolve(idx === 1));
  }), [enqueue, t]);

  useEffect(() => registerDialogHost({
    show: (o) => enqueue({ ...(o || {}), _mode: 'buttons' }),
    t: (k) => (t ? t(k) : k),
  }), [enqueue, t]);

  const finish = useCallback((result) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState((s) => ({ visible: false, opts: s.opts }));
    try { r?.(result); } catch {}
    // Próximo da fila depois da saída — evita "soluço" visual.
    setTimeout(() => { if (!resolverRef.current) showNext(); }, 200);
  }, [showNext]);

  const o = state.opts || {};
  const isButtons = o._mode === 'buttons';
  const cancelIdx = isButtons ? (o.buttons || []).findIndex((b) => b && b.style === 'cancel') : 0;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        visible={state.visible}
        onClose={() => finish(isButtons ? (cancelIdx >= 0 ? cancelIdx : -1) : 0)}
        onConfirm={() => finish(1)}
        onSelect={isButtons ? (i) => finish(i) : undefined}
        buttons={isButtons ? o.buttons : null}
        title={o.title}
        message={o.message}
        confirmLabel={o.confirmLabel}
        cancelLabel={o.cancelLabel}
        destructive={o.destructive}
        icon={o.icon}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  // Sem Provider (testes/prévias): resolve false, não quebra.
  if (!ctx) return async () => false;
  return ctx;
}
