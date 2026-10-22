// [e2ee5 WP-14 2026-10-21] /e2ee-backup — backup das chaves das conversas protegidas (E2EE v5).
//
// Ativar: chave de recuperação de 48 caracteres (recomendado; mostrar, copiar e confirmar 2 grupos)
// ou senha forte (Argon2id no núcleo). Trocar e desativar. O servidor guarda só dados cifrados.
// A chave aparece UMA vez: não é salva no aparelho nem enviada a lugar nenhum em claro. Se o usuário
// sai antes de confirmar que guardou a chave, o backup recém-criado é desfeito (nunca fica um backup
// com uma chave que ninguém tem).
// Tudo atrás de __chatyy_e2ee5 + flag e2ee5_backup (services/e2ee/backup.backupOnSync).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import SheetKeyboardAvoider from '../components/chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: teclado não cobre campos (edge-to-edge)
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconCloud, IconCloudCheck, IconCopy, IconKey, IconLock, IconRefresh, IconTrash } from '../components/Icons';
import { useGroupedColors, SettingsGroup, SettingsRow, SettingsIconTile } from '../components/settings/SettingsKit';
import { tx } from '../components/e2ee/e2eeUi';
import * as backup from '../services/e2ee/backup';

let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}

function notify(title, body) {
  if (Platform.OS === 'web') { try { window.alert(body ? `${title}\n\n${body}` : title); } catch {} return; }
  try { Alert.alert(title, body || undefined); } catch {}
}
function confirmAsk(title, body, okLabel, cancelLabel) {
  return new Promise((res) => {
    if (Platform.OS === 'web') { try { res(!!window.confirm(`${title}\n\n${body}`)); } catch { res(false); } return; }
    Alert.alert(title, body, [{ text: cancelLabel, style: 'cancel', onPress: () => res(false) }, { text: okLabel, style: 'destructive', onPress: () => res(true) }]);
  });
}

function errMsg(t, code) {
  switch (code) {
    case 'not_primary': return tx(t, 'e2ee5.backup.err_not_primary', 'O backup é feito pelo celular principal da conta.');
    case 'weak_password': return tx(t, 'e2ee5.backup.err_weak', 'Use uma senha mais forte: pelo menos 12 caracteres, misturando letras, números ou símbolos.');
    case 'network': return tx(t, 'e2ee5.backup.err_network', 'Sem conexão. Verifique a internet e tente de novo.');
    case 'disabled': return tx(t, 'e2ee5.backup.err_disabled', 'O backup ainda não está disponível na sua conta.');
    default: return tx(t, 'e2ee5.backup.err_failed', 'Não foi possível concluir. Tente de novo.');
  }
}

