// [2026-10-15 settings-split] Categoria "Acessibilidade": tamanho da fonte
// das conversas (chat_user_notif_prefs.font_size + blob get_settings, lido
// pelo chat) e densidade das listas (ThemeContext).
//
// [2026-10-19 a11y-complete] Acessibilidade COMPLETA e de verdade — cada opção
// tem consumidor (flags centrais em services/a11yPrefs; padrão = sistema):
//   • Tamanho do texto 13–20 = o MESMO da Aparência (chat_font_px + degrau do
//     servidor p/ outros aparelhos) → conversa JS e lista nativa.
//   • Texto em negrito → services/a11yGlobalPatch (todo <Text> do app, ao vivo).
//   • Aumentar contraste → ThemeContext (textos secundários/divisórias) + hora/✓ das bolhas.
//   • Reduzir movimento (flag central) · Reduzir transparência → NativeBlur e barra de abas sólidas.
//   • Áreas de toque maiores → hitSlop extra em Pressable/TouchableOpacity (a11yGlobalPatch).
//   • Legendas nas notas de voz → recebidas transcritas sozinhas (chat-conversation).
//   • ✓✓ com forma → lida com traço grosso, entregue fino (não depende só da cor).
//   • Vibração ao tocar (hapticsPref).
// Esta categoria pode ser desenhada pela lista NATIVA de Ajustes (nativeCollect)
// → só linhas padrão (switch / picker), nada de componente custom aqui.
import { useState } from 'react';
import { View, Platform } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { SettingsGroup, SettingsPickerRow, SettingsSwitchRow } from '../SettingsKit';
import {
  useReducedMotion, isSystemReduceMotionEnabled, getReduceMotionPreference, setReduceMotionPreference,
  useHapticsEnabled, setHapticsEnabled, feedback,
} from '../../../constants/motion';
import { useA11y, setA11yPref, setA11yTri, getSystemA11y, refreshA11y } from '../../../services/a11yPrefs';
import { CHAT_FONT_KEY, ENUM_PX, FONT_DEFAULT, FONT_MIN, FONT_MAX, normFontPx, pxToEnum, emitAppearanceChanged } from '../AppearanceExtras';
import { useSettingsHost, useSettingsBlob, useSaveNotifPref, useLocalKeys, setStorage } from './shared';

