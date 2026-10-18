// [2026-10-15 settings-split] Categoria "E-mail": envio, caixa de entrada,
// notificações de e-mail (+ Não perturbe), assinaturas, ferramentas,
// resposta automática, filtros, IA, leitura e encaminhamento.
// Blob get_settings com auto-save (useSettingsBlob); DND = 'notif';
// resposta automática = 'vacation' (debounce 500 ms, grava ao sair).
import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import * as settingsCache from '../../../services/settingsCache';
import FilterRuleEditor from '../../FilterRuleEditor';
import { IconMessageSquare, IconPenTool, IconDraft, IconSparkles, IconTrash, IconPlus } from '../../Icons';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, useGroupedColors } from '../SettingsKit';
import { getBlockRemoteDefault, setBlockRemoteDefault } from '../../../services/emailImagePolicy';
import { isNativeEmailBodyOn } from '../../email/NativeEmailBody';
import {
  useSettingsHost, useSettingsBlob, useSection, useLocalKeys, setStorage, OPEN_TTL, catStyles,
} from './shared';
import BiaIcon from '../../bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export default function EmailCategory() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const router = useRouter();
  const { registerAnchor } = useSettingsHost();
  const { settings, setSettings } = useSettingsBlob();
  const [showFilters, setShowFilters] = useState(false);
  const [filtersMounted, setFiltersMounted] = useState(false);

  // Preferências do aparelho.
  const [undoDelay, setUndoDelay] = useState(5);
  const [smartCompose, setSmartCompose] = useState(true);
  const [ai, setAi] = useState({ ai_smart_reply: true, ai_summary: true, ai_enhance: true });
  // [2026-10-15 native-email] Privacidade: abrir e-mails com imagens remotas bloqueadas.
  const [blockImages, setBlockImages] = useState(() => getBlockRemoteDefault());
  useLocalKeys(['undo_send_delay', 'smart_compose', 'ai_smart_reply', 'ai_summary', 'ai_enhance'], (kv) => {
    const d = kv.undo_send_delay;
    if (d != null && d !== '' && !isNaN(parseInt(d, 10))) setUndoDelay(Math.max(0, parseInt(d, 10)));
    if (kv.smart_compose === 'false') setSmartCompose(false);
    setAi(prev => {
      const next = { ...prev };
      for (const k of ['ai_smart_reply', 'ai_summary', 'ai_enhance']) if (kv[k] === 'false') next[k] = false;
      return next;
    });
  });
  const setAiFlag = (k, v) => { setAi(prev => ({ ...prev, [k]: !!v })); setStorage(k, v ? 'true' : 'false'); };

  // Não perturbe (chat_user_notif_prefs — o mesmo do gate de push).
  const notif = useSection('notif');
  const dndEnabled = !!(notif && notif.dnd_enabled);
  const dndStart = (notif && notif.dnd_start_time) || '22:00';
  const dndEnd = (notif && notif.dnd_end_time) || '07:00';
  const [startDraft, setStartDraft] = useState(dndStart);
  const [endDraft, setEndDraft] = useState(dndEnd);
  useEffect(() => { setStartDraft(dndStart); }, [dndStart]);
  useEffect(() => { setEndDraft(dndEnd); }, [dndEnd]);
  const [dndSaving, setDndSaving] = useState(false);
  const saveDnd = async (patch) => {
    const body = {
      dnd_enabled: patch.enabled !== undefined ? !!patch.enabled : dndEnabled,
      dnd_start_time: patch.start_time || dndStart,
      dnd_end_time: patch.end_time || dndEnd,
    };
    setDndSaving(true);
    try {
      const res = await settingsCache.commit('notif', { patch: body, action: 'chat_user_notif_prefs_set', params: body });
      if (res && res.ok === false) settingsCache.notifySaveFailed(t);
    } catch {}
    setDndSaving(false);
  };

  const baseSigs = () => [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
  const sigList = settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }];

  return (
    <View>
      <SettingsGroup header={t('settings.rd.sending') || 'Envio'} footer={t('settings.undoSendDesc')}>
        <SettingsPickerRow
          title={t('settings.undoSend')}
          value={undoDelay}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          options={[0, 5, 10, 15, 30].map(n => ({
            value: n,
            label: n === 0 ? (t('settings.undoSendOff') || 'Desligado') : t('settings.undoSendSeconds', { n }),
          }))}
          onChange={(n) => { setUndoDelay(n); setStorage('undo_send_delay', String(n)); }}
        />
      </SettingsGroup>

      <SettingsGroup header={t('settings.rd.inbox') || 'Caixa de entrada'}>
        <SettingsPickerRow
          title={t('settings.perPage')}
          value={settings.emails_per_page}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          sheetMessage={t('settings.perPageDesc')}
          options={[20, 50, 100].map(n => ({ value: n, label: String(n) }))}
          onChange={(n) => setSettings(prev => ({ ...prev, emails_per_page: n }))}
        />
        {(Platform.OS === 'web' || isNativeEmailBodyOn()) && <SettingsSwitchRow
          title={t('settings.blockRemoteImages') || 'Bloquear imagens remotas'}
          subtitle={t('settings.blockRemoteImagesDesc') || 'Impede que o remetente saiba quando você abriu. Toque em "Carregar imagens" no e-mail quando quiser ver.'}
          value={blockImages}
          onValueChange={(v) => { setBlockImages(!!v); setBlockRemoteDefault(!!v); }}
        />}
      </SettingsGroup>

      <View ref={registerAnchor('notifications')}>
        <SettingsGroup header={t('settings.rd.emailNotifs') || 'Notificações de email'}>
          <SettingsSwitchRow
            title={t('settings.notifications')}
            subtitle={t('settings.notificationsDesc')}
            value={settings.notifications}
            onValueChange={(v) => setSettings(prev => ({ ...prev, notifications: v }))}
          />
          {settings.notifications && (
            <SettingsRow
              title={t('settings.rd.advancedNotifs') || 'Notificações avançadas'}
              subtitle={t('settings.rd.advancedNotifsDesc') || 'Só menções, palavras-chave, soneca…'}
              onPress={() => router.push('/notification-preferences')}
            />
          )}
          {settings.notifications && (
            <SettingsSwitchRow title={t('settings.notifSound')} value={settings.notification_sound} onValueChange={(v) => setSettings(prev => ({ ...prev, notification_sound: v }))} />
          )}
          {settings.notifications && (
            <SettingsSwitchRow title={t('settings.notifVibration')} value={settings.notification_vibration} onValueChange={(v) => setSettings(prev => ({ ...prev, notification_vibration: v }))} />
          )}
          {settings.notifications && (
            <SettingsSwitchRow
              title={t('settings.dndTitle') || 'Não perturbe (horário)'}
              subtitle={t('settings.dndDesc') || 'Silencia notificações de chat dentro do horário definido.'}
              value={dndEnabled}
              onValueChange={(v) => saveDnd({ enabled: v })}
              disabled={dndSaving}
            />
          )}
          {settings.notifications && dndEnabled && (
            <SettingsRow
              title={t('settings.dndStart') || 'Início'}
              right={(
                <TextInput
                  value={startDraft}
                  onChangeText={setStartDraft}
                  onBlur={() => { const v = (startDraft || '').trim(); if (TIME_RE.test(v)) saveDnd({ start_time: v }); else setStartDraft('22:00'); }}
                  placeholder="22:00"
                  placeholderTextColor={gc.secondary}
                  style={[catStyles.timeInput, { color: colors.text, backgroundColor: gc.fill }]}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  accessibilityLabel={t('settings.dndStart') || 'Início'}
                />
              )}
            />
          )}
          {settings.notifications && dndEnabled && (
            <SettingsRow
              title={t('settings.dndEnd') || 'Fim'}
              right={(
                <TextInput
                  value={endDraft}
                  onChangeText={setEndDraft}
                  onBlur={() => { const v = (endDraft || '').trim(); if (TIME_RE.test(v)) saveDnd({ end_time: v }); else setEndDraft('07:00'); }}
                  placeholder="07:00"
                  placeholderTextColor={gc.secondary}
                  style={[catStyles.timeInput, { color: colors.text, backgroundColor: gc.fill }]}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  accessibilityLabel={t('settings.dndEnd') || 'Fim'}
                />
              )}
            />
          )}
        </SettingsGroup>
      </View>

      <SettingsGroup header={t('settings.signatures')} footer={t('settings.signatureDesc')}>
        {sigList.map((sig, idx) => (
          <View key={`sig-${idx}`} style={st.sigBlock}>
            <View style={st.sigHeader}>
              <TextInput
                style={[st.sigNameInput, { color: colors.text }]}
                value={sig.name}
                onChangeText={(v) => { const sigs = baseSigs(); sigs[idx] = { ...sigs[idx], name: v }; setSettings(prev => ({ ...prev, signatures: sigs })); }}
                placeholder={t('settings.signatureName')}
                placeholderTextColor={gc.secondary}
              />
              <TouchableOpacity
                onPress={() => { const sigs = baseSigs(); sigs.forEach((x, i) => { x.isDefault = i === idx; }); setSettings(prev => ({ ...prev, signatures: sigs })); }}
                style={[st.defaultBtn, sig.isDefault ? { backgroundColor: gc.ink } : { backgroundColor: gc.fill }]}
                accessibilityRole="button"
                accessibilityState={{ selected: !!sig.isDefault }}
                accessibilityLabel={t('settings.signatureDefault')}
              >
                <Text style={{ fontSize: 12, color: sig.isDefault ? gc.onInk : gc.secondary, fontWeight: '600' }}>{t('settings.signatureDefault')}</Text>
              </TouchableOpacity>
              {(settings.signatures || []).length > 1 && (
                <TouchableOpacity
                  onPress={() => {
                    const sigs = (settings.signatures || []).filter((_, i) => i !== idx);
                    if (sig.isDefault && sigs.length > 0) sigs[0].isDefault = true;
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.delete') || 'Excluir'}
                  style={{ marginLeft: 10 }}
                >
                  <IconTrash size={18} color={colors.error} />
                </TouchableOpacity>
              )}
            </View>
            <TextInput
              style={[st.signatureInput, { color: colors.text, backgroundColor: gc.fill }]}
              value={sig.content}
              onChangeText={(v) => {
                const sigs = baseSigs();
                sigs[idx] = { ...sigs[idx], content: v };
                setSettings(prev => ({ ...prev, signatures: sigs, signature: sigs.find(x => x.isDefault)?.content || '' }));
              }}
              placeholder={t('settings.signaturePlaceholder')}
              placeholderTextColor={gc.secondary}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>
        ))}
        <SettingsRow
          icon={IconPlus}
          iconTile={false}
          title={t('settings.addSignature')}
          chevron={false}
          onPress={() => { const sigs = baseSigs(); sigs.push({ name: '', content: '', isDefault: false }); setSettings(prev => ({ ...prev, signatures: sigs })); }}
        />
      </SettingsGroup>

      <SettingsGroup header={t('settings.emailToolsTitle') || 'Ferramentas de email'}>
        <SettingsRow title={t('settings.importFromOthers') || 'Importar de outras contas'} subtitle={t('settings.importFromOthersDesc2')} onPress={() => router.push('/email-import')} />
        <SettingsRow title={t('settings.pgpKeys') || 'Chave PGP'} subtitle={t('settings.pgpKeysDesc') || 'Criptografia ponta-a-ponta de emails'} onPress={() => router.push('/pgp-keys')} />
        <SettingsRow title={t('settings.tasks') || 'Tarefas'} subtitle={t('settings.tasksDesc') || 'Tarefas pessoais e convertidas de emails'} onPress={() => router.push('/tasks')} />
        <SettingsRow title={t('settings.bia') || 'Bia — Assistente de IA'} subtitle={t('settings.biaDesc') || 'Ensine seu tom e assinatura pra ela escrever na sua voz'} onPress={() => router.push('/bia-settings')} />
      </SettingsGroup>

      <View ref={registerAnchor('vacation')}>
        <AutoReplyGroup />
      </View>

      <SettingsGroup header={t('settings.filters')} footer={t('settings.filtersDesc')}>
        <SettingsRow title={t('settings.manageFilters')} subtitle={t('settings.manageFiltersDesc')} onPress={() => { setFiltersMounted(true); setShowFilters(true); }} />
      </SettingsGroup>

      <SettingsGroup header={t('settings.ai')} footer={t('settings.aiDesc')}>
        <SettingsSwitchRow icon={IconMessageSquare} iconTile={false} title={t('settings.smartReply')} subtitle={t('settings.smartReplyDesc')} value={ai.ai_smart_reply} onValueChange={(v) => setAiFlag('ai_smart_reply', v)} />
        <SettingsRow icon={IconPenTool} iconTile={false} title={t('settings.aiDrafts')} />
        <SettingsSwitchRow icon={IconDraft} iconTile={false} title={t('settings.aiSummary')} subtitle={t('settings.aiSummaryDesc')} value={ai.ai_summary} onValueChange={(v) => setAiFlag('ai_summary', v)} />
        <SettingsSwitchRow icon={BiaIcon} iconTile={false} title={t('settings.aiEnhance')} subtitle={t('settings.aiEnhanceDesc')} value={ai.ai_enhance} onValueChange={(v) => setAiFlag('ai_enhance', v)} />
        <SettingsSwitchRow
          title={t('settings.smartCompose')}
          subtitle={t('settings.smartComposeDesc')}
          value={smartCompose}
          onValueChange={(next) => { setSmartCompose(next); setStorage('smart_compose', String(next)); }}
        />
      </SettingsGroup>

      <SettingsGroup header={t('settings.reading')} footer={t('settings.emailReadReceiptsDesc')}>
        <SettingsSwitchRow title={t('settings.emailReadReceipts')} value={!!settings.read_receipts} onValueChange={(v) => setSettings(prev => ({ ...prev, read_receipts: !!v }))} />
      </SettingsGroup>

      <View ref={registerAnchor('forwarding')}>
        <SettingsGroup header={t('settings.forwarding')} footer={t('settings.forwardingDesc')}>
          <SettingsSwitchRow title={t('settings.forwardingEnable')} value={settings.forwarding_enabled} onValueChange={(v) => setSettings(prev => ({ ...prev, forwarding_enabled: v }))} />
          {settings.forwarding_enabled && (
            <View style={catStyles.cardInputWrap}>
              <TextInput
                style={[catStyles.cardInput, { color: colors.text, backgroundColor: gc.fill }]}
                value={settings.forwarding_email}
                onChangeText={(v) => setSettings(prev => ({ ...prev, forwarding_email: v }))}
                placeholder={t('settings.forwardingPlaceholder')}
                placeholderTextColor={gc.secondary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}
        </SettingsGroup>
      </View>

      {filtersMounted && <FilterRuleEditor visible={showFilters} onClose={() => setShowFilters(false)} />}
    </View>
  );
}

// Resposta automática (vacation_get/set). Rascunho local: o eco do servidor
// não apaga o que a pessoa digita; salva 500 ms após parar (e ao sair).
function _vacationFrom(d) {
  return {
    enabled: !!d.enabled,
    subject: d.subject || '',
    body: d.body || '',
    start_date: d.start_date || null,
    end_date: d.end_date || null,
  };
}
function AutoReplyGroup() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const [vacation, setVacation] = useState(() => {
    const c = settingsCache.peek('vacation');
    return c && typeof c === 'object' ? _vacationFrom(c) : { enabled: false, subject: '', body: '', start_date: null, end_date: null };
  });
  const latest = useRef(vacation);
  latest.current = vacation;
  const timer = useRef(null);
  const flush = useCallback(() => {
    const next = latest.current;
    const body = { enabled: next.enabled, subject: next.subject, body: next.body, start_date: next.start_date, end_date: next.end_date, only_contacts: false };
    settingsCache.commit('vacation', { patch: body, action: 'vacation_set', params: body })
      .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); })
      .catch(() => {});
  }, [t]);
  useEffect(() => {
    const un = settingsCache.subscribe('vacation', (d) => {
      if (!d || typeof d !== 'object' || timer.current) return;
      setVacation(_vacationFrom(d));
    });
    settingsCache.revalidate('vacation', { ttl: OPEN_TTL }).catch(() => {});
    return () => {
      un();
      if (timer.current) { clearTimeout(timer.current); timer.current = null; flush(); }
    };
  }, [flush]);
  const save = (patch) => {
    setVacation(prev => {
      const next = { ...prev, ...patch };
      latest.current = next;
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; flush(); }, 500);
  };
  return (
    <SettingsGroup header={t('settings.autoReply')} footer={t('settings.autoReplyDesc')}>
      <SettingsSwitchRow title={t('settings.autoReplyEnable')} value={vacation.enabled} onValueChange={(v) => save({ enabled: v })} />
      {vacation.enabled && (
        <View style={catStyles.cardInputWrap}>
          <TextInput
            style={[catStyles.cardInput, { color: colors.text, backgroundColor: gc.fill }]}
            value={vacation.subject}
            onChangeText={(v) => save({ subject: v })}
            placeholder={t('settings.autoReplySubjectPlaceholder') || 'Assunto (opcional)'}
            placeholderTextColor={gc.secondary}
          />
          <TextInput
            style={[catStyles.cardInput, { color: colors.text, backgroundColor: gc.fill, minHeight: 88, marginTop: 8 }]}
            value={vacation.body}
            onChangeText={(v) => save({ body: v })}
            placeholder={t('settings.autoReplyPlaceholder')}
            placeholderTextColor={gc.secondary}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </View>
      )}
    </SettingsGroup>
  );
}

const st = StyleSheet.create({
  sigBlock: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14 },
  sigHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sigNameInput: {
    flex: 1, fontSize: 16, fontWeight: '600', paddingVertical: 4,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  defaultBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  signatureInput: {
    borderRadius: 10, marginTop: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, lineHeight: 20,
    minHeight: 72, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
});
