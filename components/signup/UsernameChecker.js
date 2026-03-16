import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconCheckCircle, IconAlertTriangle } from '../Icons';

export default function UsernameChecker({
  value, onChange, domain, onAvailabilityChange, checkFn, firstName, lastName,
}) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [status, setStatus] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [focused, setFocused] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!value || value.length < 3) {
      setStatus(null);
      setSuggestions([]);
      onAvailabilityChange?.(null, []);
      return;
    }
    setStatus('checking');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const r = await checkFn(value, domain);
        const result = r.data || r;
        if (result.available) {
          setStatus('available');
          setSuggestions([]);
          onAvailabilityChange?.(true, []);
        } else {
          setStatus('taken');
          const sugs = result.suggestions || generateSuggestions(firstName, lastName, value);
          setSuggestions(sugs);
          onAvailabilityChange?.(false, sugs);
        }
      } catch {
        setStatus(null);
        onAvailabilityChange?.(null, []);
      }
    }, 400);
    return () => clearTimeout(timerRef.current);
  }, [value, domain]);

  const handleText = (text) => {
    onChange(text.toLowerCase().replace(/[^a-z0-9._-]/g, ''));
  };

  return (
    <View>
      <View style={s.inputRow}>
        <TextInput
          style={[
            s.input,
            { color: colors.text, backgroundColor: colors.authInputBg, borderColor: focused ? colors.authInputFocusBorder : colors.authInputBorder },
            status === 'available' && { borderColor: colors.authSuccessGreen },
            status === 'taken' && { borderColor: colors.error },
            focused && {
              borderWidth: 2,
              ...Platform.select({ web: { boxShadow: `0 0 0 3px ${status === 'available' ? colors.authSuccessGreen + '1a' : status === 'taken' ? colors.error + '1a' : colors.authInputFocusGlow}` }, default: {} }),
            },
          ]}
          value={value}
          onChangeText={handleText}
          placeholder={t('signup.stepUsername.placeholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <Text style={[s.inputSuffix, { color: colors.textTertiary }]}>@chatyy.com.br</Text>
        <View style={s.statusIcon}>
          {status === 'checking' && <ActivityIndicator size="small" color={colors.primary} />}
          {status === 'available' && <IconCheckCircle size={18} color={colors.authSuccessGreen} />}
          {status === 'taken' && <IconAlertTriangle size={18} color={colors.error} />}
        </View>
      </View>

      {status === 'available' && (
        <View style={s.statusRow}>
          <View style={[s.statusDot, { backgroundColor: colors.authSuccessGreen }]} />
          <Text style={[s.availableText, { color: colors.authSuccessGreen }]}>{t('signup.stepUsername.available')}</Text>
        </View>
      )}
      {status === 'taken' && (
        <Text style={[s.takenText, { color: colors.error }]}>{t('signup.stepUsername.taken')}</Text>
      )}

      {suggestions.length > 0 && (
        <View style={s.sugRow}>
          {suggestions.slice(0, 4).map((sug, i) => (
            <TouchableOpacity
              key={i}
              style={[s.sugBtn, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}
              onPress={() => onChange(sug)}
              activeOpacity={0.7}
            >
              <Text style={[s.sugText, { color: colors.primary }]}>{sug}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

function generateSuggestions(first, last, base) {
  const f = (first || '').toLowerCase().replace(/\s/g, '');
  const l = (last || '').toLowerCase().replace(/\s/g, '');
  const year = new Date().getFullYear().toString().slice(-2);
  const suggestions = [];
  if (f && l) {
    suggestions.push(`${f}.${l}`, `${f}${l}`, `${f}.${l}${year}`, `${f}_${l}`, `${f[0]}${l}`);
  } else {
    suggestions.push(`${base}${year}`, `${base}.mail`, `${base}1`, `${base}_01`);
  }
  return suggestions.filter(s => s !== base).slice(0, 4);
}

const s = StyleSheet.create({
  inputRow: { position: 'relative', flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 16,
    paddingRight: 36, fontSize: 15,
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'all 0.15s ease' }, default: {} }),
  },
  inputSuffix: { position: 'absolute', right: 40, fontSize: 13, fontWeight: '500' },
  statusIcon: { position: 'absolute', right: 12, top: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  availableText: { fontSize: 12, fontWeight: '600' },
  takenText: { fontSize: 12, marginTop: 5 },
  sugRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  sugBtn: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 50, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.12s ease' }, default: {} }),
  },
  sugText: { fontSize: 12, fontWeight: '600' },
});
