// [2026-10-15 settings-split] Categoria "Idioma": idioma do app (seletor com
// busca + "Idioma do sistema") e moeda ("Automático" = pela região).
//
// [2026-10-16 wave12f-idiomas] Seletor próprio (sheet grande): campo de busca
// (nome nativo, nome no idioma atual, nome em inglês ou código), cada linha
// mostra o nome NATIVO + o nome no idioma da UI ("Русский · Russo"), check no
// atual, e a 1ª linha "Seguir idioma do sistema" (antes era um switch à parte
// que só valia no próximo início — agora aplica na hora o idioma do aparelho).
import { useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, Modal, Pressable, Platform, NativeModules, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../../context/LanguageContext';
import { useCurrency } from '../../../context/CurrencyContext';
import { SELECTABLE_LOCALES, LANGUAGES as I18N_LANGUAGES, languageDisplayName, isLocaleSupported } from '../../../i18n';
import { SettingsGroup, SettingsPickerRow, SettingsRow, useGroupedColors } from '../SettingsKit';
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad } from '../../NativeSheet';
import { IconSearch, IconX } from '../../Icons';
import { useSettingsHost, useSettingsBlob, useLocalKeys, setStorage, removeStorage } from './shared';

export function languageOptions() {
  return SELECTABLE_LOCALES.map((code) => ({
    value: code,
    label: (I18N_LANGUAGES.find((l) => l.code === code) || {}).label || code,
  }));
}

const _entry = (code) => I18N_LANGUAGES.find((l) => l.code === code) || null;

// Idioma do APARELHO resolvido p/ um idioma selecionável (mesma leitura do
// LanguageContext: navegador / AppleLanguages / localeIdentifier). null = nenhum.
function deviceLanguage() {
  let tags = [];
  try {
    if (Platform.OS === 'web') {
      tags = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
    } else if (Platform.OS === 'ios') {
      const s = NativeModules.SettingsManager?.settings || {};
      tags = Array.isArray(s.AppleLanguages) && s.AppleLanguages.length ? s.AppleLanguages : (s.AppleLocale ? [s.AppleLocale] : []);
    } else {
      const l = NativeModules.I18nManager?.localeIdentifier;
      if (l) tags = [l];
    }
  } catch {}
  const sel = new Set(SELECTABLE_LOCALES);
  for (const raw of tags) {
    const tag = String(raw || '').replace(/_/g, '-');
    if (!tag) continue;
    const low = tag.toLowerCase();
    const prefix = low.split('-')[0];
    let code = null;
    if (prefix === 'pt') code = /-(pt|ao|mz|cv|gw|st|tl)\b/.test(low) ? 'pt-PT' : 'pt-BR';
    else if (prefix === 'zh') code = 'zh-CN';
    else if (prefix === 'no' || prefix === 'nn') code = 'nb';
    else if (prefix === 'iw') code = 'he';
    else if (prefix === 'tl') code = 'fil';
    else code = SELECTABLE_LOCALES.find((c) => c.toLowerCase() === low) || SELECTABLE_LOCALES.find((c) => c.toLowerCase() === prefix) || null;
    if (code && sel.has(code) && isLocaleSupported(code)) return code;
  }
  return null;
}

