// [2026-10-15 settings-split] Categoria "Privacidade": quem pode ver (valor
// à direita + sheet com checkmark), recibos, status, arquivadas, desconhecidos,
// bloqueados, extras, personalização e temporárias por padrão. Dados =
// settingsCache 'privacy' / 'defaults' (commit otimista).
import { useState } from 'react';
import { View, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../../context/LanguageContext';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, OptionSheet } from '../SettingsKit';
import { PrivacyExtrasGroup } from '../SettingsPanels';
import { useSafeNav, useSettingsHost, useChatPrivacy, useChatDefaults, privacyValueLabel } from './shared';
import { useSilenceUnknownCallers } from '../../calls/silenceUnknownCallers'; // [2026-10-16 wave12-D]
import { useCaptureBlockGlobal, setCaptureBlockGlobal } from '../../../services/captureBlock'; // [2026-10-19 secure-view]

const FIELDS = ['last_seen', 'online', 'profile_photo', 'about', 'phone_visibility', 'story_privacy', 'group_add'];

export default function PrivacyCategory() {
  const { t } = useLanguage();
  const router = useRouter();
  const safeNav = useSafeNav();
  const { registerAnchor } = useSettingsHost();
  const { privacy, savePrivacy } = useChatPrivacy();
  const { defaults, updateDefault } = useChatDefaults();
  const [picker, setPicker] = useState(null);
  const [silenceUnknown, setSilenceUnknown] = useSilenceUnknownCallers();
  // [2026-10-19 secure-view] "Bloquear capturas de tela nas conversas" (opt-in):
  // espelho local = efeito na hora; servidor = outros aparelhos.
  const captureBlock = useCaptureBlockGlobal();
  const saveCaptureBlock = (v) => {
    setCaptureBlockGlobal(!!v);
    savePrivacy({ block_screenshots: !!v });
  };

  const fieldTitle = (field) => (
    field === 'last_seen' ? t('settings.privacyLastSeen')
      : field === 'profile_photo' ? t('settings.privacyProfilePhoto')
      : field === 'online' ? t('settings.privacyOnline')
      : field === 'story_privacy' ? t('settings.privacyStatus')
      : field === 'group_add' ? t('settings.privacyGroups')
      : field === 'phone_visibility' ? t('privacy.phoneNumber')
      : field === 'about' ? t('settings.privacyAbout')
      : ''
  );
  const optionsFor = (field) => (
    field === 'online' ? [
      { value: 'everyone', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'nobody', label: t('settings.privacyInvisible') },
    ] : field === 'story_privacy' ? [
      { value: 'all', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'close_friends', label: t('settings.privacyCloseFriends') },
      { value: 'except', label: t('settings.privacyStatusExcept') },
    ] : [
      { value: 'everyone', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'nobody', label: t('settings.privacyNobody') },
    ]
  );
  const exceptN = privacy.status_except?.length || 0;

  return (
    <View>
      <View ref={registerAnchor('privacy_granular')}>
        <SettingsGroup header={t('settings.rd2.whoCanSee') || 'Quem pode ver'} footer={t('settings.rd2.whoCanSeeFooter') || 'Escolha quem vê suas informações no Chatyy.'}>
          {FIELDS.map(field => (
            <SettingsRow key={field} title={fieldTitle(field)} value={privacyValueLabel(t, privacy, field)} onPress={() => setPicker(field)} />
          ))}
        </SettingsGroup>
        <SettingsGroup footer={t('settings.privacyReadReceiptsDesc')}>
          <SettingsSwitchRow title={t('settings.privacyReadReceipts')} value={!!privacy.read_receipts} onValueChange={(v) => savePrivacy({ read_receipts: !!v })} />
        </SettingsGroup>
        <SettingsGroup header={t('settings.rd2.status') || 'Status'}>
          <SettingsRow title={t('settings.privacyCloseFriends')} subtitle={t('settings.privacyCloseFriendsDesc')} onPress={() => { try { router.push('/close-friends'); } catch {} }} />
          <SettingsRow
            title={t('settings.privacyStatusExcept')}
            value={exceptN > 0 ? String(exceptN) : undefined}
            subtitle={exceptN > 0 ? undefined : t('settings.privacyStatusExceptDesc')}
            onPress={() => { try { router.push('/status-except'); } catch {} }}
          />
        </SettingsGroup>
        <SettingsGroup header={t('settings.rd2.chats') || 'Conversas'} footer={t('settings.privacyKeepArchivedDesc')}>
          <SettingsSwitchRow title={t('settings.privacyKeepArchived')} value={privacy.keep_archived !== false} onValueChange={(v) => savePrivacy({ keep_archived: !!v })} />
        </SettingsGroup>
        <SettingsGroup footer={t('settings.blockUnknownDesc')}>
          <SettingsSwitchRow title={t('settings.blockUnknown')} value={!!privacy.block_unknown} onValueChange={(v) => savePrivacy({ block_unknown: !!v })} />
          <SettingsRow title={t('settings.blockedContacts')} onPress={() => safeNav('/settings-blocked')} testID="settings-row-blocked" />
        </SettingsGroup>
        {Platform.OS !== 'web' && (
        <SettingsGroup footer={t('settings.blockScreenshotsDesc') || 'Suas conversas não aparecem em prints nem em gravações de tela neste aparelho. Se houver uma tentativa, a outra pessoa da conversa é avisada.'}>
          <SettingsSwitchRow
            title={t('settings.blockScreenshots') || 'Bloquear capturas de tela nas conversas'}
            value={!!captureBlock}
            onValueChange={saveCaptureBlock}
            testID="settings-row-block-screenshots"
          />
        </SettingsGroup>
        )}
        {/* [2026-10-16 wave12-D] mesmo ajuste do cartão da aba Ligações (estado compartilhado). */}
        <SettingsGroup header={t('chat.tabCalls')} footer={t('calls.silenceUnknownDesc')}>
          <SettingsSwitchRow title={t('calls.silenceUnknown')} value={silenceUnknown} onValueChange={setSilenceUnknown} testID="settings-row-silence-unknown" />
        </SettingsGroup>
        <PrivacyExtrasGroup cloudChats={privacy.cloud_chats_default} onCloudChatsChange={(v) => savePrivacy({ cloud_chats_default: !!v })} />
      </View>

      {/* Personalização e ofertas (LGPD) — tela /privacy-personalization. */}
      <SettingsGroup>
        <SettingsRow
          title={t('settings.personalizationOffers')}
          subtitle={t('settings.personalizationOffersDesc')}
          subtitleLines={2}
          onPress={() => safeNav('/privacy-personalization')}
        />
      </SettingsGroup>

      {/* Temporárias por padrão — só vale p/ conversas novas. */}
      <View ref={registerAnchor('defaultDisappearing')}>
        <SettingsGroup header={t('settings.defaultDisappearing')} footer={t('settings.defaultDisappearingDesc')}>
          <SettingsPickerRow
            title={t('settings.rd2.defaultTimer') || 'Temporizador padrão'}
            value={Number(defaults.default_disappearing) || 0}
            cancelLabel={t('common.cancel') || 'Cancelar'}
            options={[
              { value: 0, label: t('settings.disappearingOff') },
              { value: 86400, label: t('settings.disappearing24h') },
              { value: 604800, label: t('settings.disappearing7d') },
              { value: 7776000, label: t('settings.disappearing90d') },
            ]}
            onChange={(v) => updateDefault({ default_disappearing: v })}
          />
        </SettingsGroup>
      </View>

      {!!picker && (
        <OptionSheet
          visible={!!picker}
          title={fieldTitle(picker)}
          options={optionsFor(picker)}
          value={picker === 'story_privacy' && privacy.story_privacy === 'everyone' ? 'all' : privacy[picker]}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          onSelect={(v) => {
            const field = picker;
            if (field) savePrivacy({ [field]: v });
            if (field === 'story_privacy' && v === 'close_friends') { try { router.push('/close-friends'); } catch {} }
            else if (field === 'story_privacy' && v === 'except') { try { router.push('/status-except'); } catch {} }
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </View>
  );
}
