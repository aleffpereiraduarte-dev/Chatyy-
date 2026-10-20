/**
 * ProfilePostProgress — [post-perfil 2026-10-20]
 *
 * Cartão de progresso das publicações do perfil em 2º plano
 * (services/profilePostQueue): miniatura LOCAL + "Publicando… 42%" com barra,
 * "Publicado" no fim e "Tentar de novo" / descartar na falha. Montado no próprio
 * perfil e no Feed (mesmo lugar do ReelPublishProgress). Também retoma os jobs
 * salvos de uma sessão anterior (nativo) da conta logada.
 *
 * usePendingProfilePosts(email) → posts otimistas p/ a grade do próprio perfil.
 * mergePendingPosts(pending, serverPosts) → grade com os otimistas no topo, sem
 * repetir o que o servidor já devolveu.
 * openPendingPostMenu(item) → toque num post otimista (cancelar / tentar de novo).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, Image } from 'react-native';
import { IconX, IconCheck, IconRepeat } from './Icons';
import {
  getProfilePostJobs,
  subscribeProfilePostJobs,
  retryProfilePost,
  cancelProfilePost,
  dismissProfilePostJob,
  resumeProfilePosts,
  pendingGridPosts,
  isProfilePostQueueEnabled,
} from '../services/profilePostQueue';

const L = {
  uploading: { pt: 'Publicando… {p}%', en: 'Posting… {p}%', es: 'Publicando… {p}%' },
  preparing: { pt: 'Preparando…', en: 'Preparing…', es: 'Preparando…' },
  finishing: { pt: 'Finalizando…', en: 'Finishing…', es: 'Finalizando…' },
  waiting: { pt: 'Sem conexão — tentando de novo…', en: 'No connection — retrying…', es: 'Sin conexión — reintentando…' },
  done: { pt: 'Publicado no seu perfil', en: 'Posted to your profile', es: 'Publicado en tu perfil' },
  failed: { pt: 'Não foi possível publicar', en: 'Could not post', es: 'No se pudo publicar' },
  retry: { pt: 'Tentar de novo', en: 'Try again', es: 'Reintentar' },
  discard: { pt: 'Descartar publicação', en: 'Discard post', es: 'Descartar publicación' },
  cancel: { pt: 'Cancelar publicação', en: 'Cancel post', es: 'Cancelar publicación' },
  close: { pt: 'Fechar', en: 'Close', es: 'Cerrar' },
};
function _lang() {
  try {
    const h = require('../services/api').getAuthHeaders?.() || {};
    const l = String(h['X-User-Language'] || '').slice(0, 2).toLowerCase();
    if (l === 'en' || l === 'es') return l;
  } catch {}
  return 'pt';
}
function tr(k, vars) {
  const row = L[k];
  let s = row ? (row[_lang()] || row.pt) : k;
  if (vars) for (const x of Object.keys(vars)) s = s.replace(`{${x}}`, String(vars[x]));
  return s;
}

/** Posts otimistas (mais novo primeiro) da conta `email`; [] sem e-mail/kill. */
export function usePendingProfilePosts(email) {
  const em = String(email || '').toLowerCase();
  const on = !!em && isProfilePostQueueEnabled();
  const [list, setList] = useState(() => (on ? pendingGridPosts(em) : []));
  useEffect(() => {
    if (!on) { setList((prev) => (prev.length ? [] : prev)); return undefined; }
    // Só muda a grade quando muda a ESTRUTURA (ids/estado/miniatura) — o progresso de
    // 150 ms em 150 ms fica no cartão; re-renderizar o Perfil inteiro a cada tique travava o JS.
    let sig = '';
    const pull = () => {
      const next = pendingGridPosts(em);
      const s = next.map((p) => `${p.id}|${p.thumbnail}|${p.__pending ? p.__pending.status : 'ok'}`).join(',');
      if (s === sig) return;
      sig = s;
      setList(next);
    };
    pull();
    const off = subscribeProfilePostJobs(pull);
    resumeProfilePosts(em).catch(() => {});
    return off;
  }, [em, on]);
  return list;
}

/** Otimistas no topo; some quando o servidor já devolve o mesmo id. */
export function mergePendingPosts(pending, serverPosts) {
  const server = Array.isArray(serverPosts) ? serverPosts : [];
  if (!pending || !pending.length) return server;
  const ids = new Set(server.map((p) => String(p?.id)));
  const extra = pending.filter((p) => !ids.has(String(p.id)));
  return extra.length ? [...extra, ...server] : server;
}

