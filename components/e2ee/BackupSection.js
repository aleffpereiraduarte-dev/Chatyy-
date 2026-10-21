// [e2ee5 WP-14 2026-10-21] Ajustes → Privacidade: seção "Backup das conversas protegidas".
// Uma linha que abre /e2ee-backup (ativar/trocar/desativar) e, num aparelho novo com backup no
// servidor, a linha "Restaurar do backup". Invisível com a flag desligada ou sem o núcleo (= hoje).
import React, { useCallback, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { SettingsGroup, SettingsRow } from '../settings/SettingsKit';
import { IconCloud, IconCloudCheck, IconRotateCcw } from '../Icons';
import { tx } from './e2eeUi';
import * as backup from '../../services/e2ee/backup';

let _last = null; // último estado (abre na hora na 2ª visita)

export default function E2eeBackupSection({ cardStyle }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [st, setSt] = useState(_last);
  // Atualiza ao (re)abrir a página — ex.: voltando da tela de backup.
  useFocusEffect(useCallback(() => {
    if (!backup.isOn()) return undefined;
    let alive = true;
    backup.getState().then((s) => { _last = s; if (alive) setSt(s); }).catch(() => {});
    return () => { alive = false; };
  }, []));
  if (!backup.isOn() || !st || !st.available) return null;
  const sub = st.enabled
    ? (st.mode === 'password'
      ? tx(t, 'e2ee5.backup.on_password', 'Ativado · protegido por senha')
      : tx(t, 'e2ee5.backup.on_key', 'Ativado · protegido por chave de recuperação'))
    : tx(t, 'e2ee5.backup.off_sub', 'Desativado. Sem backup, ao trocar de celular as conversas protegidas antigas não voltam.');
  return (
    <SettingsGroup
      header={tx(t, 'e2ee5.backup.header', 'Backup das conversas protegidas')}
      footer={tx(t, 'e2ee5.backup.footer', 'O backup guarda as chaves das conversas com criptografia de ponta a ponta. Só você abre, com a chave de recuperação ou a senha. Nem o Chatyy consegue.')}
      cardStyle={cardStyle}
    >
      {st.restorePending ? (
        <SettingsRow
          icon={IconRotateCcw}
          title={tx(t, 'e2ee5.backup.restore', 'Restaurar do backup')}
          subtitle={tx(t, 'e2ee5.backup.restore_sub', 'Recupere as conversas protegidas com a chave de recuperação ou a senha.')}
          onPress={() => router.push('/e2ee-backup-restore')}
          testID="settings-row-e2ee-restore"
        />
      ) : (
        <SettingsRow
          icon={st.enabled ? IconCloudCheck : IconCloud}
          title={tx(t, 'e2ee5.backup.title', 'Backup das chaves')}
          subtitle={sub}
          subtitleLines={3}
          onPress={() => router.push('/e2ee-backup')}
          testID="settings-row-e2ee-backup"
        />
      )}
    </SettingsGroup>
  );
}
