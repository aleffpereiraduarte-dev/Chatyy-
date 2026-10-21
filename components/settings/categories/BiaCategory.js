// [2026-10-15 settings-split] Categoria "Bia": cabeçalho, ativar, canal de
// aviso (checkmark) e personalização (/bia-settings). Chaves locais
// one_enabled / one_notif_level.
//
// [2026-10-21 bia-ajustes] Ajustes COMPLETOS (founder: "muito simples, deixa bem
// mais completo"). Só opções com efeito real:
//   Sobre       orb + nome + descrição + "Conversar com a Bia"
//   Conversa    idioma (ai_memory language) · tamanho curta/normal/detalhada
//               (ai_memory reply_length; normal = apaga a chave) · tom (ai_memory tone)
//   Voz         voz da Bia (ai_memory voice — TTS/Realtime OpenAI) · velocidade das
//               respostas lidas (local, playbackRate) · Mãos livres (local: lê as
//               respostas em voz alta sozinha)
//   Memória     "A Bia aprende comigo" (bia_personalize) · Ver o que a Bia lembra
//               (/one-memory) · Apagar memória (one_memory_delete all)
//   Acesso      bia_data_access (servidor tira/bloqueia as ferramentas de leitura de
//               e-mail e conversas) + o que vale p/ e-mails/conversas/agenda/contatos
//   Frase do dia (local; cartão da lista + boas-vindas da Bia)
//   Notificações (as de antes) · Histórico (one_history_delete clear_all)
//   Privacidade "O que a Bia vê" + política · Nome, assinatura e estilo (/bia-settings)
// Tudo com linhas do kit (a lista nativa coleta; web = mesma tela JS).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import {
  IconMail, IconBell, IconPhone, IconGlobe, IconMessageCircle, IconSmile, IconVolume2, IconZap,
  IconEye, IconTrash, IconCalendar, IconUsers, IconShield, IconEdit, IconClock, IconFileText, IconMic,
} from '../../Icons';
import BiaIcon from '../../bia/BiaIcon';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, SettingsIconTile, useGroupedColors } from '../SettingsKit';
import { useLocalKeys, setStorage } from './shared';
import * as settingsCache from '../../../services/settingsCache';
import { aiMemoryGet, aiMemorySet, apiCall, oneHistoryDelete } from '../../../services/api';
import { setCache } from '../../../services/cache';
import { safeAlert } from '../../../services/alerts';
import { HapticsCompat as Haptics } from '../../../services/haptics';
import {
  BIA_TTS_RATES, biaTtsRate, setBiaTtsRate, biaAutoRead, setBiaAutoRead, biaDailyUserOn, setBiaDailyUserOn,
  BIA_VOICES, BIA_DEFAULT_VOICE, BIA_TONES, biaToneId,
} from '../../../services/biaPrefs';

