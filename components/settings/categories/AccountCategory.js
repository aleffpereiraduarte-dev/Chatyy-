// [2026-10-15 settings-split] Categoria "Conta": perfil, contas, plano,
// números, aparelhos, dados; Segurança (bloqueio, senha, PINs, atividade,
// denúncias, criptografia, família) e Zona de perigo. Estado local — os
// modais só montam quando abertos (SecurityModals.js).
import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, Linking, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { useAuth } from '../../../context/AuthContext';
import { useBiometric } from '../../../context/BiometricContext';
import { useConfirm } from '../../ConfirmModal';
import { PASSKEYS_ENABLED } from '../../../constants/featureFlags';
import { BorderRadius, FontSize, Spacing } from '../../../constants/theme';
import { IconAlertTriangle, IconCheck, IconShield } from '../../Icons';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow } from '../SettingsKit';
import { useSafeNav, useSettingsHost } from './shared';
import { ChangePasswordModal, BackupPassphraseModal, LoginHistorySheet } from './SecurityModals';
import TwoStepSheet from '../TwoStepSheet';
import { getCachedTwoStep, loadTwoStep, fetchTwoStep, subscribeTwoStep } from '../twoStepState';

const ADMIN_EMAIL = 'aleffpereiraduarte@gmail.com';

