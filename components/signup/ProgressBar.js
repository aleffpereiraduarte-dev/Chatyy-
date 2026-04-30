import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconCheck } from '../Icons';

const STEP_KEYS = ['signup.steps.name', 'signup.steps.email', 'signup.steps.password', 'signup.steps.phone', 'signup.steps.recovery', 'signup.steps.confirm'];

function WebPulseStyle() {
  if (Platform.OS !== 'web') return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
@keyframes dot-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.1); } }
.progress-dot-active { animation: dot-pulse 2s ease-in-out infinite; }
        `,
      }}
    />
  );
}

export default function ProgressBar({ current = 1, total = 6 }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const STEPS = STEP_KEYS.map(k => t(k));
  // Clampa current pra evitar valores fora do range (sem segmento ativo).
  const safeCurrent = Math.min(Math.max(current, 1), STEPS.length);

  return (
    <View style={s.container}>
      <WebPulseStyle />
      <View style={s.row}>
        {STEPS.map((label, i) => {
          const num = i + 1;
          const done = num < safeCurrent;
          const active = num === safeCurrent;
          const isLast = i === STEPS.length - 1;

          const dotStyle = [
            s.dot,
            done && {
              backgroundColor: colors.authStepDoneBg,
              borderWidth: 1,
              borderColor: colors.authStepDoneBg,
            },
            active && {
              backgroundColor: colors.primary,
              borderWidth: 1,
              borderColor: colors.primary,
              ...(Platform.OS === 'web' ? {
                boxShadow: `0 0 12px ${colors.primary}40, 0 0 4px ${colors.primary}30`,
              } : {}),
            },
            !done && !active && {
              backgroundColor: colors.authStepPendingBg,
              borderWidth: 1,
              borderColor: colors.authStepPendingBg,
            },
            Platform.OS === 'web' && { transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)' },
          ];

          return (
            <View key={i} style={s.item}>
              <View style={s.dotLine}>
                <View
                  style={dotStyle}
                  {...(Platform.OS === 'web' && active ? { className: 'progress-dot-active' } : {})}
                >
                  {done ? (
                    <IconCheck size={12} color="#fff" />
                  ) : (
                    <Text style={[s.dotNum, active && s.dotNumActive]}>{num}</Text>
                  )}
                </View>
                {!isLast && (
                  <View style={[s.lineTrack, { backgroundColor: colors.authStepConnector }]}>
                    <View style={[
                      s.lineFill,
                      {
                        backgroundColor: done ? colors.authStepConnectorDone : 'transparent',
                        width: done ? '100%' : '0%',
                      },
                      Platform.OS === 'web' && {
                        transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1), background-color 0.3s ease',
                      },
                    ]} />
                  </View>
                )}
              </View>
              <Text style={[
                s.label,
                active && { color: colors.primary, fontWeight: '700', fontSize: 10 },
                done && { color: colors.authStepDoneBg },
                !done && !active && { color: colors.textTertiary },
                Platform.OS === 'web' && { transition: 'all 0.25s ease' },
              ]} numberOfLines={1}>
                {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { marginBottom: 24 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  item: { alignItems: 'center', flex: 1 },
  dotLine: { flexDirection: 'row', alignItems: 'center', width: '100%', justifyContent: 'center' },
  dot: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', zIndex: 1,
  },
  dotNum: { fontSize: 11, fontWeight: '700', color: '#fff' },
  dotNumActive: { fontSize: 12 },
  lineTrack: {
    position: 'absolute', height: 2, left: '58%', right: '-42%', top: 13,
    borderRadius: 1, overflow: 'hidden',
  },
  lineFill: {
    position: 'absolute', height: '100%', left: 0, top: 0,
    borderRadius: 1,
  },
  label: { fontSize: 9, marginTop: 5, textAlign: 'center' },
});
