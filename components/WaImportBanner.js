// [wa-import-v2 2026-10-13] Faixa discreta na conversa:
//   • "Importando do WhatsApp · 42%" enquanto a importação (em 2º plano) é desta conversa
//     ou foi iniciada a partir dela — tocar abre os detalhes (pausar/cancelar).
//   • Para a OUTRA pessoa de uma conversa direta: "Fulano importou o histórico do WhatsApp
//     desta conversa" + "Ocultar para mim" (servidor: wa_import_hide). Aparece uma vez
//     (dispensável); a informação vem de wa_import_conv_info, consultado só quando chegou
//     o evento history_imported desta conversa (nada de request a cada conversa aberta).
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconDownload, IconX, IconCheck } from './Icons';
import * as job from '../services/waImport/job';
import { waImportConvInfo, waImportHide } from '../services/waImport/api';

function _acct() { try { return String(require('../services/api').getActiveAccountEmail?.() || '').toLowerCase(); } catch { return ''; } }
function _st() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }
const _flagKey = (cid) => `waimp:conv:v1:${_acct()}:${cid}`;
const _dismissKey = (cid, iid) => `waimp:dismiss:v1:${_acct()}:${cid}:${iid}`;

// Marca "esta conversa recebeu histórico importado" quando o evento chega (mesmo com a conversa fechada).
job.onHistoryImported((d) => {
  try { if (d?.mode === 'direct' && d?.conversation_id) _st()?.setItem(_flagKey(d.conversation_id), String(Date.now())); } catch {}
});

const _infoCache = new Map(); // cid → { at, items }

