// [multi-guest 2026-10-10] Folha do ESPECTADOR antes de subir ao palco:
// prévia da câmera (frontal, espelhada) + escolha de microfone/câmera, e
// "Enviar pedido" (mode='request') ou "Entrar no palco"/"Agora não"
// (mode='invite', quando o host convidou). A prévia é liberada ao fechar —
// a publicação de verdade acontece só depois que o host aceita.
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconMic, IconMicOff, IconVideo, IconVideoOff, IconX } from '../Icons';
import { getLiveKitVideoView } from '../../hooks/useLiveKitRoom';

function PreviewVideo({ track }) {
  const ref = useRef(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const el = ref.current;
    if (!el || !track) return undefined;
    try { track.attach(el); el.muted = true; const p = el.play?.(); if (p && p.catch) p.catch(() => {}); } catch {}
    return () => { try { track.detach(el); } catch {} };
  }, [track]);
  if (!track) return null;
  if (Platform.OS === 'web') {
    return React.createElement('video', {
      ref, autoPlay: true, playsInline: true, muted: true,
      style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', backgroundColor: '#000' },
    });
  }
  const VV = getLiveKitVideoView();
  if (!VV) return null;
  return <VV key={track.sid || 'preview'} videoTrack={track} style={StyleSheet.absoluteFill} objectFit="cover" mirror zOrder={1} />;
}

function Toggle({ on, onPress, label, IconOn, IconOff }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.toggle, !on && styles.toggleOff, pressed && { opacity: 0.7 }]}
    >
      {on ? <IconOn size={18} color="#000" /> : <IconOff size={18} color="#fff" />}
      <Text style={[styles.toggleText, !on && styles.toggleTextOff]}>{label}</Text>
    </Pressable>
  );
}

/**
 * props: visible, mode ('request'|'invite'), hostName, hostEmail, user,
 *        busy, t, bottomInset, onClose(), onConfirm({ mic, cam }), onDeclineInvite()
 */
function ViewerJoinSheet({
  visible, mode = 'request', hostName, hostEmail, user, busy, t, bottomInset = 0,
  onClose, onConfirm, onDeclineInvite, initialMic = true, initialCam = true,
}) {
  const [mic, setMic] = useState(initialMic);
  const [cam, setCam] = useState(initialCam);
  const [track, setTrack] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const trackRef = useRef(null);

  // Prévia da câmera só enquanto a folha está aberta e a câmera escolhida.
  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      const tr = trackRef.current;
      trackRef.current = null;
      if (tr) { try { tr.stop(); } catch {} }
      setTrack(null);
    };
    if (!visible || !cam) { stop(); return undefined; }
    setPreviewFailed(false);
    (async () => {
      try {
        if (Platform.OS === 'android') {
          const { PermissionsAndroid } = require('react-native');
          const r = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);
          if (r && r[PermissionsAndroid.PERMISSIONS.CAMERA] !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('camera_denied');
        }
        if (cancelled) return;
        const lkc = require('livekit-client');
        const tr = await lkc.createLocalVideoTrack({ facingMode: 'user', resolution: { width: 480, height: 854, frameRate: 24 } });
        if (cancelled) { try { tr.stop(); } catch {} return; }
        trackRef.current = tr;
        setTrack(tr);
      } catch (e) {
        if (!cancelled) setPreviewFailed(true);
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [visible, cam]);

  if (!visible) return null;
  const isInvite = mode === 'invite';
  const title = isInvite ? t('liveGuests.invitedTitle', { name: hostName || '' }) : t('liveGuests.joinTitle');
  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} accessibilityLabel={t('common.close')} />
      <View style={[styles.sheet, { paddingBottom: bottomInset + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.headRow}>
          <Text style={styles.title} numberOfLines={2}>{title}</Text>
          <Pressable onPress={onClose} disabled={busy} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={20} color="#fff" />
          </Pressable>
        </View>
        <Text style={styles.subtitle}>{t('liveGuests.joinSubtitle')}</Text>
        <View style={styles.previewRow}>
          <View style={[styles.preview, styles.previewHost]}>
            <AvatarCircle email={hostEmail} name={hostName} size={56} />
            <Text style={styles.previewLabel} numberOfLines={1}>{hostName}</Text>
          </View>
          <View style={styles.preview}>
            {cam && track ? <PreviewVideo track={track} /> : (
              <View style={styles.previewCenter}>
                <AvatarCircle email={user?.email} name={user?.name} size={56} />
                {cam && previewFailed ? <Text style={styles.previewHint}>{t('liveGuests.previewUnavailable')}</Text> : null}
                {!cam ? <Text style={styles.previewHint}>{t('liveGuests.camOff')}</Text> : null}
              </View>
            )}
            <View style={styles.youPill}><Text style={styles.youText}>{t('liveGuests.you')}</Text></View>
          </View>
        </View>
        <View style={styles.toggles}>
          <Toggle on={mic} onPress={() => setMic((v) => !v)} label={t('liveGuests.mic')} IconOn={IconMic} IconOff={IconMicOff} />
          <Toggle on={cam} onPress={() => setCam((v) => !v)} label={t('liveGuests.camera')} IconOn={IconVideo} IconOff={IconVideoOff} />
        </View>
        <Pressable
          onPress={() => onConfirm && onConfirm({ mic, cam })}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cta, pressed && { opacity: 0.8 }]}
        >
          {busy ? <ActivityIndicator color="#000" /> : (
            <Text style={styles.ctaText}>{isInvite ? t('liveGuests.join') : t('liveGuests.sendRequest')}</Text>
          )}
        </Pressable>
        {isInvite ? (
          <Pressable onPress={onDeclineInvite} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.7 }]}>
            <Text style={styles.secondaryText}>{t('liveGuests.notNow')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', zIndex: 80, elevation: 80 },
  sheet: { backgroundColor: '#0b0b0b', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingHorizontal: 18, borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)' },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', alignSelf: 'center', marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.65)', fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 14 },
  previewRow: { flexDirection: 'row', gap: 2, height: 230, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  preview: { flex: 1, backgroundColor: '#151515', overflow: 'hidden' },
  previewHost: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  previewCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 8 },
  previewLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600', maxWidth: '90%' },
  previewHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, textAlign: 'center' },
  youPill: { position: 'absolute', left: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  youText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  toggles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  toggle: { flex: 1, height: 44, borderRadius: 22, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  toggleOff: { backgroundColor: 'rgba(255,255,255,0.1)' },
  toggleText: { color: '#000', fontSize: 14, fontWeight: '700' },
  toggleTextOff: { color: '#fff' },
  cta: { marginTop: 14, height: 50, borderRadius: 25, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#000', fontSize: 16, fontWeight: '800' },
  secondary: { marginTop: 8, height: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: 'rgba(255,255,255,0.8)', fontSize: 15, fontWeight: '600' },
});

export default memo(ViewerJoinSheet);
