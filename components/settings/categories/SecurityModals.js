// [2026-10-15 settings-split] Modais de segurança da categoria Conta (antes
// no fim do app/settings.js, com ~30 useState na tela inteira). Cada modal é
// dono do próprio estado e só monta quando aberto. Mesmo visual/fluxo/APIs.
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable, ActivityIndicator,
  ScrollView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SheetKeyboardAvoider from '../../chat/SheetKeyboardAvoider';
import NativeSheetDialog from '../../NativeSheetDialog';
import { USE_NATIVE_SHEETS } from '../../NativeSheet';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { Spacing } from '../../../constants/theme';
import { IconCheck, IconShield } from '../../Icons';
import * as api from '../../../services/api';

const webShadow = Platform.OS === 'web' ? { boxShadow: '0 8px 28px rgba(0,0,0,0.16)' } : {};

// ── Alterar senha ──────────────────────────────────────────────────────────
export function ChangePasswordModal({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [cpCurrent, setCpCurrent] = useState('');
  const [cpNew, setCpNew] = useState('');
  const [cpConfirm, setCpConfirm] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpError, setCpError] = useState('');
  const [cpSuccess, setCpSuccess] = useState(false);
  const inputStyle = (mb) => ({
    borderWidth: 1,
    borderColor: cpError ? colors.error : colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surfaceVariant || colors.background,
    marginBottom: mb,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  });
  const label = { fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 };
  const reset = () => { setCpCurrent(''); setCpNew(''); setCpConfirm(''); setCpError(''); setCpSuccess(false); };
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <SheetKeyboardAvoider style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }} onPress={onClose}>
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{ margin: 20, backgroundColor: colors.surface, borderRadius: 20, padding: 24, ...webShadow }}
          >
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              {t('settings.changePassword') || 'Alterar senha'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textTertiary, marginBottom: 20 }}>
              {t('settings.changePasswordBody') || 'Sua nova senha precisa ter no mínimo 8 caracteres.'}
            </Text>
            <Text style={label}>{(t('settings.currentPassword') || 'Senha atual').toUpperCase()}</Text>
            <TextInput
              value={cpCurrent}
              onChangeText={v => { setCpCurrent(v); setCpError(''); }}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              placeholder="••••••••" placeholderTextColor={colors.textTertiary}
              style={inputStyle(14)} editable={!cpLoading}
            />
            <Text style={label}>{(t('settings.newPassword') || 'Nova senha').toUpperCase()}</Text>
            <TextInput
              value={cpNew}
              onChangeText={v => { setCpNew(v); setCpError(''); }}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              placeholder={t('settings.newPasswordPlaceholder') || 'Mínimo 8 caracteres'} placeholderTextColor={colors.textTertiary}
              style={inputStyle(14)} editable={!cpLoading}
            />
            <Text style={label}>{(t('settings.confirmNewPassword') || 'Confirmar nova senha').toUpperCase()}</Text>
            <TextInput
              value={cpConfirm}
              onChangeText={v => { setCpConfirm(v); setCpError(''); }}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              placeholder="••••••••" placeholderTextColor={colors.textTertiary}
              style={inputStyle(6)} editable={!cpLoading}
            />
            {cpError ? <Text style={{ color: colors.error, fontSize: 13, marginTop: 4 }}>{cpError}</Text> : null}
            {cpSuccess ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <IconCheck size={14} color={colors.success} />
                <Text style={{ color: colors.success, fontSize: 13, fontWeight: '600' }}>
                  {t('settings.passwordChanged') || 'Senha alterada com sucesso'}
                </Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
              <TouchableOpacity
                onPress={() => { onClose?.(); reset(); }}
                disabled={cpLoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: cpLoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setCpError(''); setCpSuccess(false);
                  if (!cpCurrent) { setCpError(t('settings.currentPasswordRequired') || 'Informe a senha atual'); return; }
                  if (cpNew.length < 8) { setCpError(t('settings.newPasswordTooShort') || 'Nova senha precisa ter 8+ caracteres'); return; }
                  if (cpNew !== cpConfirm) { setCpError(t('settings.passwordsDontMatch') || 'As senhas não coincidem'); return; }
                  setCpLoading(true);
                  // Ação sensível: pede Face ID / digital antes de trocar a senha.
                  try {
                    const { confirmWithBiometric } = require('../../../services/biometricGate');
                    const okBio = await confirmWithBiometric({ reason: t('settings.changePassword') || 'Alterar senha' });
                    if (!okBio) { setCpLoading(false); return; }
                  } catch {}
                  try {
                    const r = await api.changePassword(cpCurrent, cpNew);
                    if (r?.success) {
                      setCpSuccess(true);
                      setTimeout(() => { onClose?.(); setCpCurrent(''); setCpNew(''); setCpConfirm(''); setCpSuccess(false); }, 1400);
                    } else {
                      setCpError(r?.message || (t('settings.passwordChangeFailed') || 'Não foi possível alterar a senha'));
                    }
                  } catch (e) {
                    setCpError(e?.message || t('common.error'));
                  } finally {
                    setCpLoading(false);
                  }
                }}
                disabled={cpLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', opacity: cpLoading ? 0.6 : 1 }}
              >
                {cpLoading
                  ? <ActivityIndicator size="small" color={colors.onPrimary || '#fff'} />
                  : <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '700' }}>{t('settings.save') || t('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </SheetKeyboardAvoider>
    </Modal>
  );
}