/** Toque num post otimista da grade. */
export function openPendingPostMenu(item) {
  const pend = item && item.__pending;
  if (!pend || !pend.jobId) return false;
  let menu = null;
  try { menu = require('../services/profilePostComposer').showActionMenu; } catch { menu = null; }
  if (!menu) return true;
  const failed = pend.status === 'failed';
  menu({
    title: failed ? tr('failed') : (pend.status === 'publishing' ? tr('finishing') : tr('uploading', { p: Math.round((pend.progress || 0) * 100) })),
    options: failed
      ? [
        { label: tr('retry'), onPress: () => retryProfilePost(pend.jobId) },
        { label: tr('discard'), destructive: true, onPress: () => { cancelProfilePost(pend.jobId); } },
      ]
      : [
        { label: tr('cancel'), destructive: true, onPress: () => { cancelProfilePost(pend.jobId); } },
      ],
    cancelLabel: tr('close'),
  });
  return true;
}

export default function ProfilePostProgress({ email, top = null, bottom = null, style }) {
  const em = String(email || '').toLowerCase();
  const on = !!em && isProfilePostQueueEnabled();
  const [jobs, setJobs] = useState(() => (on ? getProfilePostJobs(em) : []));
  useEffect(() => {
    if (!on) return undefined;
    setJobs(getProfilePostJobs(em));
    const off = subscribeProfilePostJobs(() => setJobs(getProfilePostJobs(em)));
    resumeProfilePosts(em).catch(() => {});
    return off;
  }, [em, on]);
  if (!on || !jobs.length) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, bottom != null ? { bottom } : { top: top || 0 }, style]}>
      {jobs.slice(-3).map((j) => {
        const pct = Math.round((j.progress || 0) * 100);
        const failed = j.status === 'failed';
        const done = j.status === 'done';
        const label = done ? tr('done')
          : failed ? tr('failed')
            : j.waiting ? tr('waiting')
              : j.status === 'publishing' ? tr('finishing')
                : (j.status === 'preparing' && pct < 3) ? tr('preparing')
                  : tr('uploading', { p: pct });
        return (
          <View key={j.id} style={styles.card} accessibilityLiveRegion="polite" testID={`post-publish-${j.status}`}>
            <View style={styles.thumbBox}>
              {j.coverUri ? <Image source={{ uri: j.coverUri }} style={styles.thumb} /> : null}
              {done ? <View style={styles.thumbBadge}><IconCheck size={12} color="#000" /></View> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title} numberOfLines={1}>{label}</Text>
              {!done && !failed && (
                <View style={styles.bar}>
                  <View style={[styles.barFill, { width: `${Math.max(4, pct)}%` }]} />
                </View>
              )}
            </View>
            {!done && !failed && j.status === 'publishing' && <ActivityIndicator size="small" color="#fff" style={{ marginLeft: 6 }} />}
            {failed && (
              <TouchableOpacity onPress={() => retryProfilePost(j.id)} style={styles.pill} accessibilityRole="button" testID="post-publish-retry">
                <IconRepeat size={13} color="#000" />
                <Text style={styles.pillTxt}>{tr('retry')}</Text>
              </TouchableOpacity>
            )}
            {(failed || done) && (
              <TouchableOpacity
                onPress={() => (done ? dismissProfilePostJob(j.id) : cancelProfilePost(j.id))}
                hitSlop={8}
                style={styles.close}
                accessibilityRole="button"
                accessibilityLabel={done ? tr('close') : tr('discard')}
              >
                <IconX size={14} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 60, gap: 8, alignItems: 'center' },
  card: {
    width: '100%', maxWidth: 480,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 16,
    backgroundColor: 'rgba(17,17,17,0.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  thumbBox: { width: 36, height: 36, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.12)' },
  thumb: { width: 36, height: 36 },
  thumbBadge: { position: 'absolute', right: 2, bottom: 2, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 13, fontWeight: '700' },
  bar: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 6, overflow: 'hidden' },
  barFill: { height: 3, borderRadius: 2, backgroundColor: '#fff' },
  pill: { flexDirection: 'row', gap: 4, paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  pillTxt: { color: '#000', fontSize: 12, fontWeight: '800' },
  close: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
});
