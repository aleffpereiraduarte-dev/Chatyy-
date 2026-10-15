// [2026-10-15 native-onboarding] Campo de 6 dígitos: UM TextInput invisível
// (autofill iOS oneTimeCode / Android sms-otp / web one-time-code, colar o
// código inteiro) sobre 6 células desenhadas. Cada dígito novo entra com mola
// (sobe + escala), célula ativa com cursor piscando, tremida no erro
// (errorTick muda). Animações com useNativeDriver (UI thread).
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View, TextInput, Pressable, Animated, Easing, Platform, StyleSheet, useWindowDimensions } from 'react-native';

const LEN = 6;

const OtpCells = forwardRef(function OtpCells({
  value, onChange, onComplete, colors, errorTick = 0, disabled = false, reduced = false, accessibilityLabel, autoFocus = true, testID,
}, ref) {
  const inputRef = useRef(null);
  const { width } = useWindowDimensions();
  const digitAnims = useRef(Array.from({ length: LEN }, () => new Animated.Value(1))).current;
  const shake = useRef(new Animated.Value(0)).current;
  const caret = useRef(new Animated.Value(1)).current;
  const prevRef = useRef(value || '');

  useImperativeHandle(ref, () => ({
    focus: () => { try { inputRef.current?.focus(); } catch {} },
    blur: () => { try { inputRef.current?.blur(); } catch {} },
    isFocused: () => { try { return !!inputRef.current?.isFocused?.(); } catch { return false; } },
  }), []);

  // Entrada de cada dígito novo.
  useEffect(() => {
    const prev = prevRef.current || '';
    const cur = value || '';
    prevRef.current = cur;
    if (reduced) return;
    for (let i = prev.length; i < cur.length && i < LEN; i++) {
      const v = digitAnims[i];
      v.setValue(0);
      Animated.spring(v, { toValue: 1, friction: 5, tension: 160, delay: (i - prev.length) * 35, useNativeDriver: true }).start();
    }
  }, [value, reduced, digitAnims]);

  // Tremida no erro.
  useEffect(() => {
    if (!errorTick) return;
    if (reduced) return;
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, { toValue: -10, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 10, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -7, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 7, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 45, useNativeDriver: true }),
    ]).start();
  }, [errorTick, reduced, shake]);

  // Cursor piscando (cadência do iOS).
  useEffect(() => {
    if (reduced) { caret.setValue(1); return undefined; }
    const l = Animated.loop(Animated.sequence([
      Animated.timing(caret, { toValue: 0, duration: 530, easing: Easing.step0 || undefined, useNativeDriver: true }),
      Animated.timing(caret, { toValue: 1, duration: 530, easing: Easing.step0 || undefined, useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, [reduced, caret]);

  const code = String(value || '');
  // 48 = padding lateral da tela · 5 vãos de 8 · 14 = respiro extra entre 3+3.
  const cellW = Math.min(50, Math.floor((Math.min(width, 520) - 48 - 5 * 8 - 14) / LEN));

  const handleChange = (raw) => {
    const d = String(raw || '').replace(/\D/g, '').slice(0, LEN);
    onChange?.(d);
    if (d.length === LEN) onComplete?.(d);
  };

  return (
    <Pressable
      onPress={() => inputRef.current?.focus?.()}
      style={st.wrap}
      accessible={false}
    >
      <Animated.View style={[st.row, { transform: [{ translateX: shake }] }]} importantForAccessibility="no-hide-descendants">
        {Array.from({ length: LEN }).map((_, i) => {
          const ch = code[i] || '';
          const filled = !!ch;
          const active = !disabled && (code.length === i || (code.length === LEN && i === LEN - 1));
          const a = digitAnims[i];
          return (
            <View
              key={i}
              style={[st.cell, {
                width: cellW,
                borderColor: active ? colors.text : (filled ? colors.textSecondary : colors.border),
                borderWidth: active ? 2 : 1.5,
                backgroundColor: colors.surfaceVariant,
              }, i === 2 ? { marginRight: 14 } : null]}
            >
              {filled ? (
                <Animated.Text
                  style={[st.digit, {
                    color: colors.text,
                    opacity: a,
                    transform: [
                      { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
                      { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
                    ],
                  }]}
                  maxFontSizeMultiplier={1.2}
                >
                  {ch}
                </Animated.Text>
              ) : active ? (
                <Animated.View style={[st.caret, { backgroundColor: colors.text, opacity: caret }]} />
              ) : (
                <View style={[st.dash, { backgroundColor: colors.border }]} />
              )}
            </View>
          );
        })}
      </Animated.View>
      <TextInput
        ref={inputRef}
        value={code}
        onChangeText={handleChange}
        editable={!disabled}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={LEN}
        textContentType="oneTimeCode"
        autoComplete={Platform.OS === 'web' ? 'one-time-code' : 'sms-otp'}
        importantForAutofill="yes"
        autoFocus={autoFocus}
        caretHidden
        contextMenuHidden={false}
        selectionColor="transparent"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={code ? `${code.length}/${LEN}` : undefined}
        testID={testID}
        style={[st.hidden, Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'transparent' } : null]}
      />
    </Pressable>
  );
});

const st = StyleSheet.create({
  wrap: { alignSelf: 'center', marginTop: 8, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  cell: { height: 60, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  digit: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  caret: { width: 2, height: 26, borderRadius: 1 },
  dash: { width: 12, height: 2, borderRadius: 1 },
  // color transparent (não opacity 0): o chip de código do Gboard só aparece
  // se o campo focado for "visível" p/ o serviço de autofill.
  hidden: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, color: 'transparent', backgroundColor: 'transparent', fontSize: 22, textAlign: 'center' },
});

export default OtpCells;