// ── PIN de 4 dígitos (2FA e trava de registro anti-SIM-swap) ──────────────
export function PinModal({ visible, onClose, kind }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const reg = kind === 'regLock';
  const L = reg ? {
    title: t('settings.registrationLock') || 'PIN de segurança (anti-SIM-swap)',
    desc: t('settings.registrationLockDesc') || 'PIN extra no login por telefone — protege se trocarem seu chip.',
    ok: t('settings.registrationLockEnabled') || 'PIN ativado com sucesso',
    len: t('settings.registrationLockPinLen') || 'Digite os 4 dígitos',
    fail: t('settings.registrationLockFailed') || 'Não foi possível ativar o PIN',
    enable: t('settings.registrationLockEnable') || 'Ativar PIN',
  } : {
    title: t('settings.twoFactor') || 'Verificação em duas etapas',
    desc: t('settings.twoFactorDesc') || 'Adicione uma camada extra de segurança ao seu Chatyy',
    ok: t('settings.twoFactorEnabled') || 'PIN ativado com sucesso',
    len: t('settings.twoFactorPinLen') || 'Digite os 4 dígitos',
    fail: t('settings.twoFactorFailed') || 'Não foi possível ativar o PIN',
    enable: t('settings.twoFactorEnable') || 'Ativar PIN',
  };
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = useRef([null, null, null, null]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    if (!visible) return undefined;
    setDigits(['', '', '', '']); setError(''); setSuccess(false);
    const tm = setTimeout(() => { try { refs.current[0]?.focus?.(); } catch {} }, 250);
    return () => clearTimeout(tm);
  }, [visible]);
  const submit = async () => {
    const pin = digits.join('');
    if (pin.length !== 4) { setError(L.len); return; }
    setError(''); setLoading(true);
    try {
      const r = reg ? await api.setRegistrationLock(pin) : await api.enable2fa(pin);
      if (r?.success) {
        setSuccess(true);
        setTimeout(() => { onClose?.(); setSuccess(false); }, 1100);
      } else setError(r?.message || L.fail);
    } catch (e) {
      setError(e?.message || L.fail);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <SheetKeyboardAvoider style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }} onPress={onClose}>
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{ margin: 20, backgroundColor: colors.surface, borderRadius: 20, padding: 24, ...webShadow }}
          >
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconShield size={28} color={colors.primary} />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' }}>{L.title}</Text>
              <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>{L.desc}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 18 }}>
              {[0, 1, 2, 3].map(idx => (
                <TextInput
                  key={idx}
                  ref={el => { refs.current[idx] = el; }}
                  value={digits[idx]}
                  onChangeText={(v) => {
                    const digit = (v || '').replace(/\D/g, '').slice(-1);
                    setDigits(prev => { const next = [...prev]; next[idx] = digit; return next; });
                    setError('');
                    if (digit && idx < 3) { try { refs.current[idx + 1]?.focus?.(); } catch {} }
                  }}
                  onKeyPress={(e) => {
                    if (e?.nativeEvent?.key === 'Backspace' && !digits[idx] && idx > 0) {
                      try { refs.current[idx - 1]?.focus?.(); } catch {}
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  secureTextEntry
                  style={{
                    width: 56, height: 64, borderRadius: 14,
                    borderWidth: 1.5, borderColor: digits[idx] ? colors.primary : colors.border,
                    backgroundColor: colors.surfaceVariant || colors.surface,
                    color: colors.text, textAlign: 'center',
                    fontSize: 26, fontWeight: '700',
                    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
                  }}
                />
              ))}
            </View>
            {!!error && <Text style={{ color: colors.error || '#EF4444', fontSize: 13, textAlign: 'center', marginBottom: 8 }}>{error}</Text>}
            {success && <Text style={{ color: colors.success, fontSize: 13, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>{L.ok}</Text>}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                disabled={loading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: loading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={loading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', opacity: loading ? 0.6 : 1 }}
              >
                {loading
                  ? <ActivityIndicator size="small" color={colors.onPrimary || '#fff'} />
                  : <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '700' }}>{L.enable}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </SheetKeyboardAvoider>
    </Modal>
  );
}

// ── Backup com criptografia (criar / redefinir frase) ─────────────────────
// A frase nunca sai do aparelho: chave derivada localmente, só o
// ciphertext + hash vão ao servidor (e2eeBackupEscrowPut).
export function BackupPassphraseModal({ visible, onClose, rotate }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    // A redefinição sempre abre limpa (como antes); a criação mantém o rascunho.
    if (visible && rotate) { setPass(''); setPass2(''); setMsg(''); }
  }, [visible, rotate]);
  const close = () => { if (!busy) onClose?.(); };
  const submit = async () => {
    setMsg('');
    if (!pass || pass.length < 8) { setMsg(rotate ? (t('settings.backupKey.tooShort') || 'Use ao menos 8 caracteres') : t('settings.backupKey.tooShort')); return; }
    if (pass !== pass2) { setMsg(rotate ? (t('settings.backupKey.mismatch') || 'As frases não coincidem') : t('settings.backupKey.mismatch')); return; }
    setBusy(true);
    try {
      const nacl = require('tweetnacl');
      const naclUtil = require('tweetnacl-util');
      const e2e = require('../../../services/e2e');
      const ikPub = (await e2e.getPublicKeyBase64?.()) || '';
      const blob = JSON.stringify({ v: 1, ik_pub: ikPub, ts: Date.now() });
      let key = naclUtil.decodeUTF8(pass);
      for (let i = 0; i < 100000; i++) key = nacl.hash(key);
      key = key.slice(0, nacl.secretbox.keyLength);
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const ct = nacl.secretbox(naclUtil.decodeUTF8(blob), nonce, key);
      const passHash = Array.from(nacl.hash(naclUtil.decodeUTF8(pass)).slice(0, 32))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const salt = naclUtil.encodeBase64(nacl.randomBytes(16));
      const r = await api.e2eeBackupEscrowPut?.({
        ciphertext: naclUtil.encodeBase64(ct), salt, nonce: naclUtil.encodeBase64(nonce),
        kdfIters: 100000, passphraseHash: passHash,
        deviceLabel: Platform.OS, ...(rotate ? { rotate: true } : {}),
      });
      if (r?.success) {
        setMsg('OK ' + (rotate ? (t('settings.backupKey.rotated') || 'Senha redefinida') : (t('settings.e2eBackupSaved') || 'Backup criado')));
        setPass(''); setPass2('');
        setTimeout(() => onClose?.(), 1200);
      } else {
        setMsg(r?.message || (rotate ? (t('settings.backupKey.failed') || 'Falha ao redefinir') : t('vacation.saveError')));
      }
    } catch (err) {
      setMsg(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };
  const field = (mb) => ({
    borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: 10, padding: 12, marginBottom: mb,
    color: colors.text, backgroundColor: colors.background,
  });
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <SheetKeyboardAvoider style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }} onPress={close}>
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ backgroundColor: colors.surface, borderRadius: 18, padding: rotate ? 22 : 20 }}>
            <Text style={{ color: colors.text, fontWeight: rotate ? '800' : '700', fontSize: rotate ? 18 : 17, marginBottom: 6 }}>
              {rotate ? (t('settings.backupKey.rotate') || 'Redefinir senha do backup') : (t('settings.e2eBackup') || 'Backup com criptografia')}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 14 }}>
              {rotate
                ? (t('settings.backupKey.warning') || 'Atenção: backups antigos deixarão de ser restauráveis com a senha anterior. Anote a nova senha em local seguro.')
                : (t('settings.e2eBackupSetPass') || 'Defina sua frase secreta')}
            </Text>
            <TextInput
              value={pass} onChangeText={setPass} secureTextEntry
              placeholder={t('settings.backupKey.newPass') || 'Nova frase secreta'} placeholderTextColor={colors.textTertiary}
              style={field(10)} editable={!busy}
            />
            <TextInput
              value={pass2} onChangeText={setPass2} secureTextEntry
              placeholder={t('settings.backupKey.repeatPass') || 'Repita a frase'} placeholderTextColor={colors.textTertiary}
              style={field(12)} editable={!busy}
            />
            {msg ? (
              <Text style={{ color: msg.startsWith('OK') ? colors.success : colors.error, fontSize: 13, marginBottom: 10 }}>
                {msg.replace(/^OK /, '')}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={close}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center' }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={busy}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', opacity: busy ? 0.5 : 1 }}
              >
                {busy
                  ? <ActivityIndicator size="small" color={colors.onPrimary || '#fff'} />
                  : <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </SheetKeyboardAvoider>
    </Modal>
  );
}

