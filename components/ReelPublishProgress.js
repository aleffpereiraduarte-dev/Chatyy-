/**
 * ReelPublishProgress — [2026-10-08 reels-publish]
 *
 * Inline banner for background reel publishes (services/reelPublishQueue).
 * Mounted over the Reels / Feed surfaces in ChatFeedTab. Shows one compact
 * black & white card per job: progress bar while uploading, "Finalizando"
 * while the server joins/cuts/renders the cover, "Publicado" (+ "Ver") on
 * success, "Tentar de novo" / cancel on failure. Also resumes jobs persisted
 * from a previous app session (native) for the signed-in account.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { IconX, IconCheck, IconReels, IconRepeat } from './Icons';
import {
  getReelJobs,
  subscribeReelJobs,
  retryReelPublish,
  cancelReelPublish,
  dismissReelJob,
  resumeReelPublishes,
} from '../services/reelPublishQueue';

export default function ReelPublishProgress({ email, t, top = 0, bottom = null, onView, style }) {
  const [jobs, setJobs] = useState(() => getReelJobs(email));
  const tt = useCallback((k, fb, p) => {
    const v = t ? t(k, p) : null;
    if (v && v !== k) return v;
    let s = fb;
    if (p) Object.keys(p).forEach(x => { s = s.replace(new RegExp(`\\{${x}\\}`, 'g'), String(p[x])); });
    return s;
  }, [t]);

  useEffect(() => {
    setJobs(getReelJobs(email));
    const unsub = subscribeReelJobs(() => setJobs(getReelJobs(email)));
    if (email) resumeReelPublishes(email).catch(() => {});
    return unsub;
  }, [email]);

  if (!jobs.length) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, bottom != null ? { bottom } : { top }, style]}>
      {jobs.slice(-3).map(j => {
        const pct = Math.round((j.progress || 0) * 100);
        const failed = j.status === 'failed';
        const done = j.status === 'done';
        const label = done
          ? tt('reels.publish.done', 'Reel publicado')
          : failed
            ? tt('reels.publish.failed', 'Falha ao publicar o reel')
            : j.status === 'publishing'
              ? tt('reels.publish.processing', 'Finalizando reel…')
              : (j.status === 'queued' && j.error)
                ? tt('reels.publish.waiting', 'Falhou — tentando de novo em instantes…')
                : tt('reels.publish.uploading', 'Publicando reel… {pct}%', { pct });
        return (
          <View key={j.id} style={styles.card} accessibilityLiveRegion="polite" testID={`reel-publish-${j.status}`}>
            <View style={[styles.icon, done && { backgroundColor: '#fff' }]}>
              {done ? <IconCheck size={16} color="#000" /> : failed ? <IconRepeat size={16} color="#fff" /> : <IconReels size={16} color="#fff" />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title} numberOfLines={1}>{label}</Text>
              {!!j.caption && <Text style={styles.sub} numberOfLines={1}>{j.caption}</Text>}
              {!done && !failed && (
                <View style={styles.bar}>
                  <View style={[styles.barFill, { width: `${Math.max(4, pct)}%` }]} />
                </View>
              )}
            </View>
            {!done && !failed && j.status === 'publishing' && <ActivityIndicator size="small" color="#fff" style={{ marginLeft: 6 }} />}
            {done && !!onView && (
              <TouchableOpacity onPress={() => { onView(j.post); dismissReelJob(j.id); }} style={styles.pill} accessibilityRole="button">
                <Text style={styles.pillTxt}>{tt('reels.publish.view', 'Ver')}</Text>
              </TouchableOpacity>
            )}
            {failed && (
              <TouchableOpacity onPress={() => retryReelPublish(j.id)} style={styles.pill} accessibilityRole="button">
                <Text style={styles.pillTxt}>{tt('reels.publish.retry', 'Tentar de novo')}</Text>
              </TouchableOpacity>
            )}
            {(failed || done) && (
              <TouchableOpacity
                onPress={() => (done ? dismissReelJob(j.id) : cancelReelPublish(j.id))}
                hitSlop={8}
                style={styles.close}
                accessibilityRole="button"
                accessibilityLabel={tt('reels.publish.cancel', 'Cancelar')}
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
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 16,
    backgroundColor: 'rgba(17,17,17,0.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  icon: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 1 },
  bar: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 6, overflow: 'hidden' },
  barFill: { height: 3, borderRadius: 2, backgroundColor: '#fff' },
  pill: { paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  pillTxt: { color: '#000', fontSize: 12, fontWeight: '800' },
  close: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
});
