// [2026-10-15 meet-v2] Pré-visualização antes de entrar (estilo Google Meet / FaceTime):
// prévia da câmera (ou avatar com foto/iniciais), ligar/desligar mic e câmera, seu nome
// e "Entrar agora". A câmera da prévia é solta ANTES da sala abrir (uma sessão por vez no iOS).
import { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, Animated, ActivityIndicator, useWindowDimensions } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconMic, IconMicOff, IconVideo, IconVideoOff, IconX } from '../Icons';

let CameraView = null;
let useCameraPermissions = null;
if (Platform.OS !== 'web') {
  try { const cam = require('expo-camera'); CameraView = cam.CameraView; useCameraPermissions = cam.useCameraPermissions; } catch {}
}
const useCamPerm = useCameraPermissions || (() => [null, async () => null]);

function WebPreview({ on }) {
  const ref = useRef(null);
  useEffect(() => {
    let stream = null;
    let dead = false;
    if (on && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        .then((s) => { if (dead) { s.getTracks().forEach((x) => x.stop()); return; } stream = s; if (ref.current) ref.current.srcObject = s; })
        .catch(() => {});
    }
    return () => { dead = true; if (stream) stream.getTracks().forEach((x) => x.stop()); };
  }, [on]);
  if (!on) return null;
  // eslint-disable-next-line react/no-unknown-property
  return <video ref={ref} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />;
}

function Toggle({ on, onPress, IconOn, IconOff, labelOn, labelOff }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={on ? labelOn : labelOff}
      style={({ pressed }) => [s.toggle, !on && s.toggleOff, pressed && { transform: [{ scale: 0.93 }] }]}
    >
      {on ? <IconOn size={22} color="#fff" /> : <IconOff size={22} color="#000" />}
    </Pressable>
  );
}

function MeetPrejoin({ t, insets, title, userName, userEmail, initialVideo = true, onJoin, onCancel, busy }) {
  const { width, height } = useWindowDimensions();
  const [camOn, setCamOn] = useState(!!initialVideo);
  const [micOn, setMicOn] = useState(true);
  const [perm, requestPerm] = useCamPerm();
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [fade]);

  useEffect(() => {
    if (Platform.OS === 'web' || !camOn || !perm || perm.granted || !perm.canAskAgain) return;
    requestPerm?.();
  }, [camOn, perm, requestPerm]);

  const previewW = Math.min(width - 40, 420);
  const previewH = Math.min(Math.round(previewW * 1.25), height - (insets?.top || 0) - (insets?.bottom || 0) - 280);
  const showNativeCam = Platform.OS !== 'web' && camOn && CameraView && perm?.granted;

  return (
    <Animated.View style={[s.root, { paddingTop: (insets?.top || 0) + 8, paddingBottom: (insets?.bottom || 0) + 16, opacity: fade }]}>
      <View style={s.topRow}>
        <Pressable onPress={onCancel} hitSlop={10} style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
          <IconX size={20} color="#fff" />
        </Pressable>
      </View>

      <View style={s.body}>
        <Text style={s.title} numberOfLines={2}>{title || t('meet.title')}</Text>
        <View style={[s.preview, { width: previewW, height: Math.max(previewH, 220) }]}>
          {showNativeCam ? <CameraView style={StyleSheet.absoluteFill} facing="front" mirror /> : null}
          {Platform.OS === 'web' ? <WebPreview on={camOn} /> : null}
          {!camOn || (Platform.OS !== 'web' && !showNativeCam) ? (
            <View style={s.avatarWrap}>
              {camOn && Platform.OS !== 'web' && CameraView && !perm ? <ActivityIndicator color="#fff" /> : (
                <AvatarCircle name={userName} email={userEmail} size={Math.min(132, previewW * 0.38)} />
              )}
            </View>
          ) : null}
          <View style={s.nameTag}><Text style={s.nameText} numberOfLines={1}>{userName}</Text></View>
          <View style={s.toggles}>
            <Toggle on={micOn} onPress={() => setMicOn((v) => !v)} IconOn={IconMic} IconOff={IconMicOff} labelOn={t('meet.mute')} labelOff={t('meet.unmute')} />
            <Toggle on={camOn} onPress={() => setCamOn((v) => !v)} IconOn={IconVideo} IconOff={IconVideoOff} labelOn={t('meet.stopVideo')} labelOff={t('meet.startVideo')} />
          </View>
        </View>
      </View>

      <Pressable
        onPress={() => onJoin?.({ audio: micOn, video: camOn })}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('meetV2.joinNow')}
        style={({ pressed }) => [s.join, { width: previewW }, (pressed || busy) && { opacity: 0.8 }]}
      >
        {busy ? <ActivityIndicator color="#000" /> : <Text style={s.joinText}>{t('meetV2.joinNow')}</Text>}
      </Pressable>
    </Animated.View>
  );
}

export default memo(MeetPrejoin);

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center' },
  topRow: { alignSelf: 'stretch', flexDirection: 'row', paddingHorizontal: 12, height: 44, alignItems: 'center' },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center', paddingHorizontal: 24, marginBottom: 18 },
  preview: { borderRadius: 28, overflow: 'hidden', backgroundColor: '#141414', alignItems: 'center', justifyContent: 'center' },
  avatarWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  nameTag: { position: 'absolute', left: 14, top: 14, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, maxWidth: '70%' },
  nameText: { color: '#fff', fontSize: 13.5, fontWeight: '600' },
  toggles: { position: 'absolute', bottom: 16, flexDirection: 'row', gap: 16 },
  toggle: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.35)',
  },
  toggleOff: { backgroundColor: '#fff', borderColor: '#fff' },
  join: { height: 54, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  joinText: { color: '#000', fontSize: 17, fontWeight: '700' },
});