const LANGS = ['auto', 'pt', 'en', 'es', 'fr', 'de', 'it'];
const LANG_NATIVE = { pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano' };
const LEN_RE = /,?\s*respostas (curtas|detalhadas)/i;

function lengthFrom(mem) {
  const rl = String(mem?.reply_length || '').toLowerCase();
  if (rl === 'short' || rl === 'detailed') return rl;
  const tone = String(mem?.tone || '').toLowerCase();
  if (tone.includes('respostas curtas')) return 'short';
  if (tone.includes('respostas detalhadas')) return 'detailed';
  return 'normal';
}

function rateLabel(r) { return `${String(r).replace('.', ',')}x`; }

export default function BiaCategory() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const gc = useGroupedColors();
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [level, setLevel] = useState('push');
  useLocalKeys(['one_enabled', 'one_notif_level'], (kv) => {
    if (kv.one_enabled === 'false') setEnabled(false);
    if (kv.one_notif_level) setLevel(kv.one_notif_level);
  });

  // ── preferências do servidor (ai_memory), abre na hora pelo cache ──
  const [mem, setMem] = useState(() => {
    const c = settingsCache.peek('bia_memory');
    return c && typeof c === 'object' ? c : {};
  });
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let alive = true;
    aiMemoryGet().then((r) => {
      const m = r?.success ? r.data?.memory : null;
      if (!alive || !m || typeof m !== 'object') return;
      setMem(m);
      try { settingsCache.put('bia_memory', m); } catch {}
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // ── preferências locais ──
  const [rate, setRate] = useState(() => biaTtsRate());
  const [handsFree, setHandsFree] = useState(() => biaAutoRead());
  const [dailyOn, setDailyOn] = useState(() => biaDailyUserOn());

  const failToast = useCallback(() => {
    safeAlert(t('biaSet.saveErrorTitle'), t('biaSet.saveError'), [{ text: t('common.ok') }]);
  }, [t]);

  // Grava 1 chave (otimista); devolve a memória nova ou null.
  const saveKey = useCallback(async (key, value, optimistic) => {
    const prev = mem;
    if (optimistic) setMem((m) => ({ ...m, ...optimistic }));
    try {
      const r = await aiMemorySet(key, value);
      if (!r?.success) throw new Error('fail');
      const m = r.data?.memory && typeof r.data.memory === 'object' ? r.data.memory : null;
      if (m) { setMem(m); try { settingsCache.put('bia_memory', m); } catch {} }
      try { Haptics.selectionAsync?.(); } catch {}
      return m || true;
    } catch {
      setMem(prev);
      failToast();
      return null;
    }
  }, [mem, failToast]);

  const langValue = (() => {
    const l = String(mem.language || '').toLowerCase().slice(0, 2);
    return LANGS.includes(l) ? l : 'auto';
  })();
  const lengthValue = lengthFrom(mem);
  const toneValue = biaToneId(mem.tone) || 'default';
  const voiceValue = BIA_VOICES.some(v => v.id === String(mem.voice || '').toLowerCase()) ? String(mem.voice).toLowerCase() : BIA_DEFAULT_VOICE;
  const learnOn = String(mem.bia_personalize ?? '1') !== '0';
  const dataOn = !['0', 'off', 'false'].includes(String(mem.bia_data_access ?? '1').toLowerCase());

  const pickLang = (v) => saveKey('language', v, { language: v === 'auto' ? '' : v });
  const pickLength = async (v) => {
    const m = await saveKey('reply_length', v === 'normal' ? 'auto' : v, { reply_length: v === 'normal' ? '' : v });
    // tamanho antigo embutido no tom ("Amigável e acolhedor, respostas curtas") → limpa
    const raw = String((m && typeof m === 'object' ? m.tone : mem.tone) || '');
    if (m && LEN_RE.test(raw)) {
      const clean = raw.replace(LEN_RE, '').trim();
      try {
        const r = await aiMemorySet('tone', clean);
        if (r?.success && r.data?.memory) { setMem(r.data.memory); try { settingsCache.put('bia_memory', r.data.memory); } catch {} }
      } catch {}
    }
  };
  const pickTone = async (id) => {
    const tn = BIA_TONES.find(x => x.id === id);
    const phrase = tn ? tn.phrase : '';
    // tom antigo levava o tamanho junto: preserva como reply_length antes de trocar
    const len = lengthFrom(mem);
    if (len !== 'normal' && !mem.reply_length) { try { await aiMemorySet('reply_length', len); } catch {} }
    saveKey('tone', phrase, { tone: phrase });
  };
  const pickVoice = (v) => saveKey('voice', v, { voice: v });
  const toggleLearn = (v) => saveKey('bia_personalize', v ? '1' : '0', { bia_personalize: v ? '1' : '0' });
  const toggleData = (v) => saveKey('bia_data_access', v ? '1' : '0', { bia_data_access: v ? '1' : '0' });

  const pickRate = (r) => { setRate(r); setBiaTtsRate(r); };
  const toggleHandsFree = (v) => { setHandsFree(v); setBiaAutoRead(v); };
  const toggleDaily = (v) => { setDailyOn(v); setBiaDailyUserOn(v); };

  const wipeMemory = () => {
    safeAlert(t('biaSet.wipeTitle'), t('biaSet.wipeMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('biaSet.wipeConfirm'), style: 'destructive', onPress: async () => {
        setBusy('wipe');
        try {
          const r = await apiCall('one_memory_delete', { all: 1 }, 'POST');
          if (r?.success === false) throw new Error('fail');
          try { Haptics.notificationAsync?.('success'); } catch {}
          safeAlert(t('biaSet.wipeDone'), '', [{ text: t('common.ok') }]);
        } catch { failToast(); }
        setBusy('');
      } },
    ]);
  };
  const clearHistory = () => {
    safeAlert(t('biaSet.clearHistoryTitle'), t('biaSet.clearHistoryMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('biaSet.clearHistoryConfirm'), style: 'destructive', onPress: async () => {
        setBusy('history');
        try {
          const r = await oneHistoryDelete({ clearAll: true });
          if (r?.success === false) throw new Error('fail');
          setCache('one_conversations', { success: true, data: { conversations: [] } }, 7776000000).catch(() => {});
          try { Haptics.notificationAsync?.('success'); } catch {}
          safeAlert(t('biaSet.clearHistoryDone'), '', [{ text: t('common.ok') }]);
        } catch { failToast(); }
        setBusy('');
      } },
    ]);
  };
  const whatBiaSees = () => {
    safeAlert(t('biaSet.whatSeesTitle'), t('biaSet.whatSeesBody'), [
      { text: t('biaSet.privacyPolicy'), onPress: () => router.push({ pathname: '/legal', params: { doc: 'privacy' } }) },
      { text: t('common.ok'), style: 'cancel' },
    ]);
  };

  const langOptions = useMemo(() => LANGS.map(c => ({
    value: c,
    label: c === 'auto' ? t('biaSet.langAuto') : LANG_NATIVE[c],
    sub: c === 'auto' ? t('biaSet.langAutoSub') : undefined,
  })), [t]);
  const lengthOptions = [
    { value: 'short', label: t('biaSet.lengthShort'), sub: t('biaSet.lengthShortSub') },
    { value: 'normal', label: t('biaSet.lengthNormal'), sub: t('biaSet.lengthNormalSub') },
    { value: 'detailed', label: t('biaSet.lengthDetailed'), sub: t('biaSet.lengthDetailedSub') },
  ];
  const toneOptions = [
    ...(toneValue === 'default' ? [{ value: 'default', label: t('biaSet.toneDefault') }] : []),
    ...BIA_TONES.map(x => ({ value: x.id, label: t(`biaSet.tone_${x.id}`), sub: t(`biaSet.tone_${x.id}Sub`) })),
    ...(toneValue === 'custom' ? [{ value: 'custom', label: t('biaSet.toneCustom'), sub: String(mem.tone || '').slice(0, 80) }] : []),
  ];
  const voiceOptions = BIA_VOICES.map(v => ({
    value: v.id,
    label: v.name,
    sub: t(`biaSet.voice_${v.id}`) + (v.id === BIA_DEFAULT_VOICE ? ` · ${t('biaSet.default')}` : ''),
  }));
  const rateOptions = BIA_TTS_RATES.map(r => ({ value: r, label: r === 1 ? `${rateLabel(r)} · ${t('biaSet.lengthNormal')}` : rateLabel(r), short: rateLabel(r) }));

  return (
    <View>
      {/* Sobre */}
      <SettingsGroup nativeHeader>
        <View style={st.header}>
          <SettingsIconTile Icon={BiaIcon} size={64} />
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>Bia</Text>
          <Text style={[st.desc, { color: gc.secondary }]}>{t('biaSet.aboutDesc')}</Text>
        </View>
      </SettingsGroup>
      <SettingsGroup footer={t('settings.oneEnabledDesc')}>
        <SettingsSwitchRow title={t('settings.oneEnabled')} value={enabled} onValueChange={(v) => { setEnabled(v); setStorage('one_enabled', String(v)); }} />
        <SettingsRow icon={IconMessageCircle} title={t('biaSet.openChat')} onPress={() => router.push('/one')} />
      </SettingsGroup>

      {/* Conversa */}
      <SettingsGroup header={t('biaSet.conversation')} footer={t('biaSet.conversationFooter')}>
        <SettingsPickerRow icon={IconGlobe} title={t('biaSet.lang')} options={langOptions} value={langValue} onChange={pickLang} cancelLabel={t('common.cancel')} />
        <SettingsPickerRow icon={IconFileText} title={t('biaSet.length')} options={lengthOptions} value={lengthValue} onChange={pickLength} cancelLabel={t('common.cancel')} />
        <SettingsPickerRow icon={IconSmile} title={t('biaSet.tone')} options={toneOptions} value={toneValue} onChange={(v) => { if (v !== 'default' && v !== 'custom') pickTone(v); }} cancelLabel={t('common.cancel')} />
      </SettingsGroup>

      {/* Voz */}
      <SettingsGroup header={t('biaSet.voiceHeader')} footer={t('biaSet.voiceFooter')}>
        <SettingsPickerRow icon={IconMic} title={t('biaSet.voice')} options={voiceOptions} value={voiceValue} onChange={pickVoice} cancelLabel={t('common.cancel')} />
        <SettingsPickerRow icon={IconClock} title={t('biaSet.speed')} options={rateOptions} value={rate} onChange={pickRate} cancelLabel={t('common.cancel')} />
        <SettingsSwitchRow icon={IconVolume2} title={t('biaSet.handsFree')} subtitle={t('biaSet.handsFreeSub')} value={handsFree} onValueChange={toggleHandsFree} />
      </SettingsGroup>

      {/* Memória */}
      <SettingsGroup header={t('biaSet.memoryHeader')} footer={t('biaSet.memoryFooter')}>
        <SettingsSwitchRow title={t('biaSet.learnMe')} value={learnOn} onValueChange={toggleLearn} />
        <SettingsRow icon={IconEye} title={t('biaSet.seeMemory')} onPress={() => router.push('/one-memory')} />
        <SettingsRow icon={IconTrash} iconTile={false} destructive title={t('biaSet.wipeConfirm')} disabled={busy === 'wipe'} onPress={wipeMemory} />
      </SettingsGroup>

      {/* Acesso a dados */}
      <SettingsGroup header={t('biaSet.dataHeader')} footer={t('biaSet.dataFooter')}>
        <SettingsSwitchRow title={t('biaSet.dataSwitch')} value={dataOn} onValueChange={toggleData} />
        <SettingsRow icon={IconMail} title={t('biaSet.dataEmails')} subtitle={t('biaSet.dataEmailsSub')} value={dataOn ? t('biaSet.allowed') : t('biaSet.off')} />
        <SettingsRow icon={IconMessageCircle} title={t('biaSet.dataChats')} subtitle={t('biaSet.dataChatsSub')} value={dataOn ? t('biaSet.allowed') : t('biaSet.off')} />
        <SettingsRow icon={IconCalendar} title={t('biaSet.dataCalendar')} subtitle={t('biaSet.dataCalendarSub')} value={t('biaSet.onRequest')} />
        <SettingsRow icon={IconUsers} title={t('biaSet.dataContacts')} subtitle={t('biaSet.dataContactsSub')} value={t('biaSet.onRequest')} />
      </SettingsGroup>

      {/* Frase do dia */}
      <SettingsGroup header={t('biaSet.dailyHeader')} footer={t('biaSet.dailyFooter')}>
        <SettingsSwitchRow icon={IconZap} title={t('biaSet.dailySwitch')} value={dailyOn} onValueChange={toggleDaily} />
      </SettingsGroup>

      {/* Notificações (as de antes) */}
      {enabled && (
        <SettingsGroup header={t('settings.oneNotifPrefs')} footer={t('settings.oneNotifUrgentDesc')}>
          {[
            { val: 'email', label: t('settings.oneNotifEmail'), Icon: IconMail },
            { val: 'push', label: t('settings.oneNotifPush'), Icon: IconBell },
            { val: 'urgent', label: t('settings.oneNotifUrgent'), Icon: IconPhone },
          ].map(opt => (
            <SettingsRow
              key={opt.val}
              icon={opt.Icon}
             
              title={opt.label}
              checked={level === opt.val}
              accessibilityRole="radio"
              onPress={() => { setLevel(opt.val); setStorage('one_notif_level', opt.val); }}
            />
          ))}
        </SettingsGroup>
      )}

      {/* Histórico */}
      <SettingsGroup header={t('biaSet.historyHeader')} footer={t('biaSet.historyFooter')}>
        <SettingsRow icon={IconTrash} iconTile={false} destructive title={t('biaSet.clearHistory')} disabled={busy === 'history'} onPress={clearHistory} />
      </SettingsGroup>

      {/* Privacidade + personalização de escrita */}
      <SettingsGroup header={t('biaSet.privacyHeader')}>
        <SettingsRow icon={IconShield} title={t('biaSet.whatSees')} onPress={whatBiaSees} />
        <SettingsRow icon={IconEdit} title={t('biaSet.writing')} subtitle={t('biaSet.writingSub')} onPress={() => router.push('/bia-settings')} />
      </SettingsGroup>
    </View>
  );
}

const st = StyleSheet.create({
  header: { alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 16 },
  name: { fontSize: 22, fontWeight: '600', letterSpacing: -0.3, marginTop: 12 },
  desc: { fontSize: 14, lineHeight: 19, marginTop: 6, textAlign: 'center', maxWidth: 320 },
});
