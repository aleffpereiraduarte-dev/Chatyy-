// [2026-10-15 settings-split] Categoria "Conversas": backup (tema/cor/papel de
// parede/balões → Aparência desde 2026-10-18), digitação, mensagens, importar do WhatsApp,
// palavras silenciadas, economia de dados e recursos beta. Preferências do
// aparelho (mesmas chaves locais lidas pelo chat) + settingsCache 'muted_words'.
import { useState, useCallback, useSyncExternalStore } from 'react';
import { View, Text, TextInput, TouchableOpacity, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import * as api from '../../../services/api';
import * as settingsCache from '../../../services/settingsCache';
import { IconDownload, IconTrash, IconPlus } from '../../Icons';
import { useConfirm } from '../../ConfirmModal';
import { useSettingsCollector } from '../nativeCollect'; // [2026-10-18 settings-sub-native-2]
import SettingsFormSheet, { FormCard } from '../SettingsFormSheet';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsCardContent, useGroupedColors } from '../SettingsKit';
import { useSafeNav, useSettingsHost, useLocalKeys, setStorage, useSection, catStyles as s } from './shared';
import * as mediaVis from '../../../services/mediaVisibility';

// [2026-10-16 wave10-D compiler] Economia de dados do SISTEMA (iOS Modo Dados
// Reduzidos / Android Data Saver) é estado de módulo: lido direto no render, o
// React Compiler memoizava o 1º valor (bloco sentinela) e o subtítulo não mudava.
// Agora entra por useSyncExternalStore (subscribe/getSnapshot do serviço).
function _sysDsSubscribe(cb) {
  try { return require('../../../services/systemIntegration').onSystemDataSaverChange(() => cb()); } catch { return () => {}; }
}
function _sysDsSnapshot() {
  try { return !!require('../../../services/systemIntegration').isSystemDataSaverOn(); } catch { return false; }
}
function _sysDsServer() { return false; }

const LOCAL_KEYS = ['enter_sends', 'autocorrect_enabled', 'double_tap_react', 'voice_speed_default', 'bubble_shape', 'data_saver', 'beta_features'];

export default function ChatsCategory() {
  const { colors, isDark, themeMode, setThemeMode } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const safeNav = useSafeNav();
  const { registerAnchor } = useSettingsHost();

  const [prefs, setPrefs] = useState({
    enterSends: Platform.OS === 'web', autocorrect: true, doubleTap: true, voiceSpeed: 1, bubble: 'rounded', dataSaver: false, beta: false,
  });
  useLocalKeys(LOCAL_KEYS, (kv) => {
    const vs = parseFloat(kv.voice_speed_default);
    setPrefs({
      enterSends: kv.enter_sends === 'true' ? true : kv.enter_sends === 'false' ? false : Platform.OS === 'web',
      autocorrect: kv.autocorrect_enabled !== 'false',
      doubleTap: kv.double_tap_react !== 'false',
      voiceSpeed: Number.isFinite(vs) && [0.5, 1, 1.5, 2].includes(vs) ? vs : 1,
      bubble: ['rounded', 'square', 'classic'].includes(kv.bubble_shape) ? kv.bubble_shape : 'rounded',
      dataSaver: kv.data_saver === 'true',
      beta: kv.beta_features === 'true',
    });
  });
  const setPref = (k, storageKey, v) => { setPrefs(p => ({ ...p, [k]: v })); setStorage(storageKey, String(v)); };

  const sysDataSaver = useSyncExternalStore(_sysDsSubscribe, _sysDsSnapshot, _sysDsServer);

  return (
    <View>
      {/* [2026-10-18 me-merge] Tema, cor de destaque, papel de parede e estilo dos
          balões foram para a categoria Aparência (AppearanceCategory.js). */}
      <SettingsGroup>
        <SettingsRow title={t('sidebar.backup')} subtitle={t('settings.backupSub')} onPress={() => safeNav('/backup')} />
      </SettingsGroup>

      {Platform.OS !== 'web' && (
        <View ref={registerAnchor('mediaVisibility')}>
          <MediaVisibilityGroup />
        </View>
      )}

      <SettingsGroup header={t('settings.rd2.typing') || 'Digitação'}>
        <SettingsSwitchRow
          title={t('settings.enterSends.title') || 'Enter envia mensagem'}
          subtitle={t('settings.enterSends.subtitle') || 'Pressione Enter pra enviar. Shift+Enter quebra linha.'}
          value={prefs.enterSends}
          onValueChange={(v) => setPref('enterSends', 'enter_sends', v)}
        />
        <SettingsSwitchRow
          title={t('settings.autocorrect.title') || 'Auto-correção'}
          subtitle={t('settings.autocorrect.subtitle') || 'Corrige palavras automaticamente enquanto você digita.'}
          value={prefs.autocorrect}
          onValueChange={(v) => setPref('autocorrect', 'autocorrect_enabled', v)}
        />
      </SettingsGroup>
      <SettingsGroup header={t('settings.rd2.messages') || 'Mensagens'}>
        <SettingsSwitchRow
          title={t('settings.doubleTapReact.title') || 'Toque duplo para curtir'}
          subtitle={t('settings.doubleTapReact.subtitle') || 'Toque duas vezes numa mensagem para reagir com coração.'}
          value={prefs.doubleTap}
          onValueChange={(v) => setPref('doubleTap', 'double_tap_react', v)}
        />
        <SettingsPickerRow
          title={t('settings.voiceSpeed.title') || 'Velocidade padrão dos áudios'}
          value={prefs.voiceSpeed}
          sheetMessage={t('settings.voiceSpeed.subtitle') || 'Aplica a todos os áudios recebidos. Você pode trocar individual no chat.'}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={[
            { value: 0.5, label: t('settings.voiceSpeed.option_0_5') || '0.5×' },
            { value: 1, label: t('settings.voiceSpeed.option_1') || '1×' },
            { value: 1.5, label: t('settings.voiceSpeed.option_1_5') || '1.5×' },
            { value: 2, label: t('settings.voiceSpeed.option_2') || '2×' },
          ]}
          onChange={(v) => setPref('voiceSpeed', 'voice_speed_default', v)}
        />
      </SettingsGroup>

      <SettingsGroup header={t('waImport.settingsHeader')}>
        <SettingsRow icon={IconDownload} title={t('waImport.settingsRow')} subtitle={t('waImport.settingsRowSub')} onPress={() => router.push('/import-whatsapp')} />
      </SettingsGroup>

      <View ref={registerAnchor('mutedWords')}>
        <MutedWordsGroup />
      </View>

      <SettingsGroup header={t('settings.rd2.dataLabs') || 'Dados e recursos'}>
        <SettingsSwitchRow
          title={t('settings.dataSaver.title') || 'Modo economia de dados'}
          subtitle={sysDataSaver ? t('settings.dataSaver.systemActive') : (t('settings.dataSaver.subtitle') || 'Comprime mídia e reduz pré-carregamento de vídeos.')}
          value={prefs.dataSaver}
          onValueChange={(v) => setPref('dataSaver', 'data_saver', v)}
        />
        <SettingsSwitchRow
          title={t('settings.beta.title') || 'Recursos beta'}
          subtitle={t('settings.beta.subtitle') || 'Ative pra testar funcionalidades em desenvolvimento. Podem ter bugs.'}
          value={prefs.beta}
          onValueChange={(v) => setPref('beta', 'beta_features', v)}
        />
      </SettingsGroup>
    </View>
  );
}