export default function AccountCategory() {
  const { t } = useLanguage();
  const router = useRouter();
  const safeNav = useSafeNav();
  const { registerAnchor, openAccountSwitcher } = useSettingsHost();
  const { user, accounts } = useAuth();
  const { biometricEnabled, biometricAvailable, toggleBiometric, autoLockInterval, setAutoLockInterval } = useBiometric();
  // null | 'password' | '2fa' | 'e2e' | 'backupKey' | 'logins'
  const [modal, setModalState] = useState(null);
  // Monta cada modal no 1º uso e mantém montado (anima ao fechar).
  const [mounted, setMounted] = useState({});
  const setModal = (m) => { if (m) setMounted(p => (p[m] ? p : { ...p, [m]: true })); setModalState(m); };
  const close = () => setModalState(null);
  const isWeb = Platform.OS === 'web';
  // [2026-10-16 two-step] Status (Ativada/Desativada) da verificação em duas
  // etapas — cache local na hora + confirma no servidor; a folha atualiza via store.
  const myEmail = user?.email || '';
  const [twoStep, setTwoStep] = useState(() => getCachedTwoStep(myEmail));
  useEffect(() => {
    if (!myEmail) return undefined;
    let alive = true;
    const me = myEmail.toLowerCase();
    const un = subscribeTwoStep((e, s2) => { if (alive && e === me) setTwoStep(s2); });
    loadTwoStep(myEmail).then((c) => { if (alive && c) setTwoStep((p) => p || c); });
    fetchTwoStep(myEmail).then((s2) => { if (alive && s2) setTwoStep(s2); }).catch(() => {});
    return () => { alive = false; un(); };
  }, [myEmail]);
  const AUTO_LOCK_OPTIONS = [
    { value: '0', label: t('biometric.lockImmediate') || 'Imediatamente' },
    { value: '60', label: t('biometric.lock1Min') || 'Após 1 minuto' },
    { value: '300', label: t('biometric.lock5Min') || 'Após 5 minutos' },
    { value: '900', label: t('biometric.lock15Min') || 'Após 15 minutos' },
    { value: 'never', label: t('biometric.lockNever') || 'Nunca' },
  ];

  return (
    <View>
      <View ref={registerAnchor('account')}>
        <SettingsGroup>
          <SettingsRow title={t('settings.editProfile')} subtitle={t('settings.editProfileSub')} onPress={() => safeNav('/edit-profile')} testID="settings-row-edit-profile" />
          <SettingsRow
            title={t('account.switch') || 'Trocar conta'}
            value={(accounts?.length || 0) > 1 ? String(accounts.length) : undefined}
            onPress={openAccountSwitcher}
          />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow title={t('linkedPhones.title')} onPress={() => safeNav('/linked-phones')} />
          <SettingsRow title={t('settings.linkedDevices')} onPress={() => safeNav('/linked-devices')} />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow title={t('settings.exportData')} onPress={() => safeNav('/settings-export')} />
          <SettingsRow title={t('profile.creatorDashboard')} onPress={() => safeNav('/profile-creator-dashboard')} />
        </SettingsGroup>
      </View>

      {/* Segurança — web: só "Alterar senha" (o resto depende do nativo). */}
      <View ref={registerAnchor('security')}>
        {!isWeb && biometricAvailable && (
          <SettingsGroup header={t('settings.rd2.appLock') || 'Bloqueio do app'} footer={t('settings.biometricDesc')}>
            <SettingsSwitchRow title={t('settings.biometricLock')} value={biometricEnabled} onValueChange={toggleBiometric} />
            {biometricEnabled && (
              <SettingsPickerRow
                title={t('settings.autoLockInterval') || 'Bloqueio automático'}
                value={String(autoLockInterval)}
                sheetMessage={t('settings.autoLockDesc') || 'Quanto tempo o app espera em segundo plano antes de pedir autenticação.'}
                cancelLabel={t('common.cancel') || 'Cancelar'}
                options={AUTO_LOCK_OPTIONS}
                displayValue={(AUTO_LOCK_OPTIONS.find(o => o.value === String(autoLockInterval)) || {}).label || `${autoLockInterval}s`}
                onChange={(v) => { setAutoLockInterval(v === 'never' ? 'never' : Number(v)); }}
              />
            )}
          </SettingsGroup>
        )}

        <SettingsGroup header={t('settings.security') || 'Segurança'}>
          <SettingsRow
            title={t('settings.changePassword') || 'Alterar senha'}
            subtitle={t('settings.changePasswordDesc') || 'Atualize sua senha de acesso a qualquer momento'}
            onPress={() => setModal('password')}
          />
          {/* [2026-10-16 two-step] Uma linha só (nível WhatsApp): o "PIN de
              segurança (anti-SIM-swap)" é o MESMO PIN — fundido aqui. */}
          <SettingsRow
            testID="settings-row-two-step"
            title={t('settings.twoFactor') || 'Verificação em duas etapas'}
            subtitle={t('twoStep.rowDesc') || 'PIN pedido ao registrar seu número em outro aparelho'}
            value={twoStep ? (twoStep.enabled ? (t('twoStep.on') || 'Ativada') : (t('twoStep.off') || 'Desativada')) : undefined}
            onPress={() => setModal('2fa')}
          />
          {!isWeb && (
            <SettingsRow
              title={t('settings.changePhone') || 'Alterar número de telefone'}
              subtitle={t('settings.changePhoneDesc') || 'Migre sua conta para um novo número mantendo seus chats e contatos.'}
              onPress={() => safeNav('/change-phone')}
            />
          )}
          {PASSKEYS_ENABLED && (
            <SettingsRow title={t('settings.passkeys.title')} subtitle={t('settings.passkeys.rowSub')} onPress={() => safeNav('/passkeys')} />
          )}
        </SettingsGroup>

        {!isWeb && (
          <SettingsGroup header={t('settings.rd2.activity') || 'Atividade'}>
            <SettingsRow title={t('settings.loginAlerts.history') || 'Histórico de logins'} onPress={() => setModal('logins')} />
            <SettingsRow
              title={t('settings.activityLog') || 'Histórico de atividades'}
              subtitle={t('settings.activityLogDesc') || 'Veja logins, mudanças de senha, novos dispositivos e outras ações de segurança.'}
              onPress={() => safeNav('/activity-log')}
            />
          </SettingsGroup>
        )}

        <SettingsGroup header={t('mod.reportsHeader')}>
          <SettingsRow title={t('mod.myReports')} subtitle={t('mod.myReportsDesc')} icon={IconShield} onPress={() => safeNav('/my-reports')} />
          {String(user?.email || '').toLowerCase() === ADMIN_EMAIL ? (
            <SettingsRow
              title={t('mod.adminTitle')}
              subtitle={t('mod.adminDesc')}
              icon={IconShield}
              onPress={async () => {
                const url = 'https://chatyy.com.br/api/moderacao.php';
                try {
                  if (Platform.OS === 'web') { window.open(url, '_blank', 'noopener'); return; }
                  const WB = require('expo-web-browser');
                  await WB.openBrowserAsync(url);
                } catch { Linking.openURL(url).catch(() => {}); }
              }}
            />
          ) : null}
        </SettingsGroup>

        {!isWeb && (
          <SettingsGroup header={t('settings.rd2.encryption') || 'Criptografia e backup'}>
            <SettingsRow
              title={t('settings.e2eBackup') || 'Backup com criptografia'}
              subtitle={t('settings.e2eBackupDesc') || 'Salve suas chaves protegidas por uma frase secreta'}
              onPress={() => setModal('e2e')}
            />
            <SettingsRow
              title={t('settings.backupKey.rotate') || 'Redefinir senha do backup'}
              subtitle={t('settings.backupKey.subtitle') || 'Troque a frase secreta que protege seu backup criptografado. Backups antigos deixam de ser restauráveis.'}
              subtitleLines={3}
              onPress={() => setModal('backupKey')}
            />
            <SettingsRow
              title={t('settings.advancedKey') || 'Chave avançada (BYOK)'}
              subtitle={t('settings.advancedKeyDesc') || 'Gere uma chave mestre que só existe no seu aparelho. Frase de segurança mostrada uma única vez.'}
              subtitleLines={3}
              onPress={() => safeNav('/advanced-key')}
            />
          </SettingsGroup>
        )}

        {!isWeb && (
          <SettingsGroup footer={t('settings.advancedPrivacyDesc') || 'Proxy/Tor, bloqueio de captura de tela, descoberta por número, sugestão de VPN.'}>
            <SettingsRow title={t('settings.advancedPrivacy') || 'Privacidade avançada'} onPress={() => safeNav('/advanced-privacy')} />
          </SettingsGroup>
        )}

        {!isWeb && (
          <SettingsGroup header={t('settings.rd2.family') || 'Família'}>
            <SettingsRow
              title={t('settings.rd2.family') || 'Família'}
              subtitle={t('settings.rd2.familyDesc') || 'Compartilhe plano, álbum, calendário e mais com a família'}
              onPress={() => router.push('/family')}
            />
            <SettingsRow
              title={t('settings.rd2.parental') || 'Controle parental'}
              subtitle={t('settings.rd2.parentalDesc') || 'Crie contas monitoradas para seus filhos'}
              onPress={() => router.push('/parental')}
            />
          </SettingsGroup>
        )}
      </View>

      <DangerZone />

      {mounted.password && <ChangePasswordModal visible={modal === 'password'} onClose={close} />}
      {mounted['2fa'] && <TwoStepSheet visible={modal === '2fa'} onClose={close} />}
      {mounted.e2e && <BackupPassphraseModal visible={modal === 'e2e'} onClose={close} />}
      {mounted.backupKey && <BackupPassphraseModal visible={modal === 'backupKey'} rotate onClose={close} />}
      {mounted.logins && <LoginHistorySheet visible={modal === 'logins'} onClose={close} />}
    </View>
  );
}

