// CloudBackupCard — "Backup da conversa" v4 (nuvem do Chatyy, CYB4). [backup-nuvem 2026-10-22]
// Só aparece com globalThis.__chatyy_cloud_backup === true E o servidor liberando a conta.
// A chave é a mesma do bloco "Backup no Chatyy" acima (OwnBackupCard): sem ela, pede para configurar lá.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet, Platform, Alert } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconCloudUpload, IconTrash, IconRefresh } from './Icons';
import * as cloud from '../services/cloudBackup';
import { fmtBytes, fmtDate } from './OwnBackupCard';

const FREQS = ['daily', 'weekly', 'off'];

function errText(t, code) {
  const m = {
    ERR_NETWORK: t('cbk4.errNetwork', 'Sem conexão. Tente de novo.'),
    ERR_NETWORK_POLICY: t('cbk4.errWifi', 'Aguardando Wi-Fi (ou ligue "Usar dados móveis").'),
    ERR_QUOTA: t('cbk4.errQuota', 'Sem espaço no seu plano para o backup.'),
    ERR_MISSING: t('cbk4.errMissing', 'Parte do backup não está mais na nuvem. Faça um backup novo.'),
    ERR_DECRYPT: t('cbk4.errBadKey', 'Essa chave não abre este backup.'),
    ERR_TOO_LARGE: t('cbk4.errTooLarge', 'O backup ficou grande demais. Desligue "Incluir vídeos" e tente de novo.'),
    ERR_NOT_SETUP: t('cbk4.errNoKey', 'Configure a chave do backup no bloco acima.'),
    ERR_NEED_KEY: t('cbk4.errNeedKey', 'Digite a chave ou a senha do backup no bloco acima.'),
    ERR_BAD_KEY: t('cbk4.errBadKey', 'Essa chave não abre este backup.'),
    ERR_BUSY: t('cbk4.errBusy', 'Já tem um backup em andamento.'),
    ERR_DISABLED: t('cbk4.errOff', 'Backup na nuvem indisponível para a conta.'),
  };
  return m[code] || t('cbk4.errGeneric', 'Não foi possível concluir. Tente de novo.');
}

