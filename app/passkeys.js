// [2026-10-09 passkeys] Configurações > Segurança > Passkeys.
// Lista as passkeys da conta, cria uma neste aparelho (Face ID / Touch ID /
// digital) e remove. Escondido por PASSKEYS_ENABLED até o build com
// react-native-passkeys + Associated Domains; mesmo com a flag ligada, num
// binário sem o módulo nativo o botão vira um aviso (nada quebra).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Alert, Platform } from 'react-native';
import { SettingsScreen, SettingsGroup, SettingsRow, SettingsCardContent, useGroupedColors } from '../components/settings/SettingsKit';
import { IconKey, IconPlus, IconTrash } from '../components/Icons';
import { useLanguage } from '../context/LanguageContext';
import { PASSKEYS_ENABLED } from '../constants/featureFlags';
import { isPasskeySupported, registerPasskey, listPasskeys, deletePasskey } from '../services/passkeys';

function _deviceLabel() {
  try {
    const Device = require('expo-device');
    const name = Device?.deviceName || Device?.modelName || '';
    if (name) return String(name);
  } catch {}
  return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android' : 'Web';
}

function _fmtDate(v, locale) {
  if (!v) return '';
  try {
    const d = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') || String(v).includes('+') ? '' : 'Z'));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(locale || undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

export default function PasskeysScreen() {
  const { t, language: locale } = useLanguage();
  const g = useGroupedColors();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const supported = PASSKEYS_ENABLED && isPasskeySupported();

  const reload = useCallback(async () => {
    const list = await listPasskeys();
    setItems(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onAdd = useCallback(async () => {
    if (busy) return;
    if (!supported) {
      Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.unavailable'));
      return;
    }
    setBusy(true);
    try {
      const r = await registerPasskey(_deviceLabel());
      if (r.ok) {
        await reload();
        Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.added'));
      } else if (r.reason === 'exists') {
        Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.exists'));
      } else if (r.reason === 'unavailable') {
        Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.unavailable'));
      } else if (r.reason !== 'cancelled') {
        Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.error'));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, supported, reload, t]);

  const onRemove = useCallback((item) => {
    Alert.alert(
      t('settings.passkeys.removeTitle'),
      t('settings.passkeys.removeMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.passkeys.remove'),
          style: 'destructive',
          onPress: async () => {
            const ok = await deletePasskey(item.credential_id);
            if (ok) reload();
            else Alert.alert(t('settings.passkeys.title'), t('settings.passkeys.error'));
          },
        },
      ],
    );
  }, [reload, t]);

  if (!PASSKEYS_ENABLED) {
    return (
      <SettingsScreen title={t('settings.passkeys.title')}>
        <SettingsGroup>
          <SettingsCardContent>
            <Text style={{ color: g.secondary, fontSize: 15 }}>{t('settings.passkeys.unavailable')}</Text>
          </SettingsCardContent>
        </SettingsGroup>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title={t('settings.passkeys.title')}>
      <SettingsGroup footer={t('settings.passkeys.footer')}>
        <SettingsRow
          icon={IconPlus}
          title={t('settings.passkeys.add')}
          subtitle={supported ? t('settings.passkeys.addSub') : t('settings.passkeys.unavailable')}
          onPress={onAdd}
          disabled={busy}
          right={busy ? <ActivityIndicator size="small" color={g.secondary} /> : undefined}
        />
      </SettingsGroup>

      <SettingsGroup header={t('settings.passkeys.listHeader')}>
        {items === null ? (
          <SettingsCardContent>
            <View style={{ paddingVertical: 8, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={g.secondary} />
            </View>
          </SettingsCardContent>
        ) : items.length === 0 ? (
          <SettingsCardContent>
            <Text style={{ color: g.secondary, fontSize: 15 }}>{t('settings.passkeys.empty')}</Text>
          </SettingsCardContent>
        ) : (
          items.map((it) => {
            const created = _fmtDate(it.created_at, locale);
            const used = _fmtDate(it.last_used_at, locale);
            const sub = used
              ? t('settings.passkeys.lastUsed').replace('{date}', used)
              : t('settings.passkeys.createdAt').replace('{date}', created);
            return (
              <SettingsRow
                key={String(it.credential_id || it.id)}
                icon={IconKey}
                title={it.device_name || t('settings.passkeys.title')}
                subtitle={sub}
                right={<IconTrash size={20} color={g.destructive} />}
                onPress={() => onRemove(it)}
                accessibilityLabel={t('settings.passkeys.remove')}
              />
            );
          })
        )}
      </SettingsGroup>
    </SettingsScreen>
  );
}