export default function WaImportBanner({ conversationId, global: isGlobal = false }) {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [j, setJ] = useState(job.getJob());
  const [notice, setNotice] = useState(null); // { id, by_name, hidden }
  const [busy, setBusy] = useState(false);
  const cid = String(conversationId || '');

  useEffect(() => job.subscribe(setJ), []);

  const loadInfo = useCallback(async (force) => {
    if (!cid) return;
    try {
      const st = _st();
      const flag = force ? '1' : await st?.getItem(_flagKey(cid));
      if (!flag) return;
      const c = _infoCache.get(cid);
      let items = c && Date.now() - c.at < 5 * 60 * 1000 && !force ? c.items : null;
      if (!items) {
        const r = await waImportConvInfo(Number(cid));
        if (!r?.success) return;
        items = r.data?.items || [];
        _infoCache.set(cid, { at: Date.now(), items });
      }
      const it = items.find((x) => x.mode === 'direct' && !x.is_mine && x.status !== 'deleted');
      if (!it) { setNotice(null); return; }
      const dismissed = await st?.getItem(_dismissKey(cid, it.id));
      setNotice(dismissed && !it.hidden ? null : { id: it.id, by_name: it.by_name, hidden: !!it.hidden, dismissed: !!dismissed });
    } catch {}
  }, [cid]);

  useEffect(() => { loadInfo(false); }, [loadInfo]);
  useEffect(() => job.onHistoryImported((d) => {
    if (String(d?.conversation_id) === cid && d?.mode === 'direct') { _infoCache.delete(cid); loadInfo(true); }
  }), [cid, loadInfo]);

  // [2026-10-13] global = faixa na HOME (lista de conversas): mostra qualquer
  // importação em andamento e, ao terminar, "concluída" por alguns segundos.
  const relevant = isGlobal || (cid && (String(j.conversationId || '') === cid || String(j.originConvId || '') === cid || String(j.targetConversationId || '') === cid));
  const [doneFlash, setDoneFlash] = useState(false);
  const _prevStatus = React.useRef(j.status);
  useEffect(() => {
    if (!isGlobal) return undefined;
    const was = _prevStatus.current; _prevStatus.current = j.status;
    if (j.status === 'done' && was !== 'done') {
      setDoneFlash(true);
      const tm = setTimeout(() => setDoneFlash(false), 9000);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [isGlobal, j.status]);
  const running = relevant && (j.status === 'running' || j.status === 'paused' || j.status === 'error');
  const bg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const ink = colors.text;
  const sub = colors.textSecondary;

  if (running) {
    const pct = Math.round(((j.progress && j.progress.frac) || 0) * 100);
    const label = j.status === 'paused'
      ? t('waImport.bannerPaused', { pct })
      : j.status === 'error' ? t('waImport.bannerError') : t('waImport.bannerRunning', { pct });
    return (
      <TouchableOpacity onPress={() => { try { router.push('/import-whatsapp'); } catch {} }} accessibilityRole="button" accessibilityLabel={label}
        style={[s.row, { backgroundColor: bg }]}>
        {j.status === 'running' ? <ActivityIndicator size="small" color={sub} /> : <IconDownload size={14} color={sub} />}
        <Text style={[s.text, { color: sub }]} numberOfLines={1}>{label}</Text>
        <View style={[s.track, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' }]}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: ink }} />
        </View>
      </TouchableOpacity>
    );
  }

  if (isGlobal && doneFlash && j.status === 'done') {
    const conv = j.conversationId || (j.result && j.result.conversationId);
    const label = t('waImport.homeDone') || 'Importação do WhatsApp concluída';
    return (
      <TouchableOpacity onPress={() => { setDoneFlash(false); try { if (conv) router.push({ pathname: '/chat-conversation', params: { id: String(conv) } }); } catch {} }}
        accessibilityRole="button" accessibilityLabel={label} style={[s.row, { backgroundColor: bg }]}>
        <IconCheck size={14} color={ink} />
        <Text style={[s.text, { color: ink }]} numberOfLines={1}>{label}</Text>
      </TouchableOpacity>
    );
  }
  if (isGlobal) return null;

  if (notice && !notice.dismissed && !notice.hidden) {
    const hide = async () => {
      if (busy) return;
      setBusy(true);
      const r = await waImportHide(notice.id, true);
      setBusy(false);
      if (r?.success) { _infoCache.delete(cid); setNotice({ ...notice, hidden: true }); try { require('../services/websocket').default._emit?.('push_chat_refresh', { conversation_id: Number(cid) }); } catch {} }
    };
    const dismiss = () => { try { _st()?.setItem(_dismissKey(cid, notice.id), '1'); } catch {} setNotice({ ...notice, dismissed: true }); };
    return (
      <View style={[s.row, { backgroundColor: bg }]}>
        <IconDownload size={14} color={sub} />
        <Text style={[s.text, { color: sub }]} numberOfLines={2}>{t('waImport.peerNotice', { name: notice.by_name || '' })}</Text>
        <TouchableOpacity onPress={hide} disabled={busy} hitSlop={8} accessibilityRole="button">
          <Text style={[s.action, { color: ink }]}>{t('waImport.hideForMe')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={dismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')} style={{ marginLeft: 8 }}>
          <IconX size={14} color={sub} />
        </TouchableOpacity>
      </View>
    );
  }

  if (notice && notice.hidden && !notice.dismissed) {
    const show = async () => {
      const r = await waImportHide(notice.id, false);
      if (r?.success) { _infoCache.delete(cid); setNotice({ ...notice, hidden: false }); try { require('../services/websocket').default._emit?.('push_chat_refresh', { conversation_id: Number(cid) }); } catch {} }
    };
    return (
      <View style={[s.row, { backgroundColor: bg }]}>
        <IconCheck size={14} color={sub} />
        <Text style={[s.text, { color: sub }]} numberOfLines={1}>{t('waImport.hiddenForMe')}</Text>
        <TouchableOpacity onPress={show} hitSlop={8} accessibilityRole="button"><Text style={[s.action, { color: ink }]}>{t('waImport.showAgain')}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { try { _st()?.setItem(_dismissKey(cid, notice.id), '1'); } catch {} setNotice({ ...notice, dismissed: true }); }} hitSlop={10} style={{ marginLeft: 8 }} accessibilityLabel={t('common.close')}>
          <IconX size={14} color={sub} />
        </TouchableOpacity>
      </View>
    );
  }
  return null;
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 14, gap: 8 },
  text: { flex: 1, fontSize: 12, fontWeight: '500' },
  action: { fontSize: 12, fontWeight: '700' },
  track: { width: 56, height: 3, borderRadius: 2, overflow: 'hidden' },
});