// ── Histórico de logins (últimos 30 dias; só leitura) ─────────────────────
export function LoginHistorySheet({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await api.getLoginHistory?.();
        if (!alive) return;
        if (r?.success && Array.isArray(r?.data?.events)) setList(r.data.events);
        else if (Array.isArray(r?.data)) setList(r.data);
        else setList([]);
      } catch { if (alive) setList([]); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [visible]);
  return (
    <NativeSheetDialog
      visible={!!visible}
      onClose={onClose}
      animationType="slide"
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
      panelStyle={{
        backgroundColor: colors.surface,
        borderTopLeftRadius: 20, borderTopRightRadius: 20,
        padding: Spacing.lg,
        paddingBottom: Spacing.lg + (USE_NATIVE_SHEETS ? 0 : insets.bottom),
        maxHeight: '70%',
      }}
    >
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: Spacing.md }}>
        {t('settings.loginAlerts.history') || 'Histórico de logins'}
      </Text>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: Spacing.lg }} />
      ) : list.length === 0 ? (
        <Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.lg }}>
          {t('settings.loginAlerts.empty') || 'Nenhum login recente'}
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 400 }}>
          {list.map((ev, idx) => {
            const device = ev.device || ev.user_agent || ev.client || '—';
            const ip = ev.ip || ev.ip_address || '';
            const when = ev.created_at || ev.timestamp || ev.ts || '';
            return (
              <View key={ev.id || ev.session_id || idx} style={{ paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderLight }}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{device}</Text>
                <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 2 }}>{ip}{ip && when ? ' • ' : ''}{when}</Text>
              </View>
            );
          })}
        </ScrollView>
      )}
      <TouchableOpacity
        style={{ marginTop: Spacing.md, alignSelf: 'center', paddingVertical: Spacing.md, paddingHorizontal: Spacing.xl }}
        onPress={onClose}
      >
        <Text style={{ color: colors.primary, fontWeight: '600' }}>{t('common.close') || 'Fechar'}</Text>
      </TouchableOpacity>
    </NativeSheetDialog>
  );
}
