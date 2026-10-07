// [2026-10-07 welcome] First-run flow — shown ONCE PER ACCOUNT right after
// signup / first login (gating: services/firstRun.js, host: FirstRunGate).
//
// Steps (each skippable; progress dots; current step persisted so an
// interrupted flow resumes where it stopped):
//   profile        photo + name confirm           (all platforms)
//   friends        contact discovery w/ privacy   (native only)
//   notifications  push primer, in context        (native, only if undecided)
//   look           theme pick + backup shortcut   (all; backup row native)
//
// Black & white, SVG only, respects Reduce Motion.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, Image, StyleSheet, Platform, Animated,
  Easing, ActivityIndicator, ScrollView, KeyboardAvoidingView, StatusBar, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useReducedMotion } from '../reducedMotion';
import AvatarCircle from '../AvatarCircle';
import { IconCamera, IconCloud } from '../Icons';
import { useOnbCopy } from './copy';
import { FriendsArt, BellArt, ShieldGlyph, ThemeSwatch } from './illustrations';
import { shareInvite } from './invite';
import { saveFirstRunStep } from '../../services/firstRun';

export const ALL_STEPS = ['profile', 'friends', 'notifications', 'look'];

/** Which steps apply on this device right now (async: checks push permission). */
export async function computeFirstRunSteps() {
  const steps = ['profile'];
  if (Platform.OS !== 'web') {
    steps.push('friends');
    let askPush = false;
    try {
      const { isPushPrimerNeeded } = require('../../services/pushPrimer');
      if (isPushPrimerNeeded()) askPush = true;
    } catch {}
    if (!askPush) {
      try {
        const N = require('expo-notifications');
        const p = await N.getPermissionsAsync();
        // undetermined, or iOS provisional (quiet) → still worth asking.
        const prov = Platform.OS === 'ios' && p?.ios?.status === 3;
        if (p?.status === 'undetermined' || (prov && p?.canAskAgain !== false)) askPush = true;
      } catch {}
    }
    if (askPush) steps.push('notifications');
  }
  steps.push('look');
  return steps;
}

function _haptic(kind = 'select') {
  if (Platform.OS === 'web') return;
  try {
    const H = require('expo-haptics');
    if (kind === 'success') H.notificationAsync(H.NotificationFeedbackType.Success);
    else H.selectionAsync();
  } catch {}
}

