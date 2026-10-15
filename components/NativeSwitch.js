// NativeSwitch — platform-correct themed toggle.  [2026-10-07 app-feel-ui]
//
// Why: screens passed `trackColor.true = colors.primaryLight` (#F2F3F5 — almost
// white) + `thumbColor = colors.primary` (#111): an ON switch rendered as a
// pale track with a black knob — a web toggle, not a UISwitch / Material
// switch. Each screen also had its own ad-hoc colors (ACCENT / '#555' / '#ccc'
// / '#f4f3f4'), so toggles looked different screen to screen.
//
// This wrapper IGNORES incoming trackColor/thumbColor/ios_backgroundColor and
// applies one native-looking scheme (black & white brand):
//   • iOS: white knob always (UISwitch), ON track = ink (light) / light gray
//     (dark, with dark knob for contrast), OFF track = system gray.
//   • Android: Material — ON track ink w/ white thumb, OFF neutral gray.
// Adds a selection haptic on change (native toggles tick).
// Drop-in: same props as RN <Switch>.
import React, { useRef, useEffect } from 'react';
import { Switch, Platform, Pressable, Animated, Easing } from 'react-native';
import { isReduceMotionEnabled } from './reducedMotion';

// [2026-10-15 settings-2026] Web: o <Switch> do RN-web é um toggle de
// formulário (trilho fino + bola que vaza). Desenha um UISwitch de verdade
// (51x31, knob branco com sombra, trilho que preenche) animado com spring.
// role="switch" + aria-checked preservados (QA/leitores de tela).
function WebSwitch({ value, onValueChange, disabled, onTrack, offTrack, onThumb, accessibilityLabel, testID, style }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { anim.setValue(value ? 1 : 0); return; }
    Animated.spring(anim, { toValue: value ? 1 : 0, useNativeDriver: false, tension: 260, friction: 22 }).start();
  }, [value, anim]);
  const bg = anim.interpolate({ inputRange: [0, 1], outputRange: [offTrack, onTrack] });
  const tx = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  return (
    <Pressable
      onPress={() => { if (!disabled) onValueChange?.(!value); }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: !!value, disabled: !!disabled }}
      aria-checked={!!value}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      hitSlop={6}
      style={[{ opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }, style]}
    >
      <Animated.View style={{ width: 51, height: 31, borderRadius: 16, backgroundColor: bg, justifyContent: 'center' }}>
        <Animated.View style={{
          width: 27, height: 27, borderRadius: 14, backgroundColor: value ? onThumb : '#FFFFFF',
          transform: [{ translateX: tx }],
          boxShadow: '0 2px 6px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.12)',
        }} />
      </Animated.View>
    </Pressable>
  );
}
import { useTheme } from '../context/ThemeContext';
import { selection } from '../services/haptics';

export default function NativeSwitch({
  value,
  onValueChange,
  disabled,
  trackColor, // eslint-disable-line no-unused-vars — overridden
  thumbColor, // eslint-disable-line no-unused-vars — overridden
  ios_backgroundColor, // eslint-disable-line no-unused-vars — overridden
  ...props
}) {
  const { isDark } = useTheme() || {};
  const onTrack = isDark ? '#F5F5F7' : '#111111';
  // [2026-10-14 dark-contrast] escuro: trilho desligado #39393D sobre célula
  // #1C1C1E sumia (≈1.3:1) → #636366 (systemGray do iOS, ≈2.6:1 + knob branco).
  const offTrack = Platform.OS === 'ios'
    ? (isDark ? '#636366' : '#E9E9EA')
    : (isDark ? '#5F6368' : '#C7C9CC');
  const onThumb = isDark ? '#0b0b0b' : '#ffffff';
  const offThumb = Platform.OS === 'android' ? (isDark ? '#9AA0A6' : '#ffffff') : '#ffffff';

  const handleChange = (v) => {
    if (Platform.OS !== 'web') { try { selection(); } catch {} }
    onValueChange?.(v);
  };

  if (Platform.OS === 'web') {
    return (
      <WebSwitch
        value={!!value}
        onValueChange={handleChange}
        disabled={disabled}
        onTrack={onTrack}
        offTrack={isDark ? '#3A3A3C' : '#E3E3E6'}
        onThumb={onThumb}
        accessibilityLabel={props.accessibilityLabel}
        testID={props.testID}
        style={props.style}
      />
    );
  }
  return (
    <Switch
      {...props}
      value={!!value}
      disabled={disabled}
      onValueChange={handleChange}
      trackColor={{ false: offTrack, true: onTrack }}
      thumbColor={value ? onThumb : offThumb}
      ios_backgroundColor={offTrack}
      {...(Platform.OS === 'web' ? { activeThumbColor: onThumb } : {})}
    />
  );
}
