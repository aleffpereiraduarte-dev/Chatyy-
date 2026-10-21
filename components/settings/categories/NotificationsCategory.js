// [2026-10-15 settings-split] Categoria "Notificações": push master, nível
// de entrega (checkmark), conversas e chamadas, atalhos e (web) permissão do
// navegador. Dados: settingsCache 'notif' (chat_user_notif_prefs) e 'privacy'
// (toque silencioso de ligações).
import { useState } from 'react';
import { View, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../../context/LanguageContext';
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from '../SettingsKit';
import { PushMasterSwitchRow } from '../SettingsPanels';
import { useSettingsHost, useSection, useSaveNotifPref, useChatPrivacy, setStorage, pushLevelOf } from './shared';

export default function NotificationsCategory() {
  const { t } = useLanguage();
  const router = useRouter();
  const { registerAnchor, openCategory } = useSettingsHost();
  const notif = useSection('notif');
  const saveNotifPref = useSaveNotifPref();
  const { privacy, savePrivacy } = useChatPrivacy();
  const level = pushLevelOf(notif);
  const hideReactions = !!(notif && notif.hide_reactions_in_notifs);
  const contactJoined = !(notif && notif.contact_joined_push === false);
  const [perm, setPerm] = useState(() => (typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default'));

  return (
    <View>
      {Platform.OS === 'web' && (
        <View ref={registerAnchor('notifications')}>
          <SettingsGroup header={t('settings.desktopNotifs')} footer={t('settings.desktopNotifsDesc')}>
            <SettingsRow
              title={perm === 'granted' ? t('settings.notifsEnabled') : perm === 'denied' ? t('settings.notifsBlocked') : t('settings.notifsEnable')}
              subtitle={perm === 'denied' ? t('settings.notifsBlockedDesc') : t('settings.notifsAlertDesc')}
              value={perm === 'granted' ? t('settings.notifsActive') : undefined}
              chevron={false}
              onPress={perm !== 'granted' && perm !== 'denied' ? async () => { try { const p = await Notification.requestPermission(); setPerm(p || Notification.permission); } catch { try { setPerm(Notification.permission); } catch {} } } : undefined}
            />
          </SettingsGroup>
        </View>
      )}
      {Platform.OS !== 'web' && (
        <SettingsGroup>
          <PushMasterSwitchRow />
        </SettingsGroup>
      )}
      <SettingsGroup header={t('settings.notificationsTitle')} footer={t('settings.rd2.pushFooter') || 'Vale para todas as notificações push do app.'}>
        {[
          { val: 'all', label: t('settings.notifAll'), sub: t('settings.notifAllSub') },
          { val: 'urgent', label: t('settings.notifUrgent'), sub: t('settings.notifUrgentSub') },
          { val: 'silent', label: t('settings.notifSilent'), sub: t('settings.notifSilentSub') },
        ].map(opt => (
          <SettingsRow
            key={opt.val}
            title={opt.label}
            subtitle={opt.sub}
            checked={level === opt.val}
            accessibilityRole="radio"
            onPress={() => { setStorage('push_notif_level', opt.val); saveNotifPref({ push_notif_level: opt.val }); }}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup header={t('settings.rd2.chatsAndCalls') || 'Conversas e chamadas'}>
        <SettingsSwitchRow
          title={t('settings.privacyHideReactions')}
          subtitle={t('settings.privacyHideReactionsDesc')}
          value={hideReactions}
          onValueChange={(v) => saveNotifPref({ hide_reactions_in_notifs: !!v })}
        />
        <SettingsSwitchRow
          title={t('settings.rd2.muteCalls') || 'Modo silencioso para ligações'}
          subtitle={t('settings.rd2.muteCallsDesc') || 'Silencia o toque e a vibração de chamadas recebidas. A tela continua aparecendo.'}
          value={!!privacy.mute_call_ringtone}
          onValueChange={(v) => savePrivacy({ mute_call_ringtone: !!v })}
        />
        <SettingsSwitchRow
          title={t('settings.contactJoinedPush')}
          subtitle={t('settings.contactJoinedPushDesc')}
          value={contactJoined}
          onValueChange={(v) => saveNotifPref({ contact_joined_push: !!v })}
        />
      </SettingsGroup>
      <SettingsGroup header={t('settings.rd2.more') || 'Mais'}>
        <SettingsRow
          title={t('settings.rd.advancedNotifs') || 'Notificações avançadas'}
          subtitle={t('settings.rd.advancedNotifsDesc') || 'Só menções, palavras-chave, soneca…'}
          onPress={() => router.push('/notification-preferences')}
        />
        <SettingsRow title={t('settings.rd.emailNotifs') || 'Notificações de email'} onPress={() => openCategory('email', 'notifications')} />
      </SettingsGroup>
    </View>
  );
}