export default function E2eeBackupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const g = useGroupedColors();
  const { t } = useLanguage();
  const [st, setSt] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | unavailable | off | password | key | confirm | on
  const [busy, setBusy] = useState(false);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [key, setKey] = useState(''); // SÓ em memória, some ao sair
  const [idx, setIdx] = useState([0, 1]);
  const [ans, setAns] = useState(['', '']);
  const [ansErr, setAnsErr] = useState(false);
  const pendingRef = useRef(false); // backup criado e ainda não confirmado
  const changingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await backup.getState();
      setSt(s);
      setPhase(!s.available ? 'unavailable' : s.enabled ? 'on' : 'off');
    } catch { setPhase('unavailable'); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Saiu sem confirmar a chave: desfaz (ninguém fica com backup de chave perdida).
  useEffect(() => () => {
    if (pendingRef.current) { pendingRef.current = false; backup.disable().catch(() => {}); }
  }, []);

  const back = () => { try { router.back(); } catch { router.replace('/settings'); } };

  const doEnable = async (passphrase) => {
    setBusy(true);
    try {
      const r = await backup.enable({ passphrase });
      if (passphrase) {
        setPass1(''); setPass2('');
        pendingRef.current = false;
        changingRef.current = false;
        notify(tx(t, 'e2ee5.backup.done_title', 'Backup ativado'), tx(t, 'e2ee5.backup.done_password', 'Para restaurar num celular novo, use esta senha. Sem ela, as conversas protegidas antigas não voltam.'));
        await refresh();
      } else {
        pendingRef.current = true;
        setKey(backup.formatRecoveryKey(r.recoveryKey));
        setIdx(backup.pickConfirmGroups(r.recoveryKey));
        setAns(['', '']); setAnsErr(false);
        setPhase('key');
      }
    } catch (e) {
      notify(tx(t, 'common.error', 'Erro'), errMsg(t, e && e.code));
    }
    setBusy(false);
  };

  const copyKey = async () => {
    if (!Clipboard || !key) return;
    try {
      await Clipboard.setStringAsync(key);
      notify(tx(t, 'e2ee5.backup.copied', 'Chave copiada'), tx(t, 'e2ee5.backup.copied_body', 'Cole num gerenciador de senhas ou num lugar seguro. A área de transferência será limpa em 1 minuto.'));
      const copied = key;
      setTimeout(async () => { try { const cur = await Clipboard.getStringAsync(); if (cur === copied) await Clipboard.setStringAsync(''); } catch {} }, 60000);
    } catch {}
  };

  const confirmKey = () => {
    if (!backup.checkConfirmGroups(key, idx, ans)) { setAnsErr(true); return; }
    pendingRef.current = false;
    changingRef.current = false;
    setKey('');
    notify(tx(t, 'e2ee5.backup.done_title', 'Backup ativado'), tx(t, 'e2ee5.backup.done_key', 'Guarde a chave de recuperação. Sem ela, ao trocar de celular as conversas protegidas antigas não voltam.'));
    refresh();
  };

  const doDisable = async () => {
    const ok = await confirmAsk(
      tx(t, 'e2ee5.backup.disable_title', 'Desativar o backup?'),
      tx(t, 'e2ee5.backup.disable_body', 'A cópia das chaves é apagada do servidor. Se você trocar de celular, as conversas protegidas antigas não voltam.'),
      tx(t, 'e2ee5.backup.disable', 'Desativar'),
      tx(t, 'common.cancel', 'Cancelar'),
    );
    if (!ok) return;
    try { const { confirmWithBiometric } = require('../services/biometricGate'); if (!(await confirmWithBiometric({ reason: tx(t, 'e2ee5.backup.disable', 'Desativar') }))) return; } catch {}
    setBusy(true);
    try { await backup.disable(); await refresh(); } catch (e) { notify(tx(t, 'common.error', 'Erro'), errMsg(t, e && e.code)); }
    setBusy(false);
  };

  const startChange = async () => {
    try { const { confirmWithBiometric } = require('../services/biometricGate'); if (!(await confirmWithBiometric({ reason: tx(t, 'e2ee5.backup.change', 'Trocar chave ou senha') }))) return; } catch {}
    changingRef.current = true;
    setPhase('off');
  };

  const nowBackup = async () => {
    setBusy(true);
    try { await backup.backupNow(); await refresh(); } catch {}
    setBusy(false);
  };

  const strength = backup.passwordStrength(pass1);
  const passOk = strength.ok && pass1 === pass2;
  const groups = key ? backup.recoveryGroups(key) : [];
  const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });
  const inputStyle = [st.input, { color: g.text, borderColor: g.separator, backgroundColor: g.cardBg }];

  return (
    <SheetKeyboardAvoider style={[st.root, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: tx(t, 'e2ee5.backup.header', 'Backup das conversas protegidas'), headerStyle: { backgroundColor: g.pageBg }, headerShadowVisible: false, contentStyle: { backgroundColor: g.pageBg } })} />
      ) : (
        <View style={st.header}>
          <TouchableOpacity onPress={back} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tx(t, 'common.back', 'Voltar')}>
            <IconArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[st.title, { color: colors.text }]} numberOfLines={1}>{tx(t, 'e2ee5.backup.header', 'Backup das conversas protegidas')}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={[st.scroll, { paddingBottom: 32 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        {phase === 'loading' && <ActivityIndicator color={g.secondary} style={{ marginTop: 40 }} />}

        {phase === 'unavailable' && (
          <View style={[st.card, { backgroundColor: g.cardBg }]}>
            <SettingsIconTile Icon={IconCloud} size={48} muted />
            <Text style={[st.cardTitle, { color: g.text }]}>{tx(t, 'e2ee5.backup.unavailable', 'Backup indisponível')}</Text>
            <Text style={[st.cardBody, { color: g.secondary }]}>{errMsg(t, 'disabled')}</Text>
          </View>
        )}

        {phase === 'off' && (
          <>
            <View style={[st.card, { backgroundColor: g.cardBg }]}>
              <SettingsIconTile Icon={IconCloud} size={48} />
              <Text style={[st.cardTitle, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.enable', 'Ativar o backup')}</Text>
              <Text style={[st.cardBody, { color: g.secondary }]}>
                {tx(t, 'e2ee5.backup.intro', 'Guarde no servidor, cifradas, as chaves das suas conversas com criptografia de ponta a ponta. Ao trocar ou reinstalar o celular, você recupera o histórico com a chave de recuperação ou a senha. Nem o Chatyy consegue abrir.')}
              </Text>
              {!st?.isPrimary && <Text style={[st.cardBody, { color: g.text, marginTop: 10 }]}>{errMsg(t, 'not_primary')}</Text>}
            </View>
            <SettingsGroup>
              <SettingsRow icon={IconKey} title={tx(t, 'e2ee5.backup.use_key', 'Usar chave de recuperação')} subtitle={tx(t, 'e2ee5.backup.use_key_sub', 'Recomendado. Uma chave de 48 caracteres que só você tem.')}
                onPress={busy || !st?.isPrimary ? undefined : () => doEnable('')} right={busy ? <ActivityIndicator color={g.secondary} size="small" /> : undefined} testID="e2ee5-backup-use-key" />
              <SettingsRow icon={IconLock} title={tx(t, 'e2ee5.backup.use_password', 'Usar uma senha')} subtitle={tx(t, 'e2ee5.backup.use_password_sub', 'Uma senha forte que você consiga lembrar.')}
                onPress={busy || !st?.isPrimary ? undefined : () => setPhase('password')} testID="e2ee5-backup-use-password" />
            </SettingsGroup>
            {changingRef.current && (
              <Pressable onPress={() => { changingRef.current = false; refresh(); }} style={st.ghost} accessibilityRole="button">
                <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'common.cancel', 'Cancelar')}</Text>
              </Pressable>
            )}
          </>
        )}

        {phase === 'password' && (
          <View style={[st.card, { backgroundColor: g.cardBg, alignItems: 'stretch' }]}>
            <Text style={[st.cardTitle, { color: g.text, textAlign: 'left' }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.password_title', 'Crie uma senha para o backup')}</Text>
            <Text style={[st.cardBody, { color: g.secondary, textAlign: 'left' }]}>{tx(t, 'e2ee5.backup.password_body', 'Pelo menos 12 caracteres, misturando letras, números ou símbolos. Não use a senha da sua conta. Se esquecer, o Chatyy não consegue recuperar.')}</Text>
            <TextInput style={inputStyle} value={pass1} onChangeText={setPass1} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" placeholder={tx(t, 'e2ee5.backup.password', 'Senha')} placeholderTextColor={g.secondary} testID="e2ee5-backup-pass1" />
            <TextInput style={inputStyle} value={pass2} onChangeText={setPass2} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" placeholder={tx(t, 'e2ee5.backup.password_again', 'Repita a senha')} placeholderTextColor={g.secondary} testID="e2ee5-backup-pass2" />
            {!!pass1 && !strength.ok && <Text style={[st.hint, { color: g.destructive }]}>{errMsg(t, 'weak_password')}</Text>}
            {!!pass2 && strength.ok && pass1 !== pass2 && <Text style={[st.hint, { color: g.destructive }]}>{tx(t, 'e2ee5.backup.password_mismatch', 'As senhas não são iguais.')}</Text>}
            <Pressable onPress={passOk && !busy ? () => doEnable(pass1) : undefined} accessibilityRole="button" accessibilityState={{ disabled: !passOk || busy }} testID="e2ee5-backup-pass-ok"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: !passOk || busy ? 0.4 : pressed ? 0.85 : 1 }]}>
              {busy ? <ActivityIndicator color={g.onInk} /> : <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'e2ee5.backup.enable', 'Ativar o backup')}</Text>}
            </Pressable>
            <Pressable onPress={() => { setPass1(''); setPass2(''); setPhase('off'); }} style={st.ghost} accessibilityRole="button">
              <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'common.back', 'Voltar')}</Text>
            </Pressable>
          </View>
        )}

        {phase === 'key' && (
          <View style={[st.card, { backgroundColor: g.cardBg, alignItems: 'stretch' }]}>
            <Text style={[st.cardTitle, { color: g.text, textAlign: 'left' }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.key_title', 'Sua chave de recuperação')}</Text>
            <Text style={[st.cardBody, { color: g.secondary, textAlign: 'left' }]}>{tx(t, 'e2ee5.backup.key_body', 'Anote ou guarde num gerenciador de senhas. Ela é a única forma de recuperar as conversas protegidas num celular novo. O Chatyy não tem uma cópia.')}</Text>
            <View style={[st.keyBox, { borderColor: g.separator }]} accessible accessibilityLabel={groups.join(', ')} testID="e2ee5-backup-key">
              {groups.map((gr, i) => (
                <Text key={i} style={[st.keyGroup, { color: g.text, fontFamily: mono }]} selectable>{gr}</Text>
              ))}
            </View>
            {!!Clipboard && (
              <Pressable onPress={copyKey} accessibilityRole="button" style={({ pressed }) => [st.copyBtn, { backgroundColor: g.fill, opacity: pressed ? 0.7 : 1 }]} testID="e2ee5-backup-copy">
                <IconCopy size={16} color={g.text} />
                <Text style={[st.copyText, { color: g.text }]}>{tx(t, 'e2ee5.backup.copy', 'Copiar chave')}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setPhase('confirm')} accessibilityRole="button" testID="e2ee5-backup-saved"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'e2ee5.backup.saved', 'Já guardei a chave')}</Text>
            </Pressable>
          </View>
        )}

        {phase === 'confirm' && (
          <View style={[st.card, { backgroundColor: g.cardBg, alignItems: 'stretch' }]}>
            <Text style={[st.cardTitle, { color: g.text, textAlign: 'left' }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.confirm_chunks', 'Confirme a chave')}</Text>
            <Text style={[st.cardBody, { color: g.secondary, textAlign: 'left' }]}>
              {tx(t, 'e2ee5.backup.confirm_body', 'Digite o grupo {a} e o grupo {b} da sua chave (cada grupo tem 4 caracteres).', { a: idx[0] + 1, b: (idx[1] != null ? idx[1] : idx[0]) + 1 })}
            </Text>
            {idx.map((n, j) => (
              <TextInput key={n} style={[inputStyle, { fontFamily: mono }]} value={ans[j]} onChangeText={(v) => { const a = ans.slice(); a[j] = v; setAns(a); setAnsErr(false); }}
                autoCapitalize="none" autoCorrect={false} maxLength={6} placeholder={tx(t, 'e2ee5.backup.group_n', 'Grupo {n}', { n: n + 1 })} placeholderTextColor={g.secondary} testID={`e2ee5-backup-ans-${j}`} />
            ))}
            {ansErr && <Text style={[st.hint, { color: g.destructive }]}>{tx(t, 'e2ee5.backup.confirm_wrong', 'Não confere. Veja a chave de novo.')}</Text>}
            <Pressable onPress={confirmKey} accessibilityRole="button" testID="e2ee5-backup-confirm"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'e2ee5.backup.confirm_btn', 'Confirmar')}</Text>
            </Pressable>
            <Pressable onPress={() => setPhase('key')} style={st.ghost} accessibilityRole="button">
              <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'e2ee5.backup.show_again', 'Ver a chave de novo')}</Text>
            </Pressable>
          </View>
        )}

        {phase === 'on' && (
          <>
            <View style={[st.card, { backgroundColor: g.cardBg }]}>
              <SettingsIconTile Icon={IconCloudCheck} size={48} />
              <Text style={[st.cardTitle, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.on', 'Backup ativado')}</Text>
              <Text style={[st.cardBody, { color: g.secondary }]}>
                {st?.mode === 'password' ? tx(t, 'e2ee5.backup.on_password', 'Ativado · protegido por senha') : tx(t, 'e2ee5.backup.on_key', 'Ativado · protegido por chave de recuperação')}
              </Text>
              {!!st && st.totalKeys > 0 && (
                <Text style={[st.cardBody, { color: g.secondary }]}>
                  {st.backedUpKeys >= st.totalKeys
                    ? tx(t, 'e2ee5.backup.all_saved', 'Todas as chaves estão no backup.')
                    : tx(t, 'e2ee5.backup.progress', '{n} de {total} chaves no backup', { n: st.backedUpKeys, total: st.totalKeys })}
                </Text>
              )}
            </View>
            <SettingsGroup>
              {!!st && st.backedUpKeys < st.totalKeys && (
                <SettingsRow icon={IconRefresh} title={tx(t, 'e2ee5.backup.now', 'Fazer backup agora')} onPress={busy ? undefined : nowBackup} right={busy ? <ActivityIndicator color={g.secondary} size="small" /> : undefined} />
              )}
              <SettingsRow icon={IconKey} title={tx(t, 'e2ee5.backup.change', 'Trocar chave ou senha')} subtitle={tx(t, 'e2ee5.backup.change_sub', 'A chave ou senha antiga deixa de funcionar.')} onPress={busy ? undefined : startChange} testID="e2ee5-backup-change" />
              <SettingsRow icon={IconTrash} title={tx(t, 'e2ee5.backup.disable', 'Desativar')} destructive onPress={busy ? undefined : doDisable} testID="e2ee5-backup-disable" />
            </SettingsGroup>
          </>
        )}
      </ScrollView>
    </SheetKeyboardAvoider>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700', marginLeft: 6 },
  scroll: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  card: { borderRadius: 22, padding: 20, marginBottom: 20, alignItems: 'center' },
  cardTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center', marginTop: 12 },
  cardBody: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, minHeight: 48, fontSize: 16, marginTop: 12 },
  hint: { fontSize: 13, marginTop: 8 },
  cta: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 18, alignSelf: 'stretch' },
  ctaText: { fontSize: 16, fontWeight: '600' },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ghostText: { fontSize: 15.5, fontWeight: '600' },
  keyBox: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', borderWidth: 1, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 8, marginTop: 16 },
  keyGroup: { width: '25%', textAlign: 'center', fontSize: 17, fontWeight: '600', letterSpacing: 1, paddingVertical: 6 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, borderRadius: 12, marginTop: 12 },
  copyText: { fontSize: 15, fontWeight: '600' },
});
