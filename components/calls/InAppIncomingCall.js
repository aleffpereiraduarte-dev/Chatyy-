// [2026-10-20 inapp-ring] Android: tela de CHAMADA RECEBIDA do app quando ele
// está ABERTO (nível WhatsApp). Antes: heads-up nativo + IncomingCallActivity
// por cima do app (o founder via "a notificação e atrás a tela toda preta").
//
// Quem decide a superfície é o NATIVO (modules/expo-callkit InAppRing.kt):
//   - app na frente (MainActivity resumida, tela desbloqueada) + esta tela
//     registrada (setInAppRingReady) → notificação baixa sem heads-up/FSI e
//     evento `onInAppIncomingCall` → esta tela aparece;
//   - app vai pro 2º plano → o nativo volta o heads-up/FSI; app volta → o
//     nativo rebaixa de novo e reemite o evento;
//   - toque/vibração continuam no CallRingingService (nativo);
//   - fim do toque por QUALQUER caminho (atendeu/recusou aqui ou na
//     notificação, caller cancelou, 45 s) → `onInAppRingEnded` → some.
// Atender/Recusar daqui usam EXATAMENTE os caminhos da notificação nativa
// (answerInAppRing / declineInAppRing) — Telecom, microfone, CallActivity.
//
// Gate: Android + binário com inAppRingApi() >= 1 + kill switch OTA
// `globalThis.__chatyy_android_inapp_ring = false` (desliga e devolve tudo ao
// fluxo nativo antigo). iOS não monta nada (CallKit fica como está).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, Platform, Animated, Easing, AppState, Image,
  PanResponder, Pressable, TextInput, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../AvatarCircle';
import { IconPhone, IconVideo, IconPhoneOff, IconMessageCircle, IconClock, IconX, IconSend } from '../Icons';

const API_MIN = 1;

let _ck = null;
function ck() {
  if (_ck !== null) return _ck;
  try { _ck = require('../../modules/expo-callkit'); } catch { _ck = false; }
  return _ck;
}

let _Camera = null;
function cameraMod() {
  if (_Camera !== null) return _Camera;
  try { _Camera = require('expo-camera'); } catch { _Camera = false; }
  return _Camera;
}

let _diag = () => {};
try { _diag = require('../../services/voipDiag').default || (() => {}); } catch {}

function flagOn() {
  try { return globalThis.__chatyy_android_inapp_ring !== false; } catch { return true; }
}

export function inAppRingSupported() {
  if (Platform.OS !== 'android') return false;
  const m = ck();
  if (!m || typeof m.inAppRingApi !== 'function') return false;
  try { return m.inAppRingApi() >= API_MIN; } catch { return false; }
}

