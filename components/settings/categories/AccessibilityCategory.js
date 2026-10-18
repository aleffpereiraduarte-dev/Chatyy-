// [2026-10-15 settings-split] Categoria "Acessibilidade": tamanho da fonte
// das conversas (chat_user_notif_prefs.font_size + blob get_settings, lido
// pelo chat) e densidade das listas (ThemeContext).
import { View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { SettingsGroup, SettingsPickerRow, SettingsSwitchRow } from '../SettingsKit';
import {
  useReducedMotion, isSystemReduceMotionEnabled, getReduceMotionPreference, setReduceMotionPreference,
  useHapticsEnabled, setHapticsEnabled, feedback,
} from '../../../constants/motion';
import { useSettingsHost, useSettingsBlob, useSaveNotifPref, removeStorage } from './shared';

export default function AccessibilityCategory() {
  const { density, setDensity } = useTheme();
  const { t } = useLanguage();
  const { registerAnchor } = useSettingsHost();
  const { settings, setSettings } = useSettingsBlob();
  const saveNotifPref = useSaveNotifPref();
  // [2026-10-16 motion] Movimento e toque (preferências LOCAIS do aparelho).
  const tx = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const reduceOn = useReducedMotion();
  const systemReduce = isSystemReduceMotionEnabled();
  const hapticsOn = useHapticsEnabled();
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
            // [2026-10-18 appearance-telegram] degrau escolhido aqui vence o ajuste fino (13–20) da Aparência.
            removeStorage('chat_font_px');
            try { require('../AppearanceExtras').emitAppearanceChanged(); } catch {}
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
      <SettingsGroup
        header={tx('settings.motionHeader', 'Movimento e toque')}
        footer={systemReduce
          ? tx('settings.reduceMotionSystemOn', 'O "Reduzir movimento" do sistema está ativo, então as animações já estão reduzidas.')
          : tx('settings.reduceMotionDesc', 'Troca molas e deslizes por transições discretas. A vibração ao tocar dá um retorno sutil nos botões e controles.')}
      >
        <SettingsSwitchRow
          title={tx('settings.reduceMotion', 'Reduzir movimento')}
          value={reduceOn || getReduceMotionPreference() === 'on'}
          disabled={systemReduce}
          onValueChange={(v) => setReduceMotionPreference(v ? 'on' : 'system')}
          testID="settings-reduce-motion"
        />
        <SettingsSwitchRow
          title={tx('settings.hapticsTouch', 'Vibração ao tocar')}
          value={hapticsOn}
          onValueChange={(v) => { setHapticsEnabled(v); if (v) feedback.selection(); }}
          testID="settings-haptics"
        />
      </SettingsGroup>
    </View>
  );
}