const FONT_OPTIONS = Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i);

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
  const a11y = useA11y();
  const sys = getSystemA11y();
  const sysHint = Platform.OS === 'ios'
    ? tx('settings.a11y.followsIos', 'Ativado nos Ajustes do iPhone')
    : tx('settings.a11y.followsSystem', 'Ativado nas configurações do aparelho');

  // Tamanho do texto: local (ajuste fino 13–20, igual à Aparência) > degrau do servidor.
  const [fontPx, setFontPx] = useState(0);
  useLocalKeys([CHAT_FONT_KEY], (kv) => setFontPx(normFontPx(kv[CHAT_FONT_KEY])));
  const shownPx = fontPx || ENUM_PX[settings && settings.font_size] || FONT_DEFAULT;
  const commitFont = (px) => {
    const v = normFontPx(px);
    if (!v) return;
    setFontPx(v);
    setStorage(CHAT_FONT_KEY, String(v));
    const en = pxToEnum(v);
    if (!settings || settings.font_size !== en) {
      setSettings(prev => ({ ...prev, font_size: en }));
      saveNotifPref({ font_size: en });
    }
    // O chat cacheia chat_get_settings por 10 min → sinaliza revisão nova.
    try { globalThis.__chatyy_chat_settings_rev = (Number(globalThis.__chatyy_chat_settings_rev) || 0) + 1; } catch {}
    emitAppearanceChanged();
  };

  return (
    <View ref={registerAnchor('reading')}>
      <SettingsGroup
        header={tx('settings.a11y.textHeader', 'Texto e leitura')}
        footer={tx('settings.a11y.textFooter', 'O tamanho vale para as mensagens das conversas (o mesmo ajuste da Aparência). Negrito e contraste valem para o app inteiro.')}
      >
        <SettingsPickerRow
          title={tx('settings.appear.textSize', 'Tamanho do texto')}
          value={String(shownPx)}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          sheetMessage={tx('settings.appear.textSizeFooter', 'Ajusta o texto das mensagens nas conversas. O padrão é 16.')}
          options={FONT_OPTIONS.map((px) => ({
            value: String(px),
            label: px === FONT_DEFAULT ? `${px} pt · ${tx('settings.a11y.default', 'Padrão')}` : `${px} pt`,
          }))}
          onChange={(v) => commitFont(Number(v))}
          testID="settings-a11y-text-size"
        />
        <SettingsSwitchRow
          title={tx('settings.a11y.bold', 'Texto em negrito')}
          subtitle={sys.bold ? sysHint : undefined}
          value={!!a11y.boldText}
          onValueChange={(v) => { setA11yTri('bold', !!v); if (v) feedback.selection(); }}
          testID="settings-a11y-bold"
        />
        <SettingsSwitchRow
          title={tx('settings.a11y.contrast', 'Aumentar contraste')}
          subtitle={sys.contrast ? sysHint : undefined}
          value={!!a11y.highContrast}
          onValueChange={(v) => setA11yTri('contrast', !!v)}
          testID="settings-a11y-contrast"
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
          : tx('settings.a11y.motionFooter', 'Reduzir movimento troca molas e deslizes por transições discretas. Reduzir transparência deixa barras e menus com fundo sólido. Áreas de toque maiores facilitam acertar botões pequenos.')}
      >
        <SettingsSwitchRow
          title={tx('settings.reduceMotion', 'Reduzir movimento')}
          value={reduceOn || getReduceMotionPreference() === 'on'}
          disabled={systemReduce}
          onValueChange={(v) => { setReduceMotionPreference(v ? 'on' : 'system'); refreshA11y(); }}
          testID="settings-reduce-motion"
        />
        <SettingsSwitchRow
          title={tx('settings.a11y.transparency', 'Reduzir transparência')}
          subtitle={sys.transparency ? sysHint : undefined}
          value={!!a11y.reduceTransparency}
          onValueChange={(v) => setA11yTri('transparency', !!v)}
          testID="settings-a11y-transparency"
        />
        <SettingsSwitchRow
          title={tx('settings.a11y.largeTargets', 'Áreas de toque maiores')}
          value={!!a11y.largeTargets}
          onValueChange={(v) => setA11yPref('largeTargets', !!v)}
          testID="settings-a11y-large-targets"
        />
        <SettingsSwitchRow
          title={tx('settings.hapticsTouch', 'Vibração ao tocar')}
          value={hapticsOn}
          onValueChange={(v) => { setHapticsEnabled(v); if (v) feedback.selection(); }}
          testID="settings-haptics"
        />
      </SettingsGroup>

      <SettingsGroup
        header={tx('settings.a11y.chatsHeader', 'Conversas')}
        footer={tx('settings.a11y.chatsFooter', 'Legendas: as notas de voz recebidas são transcritas sozinhas e o texto aparece embaixo do áudio. Confirmações com forma: lida aparece com traço grosso e entregue com traço fino, sem depender só da cor.')}
      >
        <SettingsSwitchRow
          title={tx('settings.a11y.voiceCaptions', 'Legendas nas notas de voz')}
          value={!!a11y.autoTranscribe}
          onValueChange={(v) => setA11yPref('autoTranscribe', !!v)}
          testID="settings-a11y-voice-captions"
        />
        <SettingsSwitchRow
          title={tx('settings.a11y.shapeTicks', 'Confirmações de leitura com forma')}
          value={!!a11y.shapeTicks}
          onValueChange={(v) => setA11yPref('shapeTicks', !!v)}
          testID="settings-a11y-shape-ticks"
        />
      </SettingsGroup>
    </View>
  );
}
