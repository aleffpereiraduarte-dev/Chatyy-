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
import { IconAlertTriangle, IconCheck } from '../../Icons'; // [2026-10-17 settings-wa] sem ícone solto só em Denúncias (resto da página é texto puro)
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow } from '../SettingsKit';
import { useSafeNav, useSettingsHost } from './shared';
import { useSettingsCollector } from '../nativeCollect'; // [2026-10-18 settings-sub-native-2]
import SettingsFormSheet from '../SettingsFormSheet';
import { ChangePasswordModal, BackupPassphraseModal, LoginHistorySheet } from './SecurityModals';
import TwoStepSheet from '../TwoStepSheet';
import { getCachedTwoStep, loadTwoStep, fetchTwoStep, subscribeTwoStep } from '../twoStepState';

const ADMIN_EMAIL = 'aleffpereiraduarte@gmail.com';

export default function AccountCategory() {
  const { t } = useLanguage();
  const router = useRouter();
  const safeNav = useSafeNav();
  const { registerAnchor, openAccountSwitcher, openCategory } = useSettingsHost();
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
  // [recovery 2026-10-18] conta sem nenhuma forma de recuperação → lembrete na linha
  const [recNone, setRecNone] = useState(false);
  useEffect(() => {
    if (!myEmail) return undefined;
    let alive = true;
    try {
      require('../../../services/api').recoveryOptionsGet()
        .then((r) => { if (alive && r?.success && r.data) setRecNone(!r.data.has_any); }).catch(() => {});
    } catch {}
    return () => { alive = false; };
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
        {/* [2026-10-18 settings-sub-native] "Editar perfil" saiu daqui (está no Meu perfil:
            Editar / Definir foto) e "Aparelhos conectados" virou linha da raiz — sem duplicar. */}
        <SettingsGroup>
          <SettingsRow
            title={t('account.switch') || 'Trocar conta'}
            value={(accounts?.length || 0) > 1 ? String(accounts.length) : undefined}
            onPress={openAccountSwitcher}
          />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow title={t('linkedPhones.title')} onPress={() => safeNav('/linked-phones')} />
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
          {/* [recovery 2026-10-18] Opções de recuperação (Gmail): e-mail/telefone/aparelhos */}
          <SettingsRow
            testID="settings-row-recovery"
            title={t('rec.opts.title')}
            subtitle={recNone ? t('rec.opts.rowNudge') : t('rec.opts.rowSub')}
            value={recNone ? t('rec.opts.rowNone') : undefined}
            onPress={() => safeNav('/recovery-options')}
          />
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
          <SettingsRow title={t('mod.myReports')} subtitle={t('mod.myReportsDesc')} onPress={() => safeNav('/my-reports')} />
          {String(user?.email || '').toLowerCase() === ADMIN_EMAIL ? (
            <SettingsRow
              title={t('mod.adminTitle')}
              subtitle={t('mod.adminDesc')}
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
            <SettingsRow title={t('settings.advancedPrivacy') || 'Privacidade avançada'} onPress={() => openCategory('privacy')} /* [2026-10-21 privacidade-unica] página única */ />
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

// Zona de perigo — esvaziar lixeira + excluir conta (Apple 5.1.1(v) / Play).
// [excluir-conta-real 2026-10-23] Exclusão de verdade: a conta é DESATIVADA na hora e apagada em 30 dias
// (servidor: account_deletion_request). Confirma com a senha OU com um código (telefone/e-mail de recuperação,
// mesma sessão da recuperação de conta: recovery_lookup → recovery_send). Depois: limpa os dados locais desta
// conta e sai. Entrar de novo dentro do prazo cancela (servidor reativa no login).
function DangerZone() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const { user, accounts, removeAccount } = useAuth();
  const myEmail = String(user?.email || '');
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);          // account_deletion_status
  const [mode, setMode] = useState('password');    // 'password' | 'code'
  const [password, setPassword] = useState('');
  const [rid, setRid] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [ack, setAck] = useState(false);
  const days = Number(info?.grace_days) || 30;
  const tt = (k, vars) => { let s = String(t(k) || ''); if (vars) for (const v of Object.keys(vars)) s = s.split('{' + v + '}').join(String(vars[v])); return s; };
  const resetSheet = () => { setPassword(''); setRid(''); setSentTo(''); setCode(''); setError(''); setAck(false); };
  const methods = info?.methods || {};
  const codeTargets = [methods.phone ? { type: 'phone', masked: methods.phone } : null, methods.email ? { type: 'email', masked: methods.email } : null].filter(Boolean);
  const canDelete = ack && !deleting && (mode === 'password' ? !!password.trim() : (!!rid && /^\d{6}$/.test(code.trim())));
  // [2026-10-18 settings-sub-native-2] Lista nativa: o formulário abre numa folha — mesmos campos e mesma chamada.
  const collecting = !!useSettingsCollector();

  const loadInfo = async () => {
    try {
      const { accountDeletionStatus } = await import('../../../services/api');
      const r = await accountDeletionStatus();
      if (r?.success && r.data) {
        setInfo(r.data);
        if (!r.data?.methods?.password && (r.data?.methods?.phone || r.data?.methods?.email)) setMode('code');
      }
    } catch {}
  };

  const errText = (r) => {
    const reason = r?.data?.reason || '';
    const map = {
      wrong_password: 'delacc.errWrongPassword', wrong_code: 'delacc.errWrongCode', bad_code: 'delacc.errWrongCode',
      expired: 'delacc.errExpired', session_expired: 'delacc.errExpired', too_many_attempts: 'delacc.errMany', locked: 'delacc.errMany',
      parental: 'delacc.errParental', protected_account: 'delacc.errProtected', wrong_account: 'delacc.errWrongCode',
    };
    return t(map[reason] || 'delacc.errGeneric');
  };

  const sendCode = async (type) => {
    if (sending) return;
    setSending(true); setError('');
    try {
      const api = await import('../../../services/api');
      let id = rid;
      if (!id) {
        const lk = await api.recoveryLookup(myEmail);
        id = lk?.data?.rid || '';
        if (!id) { setError(t('delacc.errGeneric')); return; }
        setRid(id);
      }
      const r = await api.recoverySend(id, type);
      if (r?.success) { setSentTo(r?.data?.masked || (codeTargets.find((x) => x.type === type)?.masked || '')); setCode(''); }
      else setError(r?.data?.reason === 'method_unavailable' ? t('delacc.noMethod') : errText(r));
    } catch { setError(t('common.networkError')); }
    finally { setSending(false); }
  };

  const wipeLocalAndExit = async () => {
    const em = myEmail;
    const only = (accounts?.length || 0) <= 1;
    try { require('../../../services/cache').clearUserCache?.(em); } catch {}
    try { require('../../../services/settingsCache').purgeAccount?.(em); } catch {}
    try { await require('../../../services/stickerCache').purgeStickerCacheForAccount?.(em); } catch {}
    if (only) {
      try { await require('../../../services/chatCache').clearChatCache?.(); } catch {}
      try { await require('../../../services/mediaCache').clearMediaCache?.(); } catch {}
    }
    try { await removeAccount(em); } catch {}
  };

  const submit = async () => {
    if (!canDelete) return;
    setDeleting(true); setError('');
    try {
      const { accountDeletionRequest } = await import('../../../services/api');
      const payload = mode === 'password' ? { password } : { rid, code: code.trim() };
      const r = await accountDeletionRequest(payload);
      if (r?.success) {
        setOpen(false);
        const when = r?.data?.purge_after ? new Date(r.data.purge_after) : new Date(Date.now() + days * 86400000);
        let dateStr = '';
        try { dateStr = when.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' }); } catch { dateStr = when.toISOString().slice(0, 10); }
        const body = tt('delacc.doneBody', { date: dateStr });
        if (Platform.OS === 'web') { try { window.alert(t('delacc.doneTitle') + '\n\n' + body); } catch {} }
        else Alert.alert(t('delacc.doneTitle'), body);
        await wipeLocalAndExit();
      } else {
        setError(errText(r));
        if (r?.data?.reason === 'session_expired' || r?.data?.reason === 'expired') { setRid(''); setSentTo(''); }
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setDeleting(false);
    }
  };

  const Bullet = ({ children, strong }) => (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: strong ? (colors.error || '#dc2626') : colors.textSecondary }} />
      <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 }}>{children}</Text>
    </View>
  );
  const Seg = ({ value, label }) => (
    <TouchableOpacity
      onPress={() => { setMode(value); setError(''); }}
      accessibilityRole="button" accessibilityState={{ selected: mode === value }}
      style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: mode === value ? colors.surface : 'transparent' }}
    >
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: mode === value ? '700' : '500' }}>{label}</Text>
    </TouchableOpacity>
  );

  const renderBox = (inSheet) => (
    <View style={inSheet ? null : [st.box, { backgroundColor: colors.errorBg || (colors.error + '08'), borderColor: colors.error + '30' }]} testID="delete-account-box">
      {inSheet ? null : <Text style={[st.title, { color: colors.error }]}>{t('delacc.title')}</Text>}
      <View style={{
        flexDirection: 'row', gap: 12, padding: 14,
        backgroundColor: (colors.error || '#dc2626') + '15',
        borderRadius: 12, borderWidth: 1, borderColor: (colors.error || '#dc2626') + '40', marginBottom: 14,
      }}>
        <IconAlertTriangle size={20} color={colors.error || '#dc2626'} />
        <View style={{ flex: 1 }}>
          <Bullet strong>{t('delacc.now')}</Bullet>
          <Bullet strong>{tt('delacc.after', { days })}</Bullet>
          <Bullet>{tt('delacc.cancel')}</Bullet>
          <Bullet>{t('delacc.others')}</Bullet>
          <Bullet>{t('delacc.legal')}</Bullet>
        </View>
      </View>
      {(info?.store_subscriptions?.apple || info?.store_subscriptions?.google || Platform.OS !== 'web') ? (
        <View style={{ padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginBottom: 14 }}>
          <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{t('delacc.subs')}</Text>
          <TouchableOpacity
            onPress={() => {
              const url = Platform.OS === 'android' ? 'https://play.google.com/store/account/subscriptions' : 'https://apps.apple.com/account/subscriptions';
              Linking.openURL(url).catch(() => {});
            }}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          >
            <Text style={{ color: colors.primary || colors.text, fontSize: 13, fontWeight: '700' }}>{t('delacc.subsBtn')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 8 }}>{t('delacc.confirmWith')}</Text>
      {codeTargets.length > 0 ? (
        <View style={{ flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: colors.border + '55', marginBottom: 10 }}>
          <Seg value="password" label={t('delacc.byPassword')} />
          <Seg value="code" label={t('delacc.byCode')} />
        </View>
      ) : null}

      {mode === 'password' ? (
        <TextInput
          style={[st.input, { color: colors.text, borderColor: colors.error + '40', backgroundColor: colors.surface }]}
          {...(inSheet ? { defaultValue: password } : { value: password })}
          onChangeText={setPassword}
          placeholder={t('delacc.passwordPh')}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          testID="delete-account-password"
        />
      ) : (
        <View>
          {codeTargets.length === 0 ? <Text style={[st.text, { color: colors.textSecondary }]}>{t('delacc.noMethod')}</Text> : null}
          {!sentTo ? codeTargets.map((m) => (
            <TouchableOpacity key={m.type} onPress={() => sendCode(m.type)} disabled={sending}
              style={[st.cancelBtn, { borderColor: colors.border, marginBottom: 8, alignItems: 'center', opacity: sending ? 0.5 : 1 }]}>
              <Text style={[st.cancelText, { color: colors.text }]}>{tt('delacc.sendTo', { m: m.masked })}</Text>
            </TouchableOpacity>
          )) : (
            <View>
              <Text style={[st.text, { color: colors.textSecondary, marginBottom: 6 }]}>{tt('delacc.codeSent', { m: sentTo })}</Text>
              <TextInput
                style={[st.input, { color: colors.text, borderColor: colors.error + '40', backgroundColor: colors.surface, letterSpacing: 4, fontWeight: '700' }]}
                {...(inSheet ? { defaultValue: code } : { value: code })}
                onChangeText={(v) => setCode(String(v || '').replace(/\D/g, '').slice(0, 6))}
                placeholder={t('delacc.codePh')}
                placeholderTextColor={colors.textTertiary}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                maxLength={6}
                testID="delete-account-code"
              />
              <TouchableOpacity onPress={() => { setSentTo(''); setCode(''); }} style={{ paddingVertical: 4 }}>
                <Text style={{ color: colors.textSecondary, fontSize: 13, textDecorationLine: 'underline' }}>{t('delacc.resend')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      <TouchableOpacity
        onPress={() => setAck((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, paddingVertical: 4 }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: ack }}
        testID="delete-account-ack"
      >
        <View style={{
          width: 22, height: 22, borderRadius: 6, borderWidth: 2,
          borderColor: ack ? (colors.error || '#dc2626') : colors.border,
          backgroundColor: ack ? (colors.error || '#dc2626') : 'transparent',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {ack ? <IconCheck size={14} color="#fff" /> : null}
        </View>
        <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 }}>{tt('delacc.ack', { days })}</Text>
      </TouchableOpacity>
      {!!error && <Text style={[st.error, { color: colors.error, marginTop: 10 }]}>{error}</Text>}
      <View style={st.actions}>
        {inSheet ? null : (
          <TouchableOpacity onPress={() => { setOpen(false); resetSheet(); }} style={[st.cancelBtn, { borderColor: colors.border }]}>
            <Text style={[st.cancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={submit}
          disabled={!canDelete}
          style={[st.confirmBtn, { backgroundColor: colors.error, opacity: canDelete ? 1 : 0.4 }]}
          testID="delete-account-submit"
        >
          {deleting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.confirmBtnText}>{t('delacc.submit')}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View>
      <SettingsGroup footer={t('delacc.rowSub')}>
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
          testID="settings-row-delete-account"
          onPress={() => { resetSheet(); setOpen(true); loadInfo(); }}
        />
      </SettingsGroup>

      {collecting ? (
        <SettingsFormSheet visible={open} onClose={() => { setOpen(false); if (!deleting) resetSheet(); }} title={t('delacc.title')} doneLabel={t('common.cancel')} testID="delete-account-sheet">
          {renderBox(true)}
        </SettingsFormSheet>
      ) : (open && renderBox(false))}
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
