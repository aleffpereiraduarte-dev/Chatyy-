// [2026-10-07 login-ux] "Continuar como …" — accounts this device already
// knows (multi-account roster kept by AuthContext: email + name, token zeroed
// on explicit logout). One tap continues: biometric → stored session → password
// step prefilled. "Remover" forgets the row locally (two-tap confirm).
import { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import PressableScale from '../PressableScale';

function Chevron({ color }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M9 6l6 6-6 6" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function BiometricGlyph({ kind, color, size = 20 }) {
  const p = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', fill: 'none' };
  if (kind === 'face') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" {...p} />
        <Path d="M9 9.5v1M15 9.5v1M12 10v3.5h-1M9.5 16.2c.7.5 1.6.8 2.5.8s1.8-.3 2.5-.8" {...p} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 11v3.5c0 1.6.4 3.1 1.1 4.5" {...p} />
      <Path d="M8.5 13.5c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5c0 1.5-.2 3-.6 4.4" {...p} />
      <Path d="M5.6 15.5A9 9 0 0 1 5.3 13a6.7 6.7 0 0 1 13.4 0c0 .9-.1 1.8-.2 2.6" {...p} />
      <Path d="M4.2 9.2A8.9 8.9 0 0 1 12 4.5c3.4 0 6.3 1.9 7.8 4.7" {...p} />
    </Svg>
  );
}

function Row({ acc, onSelect, onRemove, colors, t, busy, bioKind, isLast }) {
  const [confirm, setConfirm] = useState(false);
  const label = (acc.name && String(acc.name).trim()) || String(acc.email).split('@')[0];
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      borderBottomWidth: isLast ? 0 : Platform.OS === 'web' ? 1 : 0.5,
      borderBottomColor: colors.border,
    }}>
      <View style={{ flex: 1, minWidth: 0 }}>
      <PressableScale
        onPress={() => { if (!busy) onSelect(acc); }}
        haptic="light"
        scaleTo={0.98}
        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingLeft: 14, gap: 12 }}
        accessibilityRole="button"
        accessibilityLabel={t('login.continueAs', { name: label })}
      >
        <AvatarCircle name={label} email={acc.email} size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{label}</Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: colors.textSecondary, marginTop: 1 }}>{acc.email}</Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : bioKind ? (
          <BiometricGlyph kind={bioKind} color={colors.text} />
        ) : (
          <Chevron color={colors.textTertiary} />
        )}
      </PressableScale>
      </View>
      {confirm ? (
        <TouchableOpacity
          onPress={() => { setConfirm(false); onRemove(acc); }}
          accessibilityRole="button"
          accessibilityLabel={t('login.removeAccountConfirm')}
          style={{ paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, borderRadius: 999, backgroundColor: colors.errorBg }}
        >
          <Text style={{ fontSize: 12, fontWeight: '800', color: colors.error }}>{t('login.removeAccountConfirm')}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={() => setConfirm(true)}
          accessibilityRole="button"
          accessibilityLabel={t('login.removeAccount')}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
          style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: 4 }}
        >
          <Svg width={16} height={16} viewBox="0 0 24 24">
            <Path d="M6 6l12 12M18 6L6 18" stroke={colors.textTertiary} strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function RememberedAccounts({ accounts, onSelect, onRemove, onUseAnother, colors, t, busyEmail, bioEmail, bioKind }) {
  if (!accounts?.length) return null;
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 8, marginLeft: 4, letterSpacing: 0.2 }}>
        {t('login.rememberedTitle')}
      </Text>
      <View style={{
        borderRadius: 16, overflow: 'hidden',
        backgroundColor: colors.authCardBg || colors.surface,
        borderWidth: Platform.OS === 'web' ? 1 : 0.5, borderColor: colors.border,
      }}>
        {accounts.map((acc, i) => (
          <Row
            key={acc.email}
            acc={acc}
            onSelect={onSelect}
            onRemove={onRemove}
            colors={colors}
            t={t}
            busy={busyEmail === acc.email}
            bioKind={bioEmail && bioEmail === acc.email ? bioKind : null}
            isLast={i === accounts.length - 1}
          />
        ))}
      </View>
      <TouchableOpacity
        onPress={onUseAnother}
        activeOpacity={0.6}
        accessibilityRole="button"
        style={{ alignSelf: 'center', marginTop: 14, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
      >
        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t('login.useAnotherAccount')}</Text>
      </TouchableOpacity>
    </View>
  );
}