// [2026-10-15 media-visibility] "Salvar na galeria" (WhatsApp: Visibilidade da
// mídia / Salvar no Rolo da Câmera) — global da CONTA, sincronizado
// (chat_settings.save_media_to_gallery). Cada conversa pode sobrescrever nos
// dados do contato/grupo. Lógica em services/mediaVisibility.
function MediaVisibilityGroup() {
  const { t } = useLanguage();
  // [2026-10-16 media-vis-compiler] O valor SAI do snapshot do hook: com o
  // React Compiler, `mv.isGlobalOn()` sem dependência reativa era memoizado no
  // 1º render → o interruptor nunca desligava (voltava para ligado).
  const snap = useSection('chat_settings');
  const on = mediaVis.isGlobalOnIn(snap);
  const title = Platform.OS === 'ios'
    ? (t('mediaVis.titleIos') || 'Salvar no Rolo da Câmera')
    : (t('mediaVis.title') || 'Salvar na galeria');
  return (
    <SettingsGroup footer={t('mediaVis.settingsDesc') || 'Fotos e vídeos recebidos que você baixar também aparecem no app Fotos do celular, no álbum Chatyy. Desligado, ficam só no Chatyy. Dá para mudar por conversa nos dados do contato ou do grupo.'}>
      <SettingsSwitchRow
        title={title}
        value={on}
        onValueChange={(v) => {
          mediaVis.setGlobal(v).then((r) => { if (r && r.ok === false && r.r) settingsCache.notifySaveFailed(t); }).catch(() => {});
        }}
      />
    </SettingsGroup>
  );
}