// Zona de perigo — esvaziar lixeira + excluir conta (exigência da Apple).
function DangerZone() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const resetSheet = () => { setPassword(''); setError(''); setAck(false); setTyped(''); };

  const confirmWord = t('settings.deleteAccountTypeWord') || 'DELETE';
  const typedOk = (typed || '').trim().toUpperCase() === String(confirmWord).toUpperCase();
  const canDelete = ack && typedOk && !!password.trim() && !deleting;

  return (
    <View>
      <SettingsGroup footer={t('settings.deleteAccountDesc')}>
        <SettingsRow
          title={t('settings.emptyTrash')}
          destructive
          onPress={async () => {
            const ok = Platform.OS === 'web'
              ? (typeof window !== 'undefined' && window.confirm(t('settings.emptyTrashConfirmWeb')))
              : await confirm({ title: t('settings.emptyTrashTitle'), message: t('settings.emptyTrashConfirmNative'), confirmLabel: t('common.confirm'), destructive: true });
            if (ok) { try { const { emptyTrash } = await import('../../../services/api'); await emptyTrash(); } catch {} }
          }}
        />
        <SettingsRow
          title={t('settings.deleteAccount')}
          destructive
          onPress={async () => {
            const openSheet = () => { resetSheet(); setOpen(true); };
            if (Platform.OS === 'web') { openSheet(); return; }
            const ok = await confirm({
              title: t('settings.deleteAccountConfirmTitle'),
              message: t('settings.deleteAccountConfirmMessage'),
              confirmLabel: t('settings.deleteAccount'),
              destructive: true,
            });
            if (ok) openSheet();
          }}
        />
      </SettingsGroup>

      {open && (
        <View style={[st.box, { backgroundColor: colors.errorBg || (colors.error + '08'), borderColor: colors.error + '30' }]}>
          <Text style={[st.title, { color: colors.error }]}>{t('settings.confirmAccountDeletion')}</Text>
          <View style={{
            flexDirection: 'row', gap: 12, padding: 14,
            backgroundColor: (colors.error || '#dc2626') + '15',
            borderRadius: 12, borderWidth: 1,
            borderColor: (colors.error || '#dc2626') + '40',
            marginBottom: 16,
          }}>
            <IconAlertTriangle size={20} color={colors.error || '#dc2626'} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.error || '#dc2626', fontSize: 14, fontWeight: '700', marginBottom: 4 }}>{t('settings.deleteAccountWarningTitle')}</Text>
              <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{t('settings.deleteAccountWarningBody')}</Text>
            </View>
          </View>
          <Text style={[st.text, { color: colors.textSecondary }]}>{t('settings.deleteAccountPasswordMessage')}</Text>
          <TextInput
            style={[st.input, { color: colors.text, borderColor: colors.error + '40', backgroundColor: colors.surface }]}
            value={password}
            onChangeText={setPassword}
            placeholder={t('settings.yourPassword')}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry
          />
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 12, marginBottom: 6 }}>
            {(t('settings.deleteAccountTypeHint') || 'Type {word} to confirm').replace('{word}', confirmWord)}
          </Text>
          <TextInput
            style={[st.input, {
              color: colors.text,
              borderColor: typedOk ? (colors.success || '#16a34a') + '60' : (colors.error + '40'),
              backgroundColor: colors.surface, marginTop: 0, letterSpacing: 1, fontWeight: '700',
            }]}
            value={typed}
            onChangeText={setTyped}
            placeholder={confirmWord}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TouchableOpacity
            onPress={() => setAck(v => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, paddingVertical: 4 }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ack }}
          >
            <View style={{
              width: 22, height: 22, borderRadius: 6, borderWidth: 2,
              borderColor: ack ? (colors.error || '#dc2626') : colors.border,
              backgroundColor: ack ? (colors.error || '#dc2626') : 'transparent',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {ack ? <IconCheck size={14} color="#fff" /> : null}
            </View>
            <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 }}>{t('settings.deleteAccountConfirmCheckbox')}</Text>
          </TouchableOpacity>
          {!!error && <Text style={[st.error, { color: colors.error, marginTop: 10 }]}>{error}</Text>}
          <View style={st.actions}>
            <TouchableOpacity onPress={() => { setOpen(false); resetSheet(); }} style={[st.cancelBtn, { borderColor: colors.border }]}>
              <Text style={[st.cancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                if (!canDelete) return;
                setDeleting(true);
                setError('');
                try {
                  const { deleteAccount } = await import('../../../services/api');
                  const r = await deleteAccount(password);
                  if (r.success) {
                    setOpen(false);
                    if (Platform.OS === 'web') window.alert(t('settings.accountDeletedMessage'));
                    else Alert.alert(t('settings.accountDeleted'), t('settings.accountDeletedMessage'));
                    logout();
                  } else {
                    setError(r.message || t('settings.deleteAccountError'));
                  }
                } catch {
                  setError(t('common.networkError'));
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={!canDelete}
              style={[st.confirmBtn, { backgroundColor: colors.error, opacity: canDelete ? 1 : 0.4 }]}
            >
              {deleting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.confirmBtnText}>{t('settings.deleteMyAccount')}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.lg, marginTop: Spacing.md },
  title: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.sm },
  text: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.md },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    fontSize: FontSize.base, marginBottom: Spacing.sm,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  error: { fontSize: FontSize.sm, fontWeight: '500', marginBottom: Spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  cancelBtn: { borderWidth: 1, borderRadius: BorderRadius.md, paddingVertical: 10, paddingHorizontal: Spacing.xl },
  cancelText: { fontSize: FontSize.base, fontWeight: '500' },
  confirmBtn: { borderRadius: BorderRadius.md, paddingVertical: 10, paddingHorizontal: Spacing.xl },
  confirmBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
});