// Busca sem acento/caixa.
const _norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function LanguagePickerSheet({ visible, onClose, language, auto, onPickSystem, onPick, t }) {
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const [q, setQ] = useState('');
  const sysCode = useMemo(() => deviceLanguage(), [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const all = SELECTABLE_LOCALES.map((code) => {
      const e = _entry(code) || { label: code };
      const local = languageDisplayName(code, language);
      return { code, native: e.label, local: local && local !== e.label ? local : '', hay: _norm([code, e.label, local, e.en, e.pt].join(' ')) };
    });
    // Atual primeiro; o resto em ordem alfabética pelo nome no idioma da UI.
    const coll = (a, b) => { try { return (a.local || a.native).localeCompare(b.local || b.native, language); } catch { return 0; } };
    const cur = all.filter((x) => x.code === language);
    const rest = all.filter((x) => x.code !== language).sort(coll);
    const list = [...cur, ...rest];
    const nq = _norm(q.trim());
    return nq ? list.filter((x) => x.hay.includes(nq)) : list;
  }, [language, q]);

  const close = () => { setQ(''); onClose?.(); };
  const sysName = sysCode ? `${(_entry(sysCode) || {}).label || sysCode}` : '';
  const title = t('settings.languageLabel');

  const header = (
    <View>
      <View style={st.head}>
        <Text style={[st.title, { color: g.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
        {!USE_NATIVE_SHEETS && (
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={22} color={g.secondary} />
          </Pressable>
        )}
      </View>
      <View style={[st.search, { backgroundColor: g.fill }]}>
        <IconSearch size={17} color={g.secondary} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={String(t('common.search') || '').replace(/[.…]+$/, '')}
          placeholderTextColor={g.secondary}
          style={[st.searchInput, { color: g.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel={t('common.search')}
          testID="language-search"
        />
      </View>
      {!q.trim() && (
        <View style={[st.card, { backgroundColor: g.cardBg }]}>
          <SettingsRow
            title={t('settings.language.autoDetect')}
            subtitle={sysName || t('settings.language.autoDetectDesc')}
            checked={!!auto}
            accessibilityRole="radio"
            onPress={() => { onPickSystem?.(sysCode); close(); }}
            testID="language-system"
          />
        </View>
      )}
    </View>
  );

  const renderItem = ({ item, index }) => {
    const first = index === 0;
    const last = index === items.length - 1;
    return (
      <View style={[{ backgroundColor: g.cardBg, marginHorizontal: 16 }, first && st.cardTop, last && st.cardBottom]}>
        {!first && <View style={[st.sep, { backgroundColor: g.separator }]} />}
        <SettingsRow
          title={item.native}
          subtitle={item.local || undefined}
          checked={!auto && item.code === language}
          accessibilityRole="radio"
          accessibilityLabel={item.local ? `${item.native}, ${item.local}` : item.native}
          onPress={() => { onPick?.(item.code); close(); }}
          testID={`language-${item.code}`}
        />
      </View>
    );
  };

  const list = (
    <FlatList
      data={items}
      keyExtractor={(x) => x.code}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={<Text style={[st.empty, { color: g.secondary }]}>{t('common.noResults')}</Text>}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: USE_NATIVE_SHEETS ? nativeSheetBottomPad(insets, 16) : Math.max(insets.bottom, 16) + 8 }}
      initialNumToRender={24}
    />
  );

  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={close} detents={[1]} backgroundColor={g.pageBg}>
        {/* [2026-10-17 sheet-blank] minHeight = rede de segurança: se o contêiner do
            formSheet vier com altura do conteúdo (sem bottom), flex:1 daria 0 e o
            sheet ficaria vazio. Sheet [1] = detent grande (topo ~10 pt abaixo da safe area). */}
        <NativeSheetKeyboardView style={{ flex: 1, minHeight: Math.max(320, Math.round((win.height || 0) - (insets.top || 0) - 10 - (insets.bottom || 0))), paddingTop: 18, backgroundColor: g.pageBg }}>
          {list}
        </NativeSheetKeyboardView>
      </NativeSheet>
    );
  }
  return (
    <Modal
      visible={!!visible}
      onRequestClose={close}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} allowSwipeDismissal /* [2026-10-17 drag-dismiss] RN 0.83: sem isso o pageSheet NÃO desce interativo (modalInPresentation=YES) */
      transparent={Platform.OS === 'web'}
    >
      <View style={[st.webWrap, Platform.OS === 'web' && st.webBackdrop]}>
        <View style={[st.webPanel, { backgroundColor: g.pageBg, paddingTop: Platform.OS === 'android' ? insets.top + 12 : 18 }]}>
          {list}
        </View>
      </View>
    </Modal>
  );
}

export default function LanguageCategory() {
  const { t, language, changeLanguage } = useLanguage();
  const { currency, setCurrency, resetCurrency, autoDetected, supported, symbols } = useCurrency();
  const { registerAnchor } = useSettingsHost();
  const { setSettings } = useSettingsBlob();
  const [auto, setAuto] = useState(false);
  const [open, setOpen] = useState(false);
  useLocalKeys(['language_auto'], (kv) => { if (kv.language_auto === 'true') setAuto(true); });
  const currencyName = (code) => {
    const k = 'settings.currency.' + code;
    const v = t(k);
    return v && v !== k ? v : code;
  };
  const cur = _entry(language);
  const curLabel = (cur && cur.label) || String(language || '').toUpperCase();
  const pickSystem = (sysCode) => {
    setAuto(true);
    // Aplica já o idioma do aparelho (se for um dos oferecidos) e então limpa a
    // escolha manual → nos próximos inícios vale o aparelho.
    if (sysCode && sysCode !== language) {
      changeLanguage(sysCode);
      setSettings(prev => ({ ...prev, language: sysCode }));
    }
    setStorage('language_auto', 'true');
    removeStorage('app_language_manual');
  };
  const pick = (code) => {
    setAuto(false);
    setStorage('language_auto', 'false');
    if (code !== language) {
      changeLanguage(code);
      setSettings(prev => ({ ...prev, language: code }));
    }
  };
  return (
    <View ref={registerAnchor('language')}>
      <SettingsGroup header={t('settings.language')} footer={auto ? (t('settings.language.autoDetectDesc') || undefined) : undefined}>
        <SettingsRow
          title={t('settings.languageLabel')}
          value={auto ? `${t('settings.rd.auto') || 'Auto'} · ${curLabel}` : curLabel}
          chevron
          onPress={() => setOpen(true)}
          accessibilityLabel={`${t('settings.languageLabel')}, ${curLabel}`}
          testID="language-row"
        />
      </SettingsGroup>
      {open && (
        <LanguagePickerSheet
          visible={open}
          onClose={() => setOpen(false)}
          language={language}
          auto={auto}
          onPickSystem={pickSystem}
          onPick={pick}
          t={t}
        />
      )}
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

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', flex: 1 },
  search: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 16, borderRadius: 10, paddingHorizontal: 10, height: 38 },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 16, paddingVertical: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  // [2026-10-17 settings-wa] raio 18 = mesmo cartão do SettingsGroup (era 12 só aqui).
  card: { marginHorizontal: 16, marginBottom: 20, borderRadius: 18, overflow: 'hidden' },
  cardTop: { borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  cardBottom: { borderBottomLeftRadius: 18, borderBottomRightRadius: 18, overflow: 'hidden' },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  empty: { textAlign: 'center', paddingVertical: 32, fontSize: 15 },
  webWrap: { flex: 1 },
  webBackdrop: { backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  webPanel: { flex: 1, width: '100%', ...(Platform.OS === 'web' ? { maxWidth: 520, maxHeight: 720, borderRadius: 16, overflow: 'hidden' } : null) },
});
