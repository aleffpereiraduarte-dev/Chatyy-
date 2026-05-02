import { useState, useRef, useEffect } from 'react';
import { View, TextInput, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';

const DIGITS = 6;

export default function OtpInput({ value = '', onChange = () => {}, autoFocus = true }) {
  const { colors } = useTheme();
  const [digits, setDigits] = useState(Array(DIGITS).fill(''));
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const refs = useRef([]);

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
    if (text.length > 1) {
      const clean = text.replace(/\D/g, '').slice(0, DIGITS);
      const arr = clean.split('');
      while (arr.length < DIGITS) arr.push('');
      setDigits(arr);
      const joined = arr.join('');
      prevValueRef.current = joined;
      onChange(joined);
      refs.current[Math.min(clean.length, DIGITS - 1)]?.focus();
      return;
    }
    const clean = text.replace(/\D/g, '');
    const newDigits = [...digits];
    newDigits[index] = clean;
    setDigits(newDigits);
    const joined = newDigits.join('');
    prevValueRef.current = joined;
    onChange(joined);
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
        <TextInput
          key={i}
          ref={el => refs.current[i] = el}
          style={[
            s.box,
            {
              color: colors.text,
              backgroundColor: colors.authInputBg,
              borderColor: d ? colors.primary : (focusedIdx === i ? colors.authInputFocusBorder : colors.authInputBorder),
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
          maxLength={i === 0 ? DIGITS : 1}
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
  row: { flexDirection: 'row', justifyContent: 'center', gap: 7 },
  box: {
    width: 44, height: 52, borderWidth: 1.5, borderRadius: 10,
    fontSize: 22, fontWeight: '700', textAlign: 'center',
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'all 0.15s ease' }, default: {} }),
  },
});
