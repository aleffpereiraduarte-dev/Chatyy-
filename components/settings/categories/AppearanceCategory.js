// [2026-10-18 me-merge] Categoria "Aparência" (Telegram/WhatsApp): tema, cor de
// destaque, papel de parede e estilo dos balões. Saiu de "Conversas" para a
// tela "Você" ter Conversas (comportamento) e Aparência (visual) separadas.
// Mesmas chaves locais de antes (bubble_shape) — nada muda para o chat.
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import SettingsSegmented from '../../SettingsSegmented';
import { SettingsGroup, SettingsPickerRow, SettingsCardContent } from '../SettingsKit';
import { AccentColorGroup, WallpaperRow } from '../SettingsPanels';
import { useSettingsHost, useLocalKeys, setStorage } from './shared';

const LOCAL_KEYS = ['bubble_shape'];

export default function AppearanceCategory() {
  const { colors, isDark, themeMode, setThemeMode } = useTheme();
  const { t } = useLanguage();
  const { registerAnchor } = useSettingsHost();
  const [bubble, setBubble] = useState('rounded');
  useLocalKeys(LOCAL_KEYS, (kv) => {
    setBubble(['rounded', 'square', 'classic'].includes(kv.bubble_shape) ? kv.bubble_shape : 'rounded');
  });

  return (
    <View ref={registerAnchor('appearance')}>
      <SettingsGroup header={t('settings.theme.label') || 'Tema'} footer={t('settings.rd.themeFooter') || 'Sistema acompanha o modo claro/escuro do aparelho.'}>
        <SettingsCardContent>
          <SettingsSegmented
            colors={colors}
            isDark={isDark}
            value={themeMode}
            onChange={(v) => setThemeMode(v)}
            options={[
              { value: 'light', label: t('settings.theme.light') || 'Claro' },
              { value: 'dark', label: t('settings.theme.dark') || 'Escuro' },
              { value: 'system', label: t('settings.theme.system') || 'Sistema' },
            ]}
          />
        </SettingsCardContent>
      </SettingsGroup>
      <AccentColorGroup />
      <SettingsGroup>
        <WallpaperRow />
        <SettingsPickerRow
          title={t('settings.bubble.title') || 'Estilo dos balões'}
          value={bubble}
          sheetMessage={t('settings.bubble.subtitle') || 'Formato visual das mensagens.'}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={[
            { value: 'rounded', label: t('settings.bubble.rounded') || 'Arredondado' },
            { value: 'square', label: t('settings.bubble.square') || 'Quadrado' },
            { value: 'classic', label: t('settings.bubble.classic') || 'Clássico' },
          ]}
          onChange={(v) => { setBubble(v); setStorage('bubble_shape', String(v)); }}
        />
      </SettingsGroup>
    </View>
  );
}
