import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  TextInput,
  Text,
  ScrollView,
  TouchableOpacity,
  Animated,
  StyleSheet,
  Platform,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { IconCheck, IconX, IconCalendar, IconCake } from './Icons';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';

/**
 * SmartDateInput — Auto-formatting DD/MM/YYYY birthday input with age validation.
 *
 * Props:
 *   value        — current date string (DD/MM/YYYY or partial)
 *   onChange      — called with formatted string
 *   label         — field label text
 *   placeholder   — input placeholder
 *   minAge        — minimum valid age (default 6)
 *   maxAge        — maximum valid age (default 13)
 */
export default function SmartDateInput({
  value = '',
  onChange,
  label = 'Data de nascimento',
  placeholder = 'DD/MM/AAAA',
  minAge = 6,
  maxAge = 13,
}) {
  const { colors, isDark } = useTheme();
  const [focused, setFocused] = useState(false);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  // ── Auto-format logic (simple and reliable) ─────────────────────────
  const handleChangeText = useCallback(
    (raw) => {
      // Extract only digits from whatever the user typed
      const digits = raw.replace(/\D/g, '').slice(0, 8);

      // Build formatted string: DD/MM/YYYY
      let result = '';
      for (let i = 0; i < digits.length; i++) {
        if (i === 2 || i === 4) result += '/';
        result += digits[i];
      }

      onChange(result);
    },
    [onChange],
  );

  // ── Parse date ─────────────────────────────────────────────────────
  const parsed = useMemo(() => {
    const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Quick day-in-month validation
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) return null;
    const d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return null;
    // Must not be in the future
    if (d > new Date()) return null;
    return d;
  }, [value]);

  // ── Age calculation ────────────────────────────────────────────────
  const ageInfo = useMemo(() => {
    if (!parsed) return null;
    const now = new Date();
    let years = now.getFullYear() - parsed.getFullYear();
    let months = now.getMonth() - parsed.getMonth();
    if (now.getDate() < parsed.getDate()) months--;
    if (months < 0) {
      years--;
      months += 12;
    }
    return { years, months };
  }, [parsed]);

  const isComplete = value.length === 10;
  const isValid = ageInfo && ageInfo.years >= minAge && ageInfo.years <= maxAge;
  const isInvalid = isComplete && !isValid;

  // ── Shake on invalid ──────────────────────────────────────────────
  useEffect(() => {
    if (isInvalid) {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 40, useNativeDriver: true }),
      ]).start();
    }
  }, [isInvalid, shakeAnim]);

  // ── Suggestion chips ──────────────────────────────────────────────
  const chips = useMemo(() => {
    const result = [];
    const now = new Date();
    for (let age = minAge; age <= maxAge; age++) {
      // Birthday that would make the child exactly `age` years old today
      const bday = new Date(now.getFullYear() - age, now.getMonth(), now.getDate());
      const dd = String(bday.getDate()).padStart(2, '0');
      const mm = String(bday.getMonth() + 1).padStart(2, '0');
      const yyyy = String(bday.getFullYear());
      result.push({ age, date: `${dd}/${mm}/${yyyy}` });
    }
    return result;
  }, [minAge, maxAge]);

  // ── Age display text ──────────────────────────────────────────────
  const ageText = useMemo(() => {
    if (!ageInfo) return null;
    const { years, months } = ageInfo;
    const yStr = years === 1 ? '1 ano' : `${years} anos`;
    const mStr = months === 1 ? '1 mes' : `${months} meses`;
    if (months === 0) return yStr;
    return `${yStr} e ${mStr}`;
  }, [ageInfo]);

  // ── Validation message ────────────────────────────────────────────
  const validationMsg = useMemo(() => {
    if (!isComplete) return null;
    if (!parsed) return 'Data invalida';
    if (!ageInfo) return null;
    if (ageInfo.years < minAge) return `Idade minima: ${minAge} anos`;
    if (ageInfo.years > maxAge) return `Idade maxima: ${maxAge} anos`;
    return null;
  }, [isComplete, parsed, ageInfo, minAge, maxAge]);

  // ── Border color ──────────────────────────────────────────────────
  const borderColor = isValid
    ? colors.success
    : isInvalid
      ? colors.error
      : focused
        ? colors.primary
        : colors.border;

  const bgColor = isDark ? colors.surfaceVariant : colors.surface;

  // ── Styles ────────────────────────────────────────────────────────
  const s = useMemo(
    () =>
      StyleSheet.create({
        container: {
          width: '100%',
        },
        label: {
          fontSize: FontSize.sm,
          fontWeight: '600',
          color: colors.textSecondary,
          marginBottom: Spacing.xs,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        },
        inputRow: {
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1.5,
          borderRadius: BorderRadius.lg,
          paddingHorizontal: Spacing.lg,
          paddingVertical: Platform.OS === 'web' ? Spacing.md : Spacing.sm,
          backgroundColor: bgColor,
          ...Shadow.sm,
        },
        calendarIcon: {
          marginRight: Spacing.md,
          opacity: 0.5,
        },
        input: {
          flex: 1,
          fontSize: FontSize.xxl,
          fontWeight: '500',
          color: colors.text,
          letterSpacing: 2,
          padding: 0,
          ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
        },
        statusIcon: {
          marginLeft: Spacing.md,
        },
        ageRow: {
          flexDirection: 'row',
          alignItems: 'center',
          marginTop: Spacing.sm,
          paddingHorizontal: Spacing.xs,
          minHeight: 22,
        },
        ageText: {
          fontSize: FontSize.base,
          fontWeight: '500',
          marginLeft: Spacing.xs,
        },
        errorText: {
          fontSize: FontSize.sm,
          color: colors.error,
          marginTop: Spacing.xs,
          paddingHorizontal: Spacing.xs,
        },
        chipsLabel: {
          fontSize: FontSize.xs,
          color: colors.textTertiary,
          marginTop: Spacing.lg,
          marginBottom: Spacing.sm,
          paddingHorizontal: Spacing.xs,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: '600',
        },
        chipsScroll: {
          marginTop: 0,
        },
        chipsContent: {
          paddingHorizontal: Spacing.xs,
          gap: Spacing.sm,
        },
        chip: {
          paddingHorizontal: Spacing.lg,
          paddingVertical: Spacing.sm,
          borderRadius: BorderRadius.full,
          borderWidth: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.xs,
        },
        chipText: {
          fontSize: FontSize.sm,
          fontWeight: '600',
        },
      }),
    [colors, bgColor],
  );

  return (
    <View style={s.container}>
      {/* Label */}
      <Text style={s.label}>{label}</Text>

      {/* Input row with shake animation */}
      <Animated.View
        style={[
          s.inputRow,
          { borderColor },
          { transform: [{ translateX: shakeAnim }] },
          focused && {
            ...Shadow.md,
            ...(Platform.OS === 'web'
              ? { boxShadow: `0 0 0 3px ${isValid ? colors.successBg : isInvalid ? colors.errorBg : colors.focusGlow}` }
              : {}),
          },
        ]}
      >
        <View style={s.calendarIcon}>
          <IconCake size={20} color={colors.textTertiary} />
        </View>
        <TextInput
          style={s.input}
          value={value}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          maxLength={10}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          accessibilityRole="text"
        />
        {isValid && (
          <View style={s.statusIcon}>
            <IconCheck size={22} color={colors.success} />
          </View>
        )}
        {isInvalid && (
          <View style={s.statusIcon}>
            <IconX size={22} color={colors.error} />
          </View>
        )}
      </Animated.View>

      {/* Age display / error */}
      <View style={s.ageRow}>
        {ageText && isValid && (
          <>
            <IconCalendar size={14} color={colors.success} />
            <Text style={[s.ageText, { color: colors.success }]}>{ageText}</Text>
          </>
        )}
        {ageText && isInvalid && (
          <>
            <IconCalendar size={14} color={colors.error} />
            <Text style={[s.ageText, { color: colors.error }]}>{ageText}</Text>
          </>
        )}
      </View>

      {validationMsg && <Text style={s.errorText}>{validationMsg}</Text>}
    </View>
  );
}