function confirmAsync(title, msg, ok, cancel) {
  if (Platform.OS === 'web') { try { return Promise.resolve(!!globalThis.confirm?.(`${title}\n\n${msg}`)); } catch { return Promise.resolve(false); } }
  return new Promise((resolve) => Alert.alert(title, msg, [
    { text: cancel, style: 'cancel', onPress: () => resolve(false) },
    { text: ok, style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

export default function CloudBackupCard() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [srv, setSrv] = useState(null);
  const [prefs, setPrefsState] = useState(null);
  const [local, setLocal] = useState(null);
  const [progress, setProgress] = useState(cloud.getProgress());
  const [busy, setBusy] = useState(cloud.isRunning());
  const [msg, setMsg] = useState('');
  const [pendingRst, setPendingRst] = useState(null);

  const load = useCallback(async () => {
    if (!cloud.isOn()) return;
    try { setSrv(await cloud.status()); } catch { setSrv({ enabled: false }); }
    try { setPrefsState(await cloud.getPrefs()); } catch {}
    try { setLocal(await cloud.localSummary()); } catch {}
    try { setPendingRst(await cloud.pendingRestore()); } catch {}
  }, []);
  useEffect(() => { load(); return cloud.subscribe((p) => { setProgress(p); setBusy(cloud.isRunning()); }); }, [load]);

  if (!cloud.isOn() || !srv?.enabled) return null;
  const last = srv.sets?.[0] || null;
  const fg = colors.text;

  const runNow = async () => {
    setMsg(''); setBusy(true);
    try {
      const r = await cloud.runBackup({ manual: true });
      let m = t('cbk4.doneMedia', 'Backup concluído: {n} mensagens e {m} arquivos de mídia.').replace('{n}', String(r.msg_count)).replace('{m}', String(r.media_count || 0));
      if (r.quota_hit) m += ' ' + t('cbk4.mediaQuota', 'Parte da mídia ficou de fora: acabou o espaço do backup.');
      setMsg(m);
    } catch (e) { setMsg(errText(t, e?.code)); }
    setBusy(false); load();
  };
  const restoreNow = async () => {
    if (!last) return;
    const ok = await confirmAsync(t('cbk4.restoreTitle', 'Restaurar backup'),
      t('cbk4.restoreBody', 'As conversas do backup de {d} vão para este aparelho. O que já está aqui continua.').replace('{d}', fmtDate(last.created_at)),
      t('cbk4.restore', 'Restaurar'), t('common.cancel', 'Cancelar'));
    if (!ok) return;
    setMsg(''); setBusy(true);
    try {
      const r = await cloud.restore(last);
      setMsg(t('cbk4.restoredMedia', '{n} mensagens e {m} arquivos de mídia restaurados.').replace('{n}', String(r.msg_count)).replace('{m}', String(r.media_count || 0)));
    } catch (e) { setMsg(errText(t, e?.code)); }
    setBusy(false); load();
  };
  const resumeNow = async () => {
    setMsg(''); setBusy(true);
    try {
      const r = await cloud.resumePendingRestore();
      if (r?.ran) setMsg(t('cbk4.restoredMedia', '{n} mensagens e {m} arquivos de mídia restaurados.').replace('{n}', String(r.result?.msg_count || 0)).replace('{m}', String(r.result?.media_count || 0)));
      else if (r?.error) setMsg(errText(t, r.error));
      else if (r?.skipped === 'no_key') setMsg(errText(t, 'ERR_NEED_KEY'));
    } catch (e) { setMsg(errText(t, e?.code)); }
    setBusy(false); load();
  };
  const delAll = async () => {
    const ok = await confirmAsync(t('cbk4.deleteTitle', 'Apagar backup da nuvem'),
      t('cbk4.deleteBody', 'Os backups das conversas guardados na nuvem do Chatyy serão apagados. As conversas deste aparelho continuam.'),
      t('common.delete', 'Apagar'), t('common.cancel', 'Cancelar'));
    if (!ok) return;
    setBusy(true);
    try { await cloud.deleteAll(); setMsg(t('cbk4.deleted', 'Backup apagado.')); } catch (e) { setMsg(errText(t, e?.code)); }
    setBusy(false); load();
  };
  const setP = async (patch) => { setPrefsState(await cloud.setPrefs(patch)); };
  const freqLabel = { daily: t('cbk4.daily', 'Diário'), weekly: t('cbk4.weekly', 'Semanal'), off: t('cbk4.off', 'Só manual') };
  const pct = progress && progress.total && !['done', 'error', 'restored'].includes(progress.phase) ? Math.max(0.03, Math.min(1, (progress.done || 0) / progress.total)) : null;

  return (
    <View style={[st.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="cbk4-card">
      <View style={st.row}>
        <IconCloudUpload size={18} color={fg} />
        <Text style={[st.title, { color: fg }]}>{t('cbk4.title', 'Backup da conversa')}</Text>
      </View>
      <Text style={[st.small, { color: colors.textSecondary }]}>
        {t('cbk4.subtitle', 'Cifrado neste aparelho e guardado na nuvem do Chatyy. Nem o Chatyy consegue ler. Conta no espaço do seu plano.')}
      </Text>
      <Text style={[st.body, { color: fg, marginTop: Spacing.md }]} testID="cbk4-last">
        {last
          ? t('cbk4.last', 'Último backup: {d} · {s} · {n} mensagens')
            .replace('{d}', fmtDate(last.created_at)).replace('{s}', fmtBytes(last.size_bytes)).replace('{n}', String(last.msg_count))
            + (last.media_count ? ' · ' + t('cbk4.lastMedia', '{m} de mídia').replace('{m}', String(last.media_count)) : '')
          : t('cbk4.never', 'Ainda não há backup na nuvem.')}
      </Text>
      {local?.quotaHit ? (
        <Text style={[st.small, { color: colors.textSecondary }]} testID="cbk4-quota-hit">
          {t('cbk4.mediaQuota', 'Parte da mídia ficou de fora: acabou o espaço do backup.')}
        </Text>
      ) : null}
      {srv.quota ? (
        <Text style={[st.small, { color: colors.textSecondary }]}>
          {t('cbk4.used', 'Espaço usado pelo backup: {s}').replace('{s}', fmtBytes(srv.quota.backup_used))}
          {srv.quota.cap ? ' ' + t('cbk4.capOf', 'de {s}').replace('{s}', fmtBytes(srv.quota.cap)) : ''}
        </Text>
      ) : null}

      {pct != null ? (
        <View style={{ marginTop: Spacing.md }}>
          <View style={[st.barTrack, { backgroundColor: colors.border }]}><View style={[st.barFill, { backgroundColor: fg, width: `${Math.round(pct * 100)}%` }]} /></View>
          <Text style={[st.small, { color: colors.textSecondary }]}>
            {(progress.phase === 'restore' ? t('cbk4.phaseRestore', 'Restaurando') : progress.phase === 'media' ? t('cbk4.phaseMedia', 'Copiando fotos, áudios e documentos') : t('cbk4.phaseBackup', 'Fazendo backup'))} · {progress.done || 0}/{progress.total}
          </Text>
        </View>
      ) : null}

      <Text style={[st.small, { color: colors.textSecondary, marginTop: Spacing.md }]}>{t('cbk4.freq', 'Frequência')}</Text>
      <View style={[st.row, { flexWrap: 'wrap' }]}>
        {FREQS.map((f) => {
          const on = (prefs?.freq || 'daily') === f;
          return (
            <TouchableOpacity key={f} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setP({ freq: f })}
              style={[st.chip, { borderColor: fg }, on && { backgroundColor: fg }]} testID={`cbk4-freq-${f}`}>
              <Text style={[st.chipText, { color: on ? colors.background : fg }]}>{freqLabel[f]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={st.toggleRow}>
        <Text style={[st.body, { color: fg, flex: 1 }]}>{t('cbk4.cellular', 'Usar dados móveis')}</Text>
        <Switch value={!!prefs?.allowCellular} onValueChange={(v) => setP({ allowCellular: v })} testID="cbk4-cellular" />
      </View>
      <View style={st.toggleRow}>
        <Text style={[st.body, { color: fg, flex: 1 }]}>{t('cbk4.includeMedia', 'Incluir fotos, áudios e documentos')}</Text>
        <Switch value={prefs?.includeMedia !== false} onValueChange={(v) => setP({ includeMedia: v })} testID="cbk4-media" />
      </View>
      <View style={st.toggleRow}>
        <Text style={[st.body, { color: fg, flex: 1 }]}>{t('cbk4.includeVideos', 'Incluir vídeos')}</Text>
        <Switch value={!!prefs?.includeVideos} disabled={prefs?.includeMedia === false} onValueChange={(v) => setP({ includeVideos: v })} testID="cbk4-videos" />
      </View>

      {local && !local.hasKey ? <Text style={[st.small, { color: colors.textSecondary }]}>{errText(t, 'ERR_NOT_SETUP')}</Text> : null}
      {msg ? <Text style={[st.small, { color: fg }]} testID="cbk4-msg">{msg}</Text> : null}

      <TouchableOpacity accessibilityRole="button" disabled={busy || !local?.hasKey} onPress={runNow} testID="cbk4-run"
        style={[st.btn, { backgroundColor: fg }, (busy || !local?.hasKey) && { opacity: 0.45 }]}>
        <IconCloudUpload size={16} color={colors.background} />
        <Text style={[st.btnText, { color: colors.background }]}>{t('cbk4.runNow', 'Fazer backup agora')}</Text>
      </TouchableOpacity>
      {pendingRst ? (
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={resumeNow} testID="cbk4-resume"
          style={[st.btn, { borderColor: fg, borderWidth: 1 }, busy && { opacity: 0.45 }]}>
          <IconRefresh size={16} color={fg} />
          <Text style={[st.btnText, { color: fg }]}>{t('cbk4.resume', 'Continuar a restauração')}</Text>
        </TouchableOpacity>
      ) : null}
      {last ? (
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={restoreNow} testID="cbk4-restore"
          style={[st.btn, { borderColor: fg, borderWidth: 1 }, busy && { opacity: 0.45 }]}>
          <IconRefresh size={16} color={fg} />
          <Text style={[st.btnText, { color: fg }]}>{t('cbk4.restoreLast', 'Restaurar o último backup')}</Text>
        </TouchableOpacity>
      ) : null}
      {last ? (
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={delAll} testID="cbk4-delete" style={[st.btn, busy && { opacity: 0.45 }]}>
          <IconTrash size={16} color={colors.error || fg} />
          <Text style={[st.btnText, { color: colors.error || fg }]}>{t('cbk4.deleteAll', 'Apagar backup da nuvem')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: BorderRadius.lg || 12, padding: Spacing.lg, marginBottom: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: FontSize.lg || 17, fontWeight: '700' },
  body: { fontSize: FontSize.md || 15, lineHeight: 21 },
  small: { fontSize: FontSize.sm || 13, lineHeight: 18, marginTop: 4 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 16, borderRadius: BorderRadius.md || 10, marginTop: 6 },
  btnText: { fontSize: FontSize.md || 15, fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12, marginTop: 6 },
  chipText: { fontSize: FontSize.sm || 13, fontWeight: '600' },
  barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
});
