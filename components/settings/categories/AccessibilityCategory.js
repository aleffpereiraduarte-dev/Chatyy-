// [2026-10-15 settings-split] Categoria "Acessibilidade": tamanho da fonte
// das conversas (chat_user_notif_prefs.font_size + blob get_settings, lido
// pelo chat) e densidade das listas (ThemeContext).
import { View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { SettingsGroup, SettingsPickerRow } from '../SettingsKit';
import { useSettingsHost, useSettingsBlob, useSaveNotifPref } from './shared';

export default function AccessibilityCategory() {
  const { density, setDensity } = useTheme();
  const { t } = useLanguage();
  const { registerAnchor } = useSettingsHost();
  const { settings, setSettings } = useSettingsBlob();
  const saveNotifPref = useSaveNotifPref();
  return (
    <View ref={registerAnchor('reading')}>
      <SettingsGroup header={t('settings.cat.accessibility')} footer={t('settings.fontSizeDesc')}>
        <SettingsPickerRow
          title={t('settings.fontSize')}
          value={settings.font_size}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          sheetMessage={t('settings.fontSizeDesc')}
          options={[{ value: 'small', label: t('settings.fontSmall') }, { value: 'medium', label: t('settings.fontMedium') }, { value: 'large', label: t('settings.fontLarge') }]}
          onChange={(v) => {
            setSettings(prev => ({ ...prev, font_size: v }));
            saveNotifPref({ font_size: v });
            // O chat cacheia chat_get_settings por 10 min → sinaliza revisão nova.
            try { globalThis.__chatyy_chat_settings_rev = (Number(globalThis.__chatyy_chat_settings_rev) || 0) + 1; } catch {}
          }}
        />
        {typeof setDensity === 'function' && (
          <SettingsPickerRow
            title={t('quickSettings.density')}
            value={density}
            cancelLabel={t('common.cancel') || 'Cancelar'}
            options={[
              { value: 'compact', label: t('settings.densityCompact') },
              { value: 'comfortable', label: t('settings.densityComfortable') },
              { value: 'spacious', label: t('settings.densitySpacious') },
            ]}
            onChange={(v) => setDensity(v)}
          />
        )}
      </SettingsGroup>
    </View>
  );
}
