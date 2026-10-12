import { useState, useRef, useEffect } from 'react';
import { View, TextInput, StyleSheet, Platform, Animated, Easing, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';

const DIGITS = 6;
// Animatable TextInput so each box can spring on fill without a wrapping View
// that would perturb the fixed 44x52 layout.
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export default function OtpInput({ value = '', onChange = () => {}, autoFocus = true }) {
  const { colors } = useTheme();
  // [2026-10-12 first-run polish] Boxes shrink on 320–360pt phones instead of
  // overflowing the card (6 boxes + 5 gaps + ~88pt of screen/card padding).
  const { width: winW } = useWindowDimensions();
  const boxW = Math.max(36, Math.min(48, Math.floor((Math.min(winW, 448) - 88 - 5 * 8) / 6)));
  const [digits, setDigits] = useState(Array(DIGITS).fill(''));
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const refs = useRef([]);
  // Per-box scale-pop (1 → 1.12 → 1) when a box transitions empty → filled.
  // WhatsApp/iMessage OTP feel — gives each tapped-in digit a tiny bit of life.
  const scales = useRef(Array.from({ length: DIGITS }, () => new Animated.Value(1))).current;
  const popBox = (i) => {
    const sv = scales[i];
    if (!sv) return;
    try {
      Animated.sequence([
        Animated.timing(sv, { toValue: 1.12, duration: 70, useNativeDriver: true }),
        Animated.timing(sv, { toValue: 1, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
    } catch { /* native driver may be unavailable on web in some states */ }
  };

  // Sync from parent when value changes externally (e.g., reset to empty).
  // prevValueRef inicia undefined → primeiro render compara com value e
  // hidrata os dígitos se o pai já passou um valor inicial não vazio.
  const prevValueRef = useRef();
  useEffect(() => {
    if (value !== prevValueRef.current) {
      prevValueRef.current = value;
      const arr = (value || '').split('').slice(0, DIGITS);
      while (arr.length < DIGITS) arr.push('');
      setDigits(arr);
      if (!value && autoFocus) refs.current[0]?.focus();
    }
  }, [value, autoFocus]);

  const handleChange = (text, index) => {
    // [2026-10-12 first-run polish] Typing over a filled box (selection lost)
    // yields "old+new" — keep just the new digit instead of treating it as a
    // paste that rewrites the whole code from box 0.
    if (text.length === 2 && digits[index] && /^\d\d$/.test(text)) {
      text = text[0] === digits[index] ? text[1] : text[0];
    }
    if (text.length > 1) {
      const clean = text.replace(/\D/g, '').slice(0, DIGITS);
      // Paste into ANY box: a full code fills from box 0; a partial one
      // fills from the box that received it.
      const start = clean.length >= DIGITS ? 0 : index;
      const arr = [...digits];
      for (let j = 0; j < clean.length && start + j < DIGITS; j++) arr[start + j] = clean[j];
      while (arr.length < DIGITS) arr.push('');
      setDigits(arr);
      const joined = arr.join('');
      prevValueRef.current = joined;
      onChange(joined);
      refs.current[Math.min(start + clean.length, DIGITS - 1)]?.focus();
      // Stagger-pop each box that a paste newly filled.
      for (let j = start; j < Math.min(start + clean.length, DIGITS); j++) {
        if (!digits[j]) popBox(j);
      }
      return;
    }
    const clean = text.replace(/\D/g, '');
    const wasEmpty = !digits[index];
    const newDigits = [...digits];
    newDigits[index] = clean;
    setDigits(newDigits);
    const joined = newDigits.join('');
    prevValueRef.current = joined;
    onChange(joined);
    if (clean && wasEmpty) popBox(index);
    if (clean && index < DIGITS - 1) refs.current[index + 1]?.focus();
  };

  const handleKeyPress = (e, index) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
      const newDigits = [...digits];
      newDigits[index - 1] = '';
      setDigits(newDigits);
      onChange(newDigits.join(''));
    }
  };

  return (
    <View style={s.row}>
      {digits.map((d, i) => (
        <AnimatedTextInput
          key={i}
          ref={el => refs.current[i] = el}
          style={[
            s.box,
            {
              width: boxW,
              color: colors.text,
              backgroundColor: colors.authInputBg,
              borderColor: d ? colors.primary : (focusedIdx === i ? colors.authInputFocusBorder : colors.authInputBorder),
              transform: [{ scale: scales[i] }],
            },
            focusedIdx === i && {
              borderWidth: 2,
              ...Platform.select({ web: { boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}` }, default: {} }),
            },
          ]}
          value={d}
          onChangeText={text => handleChange(text, i)}
          onKeyPress={e => handleKeyPress(e, i)}
          onFocus={() => setFocusedIdx(i)}
          onBlur={() => setFocusedIdx(-1)}
          keyboardType="number-pad"
          // Every box accepts a paste (handleChange spreads it); typing is
          // still one digit per box.
          maxLength={DIGITS}
          autoFocus={autoFocus && i === 0}
          selectTextOnFocus
          // SMS auto-fill (WhatsApp parity). iOS shows "From Messages" QuickType
          // bar with the OTP from the SMS banner; Android RN respects autoComplete
          // on Android API 26+ and SmsRetriever flows. Only the first box opts in
          // because handleChange splits a multi-digit paste into all 6 boxes
          // anyway — putting it on every box made iOS suggest the code in box 5.
          textContentType={i === 0 ? 'oneTimeCode' : 'none'}
          autoComplete={i === 0 ? 'sms-otp' : 'off'}
          importantForAutofill={i === 0 ? 'yes' : 'no'}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  box: {
    width: 44, height: 54, borderWidth: 1.5, borderRadius: 12,
    fontSize: 22, fontWeight: '700', textAlign: 'center',
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'all 0.15s ease' }, default: {} }),
  },
});
