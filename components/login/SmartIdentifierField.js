// [2026-10-07 login-ux] One field for phone, e-mail or @username
// (Instagram / Telegram pattern).
//
//  - phone   → country chip (device-locale default) + format-as-you-type mask;
//              pasting "+55 11 9…" auto-picks the country and strips the DDI.
//  - e-mail  → mail glyph; @handle / bare handle → "handle@chatyy.com.br" hint.
//  - textContentType/autoComplete = username so iOS Keychain QuickType and the
//    Android Autofill service offer saved credentials right on this field.
//
// Value contract: `value` is the RAW identifier. For national phone numbers it
// holds digits only (the mask is display-only); for "+…" it holds "+digits".
import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Platform } from 'react-native';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { formatPhone } from '../../constants/countries';
import { classifyIdentifier, splitInternational, normalizeLoginEmail } from './loginSmart';

function KindGlyph({ kind, color }) {
  const p = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  if (kind === 'email') {
    return (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Rect x="3" y="5" width="18" height="14" rx="2.5" {...p} />
        <Path d="M3.5 6.5l8.5 6 8.5-6" {...p} />
      </Svg>
    );
  }
  if (kind === 'phone') {
    return (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Rect x="6.5" y="2.5" width="11" height="19" rx="2.5" {...p} />
        <Path d="M10.5 18.5h3" {...p} />
      </Svg>
    );
  }
  if (kind === 'username') {
    return (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Circle cx="12" cy="12" r="4" {...p} />
        <Path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" {...p} />
      </Svg>
    );
  }
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx="12" cy="8" r="4" {...p} />
      <Path d="M4 21a8 8 0 0 1 16 0" {...p} />
    </Svg>
  );
}

export default function SmartIdentifierField({
  value,
  onChangeText,
  country, // { iso, dial, mask, maxDigits }
  onPressCountry,
  onInternationalDetected,
  onSubmitEditing,
  inputRef,
  colors,
  t,
  invalid = false,
  autoFocus = false,
  editable = true,
  showKindHint = true,
}) {
  const [focused, setFocused] = useState(false);
  const raw = String(value || '');
  const kind = classifyIdentifier(raw);
  const isNationalPhone = kind === 'phone' && !raw.trim().startsWith('+');
  const display = isNationalPhone ? formatPhone(raw.replace(/\D/g, ''), country?.mask) : raw;

  const handleChange = (text) => {
    let next = String(text ?? '');
    // A formatted phone ("(11) 9") that suddenly gets letters / "@" is really
    // a handle or e-mail that starts with digits → drop the mask punctuation.
    if (isNationalPhone && /[A-Za-z@_]/.test(next)) next = next.replace(/[\s()\-.]/g, '');
    const k = classifyIdentifier(next);
    if (k === 'phone') {
      const trimmed = next.trim();
      if (trimmed.startsWith('+')) {
        const digits = trimmed.replace(/\D/g, '');
        // Only auto-split once the number is long enough to be unambiguous
        // ("+35" could still become +351/+353…). Paste lands here directly.
        if (digits.length >= 10) {
          const sp = splitInternational(trimmed);
          if (sp && sp.national.length >= 6) {
            onInternationalDetected?.(sp);
            onChangeText?.(sp.national.slice(0, sp.country.maxDigits || 15));
            return;
          }
        }
        onChangeText?.(`+${digits}`);
        return;
      }
      onChangeText?.(next.replace(/\D/g, '').slice(0, country?.maxDigits || 15));
      return;
    }
    onChangeText?.(next);
  };

  const borderColor = invalid ? colors.error : (focused ? colors.text : colors.authInputBorder || colors.border);

  let hint = '';
  if (showKindHint) {
    if (kind === 'phone') hint = t('login.smartHintPhone');
    else if (kind === 'username' && raw.trim().length >= 2) hint = t('login.smartHintUsername', { email: normalizeLoginEmail(raw) });
    else if (kind === 'email') hint = t('login.smartHintEmail');
  }

  return (
    <View>
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        minHeight: 56, borderRadius: 14,
        borderWidth: focused || invalid ? 1.5 : 1,
        borderColor,
        backgroundColor: colors.surfaceVariant,
        paddingLeft: isNationalPhone ? 6 : 14, paddingRight: 6,
        ...(Platform.OS === 'web' ? { transition: 'border-color 140ms ease, box-shadow 140ms ease' } : {}),
        ...(Platform.OS === 'web' && focused ? { boxShadow: `0 0 0 4px ${invalid ? colors.error : colors.text}14` } : {}),
      }}>
        {isNationalPhone ? (
          <TouchableOpacity
            onPress={onPressCountry}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={t('login.selectCountry')}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 10, height: 40, borderRadius: 10,
              backgroundColor: colors.authCardBg || colors.surface,
              marginRight: 8,
              ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '800', color: colors.text, letterSpacing: 0.4 }}>{country?.iso || ''}</Text>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textSecondary }}>{country?.dial || ''}</Text>
            <Svg width={10} height={10} viewBox="0 0 24 24">
              <Path d="M6 9l6 6 6-6" stroke={colors.textSecondary} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </Svg>
          </TouchableOpacity>
        ) : (
          <View style={{ marginRight: 10 }} pointerEvents="none">
            <KindGlyph kind={kind} color={focused ? colors.text : colors.textTertiary} />
          </View>
        )}
        <TextInput
          ref={inputRef}
          value={display}
          onChangeText={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={onSubmitEditing}
          editable={editable}
          autoFocus={autoFocus}
          placeholder={t('login.smartPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel={t('login.smartPlaceholder')}
          accessibilityHint={t('login.smartA11yHint')}
          // Keychain / Autofill: this IS the account identifier.
          textContentType="username"
          autoComplete="username"
          importantForAutofill="yes"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="email-address"
          returnKeyType="next"
          enterKeyHint="next"
          blurOnSubmit={false}
          style={[{
            flex: 1, fontSize: 17, fontWeight: isNationalPhone ? '600' : '400',
            letterSpacing: isNationalPhone ? 0.3 : 0,
            color: colors.text, paddingVertical: 14,
          }, Platform.OS === 'web' && { outlineStyle: 'none' }]}
        />
        {!!raw && focused && editable ? (
          <TouchableOpacity
            onPress={() => onChangeText?.('')}
            accessibilityRole="button"
            accessibilityLabel={t('login.clearField')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Circle cx="12" cy="12" r="10" fill={colors.textTertiary} />
              <Path d="M9 9l6 6M15 9l-6 6" stroke={colors.surfaceVariant} strokeWidth={2.2} strokeLinecap="round" />
            </Svg>
          </TouchableOpacity>
        ) : null}
      </View>
      {!!hint && (
        <Text numberOfLines={2} style={{ fontSize: 12.5, lineHeight: 17, color: colors.textSecondary, marginTop: 8, marginLeft: 4 }}>
          {hint}
        </Text>
      )}
    </View>
  );
}
