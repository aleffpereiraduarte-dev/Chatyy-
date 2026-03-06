import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconCheckCircle } from '../Icons';

const LEVEL_KEYS = [
  { key: 'signup.password.weak', color: '#ef4444' },
  { key: 'signup.password.fair', color: '#f97316' },
  { key: 'signup.password.good', color: '#eab308' },
  { key: 'signup.password.strong', color: '#22c55e' },
];

const REQUIREMENT_KEYS = [
  { test: (p) => p.length >= 8, key: 'signup.password.req8chars' },
  { test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p), key: 'signup.password.reqMixedCase' },
  { test: (p) => /\d/.test(p), key: 'signup.password.reqNumbers' },
  { test: (p) => /[^a-zA-Z0-9]/.test(p), key: 'signup.password.reqSymbols' },
];

export function calcStrength(password) {
  if (!password) return { score: 0, tips: [] };
  let score = 0;
  const tips = [];

  if (password.length >= 8) score++;
  else tips.push('signup.password.tip8chars');

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  else tips.push('signup.password.tipMixedCase');

  if (/\d/.test(password)) score++;
  else tips.push('signup.password.tipNumbers');

  if (/[^a-zA-Z0-9]/.test(password)) score++;
  else tips.push('signup.password.tipSymbols');

  if (password.length >= 12) score = Math.max(score, 3);

  return { score: Math.min(score, 3), tips };
}

export default function PasswordStrength({ password }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { score } = calcStrength(password);
  if (!password) return null;

  const level = LEVEL_KEYS[score];
  const allMet = score === 3;

  return (
    <View style={s.container}>
      {/* Segmented bar */}
      <View style={s.barRow}>
        {Array.from({ length: 4 }).map((_, i) => (
          <View
            key={i}
            style={[
              s.segment,
              {
                backgroundColor: i <= score ? level.color : colors.authInputBorder,
                ...Platform.select({ web: { transition: 'background-color 0.3s cubic-bezier(0.4,0,0.2,1)' }, default: {} }),
              },
              i < 3 && { marginRight: 4 },
            ]}
          />
        ))}
      </View>

      {/* Label */}
      <View style={s.labelRow}>
        <View style={[s.labelDot, { backgroundColor: level.color }]} />
        <Text style={[s.label, { color: level.color }]}>{t(level.key)}</Text>
      </View>

      {/* Requirements checklist */}
      {!allMet && (
        <View style={s.checklist}>
          {REQUIREMENT_KEYS.map((req, i) => {
            const met = req.test(password);
            return (
              <View key={i} style={s.checkRow}>
                {met ? (
                  <IconCheckCircle size={15} color="#22c55e" />
                ) : (
                  <View style={[s.emptyCircle, { borderColor: colors.authInputBorder }]} />
                )}
                <Text style={[
                  s.checkText,
                  { color: met ? '#22c55e' : colors.textTertiary },
                  met && { textDecorationLine: 'line-through', opacity: 0.6 },
                ]}>{t(req.key)}</Text>
              </View>
            );
          })}
        </View>
      )}

      {allMet && (
        <View style={s.strongBadge}>
          <IconCheckCircle size={14} color="#22c55e" />
          <Text style={s.strongText}>{t('signup.password.strongBadge')}</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { marginTop: 10 },
  barRow: { flexDirection: 'row', height: 5, marginBottom: 8, borderRadius: 3, overflow: 'hidden' },
  segment: { flex: 1, borderRadius: 3 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  labelDot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  checklist: { marginTop: 10, gap: 6 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  emptyCircle: { width: 15, height: 15, borderRadius: 8, borderWidth: 1.5 },
  checkText: { fontSize: 12, fontWeight: '500' },
  strongBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  strongText: { fontSize: 12, fontWeight: '700', color: '#22c55e' },
});