const STR = {
  pt: {
    voice: 'Chamada de voz do Chatyy',
    video: 'Chamada de vídeo do Chatyy',
    groupVoice: 'Chamada de voz em grupo do Chatyy',
    groupVideo: 'Chamada de vídeo em grupo do Chatyy',
    calling: 'está chamando',
    decline: 'Recusar',
    accept: 'Atender',
    message: 'Mensagem',
    remind: 'Lembrar-me',
    swipe: 'Deslize para cima para atender',
    replyTitle: 'Responder com mensagem',
    replyPh: 'Escreva uma mensagem…',
    remindTitle: 'Lembrar-me de ligar de volta',
    in1h: 'Em 1 hora',
    in15: 'Em 15 minutos',
    in3h: 'Em 3 horas',
    remindNotifTitle: 'Ligar de volta',
    remindNotifBody: (n) => `Você pediu para lembrar de ligar para ${n}.`,
    cancel: 'Cancelar',
    quick: ['Não posso falar agora.', 'Te ligo daqui a pouco.', 'Estou a caminho.', 'Pode me mandar mensagem?'],
  },
  en: {
    voice: 'Chatyy voice call',
    video: 'Chatyy video call',
    groupVoice: 'Chatyy group voice call',
    groupVideo: 'Chatyy group video call',
    calling: 'is calling',
    decline: 'Decline',
    accept: 'Accept',
    message: 'Message',
    remind: 'Remind me',
    swipe: 'Swipe up to accept',
    replyTitle: 'Reply with a message',
    replyPh: 'Write a message…',
    remindTitle: 'Remind me to call back',
    in1h: 'In 1 hour',
    in15: 'In 15 minutes',
    in3h: 'In 3 hours',
    remindNotifTitle: 'Call back',
    remindNotifBody: (n) => `You asked to be reminded to call ${n}.`,
    cancel: 'Cancel',
    quick: ["Can't talk right now.", "I'll call you back soon.", "I'm on my way.", 'Can you text me?'],
  },
  es: {
    voice: 'Llamada de voz de Chatyy',
    video: 'Videollamada de Chatyy',
    groupVoice: 'Llamada de voz grupal de Chatyy',
    groupVideo: 'Videollamada grupal de Chatyy',
    calling: 'está llamando',
    decline: 'Rechazar',
    accept: 'Contestar',
    message: 'Mensaje',
    remind: 'Recordarme',
    swipe: 'Desliza hacia arriba para contestar',
    replyTitle: 'Responder con un mensaje',
    replyPh: 'Escribe un mensaje…',
    remindTitle: 'Recordarme devolver la llamada',
    in1h: 'En 1 hora',
    in15: 'En 15 minutos',
    in3h: 'En 3 horas',
    remindNotifTitle: 'Devolver llamada',
    remindNotifBody: (n) => `Pediste que te recordáramos llamar a ${n}.`,
    cancel: 'Cancelar',
    quick: ['No puedo hablar ahora.', 'Te llamo en un rato.', 'Voy en camino.', '¿Me escribes?'],
  },
};
function strings(lang) {
  // [2026-10-21] idiomas fora de pt/es caem no inglês (fr/de/ja viam português)
  const l = String(lang || 'pt').toLowerCase();
  if (l.startsWith('pt')) return STR.pt;
  if (l.startsWith('es')) return STR.es;
  return STR.en;
}

function normalize(d) {
  if (!d || !d.callId) return null;
  return {
    callId: String(d.callId),
    callerName: String(d.callerName || '') || String(d.callerEmail || '').split('@')[0] || 'Chatyy',
    callerEmail: String(d.callerEmail || ''),
    conversationId: String(d.conversationId || ''),
    hasVideo: !!d.hasVideo,
    callerAvatar: String(d.callerAvatar || ''),
    isGroup: !!d.isGroup,
    groupName: String(d.groupName || ''),
  };
}

function CameraBackdrop() {
  const mod = cameraMod();
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Nunca pede permissão durante o toque — só usa se já foi concedida.
        const p = await mod?.Camera?.getCameraPermissionsAsync?.();
        if (alive && p?.granted) setGranted(true);
      } catch {}
    })();
    return () => { alive = false; };
  }, [mod]);
  if (!granted || !mod?.CameraView) return null;
  const CV = mod.CameraView;
  return <CV style={StyleSheet.absoluteFill} facing="front" mirror animateShutter={false} />;
}

export default function InAppIncomingCall() {
  if (Platform.OS !== 'android') return null;
  return <InAppIncomingCallAndroid />;
}

