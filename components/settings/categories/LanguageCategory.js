// [2026-10-15 settings-split] Categoria "Idioma": seguir o idioma do
// sistema, idioma do app (sheet) e moeda ("Automático" = pela região).
import { useState } from 'react';
import { View } from 'react-native';
import { useLanguage } from '../../../context/LanguageContext';
import { useCurrency } from '../../../context/CurrencyContext';
import { SELECTABLE_LOCALES, LANGUAGES as I18N_LANGUAGES } from '../../../i18n';
import { SettingsGroup, SettingsSwitchRow, SettingsPickerRow } from '../SettingsKit';
import { useSettingsHost, useSettingsBlob, useLocalKeys, setStorage, removeStorage } from './shared';

export function languageOptions() {
  return SELECTABLE_LOCALES.map((code) => ({
    value: code,
    label: (I18N_LANGUAGES.find((l) => l.code === code) || {}).label || code,
  }));
}

export default function LanguageCategory() {
  const { t, language, changeLanguage } = useLanguage();
  const { currency, setCurrency, resetCurrency, autoDetected, supported, symbols } = useCurrency();
  const { registerAnchor } = useSettingsHost();
  const { setSettings } = useSettingsBlob();
  const [auto, setAuto] = useState(false);
  useLocalKeys(['language_auto'], (kv) => { if (kv.language_auto === 'true') setAuto(true); });
  const currencyName = (code) => {
    const k = 'settings.currency.' + code;
    const v = t(k);
    return v && v !== k ? v : code;
  };
  return (
    <View ref={registerAnchor('language')}>
      <SettingsGroup header={t('settings.language')}>
        <SettingsSwitchRow
          title={t('settings.language.autoDetect') || 'Seguir idioma do sistema'}
          subtitle={t('settings.language.autoDetectDesc') || 'Detecta o idioma a partir do seu aparelho.'}
          value={auto}
          onValueChange={(v) => {
            setAuto(v);
            setStorage('language_auto', String(v));
            // Ligado: apaga a escolha manual → no próximo início vale o aparelho.
            if (v) removeStorage('app_language_manual');
          }}
        />
        <SettingsPickerRow
          title={t('settings.languageLabel')}
          value={language}
          disabled={auto}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={languageOptions()}
          displayValue={(I18N_LANGUAGES.find(o => o.code === language) || {}).label || String(language || '').toUpperCase()}
          onChange={(v) => {
            if (auto) return;
            changeLanguage(v);
            setSettings(prev => ({ ...prev, language: v }));
          }}
        />
      </SettingsGroup>
      <SettingsGroup footer={t('settings.currencyDesc') || 'Usada para exibir valores no app.'}>
        <SettingsPickerRow
          title={t('settings.currencyLabel') || 'Moeda'}
          value={autoDetected ? '__auto__' : currency}
          displayValue={autoDetected
            ? `${t('settings.rd.auto') || 'Automático'} · ${currency}`
            : `${symbols[currency] || ''} ${currency}`.trim()}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={[
            { value: '__auto__', label: t('settings.rd.auto') || 'Automático', sub: (t('settings.rd.currencyAutoSub') || 'Pela região do aparelho') + ` · ${currency}` },
            ...supported.map(code => ({ value: code, label: currencyName(code), hint: `${symbols[code] || ''} ${code}`.trim() })),
          ]}
          onChange={(v) => {
            if (v === '__auto__') { try { resetCurrency?.(); } catch {} }
            else setCurrency(v);
          }}
        />
      </SettingsGroup>
    </View>
  );
}
