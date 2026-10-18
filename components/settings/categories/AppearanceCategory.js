// [2026-10-18 me-merge] Categoria "Aparência" (Telegram/WhatsApp): tema, cor de
// destaque, papel de parede e estilo dos balões. Saiu de "Conversas" para a
// tela "Você" ter Conversas (comportamento) e Aparência (visual) separadas.
// Mesmas chaves locais de antes (bubble_shape) — nada muda para o chat.
//
// [2026-10-18 appearance-telegram] Nível Telegram: prévia AO VIVO da conversa
// no topo, tamanho do texto 13–20 (chat_font_px; JS e lista nativa recebem por
// prop → OTA), temas de cor da conversa (papel de parede da conta), emojis
// grandes (jumbo_emoji) e "Reduzir animações" (flag central reducedMotion).
// Tudo de verdade: cada controle tem consumidor na conversa.
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import * as settingsCache from '../../../services/settingsCache';
import SettingsSegmented from '../../SettingsSegmented';
import { SettingsGroup, SettingsPickerRow, SettingsCardContent, SettingsSwitchRow } from '../SettingsKit';
import { AccentColorGroup, WallpaperRow } from '../SettingsPanels';
import {
  ChatPreviewCard, TextSizeSlider, ChatThemeCards,
  CHAT_FONT_KEY, JUMBO_KEY, ENUM_PX, FONT_DEFAULT, normFontPx, pxToEnum, emitAppearanceChanged,
} from '../AppearanceExtras';
import {
  useReducedMotion, isSystemReduceMotionEnabled, getReduceMotionPreference, setReduceMotionPreference,
} from '../../../constants/motion';
import { useSettingsHost, useLocalKeys, setStorage, useSection, useSaveNotifPref } from './shared';

const LOCAL_KEYS = ['bubble_shape', CHAT_FONT_KEY, JUMBO_KEY];

function _bumpChatSettingsRev() {
  // O chat cacheia chat_get_settings por 10 min → sinaliza revisão nova.
  try { globalThis.__chatyy_chat_settings_rev = (Number(globalThis.__chatyy_chat_settings_rev) || 0) + 1; } catch {}
}

export default function AppearanceCategory() {
  const { colors, isDark, themeMode, setThemeMode } = useTheme();
  const { t } = useLanguage();
  const tx = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const { registerAnchor } = useSettingsHost();
  const saveNotifPref = useSaveNotifPref();
  const [bubble, setBubble] = useState('rounded');
  const [fontPx, setFontPx] = useState(0); // 0 = ainda sem valor local → enum do servidor
  const [jumbo, setJumbo] = useState(true);
  useLocalKeys(LOCAL_KEYS, (kv) => {
    setBubble(['rounded', 'square', 'classic'].includes(kv.bubble_shape) ? kv.bubble_shape : 'rounded');
    setFontPx(normFontPx(kv[CHAT_FONT_KEY]));
    setJumbo(kv[JUMBO_KEY] !== 'false');
  });
  // Tamanho atual: local (slider) > enum do servidor (Acessibilidade/outros aparelhos).
  const notif = useSection('notif');
  const enumPx = ENUM_PX[notif && notif.font_size] || FONT_DEFAULT;
  const shownPx = fontPx || enumPx;
  // Papel de parede da conta (mesmo snapshot da linha "Papel de parede").
  const { data: chatSettings } = settingsCache.useSettingsSection('chat_settings');
  const wallpaper = (chatSettings && typeof chatSettings.wallpaper === 'string' && chatSettings.wallpaper) || 'none';
  // Reduzir animações (mesma flag central da Acessibilidade).
  const reduceOn = useReducedMotion();
  const systemReduce = isSystemReduceMotionEnabled();

  const commitFont = (px) => {
    const v = normFontPx(px);
    if (!v) return;
    setStorage(CHAT_FONT_KEY, String(v));
    // Outros aparelhos/Acessibilidade recebem o degrau mais próximo (o servidor só guarda small/medium/large).
    const en = pxToEnum(v);
    if (!notif || notif.font_size !== en) {
      saveNotifPref({ font_size: en });
      _bumpChatSettingsRev();
    }
    emitAppearanceChanged();
  };
  const applyTheme = (value) => {
    _bumpChatSettingsRev();
    settingsCache.commit('chat_settings', { patch: { wallpaper: value }, action: 'chat_update_settings', params: { wallpaper: value } })
      .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); }).catch(() => {});
  };

  return (
    <View ref={registerAnchor('appearance')}>
      <SettingsGroup footer={tx('settings.appear.previewFooter', 'A prévia mostra como as conversas vão ficar com as opções abaixo.')}>
        <ChatPreviewCard isDark={isDark} wallpaper={wallpaper} bubbleShape={bubble} fontPx={shownPx} tx={tx} />
      </SettingsGroup>

      <SettingsGroup
        header={tx('settings.appear.textSizeHeader', 'Tamanho do texto')}
        footer={tx('settings.appear.textSizeFooter', 'Ajusta o texto das mensagens nas conversas. O padrão é 16.')}
      >
        <TextSizeSlider value={shownPx} onChange={setFontPx} onCommit={commitFont} tx={tx} />
      </SettingsGroup>

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

      <SettingsGroup
        header={tx('settings.appear.chatThemeHeader', 'Tema das conversas')}
        footer={tx('settings.appear.chatThemeFooter', 'Fundo e tons das conversas. Vale para todas as conversas sem um papel de parede próprio.')}
      >
        <ChatThemeCards isDark={isDark} wallpaper={wallpaper} bubbleShape={bubble} onSelect={applyTheme} tx={tx} />
      </SettingsGroup>

      <AccentColorGroup />

      <SettingsGroup footer={tx('settings.appear.bubbleFooter', 'Escolha uma foto, cor ou padrão e o formato dos balões das mensagens.')}>
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
          onChange={(v) => { setBubble(v); setStorage('bubble_shape', String(v)); emitAppearanceChanged(); }}
        />
      </SettingsGroup>

      <SettingsGroup
        header={tx('settings.appear.moreHeader', 'Mensagens e animações')}
        footer={systemReduce
          ? tx('settings.reduceMotionSystemOn', 'O "Reduzir movimento" do sistema está ativo, então as animações já estão reduzidas.')
          : tx('settings.appear.moreFooter', 'Emojis grandes mostram mensagens com até 3 emojis em tamanho maior, sem balão. Reduzir animações troca molas e deslizes por transições discretas em todo o app.')}
      >
        <SettingsSwitchRow
          title={tx('settings.appear.jumbo', 'Emojis grandes')}
          value={jumbo}
          onValueChange={(v) => { setJumbo(!!v); setStorage(JUMBO_KEY, v ? 'true' : 'false'); emitAppearanceChanged(); }}
          testID="settings-jumbo-emoji"
        />
        <SettingsSwitchRow
          title={tx('settings.appear.reduceMotion', 'Reduzir animações')}
          value={reduceOn || getReduceMotionPreference() === 'on'}
          disabled={systemReduce}
          onValueChange={(v) => setReduceMotionPreference(v ? 'on' : 'system')}
          testID="settings-appearance-reduce-motion"
        />
      </SettingsGroup>
    </View>
  );
}
