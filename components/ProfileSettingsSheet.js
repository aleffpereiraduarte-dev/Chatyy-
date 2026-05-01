/**
 * ProfileSettingsSheet — Instagram-style stacked settings sheet.
 *
 * One modal, multiple screens. Instead of routing the user out to the giant
 * /settings page (which was email-centric and felt "quiet"), every screen
 * lives inside this sheet — Account, Privacy, Security, Notifications,
 * Language, Invite friends, Plan, About, Help.
 *
 * Navigation is driven by a `screen` stack (array of keys). Pushing adds a
 * screen, popping removes. Each screen has its own header back button.
 *
 * Wired from <Profile mode="self">. The `onEditProfile` callback still
 * exists so tapping "Editar perfil" can reuse the inline ProfileEditSheet
 * on the parent if wanted (our parent does exactly that).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, ScrollView,
  Platform, StyleSheet, Switch, ActivityIndicator, Alert, Share,
  Linking, TextInput,
} from 'react-native';
import {
  IconUser, IconLock, IconBell, IconGlobe, IconCreditCard, IconDatabase,
  IconPhone, IconEye, IconChevronRight, IconX, IconLogOut, IconHelp, IconInfo,
  IconUserPlus, IconShare, IconAlertTriangle, IconArrowLeft, IconMessageSquare,
  IconCopy, IconCheckCircle, IconMail, IconSparkles, IconFilter, IconEdit,
  IconForward, IconFileText, IconUsers,
  IconClock, IconImage, IconStar,
} from './Icons';
import * as api from '../services/api';
import { useTheme, ACCENT_PRESETS } from '../context/ThemeContext';

const ACCENT = '#7C3AED';

// ─── Shared building blocks ──────────────────────────────────────────
function Row({ icon: Icon, label, value, onPress, colors, destructive, right }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 14 }}
    >
      <View style={{
        width: 34, height: 34, borderRadius: 9,
        backgroundColor: destructive ? '#ef444422' : (colors?.surface || '#f3f4f6'),
        alignItems: 'center', justifyContent: 'center',
      }}>
        {Icon && <Icon size={18} color={destructive ? '#ef4444' : (colors?.text || '#111')} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '500', color: destructive ? '#ef4444' : (colors?.text || '#111') }}>
          {label}
        </Text>
        {!!value && (
          <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }} numberOfLines={1}>
            {value}
          </Text>
        )}
      </View>
      {right || <IconChevronRight size={16} color={colors?.textTertiary || '#bbb'} />}
    </TouchableOpacity>
  );
}

function Section({ title, children, colors }) {
  return (
    <View style={{ marginTop: 18 }}>
      {title && (
        <Text style={{
          fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
          color: colors?.textSecondary, paddingHorizontal: 20, marginBottom: 6,
          letterSpacing: 0.6,
        }}>
          {title}
        </Text>
      )}
      <View style={{ backgroundColor: colors?.surface || '#fff' }}>
        {children}
      </View>
    </View>
  );
}

function ToggleRow({ icon: Icon, label, value, onChange, colors, description }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 14 }}>
      <View style={{
        width: 34, height: 34, borderRadius: 9,
        backgroundColor: colors?.surface || '#f3f4f6',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {Icon && <Icon size={18} color={colors?.text || '#111'} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '500', color: colors?.text }}>{label}</Text>
        {!!description && (
          <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }}>{description}</Text>
        )}
      </View>
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ false: '#ccc', true: ACCENT }}
        thumbColor="#fff"
      />
    </View>
  );
}

function AccentColorRow({ colors, t }) {
  const { accentColor, setAccentColor } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 13, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{
          width: 34, height: 34, borderRadius: 9,
          backgroundColor: colors?.surface || '#f3f4f6',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: accentColor }} />
        </View>
        <Text style={{ fontSize: 15, fontWeight: '500', color: colors?.text || '#111', flex: 1 }}>
          {t?.('settings.accentColor') || 'Cor do destaque'}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 12, paddingLeft: 48 }}>
        {ACCENT_PRESETS.map(p => {
          const selected = accentColor === p.hex;
          return (
            <TouchableOpacity
              key={p.key}
              onPress={() => setAccentColor(p.hex)}
              accessibilityLabel={p.key}
              accessibilityRole="button"
              style={{
                width: 30, height: 30, borderRadius: 15,
                backgroundColor: p.hex,
                borderWidth: selected ? 3 : 0,
                borderColor: colors?.text || '#111',
                alignItems: 'center', justifyContent: 'center',
              }}
            />
          );
        })}
      </View>
    </View>
  );
}

// ─── Screen: Main menu ───────────────────────────────────────────────
function MainScreen({ push, onEditProfile, onLogout, colors, isDark, t, router, onClose, closeAndRun }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('settings.account') || 'Conta'} colors={colors}>
        <Row icon={IconUser}      label={t?.('settings.editProfile') || 'Editar perfil'}       onPress={onEditProfile} colors={colors} />
        <Row icon={IconLock}      label={t?.('settings.security') || 'Segurança e senha'}      onPress={() => push('security')} colors={colors} />
        <Row icon={IconEye}       label={t?.('settings.privacy') || 'Privacidade'}             onPress={() => push('privacy')} colors={colors} />
      </Section>

      <Section title={t?.('settings.preferences') || 'Preferências'} colors={colors}>
        <Row icon={IconBell}  label={t?.('settings.notifications') || 'Notificações'}          onPress={() => push('notifications')} colors={colors} />
        <Row icon={IconGlobe} label={t?.('settings.language') || 'Idioma'}                     onPress={() => push('language')} colors={colors} />
        <Row icon={IconEye}   label={t?.('settings.reading') || 'Leitura'}                     onPress={() => push('reading')} colors={colors} />
        <AccentColorRow colors={colors} t={t} />
      </Section>

      <Section title={t?.('settings.email') || 'Email'} colors={colors}>
        <Row icon={IconMail}     label={t?.('settings.emailCompose') || 'Email e composição'} onPress={() => push('email')} colors={colors} />
        <Row icon={IconClock}    label={t?.('settings.vacation') || 'Resposta automática'}    onPress={() => push('vacation')} colors={colors} />
        <Row icon={IconSparkles} label={t?.('settings.aiFeatures') || 'Recursos com IA'}      onPress={() => push('ai')} colors={colors} />
      </Section>

      <Section title={t?.('settings.community') || 'Comunidade'} colors={colors}>
        <Row icon={IconUserPlus} label={t?.('referral.inviteFriends') || 'Convidar amigos'}    onPress={() => push('invite')} colors={colors} />
      </Section>

      <Section title={t?.('settings.billing') || 'Plano e armazenamento'} colors={colors}>
        <Row icon={IconCreditCard} label={t?.('settings.plans') || 'Planos e assinaturas'}     onPress={() => closeAndRun?.(() => router?.push('/plans'))} colors={colors} />
      </Section>

      <Section title={t?.('settings.help') || 'Ajuda'} colors={colors}>
        <Row icon={IconHelp} label={t?.('settings.support') || 'Suporte'}                      onPress={() => push('support')} colors={colors} />
        <Row icon={IconInfo} label={t?.('settings.about') || 'Sobre o Chatyy'}                 onPress={() => push('about')} colors={colors} />
      </Section>

      <Section title={t?.('settings.privacy') || 'Privacidade'} colors={colors}>
        <Row icon={IconDatabase} label={t?.('settings.exportData') || 'Baixar meus dados'} onPress={() => push('export')} colors={colors} />
      </Section>

      <Section title={t?.('settings.dangerZone') || 'Zona de perigo'} colors={colors}>
        <Row icon={IconLogOut}         label={t?.('settings.logout') || 'Sair'}                 onPress={onLogout} colors={colors} />
        <Row icon={IconAlertTriangle}  label={t?.('settings.deleteAccount') || 'Excluir conta'} onPress={() => push('delete')} colors={colors} destructive />
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Security ────────────────────────────────────────────────
function SecurityScreen({ colors, t, router, onClose }) {
  // Most security controls live in the main settings screen (biometric,
  // sessions, password change). We surface the common ones inline and
  // route heavier flows to /settings with the right anchor.
  const [biometricOn, setBiometricOn] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const LA = require('expo-local-authentication');
        const supported = await LA.hasHardwareAsync?.();
        const enrolled = await LA.isEnrolledAsync?.();
        setBiometricAvailable(!!(supported && enrolled));
      } catch {}
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const v = await AsyncStorage.getItem('biometric_enabled');
        setBiometricOn(v === 'true');
      } catch {}
    })();
  }, []);

  const toggleBiometric = async (v) => {
    setBiometricOn(v);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('biometric_enabled', v ? 'true' : 'false');
    } catch {}
  };

  const goDetailedSettings = (section) => {
    onClose?.();
    setTimeout(() => router?.push(`/settings?section=${section}`), 150);
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      {biometricAvailable && (
        <Section title={t?.('settings.deviceSecurity') || 'Dispositivo'} colors={colors}>
          <ToggleRow
            icon={IconLock}
            label={t?.('settings.biometricLock') || 'Bloqueio biométrico'}
            description={t?.('settings.biometricDesc') || 'Exigir Face ID/Touch ID ao abrir o app'}
            value={biometricOn}
            onChange={toggleBiometric}
            colors={colors}
          />
        </Section>
      )}
      <Section title={t?.('settings.accountSecurity') || 'Conta'} colors={colors}>
        <Row icon={IconLock} label={t?.('settings.changePassword') || 'Alterar senha'} onPress={() => goDetailedSettings('security')} colors={colors} />
        <Row icon={IconPhone} label={t?.('settings.twoFactor') || 'Verificação em duas etapas'} onPress={() => goDetailedSettings('security')} colors={colors} />
      </Section>
      <Section colors={colors}>
        <Text style={{ fontSize: 12, color: colors?.textTertiary, paddingHorizontal: 20, paddingVertical: 12, lineHeight: 17 }}>
          {t?.('settings.securityNote') || 'Suas conversas e emails são protegidos por criptografia em trânsito. Habilite o bloqueio biométrico para uma camada extra de segurança quando alguém pegar seu celular.'}
        </Text>
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Privacy ─────────────────────────────────────────────────
function PrivacyScreen({ colors, t }) {
  const [settings, setSettings] = useState({
    read_receipts: true,
    last_seen: 'everyone',
    online: 'everyone',
    profile_photo: 'everyone',
    about: 'everyone',
    story_privacy: 'everyone',
    group_add: 'everyone',
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.apiCall?.('chat_privacy_get', {}, 'POST');
        if (r?.success && r.data) {
          setSettings(prev => ({ ...prev, ...r.data }));
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const update = async (patch) => {
    setSettings(prev => ({ ...prev, ...patch }));
    try { await api.apiCall?.('chat_privacy_set', patch, 'POST'); } catch {}
  };

  // Triple-state row: tap cycles everyone → contacts → nobody → everyone.
  // Backend `chat_privacy_set` aceita qualquer subset desses 3 valores.
  const PrivacyRow = ({ Icon, label, field, options }) => {
    const OPTS = options || ['everyone', 'contacts', 'nobody'];
    const labels = {
      everyone: t?.('profile.privacyEveryone') || 'Qualquer um',
      contacts: t?.('profile.privacyContactsOnly') || 'Só meus contatos',
      nobody:   t?.('profile.privacyNobody') || 'Ninguém',
    };
    const cur = settings[field] || OPTS[0];
    return (
      <TouchableOpacity
        onPress={() => update({ [field]: OPTS[(OPTS.indexOf(cur) + 1) % OPTS.length] })}
        activeOpacity={0.65}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}
      >
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors?.surface, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <Icon size={18} color={colors?.text} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors?.text, fontSize: 15, fontWeight: '500' }}>{label}</Text>
          <Text style={{ color: colors?.textTertiary, fontSize: 12, marginTop: 2 }}>{labels[cur] || cur}</Text>
        </View>
        <IconChevronRight size={18} color={colors?.textTertiary} />
      </TouchableOpacity>
    );
  };

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={ACCENT} /></View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('privacy.whoCanSee') || 'Quem pode ver'} colors={colors}>
        <PrivacyRow
          Icon={IconClock}
          label={t?.('privacy.lastSeen') || 'Visto por último e online'}
          field="last_seen"
        />
        <PrivacyRow
          Icon={IconImage}
          label={t?.('privacy.profilePhoto') || 'Foto de perfil'}
          field="profile_photo"
        />
        <PrivacyRow
          Icon={IconFileText}
          label={t?.('privacy.about') || 'Recado (about)'}
          field="about"
        />
        <PrivacyRow
          Icon={IconStar}
          label={t?.('privacy.status') || 'Quem vê meu status'}
          field="story_privacy"
        />
      </Section>
      <Section title={t?.('privacy.conversations') || 'Conversas'} colors={colors}>
        <ToggleRow
          icon={IconCheckCircle}
          label={t?.('privacy.readReceipts') || 'Confirmações de leitura'}
          description={t?.('privacy.readReceiptsDesc') || 'Mostrar V azul quando ler as mensagens'}
          value={!!settings.read_receipts}
          onChange={(v) => update({ read_receipts: v })}
          colors={colors}
        />
      </Section>
      <Section title={t?.('privacy.groupsSection') || 'Grupos'} colors={colors}>
        <PrivacyRow
          Icon={IconUsers}
          label={t?.('profile.privacyGroupAdd') || 'Quem pode me adicionar em grupos'}
          field="group_add"
        />
      </Section>
      <Section colors={colors}>
        <Text style={{ fontSize: 12, color: colors?.textTertiary, paddingHorizontal: 20, paddingVertical: 12, lineHeight: 17 }}>
          {t?.('privacy.note') || 'Pra bloquear um usuário específico, abra o perfil dele e toque nos três pontos.'}
        </Text>
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Notifications ───────────────────────────────────────────
function NotificationsScreen({ colors, t }) {
  const [prefs, setPrefs] = useState({
    push_enabled: true,
    sound: true,
    vibration: true,
    group_by_conversation: true,
  });
  const [dnd, setDnd] = useState({ enabled: false, start: '22:00', end: '07:00' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.getSettings?.();
        if (r?.success && r.data) {
          setPrefs(prev => ({
            ...prev,
            sound: r.data.notification_sound ?? true,
            vibration: r.data.notification_vibration ?? true,
          }));
          if (r.data.dnd_window && typeof r.data.dnd_window === 'object') {
            setDnd(prev => ({
              enabled: !!r.data.dnd_window.enabled,
              start: r.data.dnd_window.start || prev.start,
              end: r.data.dnd_window.end || prev.end,
            }));
          }
        }
        // Per-device push token state is managed separately; for the toggle
        // we just read AsyncStorage so user intent survives app restart.
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const v = await AsyncStorage.getItem('push_enabled');
        setPrefs(p => ({ ...p, push_enabled: v !== 'false' }));
        // Hydrate DnD from MMKV-equivalent storage; fall back to whatever we
        // got from server (which may have been just-now persisted from
        // another device).
        const stored = await AsyncStorage.getItem('dnd_window');
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            setDnd(prev => ({
              enabled: !!parsed.enabled,
              start: parsed.start || prev.start,
              end: parsed.end || prev.end,
            }));
          } catch {}
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const update = async (patch) => {
    setPrefs(prev => ({ ...prev, ...patch }));
    try {
      if ('push_enabled' in patch) {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem('push_enabled', patch.push_enabled ? 'true' : 'false');
      }
      // Persist sound/vibration via the existing settings API
      const serverPatch = {};
      if ('sound' in patch) serverPatch.notification_sound = patch.sound;
      if ('vibration' in patch) serverPatch.notification_vibration = patch.vibration;
      if (Object.keys(serverPatch).length && api.updateSettings) {
        await api.updateSettings(serverPatch);
      }
    } catch {}
  };

  // Persist DnD window locally + push to server so push-notify can suppress
  // notifications inside the user's quiet hours. Server enforcement is
  // best-effort — if the column doesn't exist yet the update is just stored
  // client-side and the UI keeps working.
  const updateDnd = async (patch) => {
    const next = { ...dnd, ...patch };
    setDnd(next);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('dnd_window', JSON.stringify(next));
      if (api.updateSettings) {
        await api.updateSettings({ dnd_window: next });
      }
    } catch {}
  };

  const validateTime = (s) => /^\d{2}:\d{2}$/.test(s);

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={ACCENT} /></View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('notif.general') || 'Geral'} colors={colors}>
        <ToggleRow
          icon={IconBell}
          label={t?.('notif.push') || 'Notificações push'}
          description={t?.('notif.pushDesc') || 'Receber avisos de novas mensagens e emails'}
          value={prefs.push_enabled}
          onChange={(v) => update({ push_enabled: v })}
          colors={colors}
        />
        <ToggleRow
          icon={IconBell}
          label={t?.('notif.sound') || 'Som'}
          value={prefs.sound}
          onChange={(v) => update({ sound: v })}
          colors={colors}
        />
        {Platform.OS !== 'web' && (
          <ToggleRow
            icon={IconBell}
            label={t?.('notif.vibration') || 'Vibração'}
            value={prefs.vibration}
            onChange={(v) => update({ vibration: v })}
            colors={colors}
          />
        )}
      </Section>
      <Section title={t?.('settings.doNotDisturb') || 'Não perturbe'} colors={colors}>
        <ToggleRow
          icon={IconClock}
          label={t?.('settings.doNotDisturb') || 'Não perturbe'}
          description={dnd.enabled ? `${dnd.start} – ${dnd.end}` : (t?.('settings.dndOffDesc') || 'Silenciar notificações em horários definidos')}
          value={dnd.enabled}
          onChange={(v) => updateDnd({ enabled: v })}
          colors={colors}
        />
        {dnd.enabled && (
          <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, color: colors?.textSecondary, marginBottom: 4 }}>
                {t?.('settings.dndStart') || 'Início'}
              </Text>
              <TextInput
                value={dnd.start}
                onChangeText={(v) => setDnd(prev => ({ ...prev, start: v }))}
                onBlur={() => { if (validateTime(dnd.start)) updateDnd({ start: dnd.start }); }}
                placeholder="22:00"
                placeholderTextColor={colors?.textTertiary}
                style={{
                  backgroundColor: colors?.surface, color: colors?.text,
                  borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16,
                  borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, color: colors?.textSecondary, marginBottom: 4 }}>
                {t?.('settings.dndEnd') || 'Fim'}
              </Text>
              <TextInput
                value={dnd.end}
                onChangeText={(v) => setDnd(prev => ({ ...prev, end: v }))}
                onBlur={() => { if (validateTime(dnd.end)) updateDnd({ end: dnd.end }); }}
                placeholder="07:00"
                placeholderTextColor={colors?.textTertiary}
                style={{
                  backgroundColor: colors?.surface, color: colors?.text,
                  borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16,
                  borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border,
                }}
              />
            </View>
          </View>
        )}
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Language ────────────────────────────────────────────────
function LanguageScreen({ colors, t }) {
  const LANGS = [
    { code: 'pt-BR', label: 'Português (Brasil)', flag: 'BR' },
    { code: 'en', label: 'English', flag: 'US' },
    { code: 'es', label: 'Español', flag: 'ES' },
  ];
  // The app uses a LanguageContext but we avoid importing it here to keep
  // the sheet drop-in. Read+write via AsyncStorage key the context uses.
  const [current, setCurrent] = useState('pt-BR');

  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const v = await AsyncStorage.getItem('language');
        if (v) setCurrent(v);
      } catch {}
    })();
  }, []);

  const pick = async (code) => {
    setCurrent(code);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('language', code);
      // Let the language context reload via an app restart; show a hint
      Alert.alert(t?.('settings.languageChanged') || 'Idioma alterado',
        t?.('settings.languageRestart') || 'Feche e abra o app para aplicar em todos os textos.');
    } catch {}
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section colors={colors}>
        {LANGS.map(l => (
          <TouchableOpacity
            key={l.code}
            onPress={() => pick(l.code)}
            activeOpacity={0.6}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 }}
          >
            <Text style={{ fontSize: 20, marginRight: 14 }}>{l.flag === 'BR' ? '🇧🇷' : l.flag === 'US' ? '🇺🇸' : '🇪🇸'}</Text>
            <Text style={{ flex: 1, fontSize: 15, color: colors?.text, fontWeight: current === l.code ? '700' : '500' }}>
              {l.label}
            </Text>
            {current === l.code && <IconCheckCircle size={20} color={ACCENT} />}
          </TouchableOpacity>
        ))}
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Invite friends ──────────────────────────────────────────
function InviteScreen({ colors, t }) {
  const [code, setCode] = useState('');
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.getReferralCode?.();
        if (r?.success && r.data) {
          setCode(r.data.code || '');
          setCount(r.data.referred_count || 0);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const inviteLink = useMemo(
    () => (code ? `https://chatyy.com.br/signup?ref=${code}` : 'https://chatyy.com.br'),
    [code]
  );

  const handleShare = async () => {
    const msg = (t?.('referral.shareMessage') || 'Entra no Chatyy com meu código {code}: {link}')
      .replace('{code}', code)
      .replace('{link}', inviteLink);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ text: msg, url: inviteLink });
      } else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(msg);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        await Share.share({ message: msg, url: inviteLink });
      }
    } catch {}
  };

  const handleCopyCode = async () => {
    if (!code) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
      } else {
        const Clipboard = require('expo-clipboard');
        await Clipboard.setStringAsync?.(code);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={ACCENT} /></View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 20, alignItems: 'center' }}>
        <View style={{
          width: 88, height: 88, borderRadius: 44,
          backgroundColor: ACCENT + '1a',
          alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          <IconUserPlus size={40} color={ACCENT} />
        </View>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors?.text, textAlign: 'center' }}>
          {t?.('referral.inviteFriendsTitle') || 'Convide seus amigos'}
        </Text>
        <Text style={{ fontSize: 14, color: colors?.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 20 }}>
          {t?.('referral.description') || 'Compartilhe o Chatyy com quem você quer conversar — e acompanhe quantos aceitaram o seu convite.'}
        </Text>
      </View>

      {!!code && (
        <>
          <Section title={t?.('referral.yourCode') || 'Seu código'} colors={colors}>
            <TouchableOpacity
              onPress={handleCopyCode}
              activeOpacity={0.7}
              style={{ alignItems: 'center', paddingVertical: 18, paddingHorizontal: 20 }}
            >
              <Text style={{ fontSize: 28, fontWeight: '900', color: ACCENT, letterSpacing: 6 }}>
                {code}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <IconCopy size={14} color={colors?.textSecondary} />
                <Text style={{ fontSize: 12, color: colors?.textSecondary }}>
                  {copied ? (t?.('referral.copied') || 'Copiado!') : (t?.('referral.tapToCopy') || 'Toque pra copiar')}
                </Text>
              </View>
            </TouchableOpacity>
          </Section>

          <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
            <TouchableOpacity
              onPress={handleShare}
              activeOpacity={0.8}
              style={{
                backgroundColor: ACCENT,
                borderRadius: 12, paddingVertical: 14,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <IconShare size={18} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                {t?.('referral.share') || 'Compartilhar convite'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
            <Text style={{ fontSize: 13, color: colors?.textSecondary, textAlign: 'center' }}>
              {(t?.('referral.friendsInvited') || '{count} amigos aceitaram seu convite')
                .replace('{count}', String(count))}
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ─── Screen: About ───────────────────────────────────────────────────
function AboutScreen({ colors, t }) {
  const appVersion = '2.4.0';
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 24, alignItems: 'center' }}>
        <View style={{
          width: 80, height: 80, borderRadius: 18,
          backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', marginBottom: 14,
        }}>
          <Text style={{ fontSize: 38, fontWeight: '900', color: '#fff' }}>C</Text>
        </View>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors?.text }}>Chatyy</Text>
        <Text style={{ fontSize: 13, color: colors?.textSecondary, marginTop: 4 }}>
          {t?.('about.version') || 'Versão'} {appVersion}
        </Text>
      </View>

      <Section title={t?.('about.legal') || 'Legal'} colors={colors}>
        <Row label={t?.('plans.termsOfUse') || 'Termos de Uso (EULA)'} onPress={() => Linking.openURL('https://chatyy.com.br/terms')} colors={colors} />
        <Row label={t?.('plans.privacyPolicy') || 'Política de Privacidade'} onPress={() => Linking.openURL('https://chatyy.com.br/privacy')} colors={colors} />
        <Row label={t?.('settings.support') || 'Suporte'} onPress={() => Linking.openURL('https://chatyy.com.br/support')} colors={colors} />
      </Section>

      <View style={{ paddingHorizontal: 20, paddingVertical: 20, alignItems: 'center' }}>
        <Text style={{ fontSize: 11, color: colors?.textTertiary, textAlign: 'center' }}>
          © 2026 OneMundo · chatyy.com.br
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Screen: Support ─────────────────────────────────────────────────
function SupportScreen({ colors, t }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('support.contact') || 'Contato'} colors={colors}>
        <Row icon={IconMessageSquare} label={t?.('support.email') || 'Enviar email para suporte'}
          onPress={() => Linking.openURL('mailto:suporte@chatyy.com.br?subject=Chatyy%20-%20Ajuda')}
          colors={colors}
          value="suporte@chatyy.com.br"
        />
        <Row icon={IconGlobe} label={t?.('support.website') || 'Central de ajuda'}
          onPress={() => Linking.openURL('https://chatyy.com.br/suporte')}
          colors={colors}
        />
      </Section>
      <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
        <Text style={{ fontSize: 13, color: colors?.textSecondary, lineHeight: 20 }}>
          {t?.('support.description') ||
            'Conta pra gente o que aconteceu que respondemos em até 24h em dias úteis.'}
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Screen: Reading ─────────────────────────────────────────────────
function ReadingScreen({ colors, t }) {
  const [fontSize, setFontSize] = useState('medium');
  const [emailReadReceipts, setEmailReadReceipts] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.getSettings?.();
        if (r?.success && r.data) {
          setFontSize(r.data.font_size || 'medium');
          setEmailReadReceipts(!!r.data.read_receipts);
        }
      } catch {}
    })();
  }, []);

  const updateFont = async (v) => {
    setFontSize(v);
    try { await api.updateSettings?.({ font_size: v }); } catch {}
  };
  const updateReceipts = async (v) => {
    setEmailReadReceipts(v);
    try { await api.updateSettings?.({ read_receipts: v }); } catch {}
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('settings.fontSize') || 'Tamanho da fonte'} colors={colors}>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
          {[
            { v: 'small',  label: t?.('settings.fontSmall')  || 'Pequeno', size: 13 },
            { v: 'medium', label: t?.('settings.fontMedium') || 'Médio',   size: 15 },
            { v: 'large',  label: t?.('settings.fontLarge')  || 'Grande',  size: 17 },
          ].map(opt => {
            const active = fontSize === opt.v;
            return (
              <TouchableOpacity
                key={opt.v}
                onPress={() => updateFont(opt.v)}
                activeOpacity={0.7}
                style={{
                  flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center',
                  backgroundColor: active ? ACCENT : (colors?.surface || '#f3f4f6'),
                }}
              >
                <Text style={{
                  fontSize: opt.size,
                  fontWeight: '600',
                  color: active ? '#fff' : colors?.text,
                }}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Section>
      <Section colors={colors}>
        <ToggleRow
          icon={IconMail}
          label={t?.('settings.emailReadReceipts') || 'Confirmações de leitura de email'}
          description={t?.('settings.emailReadReceiptsDesc') || 'Avisar remetentes quando você abrir o email deles'}
          value={emailReadReceipts}
          onChange={updateReceipts}
          colors={colors}
        />
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Email & compose ─────────────────────────────────────────
// ─── Screen: Vacation responder (auto-reply) ─────────────────────────
function VacationScreen({ colors, t }) {
  const [enabled, setEnabled] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [onlyContacts, setOnlyContacts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.vacationGet?.();
        if (r?.success && r.data) {
          setEnabled(!!r.data.enabled);
          setStartDate(r.data.start_date || '');
          setEndDate(r.data.end_date || '');
          setSubject(r.data.subject || '');
          setBody(r.data.body || '');
          setOnlyContacts(!!r.data.only_contacts);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const save = async (override = {}) => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        enabled: override.enabled ?? enabled,
        start_date: startDate || null,
        end_date: endDate || null,
        subject: subject || (t?.('settings.vacationDefaultSubject') || 'Em férias'),
        body,
        only_contacts: onlyContacts,
        ...override,
      };
      const r = await api.vacationSet?.(payload);
      if (r?.success) setSavedAt(Date.now());
    } catch {}
    setSaving(false);
  };

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={ACCENT} /></View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
      <Section title={t?.('settings.vacation') || 'Resposta automática'} colors={colors}>
        <ToggleRow
          icon={IconMail}
          label={enabled ? (t?.('common.enabled') || 'Ativada') : (t?.('common.disabled') || 'Desativada')}
          value={enabled}
          onChange={(v) => { setEnabled(v); save({ enabled: v }); }}
          colors={colors}
        />
      </Section>

      {enabled && (
        <>
          <Section title={t?.('settings.vacationStart') || 'Início'} colors={colors}>
            <TextInput
              value={startDate}
              onChangeText={setStartDate}
              onEndEditing={() => save()}
              placeholder="2026-05-01"
              placeholderTextColor={colors?.textTertiary}
              autoCapitalize="none"
              style={{ paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, color: colors?.text }}
            />
          </Section>

          <Section title={t?.('settings.vacationEnd') || 'Fim'} colors={colors}>
            <TextInput
              value={endDate}
              onChangeText={setEndDate}
              onEndEditing={() => save()}
              placeholder="2026-05-15"
              placeholderTextColor={colors?.textTertiary}
              autoCapitalize="none"
              style={{ paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, color: colors?.text }}
            />
          </Section>

          <Section title={t?.('settings.vacationSubject') || 'Assunto'} colors={colors}>
            <TextInput
              value={subject}
              onChangeText={setSubject}
              onEndEditing={() => save()}
              placeholder={t?.('settings.vacationDefaultSubject') || 'Em férias até [data]'}
              placeholderTextColor={colors?.textTertiary}
              style={{ paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, color: colors?.text }}
            />
          </Section>

          <Section title={t?.('settings.vacationMessage') || 'Mensagem'} colors={colors}>
            <TextInput
              value={body}
              onChangeText={setBody}
              onEndEditing={() => save()}
              multiline
              placeholder={t?.('settings.autoReplyPlaceholder') || 'Estou de férias, volto na segunda...'}
              placeholderTextColor={colors?.textTertiary}
              style={{ minHeight: 110, textAlignVertical: 'top', paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, color: colors?.text }}
            />
          </Section>

          <Section title={t?.('settings.vacationAudience') || 'Enviar para'} colors={colors}>
            <ToggleRow
              icon={IconUsers}
              label={t?.('settings.vacationOnlyContacts') || 'Apenas contatos'}
              description={t?.('settings.vacationOnlyContactsDesc') || 'Não responder pra desconhecidos / spam'}
              value={onlyContacts}
              onChange={(v) => { setOnlyContacts(v); save({ only_contacts: v }); }}
              colors={colors}
            />
          </Section>

          <View style={{ paddingHorizontal: 20, marginTop: 14 }}>
            <TouchableOpacity
              onPress={() => save()}
              disabled={saving}
              style={{ backgroundColor: ACCENT, paddingVertical: 14, borderRadius: 12, alignItems: 'center' }}
            >
              {saving ? <ActivityIndicator color="#fff" /> : (
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                  {savedAt && Date.now() - savedAt < 2000
                    ? (t?.('common.saved') || 'Salvo')
                    : (t?.('common.save') || 'Salvar')}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function EmailComposeScreen({ colors, t, push }) {
  const [undoDelay, setUndoDelay] = useState(5);
  const [perPage, setPerPage] = useState(20);
  const [signature, setSignature] = useState('');
  const [autoReply, setAutoReply] = useState(false);
  const [autoReplyMsg, setAutoReplyMsg] = useState('');
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [forwardEmail, setForwardEmail] = useState('');
  const [morningBriefing, setMorningBriefing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.getSettings?.();
        if (r?.success && r.data) {
          setSignature(r.data.signature || '');
          setPerPage(r.data.emails_per_page || 20);
          setAutoReply(!!r.data.auto_reply);
          setAutoReplyMsg(r.data.auto_reply_message || '');
          setForwardEnabled(!!r.data.forwarding_enabled);
          setForwardEmail(r.data.forwarding_email || '');
          setMorningBriefing(!!r.data.morning_briefing);
        }
        if (Platform.OS === 'web') {
          const d = (typeof localStorage !== 'undefined') ? localStorage.getItem('undo_send_delay') : null;
          if (d) setUndoDelay(parseInt(d, 10) || 5);
        } else {
          const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
          const d = await AsyncStorage.getItem('undo_send_delay');
          if (d) setUndoDelay(parseInt(d, 10) || 5);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const save = async (patch) => {
    try { await api.updateSettings?.(patch); } catch {}
  };
  const saveUndo = async (v) => {
    setUndoDelay(v);
    try {
      if (Platform.OS === 'web') localStorage?.setItem?.('undo_send_delay', String(v));
      else {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem('undo_send_delay', String(v));
      }
    } catch {}
  };

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={ACCENT} /></View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Undo send */}
      <Section title={t?.('settings.emailUndoSend') || 'Desfazer envio'} colors={colors}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
          <Text style={{ fontSize: 12, color: colors?.textSecondary, marginBottom: 10 }}>
            {t?.('settings.emailUndoSendDesc') || 'Janela de tempo pra cancelar um email após enviar'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[5, 10, 15, 30].map(s => {
              const active = undoDelay === s;
              return (
                <TouchableOpacity key={s} onPress={() => saveUndo(s)} activeOpacity={0.7}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                    backgroundColor: active ? ACCENT : (colors?.surface || '#f3f4f6'),
                  }}
                >
                  <Text style={{ color: active ? '#fff' : colors?.text, fontWeight: '600' }}>{s}s</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Section>

      {/* Emails per page */}
      <Section title={t?.('settings.emailsPerPage') || 'Emails por página'} colors={colors}>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
          {[20, 50, 100].map(n => {
            const active = perPage === n;
            return (
              <TouchableOpacity key={n}
                onPress={() => { setPerPage(n); save({ emails_per_page: n }); }}
                activeOpacity={0.7}
                style={{
                  flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                  backgroundColor: active ? ACCENT : (colors?.surface || '#f3f4f6'),
                }}
              >
                <Text style={{ color: active ? '#fff' : colors?.text, fontWeight: '600' }}>{n}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Section>

      {/* Signature */}
      <Section title={t?.('settings.emailSignatures') || 'Assinatura'} colors={colors}>
        <TextInput
          value={signature}
          onChangeText={setSignature}
          onEndEditing={() => save({ signature })}
          multiline
          placeholder={t?.('settings.emailSignaturesPlaceholder') || 'Sua assinatura — ex: Aleff Duarte · Chatyy'}
          placeholderTextColor={colors?.textTertiary}
          style={{
            minHeight: 70, textAlignVertical: 'top',
            paddingHorizontal: 16, paddingVertical: 12,
            fontSize: 14, color: colors?.text,
          }}
        />
      </Section>

      {/* Auto-reply */}
      <Section title={t?.('settings.emailAutoReply') || 'Resposta automática'} colors={colors}>
        <ToggleRow
          icon={IconMail}
          label={t?.('settings.enableAutoReply') || 'Ativar'}
          value={autoReply}
          onChange={(v) => { setAutoReply(v); save({ auto_reply: v }); }}
          colors={colors}
        />
        {autoReply && (
          <TextInput
            value={autoReplyMsg}
            onChangeText={setAutoReplyMsg}
            onEndEditing={() => save({ auto_reply_message: autoReplyMsg })}
            multiline
            placeholder={t?.('settings.autoReplyPlaceholder') || 'Estou de férias, volto na segunda...'}
            placeholderTextColor={colors?.textTertiary}
            style={{
              minHeight: 70, textAlignVertical: 'top',
              paddingHorizontal: 16, paddingVertical: 12,
              fontSize: 14, color: colors?.text,
            }}
          />
        )}
      </Section>

      {/* Forwarding */}
      <Section title={t?.('settings.emailForwarding') || 'Encaminhamento'} colors={colors}>
        <ToggleRow
          icon={IconForward}
          label={t?.('settings.enableForwarding') || 'Encaminhar todos os emails'}
          value={forwardEnabled}
          onChange={(v) => { setForwardEnabled(v); save({ forwarding_enabled: v }); }}
          colors={colors}
        />
        {forwardEnabled && (
          <TextInput
            value={forwardEmail}
            onChangeText={setForwardEmail}
            onEndEditing={() => save({ forwarding_email: forwardEmail })}
            placeholder={t?.('settings.emailForwardingPlaceholder') || 'destino@exemplo.com'}
            placeholderTextColor={colors?.textTertiary}
            keyboardType="email-address"
            autoCapitalize="none"
            style={{
              paddingHorizontal: 16, paddingVertical: 12,
              fontSize: 14, color: colors?.text,
            }}
          />
        )}
      </Section>

      {/* Morning briefing */}
      <Section title={t?.('settings.morningBriefing') || 'Resumo matinal'} colors={colors}>
        <ToggleRow
          icon={IconSparkles}
          label={t?.('settings.morningBriefing') || 'Resumo matinal'}
          description={t?.('settings.morningBriefingDesc') || 'Receba às 8h um resumo dos seus emails da noite feito pela IA'}
          value={morningBriefing}
          onChange={(v) => { setMorningBriefing(v); save({ morning_briefing: v }); }}
          colors={colors}
        />
      </Section>
    </ScrollView>
  );
}

// ─── Screen: AI features ─────────────────────────────────────────────
function AIFeaturesScreen({ colors, t }) {
  const [smartCompose, setSmartCompose] = useState(true);
  const [oneEnabled, setOneEnabled] = useState(true);
  const [oneNotifLevel, setOneNotifLevel] = useState('push');
  const [smartReply, setSmartReply] = useState(true);
  const [aiSummary, setAiSummary]     = useState(true);
  const [aiEnhance, setAiEnhance]     = useState(true);

  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS === 'web') {
          const sc = (typeof localStorage !== 'undefined') ? localStorage.getItem('smart_compose') : null;
          if (sc === 'false') setSmartCompose(false);
          const oe = (typeof localStorage !== 'undefined') ? localStorage.getItem('one_enabled') : null;
          if (oe === 'false') setOneEnabled(false);
          const ol = (typeof localStorage !== 'undefined') ? localStorage.getItem('one_notif_level') : null;
          if (ol) setOneNotifLevel(ol);
          const sr = (typeof localStorage !== 'undefined') ? localStorage.getItem('ai_smart_reply') : null;
          if (sr === 'false') setSmartReply(false);
          const aiSum = (typeof localStorage !== 'undefined') ? localStorage.getItem('ai_summary') : null;
          if (aiSum === 'false') setAiSummary(false);
          const aiEn = (typeof localStorage !== 'undefined') ? localStorage.getItem('ai_enhance') : null;
          if (aiEn === 'false') setAiEnhance(false);
        } else {
          const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
          const sc = await AsyncStorage.getItem('smart_compose');
          if (sc === 'false') setSmartCompose(false);
          const oe = await AsyncStorage.getItem('one_enabled');
          if (oe === 'false') setOneEnabled(false);
          const ol = await AsyncStorage.getItem('one_notif_level');
          if (ol) setOneNotifLevel(ol);
          const sr = await AsyncStorage.getItem('ai_smart_reply');
          if (sr === 'false') setSmartReply(false);
          const aiSum = await AsyncStorage.getItem('ai_summary');
          if (aiSum === 'false') setAiSummary(false);
          const aiEn = await AsyncStorage.getItem('ai_enhance');
          if (aiEn === 'false') setAiEnhance(false);
        }
      } catch {}
    })();
  }, []);

  const writeLocal = async (key, value) => {
    try {
      if (Platform.OS === 'web') localStorage?.setItem?.(key, value);
      else {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem(key, value);
      }
    } catch {}
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section colors={colors}>
        <ToggleRow
          icon={IconSparkles}
          label={t?.('settings.smartCompose') || 'Composição inteligente'}
          description={t?.('settings.smartComposeDesc') || 'Sugestões de texto enquanto você digita um email'}
          value={smartCompose}
          onChange={(v) => { setSmartCompose(v); writeLocal('smart_compose', v ? 'true' : 'false'); }}
          colors={colors}
        />
      </Section>
      <Section title={t?.('settings.oneAssistant') || 'One Assistente'} colors={colors}>
        <ToggleRow
          icon={IconSparkles}
          label={t?.('settings.oneAssistantEnable') || 'Ativar One'}
          description={t?.('settings.oneAssistantDesc') || 'Seu assistente pessoal nos apps Chatyy'}
          value={oneEnabled}
          onChange={(v) => { setOneEnabled(v); writeLocal('one_enabled', v ? 'true' : 'false'); }}
          colors={colors}
        />
      </Section>
      {oneEnabled && (
        <Section title={t?.('settings.oneNotifLevel') || 'Tipo de notificação'} colors={colors}>
          <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingVertical: 10 }}>
            {[
              { v: 'email',  label: t?.('settings.oneNotifEmail')  || 'Só email' },
              { v: 'push',   label: t?.('settings.oneNotifPush')   || 'Push e email' },
              { v: 'urgent', label: t?.('settings.oneNotifUrgent') || 'Só urgente' },
            ].map(opt => {
              const active = oneNotifLevel === opt.v;
              return (
                <TouchableOpacity key={opt.v}
                  onPress={() => { setOneNotifLevel(opt.v); writeLocal('one_notif_level', opt.v); }}
                  activeOpacity={0.7}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                    backgroundColor: active ? ACCENT : (colors?.surface || '#f3f4f6'),
                  }}
                >
                  <Text style={{ color: active ? '#fff' : colors?.text, fontWeight: '600', fontSize: 13 }}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>
      )}
      {/* Real toggles for the three AI sub-features. Previously these were
          Row items with onPress={() => {}} which Apple flagged as dead
          buttons (2.1a). Now each persists to local storage and the
          feature code reads them where used. */}
      <Section title={t?.('settings.aiFeatures') || 'Recursos com IA'} colors={colors}>
        <ToggleRow
          icon={IconSparkles}
          label={t?.('settings.smartReply') || 'Respostas rápidas'}
          description={t?.('settings.smartReplyDesc') || 'Sugestões de 1 toque para responder'}
          value={smartReply}
          onChange={(v) => { setSmartReply(v); writeLocal('ai_smart_reply', v ? 'true' : 'false'); }}
          colors={colors}
        />
        <ToggleRow
          icon={IconFileText}
          label={t?.('settings.aiSummary') || 'Resumo com IA'}
          description={t?.('settings.aiSummaryDesc') || 'Resumir threads longas em 3 linhas'}
          value={aiSummary}
          onChange={(v) => { setAiSummary(v); writeLocal('ai_summary', v ? 'true' : 'false'); }}
          colors={colors}
        />
        <ToggleRow
          icon={IconEdit}
          label={t?.('settings.aiEnhance') || 'Melhorar texto com IA'}
          description={t?.('settings.aiEnhanceDesc') || 'Reescrever pra soar mais profissional ou amigável'}
          value={aiEnhance}
          onChange={(v) => { setAiEnhance(v); writeLocal('ai_enhance', v ? 'true' : 'false'); }}
          colors={colors}
        />
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Delete account (Apple requirement) ──────────────────────
function DeleteAccountScreen({ colors, t, onClose, onLogout }) {
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('confirm'); // 'confirm' | 'password'
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      const r = await api.apiCall?.('delete_account', { password }, 'POST');
      if (r?.success) {
        Alert.alert(t?.('settings.accountDeleted') || 'Conta excluída',
          t?.('settings.accountDeletedMsg') || 'Sua conta foi excluída. Até mais!');
        onClose?.();
        setTimeout(() => onLogout?.(), 200);
      } else {
        setError(r?.message || (t?.('settings.deleteAccountWrongPassword') || 'Senha incorreta'));
      }
    } catch (e) {
      setError(e?.message || (t?.('common.error') || 'Erro'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 20, alignItems: 'center' }}>
        <View style={{
          width: 76, height: 76, borderRadius: 38,
          backgroundColor: '#ef444422', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          <IconAlertTriangle size={36} color="#ef4444" />
        </View>
        <Text style={{ fontSize: 18, fontWeight: '800', color: colors?.text, textAlign: 'center' }}>
          {t?.('settings.deleteAccountConfirmTitle') || 'Excluir sua conta?'}
        </Text>
        <Text style={{ fontSize: 13, color: colors?.textSecondary, textAlign: 'center', marginTop: 10, lineHeight: 19 }}>
          {t?.('settings.deleteAccountConfirmMessage') ||
            'Essa ação é permanente. Todos os seus emails, conversas, fotos, arquivos e assinaturas serão apagados. Você não poderá recuperar depois. Tem certeza?'}
        </Text>
      </View>

      {step === 'confirm' ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <TouchableOpacity
            onPress={() => setStep('password')}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#ef4444', borderRadius: 12, paddingVertical: 14,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
              {t?.('settings.deleteAccountContinue') || 'Continuar'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            style={{
              borderRadius: 12, paddingVertical: 14,
              alignItems: 'center',
              backgroundColor: colors?.surface || '#f3f4f6',
            }}
          >
            <Text style={{ color: colors?.text, fontWeight: '600', fontSize: 15 }}>
              {t?.('common.cancel') || 'Cancelar'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <Text style={{ fontSize: 13, color: colors?.textSecondary }}>
            {t?.('settings.deleteAccountPasswordPrompt') || 'Digite sua senha pra confirmar'}
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors?.textTertiary}
            secureTextEntry
            style={{
              borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border || '#ddd',
              borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
              fontSize: 15, color: colors?.text,
              backgroundColor: colors?.surface || '#f7f7f7',
            }}
            autoFocus
          />
          {!!error && (
            <Text style={{ color: '#ef4444', fontSize: 13 }}>{error}</Text>
          )}
          <TouchableOpacity
            onPress={handleDelete}
            disabled={!password || deleting}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#ef4444', borderRadius: 12, paddingVertical: 14,
              alignItems: 'center', opacity: !password || deleting ? 0.5 : 1,
            }}
          >
            {deleting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                {t?.('settings.deleteAccount') || 'Excluir conta'}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('confirm')} activeOpacity={0.7} style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ color: colors?.textSecondary, fontSize: 14 }}>
              {t?.('common.back') || 'Voltar'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Screen: Account data export (GDPR) ──────────────────────────────
function ExportDataScreen({ colors, t }) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const requestExport = async () => {
    setWorking(true); setError(''); setResult(null);
    try {
      const r = await api.accountDataExport?.();
      if (r?.success && r.data) setResult(r.data);
      else setError(r?.message || (t?.('common.error') || 'Erro'));
    } catch (e) { setError(e?.message || (t?.('common.error') || 'Erro')); }
    finally { setWorking(false); }
  };

  const openUrl = (u) => {
    if (!u) return;
    try { Linking.openURL(u); } catch {}
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 14, color: colors?.text, lineHeight: 22, marginBottom: 16 }}>
          {t?.('settings.exportDataConfirm')
            || 'Vamos preparar um arquivo JSON com seu perfil, lista de conversas, pastas de email e posts do feed. O link de download estará disponível por 24h. Limite: 1 exportação a cada 24h.'}
        </Text>
        {result?.url ? (
          <View style={{ backgroundColor: colors?.surface, padding: 14, borderRadius: 10, marginBottom: 12 }}>
            <Text style={{ fontSize: 12, color: colors?.textSecondary, marginBottom: 6 }}>
              {t?.('settings.exportReady') || 'Pronto! Toque pra baixar:'}
            </Text>
            <TouchableOpacity onPress={() => openUrl(result.url)}>
              <Text style={{ fontSize: 13, color: ACCENT, fontWeight: '600' }} numberOfLines={2}>{result.url}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {!!error && <Text style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</Text>}
        <TouchableOpacity
          disabled={working}
          onPress={requestExport}
          style={{
            backgroundColor: ACCENT, paddingVertical: 13, borderRadius: 12, alignItems: 'center',
            opacity: working ? 0.6 : 1,
          }}
          accessibilityRole="button"
        >
          {working
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                {t?.('settings.exportData') || 'Baixar meus dados'}
              </Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Main component ──────────────────────────────────────────────────
const SCREEN_TITLES = {
  main: 'settings.title',
  security: 'settings.security',
  privacy: 'settings.privacy',
  notifications: 'settings.notifications',
  language: 'settings.language',
  reading: 'settings.reading',
  email: 'settings.emailCompose',
  ai: 'settings.aiFeatures',
  invite: 'referral.inviteFriends',
  about: 'settings.about',
  support: 'settings.support',
  delete: 'settings.deleteAccount',
  export: 'settings.exportData',
  vacation: 'settings.vacation',
};
const SCREEN_TITLE_FALLBACK = {
  main: 'Configurações',
  security: 'Segurança e senha',
  privacy: 'Privacidade',
  notifications: 'Notificações',
  language: 'Idioma',
  reading: 'Leitura',
  email: 'Email e composição',
  ai: 'Recursos com IA',
  invite: 'Convidar amigos',
  about: 'Sobre o Chatyy',
  support: 'Suporte',
  delete: 'Excluir conta',
  export: 'Baixar meus dados',
  vacation: 'Resposta automática',
  filters: 'Filtros de email',
};

export default function ProfileSettingsSheet({
  visible, onClose, colors, isDark, t, router, onLogout, onEditProfile,
}) {
  const [stack, setStack] = useState(['main']);
  const currentScreen = stack[stack.length - 1];

  // Reset to main whenever the sheet opens so the user always starts at the
  // root menu — avoids them coming back mid-navigation to a random sub-screen.
  useEffect(() => { if (visible) setStack(['main']); }, [visible]);

  const push = useCallback((screen) => setStack(prev => [...prev, screen]), []);
  const pop = useCallback(() => setStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev), []);

  // Apple 2.1 rejection (2026-04-22): "No action occurred when tapping
  // 'Planos e assinaturas'" on iPad. Root cause: bottom-sheet Modal stays in
  // the view tree until dismiss animation finishes (~300ms), and any
  // router.push fired during that window pushes UNDER the modal, looking
  // like a no-op. We schedule the navigation as a "pending intent", close
  // the sheet, and execute the intent ONLY after Modal fires onDismiss
  // (iOS) or after a deliberate 400ms delay (Android — onDismiss is
  // iOS-only).
  const pendingActionRef = useRef(null);

  const closeAndRun = useCallback((action) => {
    pendingActionRef.current = action;
    onClose?.();
    if (Platform.OS !== 'ios') {
      setTimeout(() => {
        const a = pendingActionRef.current;
        pendingActionRef.current = null;
        try { a?.(); } catch {}
      }, 400);
    }
  }, [onClose]);

  const flushPendingAction = useCallback(() => {
    const a = pendingActionRef.current;
    pendingActionRef.current = null;
    if (a) {
      // requestAnimationFrame ensures the navigator has committed the
      // dismiss before we push, especially on iPad where the modal lingers
      // a frame past onDismiss.
      requestAnimationFrame(() => { try { a(); } catch {} });
    }
  }, []);

  const handleEditProfile = useCallback(() => closeAndRun(() => onEditProfile?.()), [closeAndRun, onEditProfile]);
  const handleLogout = useCallback(() => closeAndRun(() => onLogout?.()), [closeAndRun, onLogout]);

  const title = (t?.(SCREEN_TITLES[currentScreen]) || SCREEN_TITLE_FALLBACK[currentScreen]);

  const renderBody = () => {
    switch (currentScreen) {
      case 'security':      return <SecurityScreen colors={colors} t={t} router={router} onClose={onClose} />;
      case 'privacy':       return <PrivacyScreen colors={colors} t={t} />;
      case 'notifications': return <NotificationsScreen colors={colors} t={t} />;
      case 'language':      return <LanguageScreen colors={colors} t={t} />;
      case 'reading':       return <ReadingScreen colors={colors} t={t} />;
      case 'email':         return <EmailComposeScreen colors={colors} t={t} push={push} />;
      case 'ai':            return <AIFeaturesScreen colors={colors} t={t} />;
      case 'invite':        return <InviteScreen colors={colors} t={t} />;
      case 'about':         return <AboutScreen colors={colors} t={t} />;
      case 'support':       return <SupportScreen colors={colors} t={t} />;
      case 'delete':        return <DeleteAccountScreen colors={colors} t={t} onClose={onClose} onLogout={handleLogout} />;
      case 'export':        return <ExportDataScreen colors={colors} t={t} />;
      case 'vacation':      return <VacationScreen colors={colors} t={t} />;
      default:
        return (
          <MainScreen
            push={push}
            onEditProfile={handleEditProfile}
            onLogout={handleLogout}
            colors={colors}
            isDark={isDark}
            t={t}
            router={router}
            onClose={onClose}
            closeAndRun={closeAndRun}
          />
        );
    }
  };

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={flushPendingAction}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || '#fff',
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '92%', minHeight: '70%',
          }}
          onPress={e => e.stopPropagation?.()}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 10 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>

          {/* Header with back button (on sub-screens) + title + close */}
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 12, paddingVertical: 10,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border,
          }}>
            {stack.length > 1 ? (
              <TouchableOpacity onPress={pop} style={{ padding: 6 }} accessibilityLabel={t?.('common.back') || 'Voltar'}>
                <IconArrowLeft size={22} color={colors?.text} />
              </TouchableOpacity>
            ) : (
              <View style={{ width: 34 }} />
            )}
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors?.text, textAlign: 'center' }}>
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }} accessibilityLabel={t?.('common.close') || 'Fechar'}>
              <IconX size={22} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          {renderBody()}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