// Palavras silenciadas do feed (feed_muted_words_*). Lista = snapshot
// 'muted_words' (otimista; desfaz se o servidor recusar).
function MutedWordsGroup() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const data = useSection('muted_words');
  const words = Array.isArray(data) ? data : [];
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const putList = (fn) => { try { const c = settingsCache.peek('muted_words'); settingsCache.put('muted_words', fn(Array.isArray(c) ? c : [])); } catch {} };

  const add = useCallback(async () => {
    const w = input.trim().toLowerCase();
    if (!w || words.includes(w)) { setInput(''); return; }
    setLoading(true);
    putList(list => [w, ...list.filter(x => x !== w)]);
    setInput('');
    try {
      const r = await api.feedMutedWordsAdd(w);
      if (!r?.success) { putList(list => list.filter(x => x !== w)); settingsCache.notifySaveFailed(t); }
    } catch {
      putList(list => list.filter(x => x !== w));
      settingsCache.notifySaveFailed(t);
    } finally {
      setLoading(false);
    }
  }, [input, words, t]);

  const remove = useCallback(async (word) => {
    const before = settingsCache.peek('muted_words');
    putList(list => list.filter(x => x !== word));
    try {
      const r = await api.feedMutedWordsRemove(word);
      if (r?.success === false && Array.isArray(before)) settingsCache.put('muted_words', before);
    } catch {}
  }, []);

  const disabled = loading || !input.trim();

  // [2026-10-18 settings-sub-native-2] Lista nativa: "Adicionar palavra" abre
  // uma folha com o MESMO campo/botão; cada palavra é uma linha com "Remover"
  // em vermelho (toque → confirma → mesma remoção da lixeira da tela JS).
  const collecting = !!useSettingsCollector();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  if (collecting) {
    const removeLabel = t('common.remove') || 'Remover';
    return (
      <>
        <SettingsGroup header={t('settings.mutedWords') || 'Palavras silenciadas'} footer={t('settings.mutedWordsDesc') || 'Posts cujo texto contenha qualquer dessas palavras não aparecem no seu feed.'}>
          <SettingsRow
            icon={IconPlus}
            title={String(t('settings.mutedWordsAdd') || 'Adicionar palavra').replace(/[.…]+$/, '')}
            chevron={false}
            native={{ acc: loading ? 's' : 'n' }}
            onPress={() => { setInput(''); setAddOpen(true); }}
          />
          {words.length === 0 ? (
            <SettingsRow title={t('settings.mutedWordsEmpty') || 'Nenhuma palavra silenciada ainda.'} />
          ) : words.map(w => (
            <SettingsRow
              key={w}
              title={w}
              native={{ val: removeLabel, acc: 'n', vd: true }}
              onPress={async () => {
                const ok = await confirm({
                  title: (t('settings.nat.mutedWordRemoveTitle') || 'Remover "{w}"?').replace('{w}', w),
                  message: t('settings.nat.mutedWordRemoveMsg') || 'Posts com essa palavra voltam a aparecer no seu feed.',
                  confirmLabel: removeLabel,
                  destructive: true,
                });
                if (ok) remove(w);
              }}
            />
          ))}
        </SettingsGroup>
        <SettingsFormSheet visible={addOpen} onClose={() => setAddOpen(false)} title={t('settings.mutedWords') || 'Palavras silenciadas'} doneLabel={t('common.cancel') || 'Cancelar'} testID="muted-word-sheet">
          <FormCard style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              defaultValue=""
              onChangeText={setInput}
              placeholder={t('settings.mutedWordsAdd') || 'Adicionar palavra…'}
              placeholderTextColor={gc.secondary}
              onSubmitEditing={() => { if (input.trim()) { add(); setAddOpen(false); } }}
              returnKeyType="done"
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              style={[s.cardInput, { flex: 1, color: colors.text, backgroundColor: gc.fill }]}
              accessibilityLabel={t('settings.mutedWordsAdd') || 'Adicionar palavra'}
            />
            <TouchableOpacity
              onPress={() => { add(); setAddOpen(false); }}
              disabled={disabled}
              style={[s.inkBtn, { backgroundColor: gc.ink, opacity: disabled ? 0.35 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={t('common.add') || 'Adicionar'}
            >
              <Text style={[s.inkBtnText, { color: gc.onInk }]}>{t('common.add') || 'Adicionar'}</Text>
            </TouchableOpacity>
          </FormCard>
        </SettingsFormSheet>
      </>
    );
  }
  return (
    <SettingsGroup header={t('settings.mutedWords') || 'Palavras silenciadas'} footer={t('settings.mutedWordsDesc') || 'Posts cujo texto contenha qualquer dessas palavras não aparecem no seu feed.'}>
      <View style={[s.cardInputWrap, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={t('settings.mutedWordsAdd') || 'Adicionar palavra…'}
          placeholderTextColor={gc.secondary}
          onSubmitEditing={add}
          returnKeyType="done"
          autoCorrect={false}
          autoCapitalize="none"
          style={[s.cardInput, { flex: 1, color: colors.text, backgroundColor: gc.fill }]}
          accessibilityLabel={t('settings.mutedWordsAdd') || 'Adicionar palavra'}
        />
        <TouchableOpacity
          onPress={add}
          disabled={disabled}
          style={[s.inkBtn, { backgroundColor: gc.ink, opacity: disabled ? 0.35 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={t('common.add') || 'Adicionar'}
        >
          <Text style={[s.inkBtnText, { color: gc.onInk }]}>{t('common.add') || 'Adicionar'}</Text>
        </TouchableOpacity>
      </View>
      {words.length === 0 ? (
        <SettingsRow title={t('settings.mutedWordsEmpty') || 'Nenhuma palavra silenciada ainda.'} titleStyle={{ color: gc.secondary, fontSize: 15 }} />
      ) : words.map(w => (
        <SettingsRow
          key={w}
          title={w}
          right={(
            <TouchableOpacity
              onPress={() => remove(w)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={(t('settings.mutedWordsRemove') || 'Remover {w}').replace('{w}', w)}
            >
              <IconTrash size={18} color={gc.destructive} />
            </TouchableOpacity>
          )}
        />
      ))}
    </SettingsGroup>
  );
}
