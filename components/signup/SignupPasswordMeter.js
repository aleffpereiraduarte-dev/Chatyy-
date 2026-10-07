// SignupPasswordMeter — 4-segment strength bar for the phone signup.
// [2026-10-07 signup-ux] Monochrome until the score means something: segments
// fill in ink (colors.text); only "weak" tints the label red so the user knows
// why. Scoring lives in signupSmarts.passwordScore (penalises reuse of the
// name / @handle / phone, common passwords and sequences).
import { View, Text } from 'react-native';
import { passwordScore } from './signupSmarts';

const LABEL_KEYS = ['', 'signup.password.weak', 'signup.password.fair', 'signup.password.good', 'signup.password.strong'];
const LABEL_FALLBACK = ['', 'Fraca', 'Razoável', 'Boa', 'Forte'];

export default function SignupPasswordMeter({ password, context, colors, t }) {
  if (!password) return null;
  const score = passwordScore(password, context);
  const tooShort = password.length < 8;
  const label = tooShort
    ? t('signupPhone.pwdMin', { c: password.length })
    : (t(LABEL_KEYS[score]) || LABEL_FALLBACK[score]);
  const labelColor = tooShort ? colors.textTertiary : (score <= 1 ? colors.error : (score >= 4 ? colors.text : colors.textSecondary));
  return (
    <View style={{ marginTop: 10 }} accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 4, now: score }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[1, 2, 3, 4].map(i => (
          <View
            key={i}
            style={{
              flex: 1, height: 3, borderRadius: 2,
              backgroundColor: i <= score ? (score <= 1 ? colors.error : colors.text) : colors.border,
            }}
          />
        ))}
      </View>
      <Text style={{ fontSize: 12, fontWeight: '600', marginTop: 6, color: labelColor }}>{label}</Text>
    </View>
  );
}