function Chevron({ color, size = 16 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

export default function FirstRunFlow({ visible, steps, initialStep, onDone, onOpenBackup }) {
  const { isDark, themeMode, setThemeMode } = useTheme();
  const { t } = useLanguage();
  const { user, updateUser } = useAuth();
  const c = useOnbCopy();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const email = String(user?.email || '').toLowerCase();

  const list = useMemo(() => (Array.isArray(steps) && steps.length ? steps : ['profile', 'look']), [steps]);
  const [idx, setIdx] = useState(() => Math.max(0, list.indexOf(initialStep)));
  const step = list[Math.min(idx, list.length - 1)];
  const isLast = idx >= list.length - 1;

  const fg = isDark ? '#ffffff' : '#111111';
  const bg = isDark ? '#000000' : '#ffffff';
  const sub = isDark ? 'rgba(255,255,255,0.62)' : 'rgba(17,17,17,0.6)';
  const muted = isDark ? '#1c1c1e' : '#F1F2F4';
  const hair = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.12)';

  // Content transition per step (fade + small slide). Off under Reduce Motion.
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!visible) return;
    if (reduceMotion) { anim.setValue(1); return; }
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [step, visible, reduceMotion, anim]);

  // Persist the current step for resume.
  useEffect(() => {
    if (visible && email && step) saveFirstRunStep(email, step);
  }, [visible, email, step]);

  const finish = useCallback((reason) => {
    _haptic('success');
    onDone?.(reason || 'completed');
  }, [onDone]);

  const next = useCallback(() => {
    if (idx >= list.length - 1) { finish('completed'); return; }
    _haptic();
    setIdx(idx + 1);
  }, [idx, list.length, finish]);

  const back = useCallback(() => {
    if (idx > 0) setIdx(idx - 1);
    else next();
  }, [idx, next]);

  // ── profile ──────────────────────────────────────────────────────────
  const initialName = String(user?.name || '').trim();
  const [name, setName] = useState(initialName);
  const [photo, setPhoto] = useState(null); // { uri }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!name && initialName) setName(initialName); }, [initialName]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPhoto = useCallback(async () => {
    try {
      const ImagePicker = require('expo-image-picker');
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm?.granted) return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (res && !res.canceled && res.assets?.[0]?.uri) { setPhoto({ uri: res.assets[0].uri }); setErr(''); _haptic(); }
    } catch {}
  }, []);

  const saveProfile = useCallback(async () => {
    const n = name.trim();
    if (n.length < 2) { setErr(c('fr.profile.nameShort')); return; }
    setBusy(true); setErr('');
    let ok = true;
    try {
      const api = require('../../services/api');
      if (n !== initialName) {
        const r = await api.updateProfile({ name: n });
        if (r?.success === false) ok = false;
        else { try { updateUser?.({ name: n }); } catch {} }
      }
      if (photo?.uri) {
        const r = await api.uploadAvatar({ uri: photo.uri, name: 'avatar.jpg', type: 'image/jpeg' });
        if (r?.success) {
          try { api.bustAvatarCache(email); } catch {}
          try { require('../../services/cache').invalidate?.('user_profile'); } catch {}
        } else ok = false;
      }
    } catch { ok = false; }
    setBusy(false);
    if (!ok) { setErr(c('fr.profile.saveFail')); return; }
    next();
  }, [name, initialName, photo, email, c, next, updateUser]);

  // ── friends ──────────────────────────────────────────────────────────
  const [friends, setFriends] = useState({ state: 'idle', list: [] });
  const findFriends = useCallback(async () => {
    setFriends({ state: 'loading', list: [] });
    try {
      const { syncContacts } = require('../../services/contactSync');
      // forceRefresh=true → shows the canonical store-compliant consent
      // (contactsConsent.*) and then the OS permission, same as chat-new.
      const r = await syncContacts(true, t);
      if (r?.error === 'consent_denied' || r?.error === 'permission_denied') { setFriends({ state: 'denied', list: [] }); return; }
      const me = email;
      const found = (r?.chatyContacts || []).filter((x) => x?.email && String(x.email).toLowerCase() !== me);
      setFriends({ state: 'done', list: found });
      _haptic('success');
    } catch {
      setFriends({ state: 'denied', list: [] });
    }
  }, [t, email]);

  // ── notifications ────────────────────────────────────────────────────
  const [pushBusy, setPushBusy] = useState(false);
  const enablePush = useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const { pushPrimerClosed } = require('../../services/pushPrimer');
      pushPrimerClosed(true);
    } catch {}
    try {
      const { enablePushFromPrimer, diagPushPrimer } = require('../../services/pushNotifications');
      try { diagPushPrimer?.('primer_shown', 'first_run'); } catch {}
      await enablePushFromPrimer();
    } catch {}
    setPushBusy(false);
    next();
  }, [pushBusy, next]);
  const laterPush = useCallback(() => {
    try { require('../../services/pushPrimer').recordPushPrimerOffer(); } catch {}
    try { require('../../services/pushNotifications').diagPushPrimer?.('primer_later', 'first_run'); } catch {}
    next();
  }, [next]);

  // ── render helpers ───────────────────────────────────────────────────
  const Primary = ({ label, onPress, loading, disabled }) => (
    <Pressable
      onPress={onPress}
      disabled={loading || disabled}
      style={({ pressed }) => [st.primary, { backgroundColor: fg, opacity: disabled ? 0.4 : (pressed ? 0.86 : 1) }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? <ActivityIndicator color={bg} /> : <Text style={[st.primaryText, { color: bg }]} maxFontSizeMultiplier={1.3}>{label}</Text>}
    </Pressable>
  );
  const Secondary = ({ label, onPress }) => (
    <Pressable onPress={onPress} style={({ pressed }) => [st.secondary, { opacity: pressed ? 0.55 : 1 }]} accessibilityRole="button" hitSlop={6}>
      <Text style={[st.secondaryText, { color: fg }]} maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  );

  let body = null;
  let footer = null;

  if (step === 'profile') {
    body = (
      <View style={st.center}>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header">{c('fr.profile.title')}</Text>
        <Text style={[st.sub, { color: sub }]}>{c('fr.profile.sub')}</Text>
        <Pressable onPress={pickPhoto} style={st.avatarWrap} accessibilityRole="button" accessibilityLabel={photo ? c('fr.profile.changePhoto') : c('fr.profile.addPhoto')}>
          {photo?.uri ? (
            <Image source={{ uri: photo.uri }} style={[st.avatarImg, { backgroundColor: muted }]} />
          ) : (
            <AvatarCircle name={name || initialName} email={email} size={116} />
          )}
          <View style={[st.camBadge, { backgroundColor: fg, borderColor: bg }]}>
            <IconCamera size={16} color={bg} />
          </View>
        </Pressable>
        <Pressable onPress={pickPhoto} hitSlop={8} accessibilityRole="button">
          <Text style={[st.link, { color: fg }]}>{photo ? c('fr.profile.changePhoto') : c('fr.profile.addPhoto')}</Text>
        </Pressable>
        <TextInput
          value={name}
          onChangeText={(v) => { setName(v); if (err) setErr(''); }}
          placeholder={c('fr.profile.namePh')}
          placeholderTextColor={sub}
          maxLength={40}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={saveProfile}
          style={[st.input, { color: fg, borderBottomColor: hair }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          accessibilityLabel={c('fr.profile.namePh')}
        />
        {err ? <Text style={[st.err, { color: fg }]}>{err}</Text> : null}
      </View>
    );
    footer = <Primary label={c('fr.continue')} onPress={saveProfile} loading={busy} disabled={name.trim().length < 2} />;
  } else if (step === 'friends') {
    const n = friends.list.length;
    body = (
      <View style={st.center}>
        <FriendsArt size={150} fg={fg} bg={bg} muted={muted} />
        <Text style={[st.title, { color: fg, marginTop: 18 }]} accessibilityRole="header">{c('fr.friends.title')}</Text>
        <Text style={[st.sub, { color: sub }]}>{c('fr.friends.sub')}</Text>
        {friends.state === 'done' ? (
          <View style={{ alignItems: 'center', marginTop: 20, alignSelf: 'stretch' }}>
            <Text style={[st.resultText, { color: fg }]}>
              {n === 0 ? c('fr.friends.none') : (n === 1 ? c('fr.friends.foundOne') : c('fr.friends.found', { n }))}
            </Text>
            {n > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.friendsRow}>
                {friends.list.slice(0, 12).map((f) => (
                  <View key={f.email} style={st.friend}>
                    <AvatarCircle name={f.name} email={f.email} uri={f.avatar || undefined} size={52} />
                    <Text style={[st.friendName, { color: fg }]} numberOfLines={1}>{String(f.name || f.email).split(' ')[0]}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : null}
          </View>
        ) : friends.state === 'denied' ? (
          <Text style={[st.resultText, { color: sub, marginTop: 20 }]}>{c('fr.friends.denied')}</Text>
        ) : (
          <View style={[st.privacy, { backgroundColor: muted }]}>
            <ShieldGlyph size={20} color={fg} />
            <Text style={[st.privacyText, { color: sub }]}>{c('fr.friends.privacy')}</Text>
          </View>
        )}
      </View>
    );
    footer = friends.state === 'done' || friends.state === 'denied' ? (
      <>
        <Primary label={c('fr.continue')} onPress={next} />
        <Secondary label={c('fr.friends.invite')} onPress={() => shareInvite(c)} />
      </>
    ) : (
      <>
        <Primary label={friends.state === 'loading' ? c('fr.friends.searching') : c('fr.friends.cta')} onPress={findFriends} loading={friends.state === 'loading'} />
        <Secondary label={c('fr.notNow')} onPress={next} />
      </>
    );
  } else if (step === 'notifications') {
    body = (
      <View style={st.center}>
        <BellArt size={150} fg={fg} bg={bg} muted={muted} />
        <Text style={[st.title, { color: fg, marginTop: 18 }]} accessibilityRole="header">{c('fr.notif.title')}</Text>
        <Text style={[st.sub, { color: sub }]}>{c('fr.notif.sub')}</Text>
      </View>
    );
    footer = (
      <>
        <Primary label={c('fr.notif.cta')} onPress={enablePush} loading={pushBusy} />
        <Secondary label={c('fr.notNow')} onPress={laterPush} />
      </>
    );
  } else {
    const modes = [
      { k: 'system', label: c('fr.look.system') },
      { k: 'light', label: c('fr.look.light') },
      { k: 'dark', label: c('fr.look.dark') },
    ];
    body = (
      <View style={st.center}>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header">{c('fr.look.title')}</Text>
        <Text style={[st.sub, { color: sub }]}>{c('fr.look.sub')}</Text>
        <View style={st.themeRow}>
          {modes.map((m) => {
            const sel = (themeMode || 'system') === m.k;
            return (
              <Pressable
                key={m.k}
                onPress={() => { _haptic(); try { setThemeMode?.(m.k); } catch {} }}
                style={({ pressed }) => [st.themeCard, { borderColor: sel ? fg : hair, borderWidth: sel ? 2 : 1, opacity: pressed ? 0.8 : 1 }]}
                accessibilityRole="radio"
                accessibilityState={{ selected: sel }}
                accessibilityLabel={m.label}
              >
                <ThemeSwatch mode={m.k} size={48} fg={fg} />
                <Text style={[st.themeLabel, { color: fg, fontWeight: sel ? '700' : '500' }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {Platform.OS !== 'web' && typeof onOpenBackup === 'function' ? (
          <Pressable
            onPress={() => { _haptic(); onOpenBackup(); }}
            style={({ pressed }) => [st.backupRow, { borderColor: hair, opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
          >
            <View style={[st.backupIcon, { backgroundColor: muted }]}><IconCloud size={20} color={fg} /></View>
            <View style={{ flex: 1 }}>
              <Text style={[st.backupTitle, { color: fg }]}>{c('fr.look.backup')}</Text>
              <Text style={[st.backupSub, { color: sub }]}>{c('fr.look.backupSub')}</Text>
            </View>
            <Chevron color={sub} />
          </Pressable>
        ) : null}
      </View>
    );
    footer = <Primary label={c('fr.done')} onPress={() => finish('completed')} />;
  }

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  const topPad = Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0, 16);
  const wide = winW >= 768;

  return (
    <Modal
      visible={!!visible}
      animationType={reduceMotion ? 'none' : (wide ? 'fade' : 'slide')}
      presentationStyle={Platform.OS === 'ios' ? 'fullScreen' : undefined}
      statusBarTranslucent
      transparent={wide}
      onRequestClose={back}
    >
      <View style={[st.root, wide ? st.rootWide : { backgroundColor: bg }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[wide ? [st.card, { backgroundColor: bg }] : { flex: 1 }, { paddingTop: wide ? 18 : topPad, paddingBottom: Math.max(insets.bottom, 16) }]}
        >
          <View style={st.header}>
            <View style={st.dots} accessibilityLabel={c('fr.stepOf', { n: idx + 1, total: list.length })}>
              {list.map((k, i) => (
                <View key={k} style={[st.dot, { width: i === idx ? 18 : 6, backgroundColor: fg, opacity: i <= idx ? 1 : 0.2 }]} />
              ))}
            </View>
            {!isLast ? (
              <Pressable onPress={next} hitSlop={10} style={[st.skip, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]} accessibilityRole="button" accessibilityLabel={c('fr.skip')}>
                <Text style={[st.skipText, { color: sub }]}>{c('fr.skip')}</Text>
              </Pressable>
            ) : <View style={st.skip} />}
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Animated.View style={{ opacity: anim, transform: [{ translateY }], alignSelf: 'stretch' }}>
              {body}
            </Animated.View>
          </ScrollView>
          <View style={st.footer}>{footer}</View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  rootWide: { backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 460, maxHeight: 720, minHeight: 560, borderRadius: 24, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, height: 44 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { height: 6, borderRadius: 3 },
  skip: { minWidth: 56, minHeight: 40, alignItems: 'flex-end', justifyContent: 'center' },
  skipText: { fontSize: 15, fontWeight: '600' },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 16 },
  center: { alignItems: 'center', alignSelf: 'center', width: '100%', maxWidth: 420 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6, textAlign: 'center' },
  sub: { fontSize: 15.5, lineHeight: 22, textAlign: 'center', marginTop: 8, maxWidth: 330 },
  avatarWrap: { marginTop: 28, width: 116, height: 116 },
  avatarImg: { width: 116, height: 116, borderRadius: 58 },
  camBadge: { position: 'absolute', right: 0, bottom: 0, width: 36, height: 36, borderRadius: 18, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600', marginTop: 12 },
  input: { alignSelf: 'stretch', marginTop: 26, fontSize: 20, fontWeight: '600', textAlign: 'center', paddingVertical: 10, borderBottomWidth: 1.5 },
  err: { fontSize: 13.5, marginTop: 10, textAlign: 'center', opacity: 0.8 },
  privacy: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 16, padding: 14, marginTop: 22, alignSelf: 'stretch' },
  privacyText: { flex: 1, fontSize: 13, lineHeight: 18.5 },
  resultText: { fontSize: 15.5, fontWeight: '600', textAlign: 'center' },
  friendsRow: { gap: 14, paddingHorizontal: 4, paddingTop: 16 },
  friend: { alignItems: 'center', width: 60 },
  friendName: { fontSize: 12, marginTop: 6, maxWidth: 60 },
  themeRow: { flexDirection: 'row', gap: 12, marginTop: 26, justifyContent: 'center' },
  themeCard: { alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 16, minWidth: 92 },
  themeLabel: { fontSize: 13.5, marginTop: 10 },
  backupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch', marginTop: 26, padding: 14, borderRadius: 16, borderWidth: 1 },
  backupIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  backupTitle: { fontSize: 15, fontWeight: '700' },
  backupSub: { fontSize: 13, marginTop: 2 },
  footer: { paddingHorizontal: 24, paddingTop: 8, alignSelf: 'center', width: '100%', maxWidth: 460 },
  primary: { minHeight: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 17, fontWeight: '700' },
  secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryText: { fontSize: 16, fontWeight: '600' },
});