function InAppIncomingCallAndroid() {
  const { user } = useAuth();
  const { language } = useLanguage();
  const S = strings(language);
  const insets = useSafeAreaInsets();
  const [call, setCall] = useState(null);
  const [sheet, setSheet] = useState(null); // null | 'reply' | 'remind'
  const [customText, setCustomText] = useState('');
  const [camOn, setCamOn] = useState(true);
  const callRef = useRef(null);
  callRef.current = call;
  const actingRef = useRef(''); // call_id com ação em andamento (evita toque duplo)

  const enabled = !!user?.email && inAppRingSupported();

  // Registro no nativo (gate + kill switch). Reavalia ao voltar pra frente.
  useEffect(() => {
    if (!enabled) return undefined;
    const m = ck();
    const sync = () => {
      const on = flagOn();
      try { m.setInAppRingReady(on); } catch {}
      if (!on) { setCall(null); return; }
      const cur = normalize(m.getInAppRing?.());
      if (cur) {
        setCall((prev) => (prev && prev.callId === cur.callId ? { ...prev, ...cur } : cur));
      } else if (callRef.current && actingRef.current !== callRef.current.callId) {
        setCall(null);
      }
    };
    sync();
    const unA = m.onInAppIncomingCall((d) => {
      if (!flagOn()) return;
      const n = normalize(d);
      if (!n) return;
      try { _diag('inapp_ring_show', n.callId, { video: n.hasVideo ? 1 : 0 }); } catch {}
      setCall((prev) => (prev && prev.callId === n.callId ? { ...prev, ...n } : n));
    });
    const unB = m.onInAppRingEnded((d) => {
      const id = String(d?.callId || '');
      setCall((prev) => (prev && (!id || prev.callId === id) ? null : prev));
    });
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') sync(); });
    return () => {
      try { unA(); } catch {}
      try { unB(); } catch {}
      try { sub.remove(); } catch {}
      try { m.setInAppRingReady(false); } catch {}
    };
  }, [enabled]);

  // Reset ao trocar de chamada.
  useEffect(() => {
    setSheet(null);
    setCustomText('');
    setCamOn(true);
    if (!call) actingRef.current = '';
  }, [call?.callId]);

  // ── animações ──
  const fade = useRef(new Animated.Value(0)).current;
  const rings = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  const bob = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!call) return undefined;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loops = rings.map((r, i) => {
      r.setValue(0);
      return Animated.loop(Animated.sequence([
        Animated.delay(i * 650),
        Animated.timing(r, { toValue: 1, duration: 1950, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(r, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    });
    const b = Animated.loop(Animated.sequence([
      Animated.timing(bob, { toValue: 1, duration: 520, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(bob, { toValue: 0, duration: 520, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay(700),
    ]));
    loops.forEach((l) => l.start());
    b.start();
    return () => { loops.forEach((l) => l.stop()); b.stop(); };
  }, [call?.callId]);

  const doAccept = useCallback(() => {
    const c = callRef.current;
    if (!c || actingRef.current === c.callId) return;
    actingRef.current = c.callId;
    try { _diag('inapp_ring_accept', c.callId, {}); } catch {}
    // Solta a câmera da prévia antes da CallActivity abrir a dela.
    setCamOn(false);
    const m = ck();
    setTimeout(() => {
      let ok = false;
      try { ok = !!m.answerInAppRing(c.callId); } catch {}
      if (!ok) actingRef.current = '';
    }, c.hasVideo ? 140 : 0);
  }, []);

  const doDecline = useCallback((after) => {
    const c = callRef.current;
    if (!c || actingRef.current === c.callId) return;
    actingRef.current = c.callId;
    try { _diag('inapp_ring_decline', c.callId, { after: after ? 1 : 0 }); } catch {}
    const m = ck();
    let ok = false;
    try { ok = !!m.declineInAppRing(c.callId); } catch {}
    if (!ok) { actingRef.current = ''; return; }
    setCall(null);
    if (typeof after === 'function') { try { after(c); } catch {} }
  }, []);

  const replyWith = useCallback((text) => {
    const msg = String(text || '').trim();
    if (!msg) return;
    doDecline((c) => {
      try {
        const api = require('../../services/api');
        api.chatCallDeclineWithMessage?.(c.callId, c.conversationId, c.callerEmail, msg.slice(0, 240))?.catch?.(() => {});
      } catch {}
    });
  }, [doDecline]);

  const remindIn = useCallback((minutes) => {
    doDecline((c) => {
      (async () => {
        try {
          const Notifications = require('expo-notifications');
          const name = c.isGroup ? (c.groupName || c.callerName) : c.callerName;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: S.remindNotifTitle,
              body: S.remindNotifBody(name),
              data: { type: 'call_reminder', conversation_id: c.conversationId, email: c.callerEmail, video: c.hasVideo ? 1 : 0 },
              sound: true,
            },
            trigger: { type: 'timeInterval', seconds: Math.max(60, Math.round(minutes * 60)), channelId: 'chat_dm' },
          });
        } catch {}
      })();
    });
  }, [doDecline, S]);

  // Deslizar o botão verde pra cima = atender (tocar também atende).
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
    onPanResponderMove: (_e, g) => { drag.setValue(Math.max(-140, Math.min(0, g.dy))); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy < -70 || (Math.abs(g.dy) < 8 && Math.abs(g.dx) < 8)) {
        Animated.timing(drag, { toValue: -150, duration: 120, useNativeDriver: true }).start();
        doAccept();
      } else {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, friction: 6 }).start();
      }
    },
    onPanResponderTerminate: () => { Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(); },
  }), [doAccept]);
  useEffect(() => { drag.setValue(0); }, [call?.callId]);

  if (!enabled || !call) return null;

  const title = call.isGroup ? (call.groupName || call.callerName) : call.callerName;
  const kind = call.isGroup ? (call.hasVideo ? S.groupVideo : S.groupVoice) : (call.hasVideo ? S.video : S.voice);
  const AcceptIcon = call.hasVideo ? IconVideo : IconPhone;
  const AV = 128;

  const ringStyle = (r) => ({
    position: 'absolute', width: AV, height: AV, borderRadius: AV / 2,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)',
    opacity: r.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.6, 0] }),
    transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
  });

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onRequestClose={() => { if (sheet) setSheet(null); }}
    >
      <Animated.View style={[st.root, { opacity: fade }]}>
        {/* Fundo: câmera frontal (vídeo) ou foto desfocada (voz) */}
        {call.hasVideo && camOn ? <CameraBackdrop /> : null}
        {!call.hasVideo && call.callerAvatar ? (
          <Image source={{ uri: call.callerAvatar }} style={[StyleSheet.absoluteFill, { opacity: 0.55 }]} blurRadius={40} resizeMode="cover" />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: call.hasVideo ? 'rgba(0,0,0,0.38)' : 'rgba(7,12,18,0.72)' }]} />
        <View style={[st.topShade]} pointerEvents="none" />
        <View style={[st.bottomShade]} pointerEvents="none" />

        <View style={[st.content, { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 28 }]}>
          {/* Cabeçalho */}
          <View style={st.header}>
            <Text style={st.kind} numberOfLines={1}>{kind}</Text>
            <Text style={st.name} numberOfLines={2} accessibilityRole="header">{title}</Text>
            {call.isGroup && call.groupName && call.callerName ? (
              <Text style={st.sub} numberOfLines={1}>{call.callerName} {S.calling}</Text>
            ) : null}
          </View>

          {/* Avatar com anel pulsando (voz) */}
          <View style={st.center}>
            {!call.hasVideo || !camOn ? (
              <View style={{ width: AV, height: AV, alignItems: 'center', justifyContent: 'center' }}>
                {rings.map((r, i) => <Animated.View key={i} style={ringStyle(r)} />)}
                <AvatarCircle name={title} email={call.callerEmail} uri={call.callerAvatar || undefined} size={AV} ringColor="transparent" />
              </View>
            ) : (
              <View style={st.smallAvatarWrap}>
                <AvatarCircle name={title} email={call.callerEmail} uri={call.callerAvatar || undefined} size={72} ringColor="transparent" />
              </View>
            )}
          </View>

          {/* Ações secundárias */}
          <View style={st.secondaryRow}>
            <Pressable style={st.secondary} onPress={() => setSheet('remind')} accessibilityRole="button" accessibilityLabel={S.remind}>
              <View style={st.secondaryIcon}><IconClock size={20} color="#fff" /></View>
              <Text style={st.secondaryText}>{S.remind}</Text>
            </Pressable>
            <Pressable style={st.secondary} onPress={() => setSheet('reply')} accessibilityRole="button" accessibilityLabel={S.message}>
              <View style={st.secondaryIcon}><IconMessageCircle size={20} color="#fff" /></View>
              <Text style={st.secondaryText}>{S.message}</Text>
            </Pressable>
          </View>

          {/* Recusar / Atender */}
          <View style={st.mainRow}>
            <View style={st.mainCol}>
              <Pressable
                onPress={() => doDecline()}
                style={({ pressed }) => [st.btn, st.btnDecline, pressed && { transform: [{ scale: 0.94 }] }]}
                accessibilityRole="button"
                accessibilityLabel={S.decline}
              >
                <IconPhoneOff size={32} color="#fff" />
              </Pressable>
              <Text style={st.btnLabel}>{S.decline}</Text>
            </View>
            <View style={st.mainCol}>
              <Animated.View
                {...pan.panHandlers}
                accessible
                accessibilityRole="button"
                accessibilityLabel={S.accept}
                accessibilityHint={S.swipe}
                onAccessibilityTap={doAccept}
                style={[st.btn, st.btnAccept, {
                  transform: [
                    { translateY: Animated.add(drag, bob.interpolate({ inputRange: [0, 1], outputRange: [0, -8] })) },
                  ],
                }]}
              >
                <AcceptIcon size={32} color="#fff" />
              </Animated.View>
              <Text style={st.btnLabel}>{S.accept}</Text>
            </View>
          </View>
          <Text style={st.hint}>{S.swipe}</Text>
        </View>

        {/* Folhas: responder com mensagem / lembrar depois */}
        {sheet ? (
          <View style={StyleSheet.absoluteFill}>
            <Pressable style={st.backdrop} onPress={() => setSheet(null)} accessibilityLabel={S.cancel} />
            <KeyboardAvoidingView behavior="padding" style={st.sheetWrap} pointerEvents="box-none">
              <View style={[st.sheet, { paddingBottom: insets.bottom + 14 }]}>
                <View style={st.sheetHead}>
                  <Text style={st.sheetTitle}>{sheet === 'reply' ? S.replyTitle : S.remindTitle}</Text>
                  <Pressable onPress={() => setSheet(null)} hitSlop={12} accessibilityRole="button" accessibilityLabel={S.cancel}>
                    <IconX size={20} color="#c7cdd4" />
                  </Pressable>
                </View>
                {sheet === 'reply' ? (
                  <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
                    {S.quick.map((q) => (
                      <Pressable key={q} style={({ pressed }) => [st.option, pressed && st.optionPressed]} onPress={() => replyWith(q)}>
                        <Text style={st.optionText}>{q}</Text>
                      </Pressable>
                    ))}
                    <View style={st.inputRow}>
                      <TextInput
                        value={customText}
                        onChangeText={setCustomText}
                        placeholder={S.replyPh}
                        placeholderTextColor="#8a939c"
                        style={st.input}
                        maxLength={240}
                        returnKeyType="send"
                        onSubmitEditing={() => replyWith(customText)}
                      />
                      <Pressable
                        onPress={() => replyWith(customText)}
                        disabled={!customText.trim()}
                        style={[st.sendBtn, !customText.trim() && { opacity: 0.4 }]}
                        accessibilityRole="button"
                      >
                        <IconSend size={18} color="#fff" />
                      </Pressable>
                    </View>
                  </ScrollView>
                ) : (
                  <View>
                    {[[15, S.in15], [60, S.in1h], [180, S.in3h]].map(([min, label]) => (
                      <Pressable key={min} style={({ pressed }) => [st.option, pressed && st.optionPressed]} onPress={() => remindIn(min)}>
                        <Text style={st.optionText}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            </KeyboardAvoidingView>
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1014' },
  topShade: { position: 'absolute', left: 0, right: 0, top: 0, height: 260, backgroundColor: 'rgba(0,0,0,0.25)' },
  bottomShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 320, backgroundColor: 'rgba(0,0,0,0.30)' },
  content: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between' },
  header: { alignItems: 'center' },
  kind: { color: 'rgba(255,255,255,0.78)', fontSize: 14, fontWeight: '500', letterSpacing: 0.2 },
  name: { color: '#fff', fontSize: 32, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  sub: { color: 'rgba(255,255,255,0.75)', fontSize: 15, marginTop: 6 },
  center: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  smallAvatarWrap: { position: 'absolute', top: 0, padding: 3, borderRadius: 40, backgroundColor: 'rgba(0,0,0,0.25)' },
  secondaryRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 34 },
  secondary: { alignItems: 'center', minWidth: 96, paddingVertical: 4 },
  secondaryIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  secondaryText: { color: '#fff', fontSize: 13, marginTop: 8 },
  mainRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end' },
  mainCol: { alignItems: 'center', minWidth: 110 },
  btn: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  btnDecline: { backgroundColor: '#ea3b3b' },
  btnAccept: { backgroundColor: '#1fbf5b' },
  btnLabel: { color: '#fff', fontSize: 14, marginTop: 10, fontWeight: '500' },
  hint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, textAlign: 'center', marginTop: 18 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#1b2329', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 14 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  option: { paddingVertical: 14, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  optionPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
  optionText: { color: '#eef2f5', fontSize: 15 },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  input: { flex: 1, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, marginLeft: 8, backgroundColor: '#1fbf5b', alignItems: 'center', justifyContent: 'center' },
});
