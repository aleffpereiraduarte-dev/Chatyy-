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
import React from 'react';
import { Switch, Platform } from 'react-native';
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
  const onTrack = isDark ? '#E9EDEF' : '#111111';
  const offTrack = Platform.OS === 'ios'
    ? (isDark ? '#39393D' : '#E9E9EA')
    : (isDark ? '#3A3D40' : '#C7C9CC');
  const onThumb = isDark ? '#111b21' : '#ffffff';
  const offThumb = Platform.OS === 'android' ? (isDark ? '#9AA0A6' : '#ffffff') : '#ffffff';

  const handleChange = (v) => {
    if (Platform.OS !== 'web') { try { selection(); } catch {} }
    onValueChange?.(v);
  };

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
