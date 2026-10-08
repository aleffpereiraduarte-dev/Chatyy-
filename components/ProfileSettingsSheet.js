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

import NativeSwitch from './NativeSwitch'; // [2026-10-07 app-feel-ui] themed native toggle
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
  IconClock, IconImage, IconStar, IconMapPin, IconSearch,
  IconSmartphone, IconMonitor, IconShield, IconBarChart, IconGiftBox,
  IconEyeOff, IconArchive, IconCloud, IconCheck, IconBrush, IconZap, IconMusic, IconFilm,
} from './Icons';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import { useTheme, ACCENT_PRESETS } from '../context/ThemeContext';
import { useBiometric } from '../context/BiometricContext';
import { useCurrency } from '../context/CurrencyContext';
import SettingsSegmented from './SettingsSegmented';
import StorageShopSheet from './StorageShopSheet';
import { openStripePortal, isStripeCardAvailable } from '../services/stripeCheckout';
import { useLanguage } from '../context/LanguageContext';
import Svg, { Rect as SvgRect, Circle as SvgCircle, Polygon as SvgPolygon, G as SvgG, Defs as SvgDefs, ClipPath as SvgClipPath } from 'react-native-svg';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { WALLET_ENABLED, MONETIZATION_ENABLED } from '../constants/featureFlags';

const ACCENT = '#111111';

// [FIX cross-account cache leak 2026-10-05] These sender-local flags
// (strip-EXIF, sealed-sender, phone-visibility cache, push master switch)
// used to live under GLOBAL AsyncStorage keys, so a device with more than
// one logged-in account made account B inherit account A's choices. Scope
// every key to the active account email. `_acctKey` returns the bare key
// only when no account is resolvable (logged-out edge) — it never resolves
// to a DIFFERENT account's value.
function _activeEmail() {
  try {
    return (typeof api.getActiveAccountEmail === 'function' ? api.getActiveAccountEmail() : '') || '';
  } catch { return ''; }
}
function _acctKey(base) {
  const email = _activeEmail();
  return email ? `${base}:${email}` : base;
}
// Read a per-account flag, falling back ONCE to the legacy global key so an
// existing single-account user's saved choice survives the upgrade. Never
// reads another account's namespaced value.
async function _readAcctFlag(AsyncStorage, base) {
  const nk = _acctKey(base);
  let v = null;
  try { v = await AsyncStorage.getItem(nk); } catch {}
  if (v == null && nk !== base) {
    try { v = await AsyncStorage.getItem(base); } catch {}
  }
  return v;
}

// ─── Shared building blocks ──────────────────────────────────────────
// Row — iconTint is the brand colour for the icon glyph + a 14% bg tint
// behind it. When omitted, falls back to the previous neutral "surface
// chip" look. Instagram 2024 uses tinted square icons per section
// (Account=purple, Privacy=red, Notifications=amber, Language=blue,
// Help=gray) and we mirror that. `right` overrides the trailing chevron
// for switches/value labels. `noChevron` hides it when there's no
// navigation (terminal info rows).
function Row({ icon: Icon, label, value, onPress, colors, destructive, right, iconTint, noChevron }) {
  // Monochrome, theme-aware icon treatment. The settings palette is unified
  // on a single neutral tint ('#111111') so every section icon reads as one
  // family (Instagram-level consistency) — but a hardcoded near-black glyph is
  // invisible in dark mode, so we resolve the glyph + chip from theme tokens:
  //   • mono/neutral  → colors.text glyph on a soft surfaceVariant chip
  //   • gray helper    → colors.textSecondary glyph
  //   • destructive    → red glyph on a red-tinted chip
  //   • explicit color → keep the brand color + 12% tinted chip
  const isMono = iconTint === '#111111';
  const isGray = iconTint === '#64748b';
  const glyph = destructive ? '#ef4444'
    : isMono ? (colors?.text || '#111')
    : isGray ? (colors?.textSecondary || '#64748b')
    : (iconTint || (colors?.textSecondary || '#64748b'));
  const chipBg = destructive ? 'rgba(239,68,68,0.12)'
    : (isMono || isGray || !iconTint) ? (colors?.surfaceVariant || '#f1f5f9')
    : iconTint + '1F';  // 1F = ~12% alpha — Instagram-style colored chip
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 14,
        backgroundColor: pressed ? (colors?.surfaceVariant || 'rgba(0,0,0,0.04)') : 'transparent',
      })}
    >
      <View style={{
        width: 34, height: 34, borderRadius: 9,
        backgroundColor: Icon ? chipBg : 'transparent',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {Icon && <Icon size={18} color={glyph} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15.5, fontWeight: '500', letterSpacing: -0.1, color: destructive ? '#ef4444' : (colors?.text || '#111') }}>
          {label}
        </Text>
        {!!value && (
          <Text style={{ fontSize: 12.5, color: colors?.textSecondary, marginTop: 2 }} numberOfLines={1}>
            {value}
          </Text>
        )}
      </View>
      {right !== undefined
        ? right
        : (noChevron || !onPress
            ? null
            : <IconChevronRight size={18} color={colors?.textTertiary || '#bbb'} />)}
    </Pressable>
  );
}

// Grouped card (iOS/Instagram-level). Section title is a discreet uppercase
// caption; the rows sit inside a single rounded, hairline-bordered surface
// card with inset hairline separators between them (aligned to where the row
// label begins, ~64px, so the icon column reads as a clean gutter). Dividers
// are injected here instead of per-row so every screen that renders rows in a
// Section gets consistent separators with zero double-lines.
function Section({ title, children, colors }) {
  const kids = React.Children.toArray(children).filter(Boolean);
  const dividerColor = colors?.borderLight || 'rgba(0,0,0,0.06)';
  return (
    <View style={{ marginTop: 22 }}>
      {title ? (
        <Text style={{
          fontSize: 12, fontWeight: '700', textTransform: 'uppercase',
          color: colors?.textTertiary,
          marginLeft: 20, marginRight: 20, marginBottom: 9,
          letterSpacing: 0.7,
        }}>
          {title}
        </Text>
      ) : null}
      <View style={{
        marginHorizontal: 16,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: colors?.surface || '#fff',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors?.border || 'rgba(0,0,0,0.08)',
      }}>
        {kids.map((child, i) => (
          <React.Fragment key={i}>
            {i > 0 ? (
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: dividerColor, marginLeft: 64 }} />
            ) : null}
            {child}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

function ToggleRow({ icon: Icon, label, value, onChange, colors, description }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 16, paddingVertical: 13, gap: 14,
    }}>
      <View style={{
        width: 34, height: 34, borderRadius: 9,
        backgroundColor: colors?.surfaceVariant || '#f3f4f6',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {Icon && <Icon size={18} color={colors?.text || '#64748b'} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15.5, fontWeight: '500', letterSpacing: -0.1, color: colors?.text }}>{label}</Text>
        {!!description && (
          <Text style={{ fontSize: 12.5, color: colors?.textSecondary, marginTop: 2, lineHeight: 17 }}>{description}</Text>
        )}
      </View>
      <NativeSwitch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ false: isDarkColors(colors) ? '#3a3a3a' : '#ddd', true: colors?.primary || ACCENT }}
        thumbColor="#fff"
        ios_backgroundColor={isDarkColors(colors) ? '#3a3a3a' : '#ddd'}
      />
    </View>
  );
}

// Footnote — grey explanatory caption BELOW a card (iOS grouped-table footer).
function Footnote({ children, colors }) {
  return (
    <Text style={{
      fontSize: 12.5, lineHeight: 17, color: colors?.textTertiary,
      marginHorizontal: 20, marginTop: 10,
    }}>
      {children}
    </Text>
  );
}

function AccentColorRow({ colors, t }) {
  const { accentColor, setAccentColor } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 13, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{
          width: 34, height: 34, borderRadius: 9,
          backgroundColor: colors?.surfaceVariant || '#f3f4f6',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: accentColor }} />
        </View>
        <Text style={{ fontSize: 15.5, fontWeight: '500', letterSpacing: -0.1, color: colors?.text || '#111', flex: 1 }}>
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
// Instagram 2024-style settings:
//  • Hero card (avatar + name + email + "edit profile" tap target)
//  • Plus upsell card (gradient) — only when user has no active plan
//  • Sticky search bar that fuzzy-filters all rows by label
//  • Section icons in tinted squares (purple Account, red Privacy,
//    amber Notifications, blue Language, gray Help) — 1F (~12%) bg
//  • "Sua atividade" surface for time/sessions/devices
//  • "Para criadores e empresas" placeholder section (-> /plans)
//  • Logout/Delete pushed to bottom with strong 6px divider on top
//
// Section colour palette (kept inline so tweaks live next to the rows):
// [beauty 2026-10-02] Settings icons are MONO now — the per-row rainbow
// (amber/blue/teal/green) read busy/dated. All neutral #111111 like the rows
// that already shipped mono (PURPLE/PINK); only danger stays red.
const ICON_PURPLE = '#111111';
const ICON_RED    = '#ef4444';
const ICON_AMBER  = '#111111';
const ICON_BLUE   = '#111111';
const ICON_TEAL   = '#111111';
const ICON_GRAY   = '#64748b';
const ICON_PINK   = '#111111';
const ICON_GREEN  = '#111111';

// ─── Hero card (avatar + name + email) ───────────────────────────────
function HeroCard({ colors, userEmail, userName, username, avatarUrl, onPress, t }) {
  // [2026-10-04] Show the REAL profile — same display name, @handle and photo as
  // the /u/[username] profile screen — not the email local-part. Before, name
  // and @ were both derived from userEmail.split('@')[0], so a user whose email
  // was duarte@ but whose username is @aleffduarte saw a mismatched "@duarte".
  const handle = (username && String(username).trim())
    || (userEmail ? userEmail.split('@')[0] : '');
  const displayName = (userName && String(userName).trim())
    || handle
    || (t?.('settings.yourProfile') || 'Seu perfil');
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginTop: 14,
        padding: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 15,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors?.border || '#e5e7eb',
        backgroundColor: pressed
          ? (colors?.surfaceVariant || colors?.surface || '#f3f4f6')
          : (colors?.surface || '#fff'),
        // Soft lift so the identity card reads as the premium focal point at
        // the top of the sheet (kept subtle; theme-aware).
        ...(Platform.OS === 'web'
          ? { boxShadow: isDarkColors(colors) ? '0 2px 10px rgba(0,0,0,0.35)' : '0 2px 10px rgba(15,23,42,0.06)' }
          : {
              shadowColor: '#000',
              shadowOpacity: isDarkColors(colors) ? 0.28 : 0.06,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 3 },
              elevation: 2,
            }),
      })}
      accessibilityRole="button"
      accessibilityLabel={t?.('settings.editProfile') || 'Editar perfil'}
    >
      <AvatarCircle
        uri={avatarUrl || null}
        email={userEmail}
        name={displayName}
        size={62}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 18, fontWeight: '800', letterSpacing: -0.3, color: colors?.text || '#111' }} numberOfLines={1}>
          {displayName}
        </Text>
        {!!handle && (
          <Text style={{ fontSize: 13.5, color: colors?.textSecondary, marginTop: 2 }} numberOfLines={1}>
            @{handle}
          </Text>
        )}
        {!!userEmail && (
          <Text style={{ fontSize: 12, color: colors?.textTertiary, marginTop: 2 }} numberOfLines={1}>
            {userEmail}
          </Text>
        )}
      </View>
      <IconChevronRight size={18} color={colors?.textTertiary || '#bbb'} />
    </Pressable>
  );
}

// ─── Plus upsell card (gradient) ────────────────────────────────────
function PlusUpsellCard({ colors, onPress, t }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginTop: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: 'rgba(17, 17, 17,0.06)',
        opacity: pressed ? 0.7 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: 'rgba(17, 17, 17,0.28)',
      })}
      accessibilityRole="button"
    >
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: 'rgba(17, 17, 17,0.12)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <IconSparkles size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors?.text || '#111' }} numberOfLines={1}>
          {t?.('settings.plusTeaserTitle') || 'Plus está esperando você'}
        </Text>
        <Text style={{ fontSize: 12, color: colors?.textSecondary || '#64748b', marginTop: 1, opacity: 0.7 }} numberOfLines={1}>
          {t?.('settings.plusTeaserSubtitle') || 'Mais armazenamento, IA ilimitada e selo verificado'}
        </Text>
      </View>
      <IconChevronRight size={16} color={colors?.textSecondary || '#94a3b8'} />
    </Pressable>
  );
}

// ─── Search bar ──────────────────────────────────────────────────────
function SettingsSearchBar({ value, onChangeText, colors, t }) {
  return (
    <View style={{
      marginHorizontal: 16, marginTop: 14, marginBottom: 2,
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 13, height: 40, borderRadius: 12,
      backgroundColor: colors?.surface || '#fff',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors?.border || 'rgba(0,0,0,0.08)',
    }}>
      <IconSearch size={16} color={colors?.textSecondary || '#64748b'} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={t?.('settings.search') || 'Pesquisar'}
        placeholderTextColor={colors?.textTertiary || '#9ca3af'}
        style={{ flex: 1, fontSize: 14, color: colors?.text || '#111', padding: 0 }}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
      />
      {!!value && (
        <TouchableOpacity onPress={() => onChangeText('')} accessibilityLabel="Clear search">
          <IconX size={16} color={colors?.textSecondary || '#64748b'} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// Fuzzy filter — case-insensitive substring on label, no fancy ranking.
// Good enough for ~30 rows. We keep section visibility based on whether
// at least one row inside matches.
function matches(label, q) {
  if (!q) return true;
  return (label || '').toLowerCase().includes(q.toLowerCase());
}

function MainScreen({ push, onEditProfile, onLogout, colors, isDark, t, router, onClose, closeAndRun, userEmail, userName, username, avatarUrl }) {
  const [query, setQuery] = useState('');

  // Linked alt phones count — surfaced as a small badge on the "Outros
  // números" row so the user sees at-a-glance how many secondary numbers
  // are attached. Fetched once on mount; cheap (single API call, the
  // backend stub returns [] when not implemented).
  const [linkedPhonesCount, setLinkedPhonesCount] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.linkedPhonesList?.();
        if (!alive) return;
        const items = Array.isArray(r?.items) ? r.items : [];
        setLinkedPhonesCount(items.filter(p => !p?.is_primary).length);
      } catch {
        if (alive) setLinkedPhonesCount(0);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Build the row catalogue once (stable refs are not critical — the
  // list is tiny). Each entry knows its label, icon, tint and the push
  // target. `q` filters the visible set; sections render only if at
  // least one row inside passed the filter.
  const sections = useMemo(() => ([
    {
      key: 'account',
      title: t?.('settings.account') || 'Conta',
      rows: [
        { icon: IconUser, label: t?.('settings.editProfile') || 'Editar perfil', tint: ICON_PURPLE, onPress: onEditProfile },
        { icon: IconCloud, label: 'Chatyy One', tint: ICON_PURPLE, onPress: () => push('one') },
        { icon: IconLock, label: t?.('settings.security') || 'Segurança e senha', tint: ICON_PURPLE, onPress: () => push('security') },
        { icon: IconEye,  label: t?.('settings.privacy') || 'Privacidade',         tint: ICON_PURPLE, onPress: () => push('privacy') },
        {
          icon: IconPhone,
          label: t?.('linkedPhones.title') || 'Outros números',
          tint: ICON_PURPLE,
          badge: linkedPhonesCount && linkedPhonesCount > 0 ? String(linkedPhonesCount) : null,
          onPress: () => closeAndRun(() => { try { router?.push?.('/linked-phones'); } catch {} }),
        },
      ],
    },
    {
      key: 'activity',
      title: t?.('settings.yourActivity') || 'Sua atividade',
      rows: [
        // 2026-05-20 — "Tempo no app" row removed: it was routing to push('about')
        // (Sobre o Chatyy screen), which has nothing to do with time-on-app
        // analytics. Until we ship a real usage/screen-time feature, the row
        // misled users. Replaced with a route to /activity-log (security audit
        // log) which is the closest real "your activity" surface.
        { icon: IconClock,    label: t?.('settings.activityHistory') || 'Histórico de atividades',  tint: ICON_TEAL, onPress: () => closeAndRun(() => { try { router?.push?.('/activity-log'); } catch {} }) },
        { icon: IconUsers,    label: t?.('settings.linkedDevices') || 'Aparelhos conectados',  tint: ICON_TEAL, onPress: () => push('devices') },
        { icon: IconDatabase, label: t?.('settings.exportData') || 'Baixar meus dados',           tint: ICON_TEAL, onPress: () => push('export') },
        // Reels P1 — Painel de criador (creator monetization dashboard).
        // Surfaces subscriber_count, monthly revenue, tip totals, and
        // top tippers for the logged-in creator. Routes to
        // /profile-creator-dashboard which calls the creator_dashboard
        // backend action.
        { icon: IconBarChart, label: t?.('profile.creatorDashboard') || 'Painel de criador', tint: ICON_PURPLE, onPress: () => closeAndRun(() => { try { router?.push?.('/profile-creator-dashboard'); } catch {} }) },
        // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
        // Carteira + Meus Ganhos rows route to wallet/earnings screens that
        // are hidden during the WhatsApp-style free era. Conditional spread
        // keeps the rows in the source so flipping the flag re-shows them.
        ...(WALLET_ENABLED ? [
          { icon: IconGiftBox, label: t?.('wallet.title') || 'Carteira', tint: ICON_PURPLE, onPress: () => closeAndRun(() => { try { router?.push?.('/wallet'); } catch {} }) },
        ] : []),
        ...(MONETIZATION_ENABLED ? [
          { icon: IconBarChart, label: t?.('creatorEarnings.title') || 'Meus Ganhos', tint: '#10B981', onPress: () => closeAndRun(() => { try { router?.push?.('/creator-earnings'); } catch {} }) },
        ] : []),
      ],
    },
    {
      key: 'preferences',
      title: t?.('settings.preferences') || 'Preferências',
      rows: [
        { icon: IconBell,  label: t?.('settings.notifications') || 'Notificações', tint: ICON_AMBER, onPress: () => push('notifications') },
        { icon: IconBrush, label: t?.('settings.appearance') || 'Aparência',        tint: ICON_BLUE,  onPress: () => push('appearance') },
        { icon: IconGlobe, label: t?.('settings.language') || 'Idioma',            tint: ICON_BLUE,  onPress: () => push('language') },
        { icon: IconDatabase, label: t?.('config.storage') || 'Armazenamento e dados', tint: ICON_BLUE, onPress: () => push('storage') },
        { icon: IconEye,   label: t?.('settings.reading') || 'Leitura',            tint: ICON_BLUE,  onPress: () => push('reading') },
      ],
      // The accent picker is a custom inline row, kept always visible
      // when the section is visible (filtered out when query is non-empty).
      tail: (visible) => visible && !query ? <AccentColorRow colors={colors} t={t} /> : null,
    },
    {
      key: 'email',
      title: t?.('settings.email') || 'Email',
      rows: [
        { icon: IconMail,     label: t?.('settings.emailCompose') || 'Email e composição', tint: ICON_PINK, onPress: () => push('email') },
        { icon: IconClock,    label: t?.('settings.vacation') || 'Resposta automática',    tint: ICON_PINK, onPress: () => push('vacation') },
        { icon: IconSparkles, label: t?.('settings.aiFeatures') || 'Recursos com IA',      tint: ICON_PURPLE, onPress: () => push('ai') },
      ],
    },
    // "Para criadores e empresas" section removed 2026-05-09 by founder request.
    // Both rows routed to /plans, which now lives behind a contextual upsell
    // (UpsellHelper) at gated features instead of a permanent settings entry.
    {
      key: 'community',
      title: t?.('settings.community') || 'Comunidade',
      rows: [
        { icon: IconUserPlus, label: t?.('referral.inviteFriends') || 'Convidar amigos', tint: ICON_GREEN, onPress: () => push('invite') },
      ],
    },
    {
      key: 'help',
      title: t?.('settings.help') || 'Ajuda',
      rows: [
        { icon: IconHelp, label: t?.('settings.support') || 'Suporte',         tint: ICON_GRAY, onPress: () => push('support') },
        { icon: IconInfo, label: t?.('settings.about') || 'Sobre o Chatyy',    tint: ICON_GRAY, onPress: () => push('about') },
      ],
    },
  ]), [t, push, onEditProfile, closeAndRun, router, colors, query]);

  const visibleSections = sections
    .map(s => ({ ...s, rows: s.rows.filter(r => matches(r.label, query)) }))
    .filter(s => s.rows.length > 0);

  // Logout/Delete are always visible at the bottom unless user is
  // searching — when filtering, surface them only if matched.
  const dangerRows = [
    { key: 'logout', icon: IconLogOut,        label: t?.('settings.logout') || 'Sair',                   onPress: onLogout },
    { key: 'delete', icon: IconAlertTriangle, label: t?.('settings.deleteAccount') || 'Excluir conta', destructive: true, onPress: () => push('delete') },
  ];
  const visibleDanger = query ? dangerRows.filter(r => matches(r.label, query)) : dangerRows;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 40 }}
      // Sticky search bar — Instagram has search pinned at top of
      // settings even as you scroll. Hero/upsell scroll out under it.
      // Index is computed dynamically: when query is empty we have 2
      // children before search (hero, upsell) → sticky index = 2.
      // While searching we hide hero+upsell so search is the first
      // child → sticky index = 0. We always render search wrapped in
      // a coloured-background container so the rows scrolling under
      // it don't bleed through.
      stickyHeaderIndices={query ? [0] : [0, 1]}
    >
      {/* Hero + plus card hide while searching to keep results focused. */}
      {!query && <HeroCard colors={colors} userEmail={userEmail} userName={userName} username={username} avatarUrl={avatarUrl} onPress={onEditProfile} t={t} />}
      {/* Plus upsell removed from Configurações (2026-05-08): user prefers a
          cleaner sheet. Upsell still surfaces contextually via UpsellHelper at
          gated features (e.g., backup, custom themes, status views). */}

      <View style={{ backgroundColor: isDark ? (colors?.background || '#000') : (colors?.surfaceVariant || '#f3f4f6') }}>
        <SettingsSearchBar value={query} onChangeText={setQuery} colors={colors} t={t} />
      </View>

      {visibleSections.map(s => (
        <Section key={s.key} title={s.title} colors={colors}>
          {s.rows.map((r, i) => (
            <Row
              key={s.key + '-' + i}
              icon={r.icon}
              label={r.label}
              iconTint={r.tint}
              onPress={r.onPress}
              colors={colors}
              right={r.badge ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                }}>
                  <View style={{
                    minWidth: 22, paddingHorizontal: 6, height: 20,
                    borderRadius: 10, backgroundColor: colors?.primary || colors?.text || '#111111',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ color: colors?.background || '#fff', fontSize: 11, fontWeight: '700' }}>{r.badge}</Text>
                  </View>
                  <IconChevronRight size={18} color={colors?.textTertiary || '#bbb'} />
                </View>
              ) : undefined}
            />
          ))}
          {s.tail ? s.tail(true) : null}
        </Section>
      ))}

      {visibleDanger.length > 0 && (
        <View style={{ marginTop: 14 }}>
          <Section title={t?.('settings.dangerZone') || 'Zona de perigo'} colors={colors}>
            {visibleDanger.map(r => (
              <Row
                key={r.key}
                icon={r.icon}
                label={r.label}
                iconTint={r.destructive ? undefined : ICON_GRAY}
                destructive={r.destructive}
                onPress={r.onPress}
                colors={colors}
              />
            ))}
          </Section>
        </View>
      )}

      {/* Empty-state when search returns nothing. */}
      {query && visibleSections.length === 0 && visibleDanger.length === 0 && (
        <View style={{ alignItems: 'center', paddingVertical: 48 }}>
          <Text style={{ fontSize: 14, color: colors?.textSecondary }}>
            {t?.('settings.noResults') || 'Nenhuma configuração encontrada'}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Screen: Security ────────────────────────────────────────────────
function SecurityScreen({ colors, t, router, onClose }) {
  // Most security controls live in the main settings screen (biometric,
  // sessions, password change). We surface the common ones inline and
  // route heavier flows to /settings with the right anchor.
  // [2026-05-27 Lester QA #8] Biometric lock state MUST come from the real
  // BiometricContext. The old local version wrote `biometric_enabled` to
  // AsyncStorage and only flipped a local boolean — but BiometricProvider
  // persists via SecureStore and gates the auto-lock on ITS OWN
  // `biometricEnabled`. So enabling the lock here was a no-op: wrong store,
  // and the provider never armed the lock → "allows access without Face ID".
  // Now we drive the provider directly (which also runs the Face ID confirm
  // before arming, and persists to the store the lock screen actually reads).
  const { biometricEnabled, biometricAvailable, toggleBiometric: ctxToggleBiometric } = useBiometric();

  // ToggleRow passes the desired value; the context toggle is value-less (it
  // flips current state + runs the biometric confirm), so only fire it when
  // the requested state differs from what the provider already has.
  const toggleBiometric = async (v) => {
    if (!!v === !!biometricEnabled) return;
    try { await ctxToggleBiometric(); } catch {}
  };

  const goDetailedSettings = (section) => {
    // [2026-05-28] Navigate BEFORE closing the sheet. On iOS, calling
    // onClose() first dismisses the modal, and a queued setTimeout push can
    // get cancelled by the modal-dismiss transition → the Security rows
    // appeared dead (#1366). Push synchronously, then close the sheet a tick
    // later so the destination is already on the stack.
    try { router?.push(`/settings?section=${section}`); } catch {}
    setTimeout(() => { try { onClose?.(); } catch {} }, 60);
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      {biometricAvailable && (
        <Section title={t?.('settings.deviceSecurity') || 'Dispositivo'} colors={colors}>
          <ToggleRow
            icon={IconLock}
            label={t?.('settings.biometricLock') || 'Bloqueio biométrico'}
            description={t?.('settings.biometricDesc') || 'Exigir Face ID/Touch ID ao abrir o app'}
            value={biometricEnabled}
            onChange={toggleBiometric}
            colors={colors}
          />
        </Section>
      )}
      <Section title={t?.('settings.accountSecurity') || 'Conta'} colors={colors}>
        <Row icon={IconLock} label={t?.('settings.changePassword') || 'Alterar senha'} onPress={() => goDetailedSettings('security')} colors={colors} />
        <Row icon={IconPhone} label={t?.('settings.twoFactor') || 'Verificação em duas etapas'} onPress={() => goDetailedSettings('security')} colors={colors} />
      </Section>
      <Footnote colors={colors}>
        {t?.('settings.securityNote') || 'Suas conversas e emails são protegidos por criptografia em trânsito. Habilite o bloqueio biométrico para uma camada extra de segurança quando alguém pegar seu celular.'}
      </Footnote>
    </ScrollView>
  );
}

// ─── Screen: Aparelhos conectados ────────────────────────────────────
// Renamed from "linked devices" → fetches active bearer-token sessions via
// sessions_list and shows device, last seen, location, IP. Tap → revoke
// individual session, or revoke-all at the bottom. Was previously routing
// to SecurityScreen which didn't list devices at all.
function DevicesScreen({ colors, t, onClose, onLogout }) {
  const [sessions, setSessions] = useState(null); // null = loading, [] = empty
  const [error, setError] = useState(null);
  const [revokingHash, setRevokingHash] = useState(null);

  const load = useCallback(async () => {
    try {
      const api = require('../services/api');
      const r = await api.getSessionsList();
      if (r?.success) {
        const items = Array.isArray(r.data)
          ? r.data
          : (Array.isArray(r.data?.sessions) ? r.data.sessions : (Array.isArray(r.sessions) ? r.sessions : []));
        setSessions(items);
        setError(null);
      } else {
        setError(r?.message || 'Falhou ao carregar sessões');
        setSessions([]);
      }
    } catch (e) {
      setError(e?.message || 'Erro de rede');
      setSessions([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // [fix 2026-10-01] Confirm before the destructive revoke — these instantly
  // log a device out with no undo; a mis-tap used to kill a session silently.
  const revokeOne = (hash) => {
    Alert.alert(
      t?.('settings.revokeDeviceTitle') || 'Desconectar aparelho?',
      t?.('settings.revokeDeviceMsg') || 'Esse aparelho precisará entrar de novo.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('settings.disconnect') || 'Desconectar', style: 'destructive', onPress: async () => {
          setRevokingHash(hash);
          try {
            const api = require('../services/api');
            await api.revokeSession(hash);
            setSessions(prev => (prev || []).filter(s => (s.token_hash || s.hash) !== hash));
          } catch {} finally { setRevokingHash(null); }
        } },
      ]
    );
  };

  const revokeAllOther = () => {
    Alert.alert(
      t?.('settings.revokeAllTitle') || 'Sair de todos os outros aparelhos?',
      t?.('settings.revokeAllMsg') || 'Todos os aparelhos, menos este, precisarão entrar de novo.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('settings.disconnectAll') || 'Sair de todos', style: 'destructive', onPress: async () => {
          try {
            const api = require('../services/api');
            await api.revokeAllSessions();
            setSessions(prev => (prev || []).filter(s => s.is_current));
          } catch {}
        } },
      ]
    );
  };

  const fmtAgo = (ts) => {
    if (!ts) return '';
    const sec = Math.max(1, Math.floor(Date.now() / 1000) - Number(ts));
    if (sec < 60) return `agora`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  };

  // Age-based pill color: surfaces freshness at a glance. Green (<1h)
  // reads as "just active", yellow (<24h) as "today-ish", gray (>24h)
  // as "stale, probably safe to revoke if you don't recognize it".
  const ageTint = (ts) => {
    if (!ts) return '#94a3b8';
    const sec = Math.max(1, Math.floor(Date.now() / 1000) - Number(ts));
    if (sec < 3600) return '#10b981';
    if (sec < 86400) return '#f59e0b';
    return '#94a3b8';
  };

  // Pick icon + tint baseado no device_label/user_agent. iPhone roxo,
  // Android verde, Desktop azul, fallback cinza.
  const deviceVisual = (s) => {
    const label = (s.device_label || s.user_agent || '').toLowerCase();
    if (label.includes('iphone') || label.includes('ipad') || label.includes('darwin') || label.includes('cfnetwork')) {
      return { Icon: IconSmartphone, tint: '#111111', bg: '#11111118' };
    }
    if (label.includes('android')) {
      return { Icon: IconSmartphone, tint: '#111111', bg: '#11111118' };
    }
    if (label.includes('mac') || label.includes('windows') || label.includes('linux') || label.includes('chrome') || label.includes('firefox') || label.includes('safari') || label.includes('edge')) {
      return { Icon: IconMonitor, tint: '#111111', bg: '#11111118' };
    }
    return { Icon: IconShield, tint: '#94a3b8', bg: '#94a3b818' };
  };

  const others = (sessions || []).filter(s => !s.is_current);
  const current = (sessions || []).find(s => s.is_current);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      {sessions === null ? (
        <View style={{ paddingVertical: 48, alignItems: 'center' }}>
          <ActivityIndicator color={colors?.primary} />
        </View>
      ) : sessions.length === 0 ? (
        <View style={{ paddingVertical: 48, alignItems: 'center', paddingHorizontal: 24 }}>
          <IconShield size={36} color={colors?.textTertiary} />
          <Text style={{ marginTop: 12, fontSize: 14, color: colors?.textSecondary, textAlign: 'center' }}>
            {error
              ? (t?.('settings.devicesError') || 'Não consegui carregar os aparelhos. Tente puxar pra atualizar.')
              : (t?.('settings.devicesEmpty') || 'Nenhum outro aparelho conectado.')}
          </Text>
        </View>
      ) : (
        <>
          {/* Hero: contagem total + brief */}
          <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: colors?.text }}>
              {sessions.length} {sessions.length === 1 ? 'aparelho' : 'aparelhos'}
            </Text>
            <Text style={{ fontSize: 13, color: colors?.textSecondary, marginTop: 4 }}>
              Sessões ativas com acesso à sua conta. Toque em um aparelho pra encerrar a sessão.
            </Text>
          </View>

          {/* Current device card — destacado */}
          {current && (() => {
            const v = deviceVisual(current);
            return (
              <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: 16, padding: 16, borderRadius: 16, backgroundColor: colors?.primary + '12', borderWidth: 1, borderColor: colors?.primary + '30' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: v.bg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <v.Icon size={24} color={v.tint} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors?.text }} numberOfLines={1}>
                        {current.device_label || current.user_agent || 'Aparelho'}
                      </Text>
                      <View style={{ marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: '#10b981' }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 0.4 }}>
                          {(t?.('settings.currentDevice') || 'ESTE APARELHO').toUpperCase()}
                        </Text>
                      </View>
                    </View>
                    {!!current.ip && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <IconMapPin size={11} color={colors?.textTertiary} />
                        <Text style={{ fontSize: 12, color: colors?.textTertiary, marginLeft: 4 }} numberOfLines={1}>
                          {current.ip}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
            );
          })()}

          {/* Outros aparelhos */}
          {others.length > 0 && (
            <>
              <View style={{ paddingHorizontal: 20, marginBottom: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textTertiary, letterSpacing: 0.6 }}>
                  {(t?.('settings.otherDevicesSection') || 'OUTROS APARELHOS').toUpperCase()}
                </Text>
              </View>
              <View style={{ marginHorizontal: 16, borderRadius: 14, backgroundColor: colors?.surface || (isDarkColors(colors) ? '#1c1c1e' : '#fff'), overflow: 'hidden' }}>
                {others.map((s, i) => {
                  const hash = s.token_hash || s.hash || `idx-${i}`;
                  const v = deviceVisual(s);
                  const last = fmtAgo(s.last_seen_at || s.last_seen || s.created_at);
                  return (
                    <TouchableOpacity
                      key={hash}
                      activeOpacity={0.6}
                      onPress={() => revokeOne(hash)}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: i === others.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors?.border || 'rgba(0,0,0,0.06)' }}
                    >
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: v.bg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                        <v.Icon size={20} color={v.tint} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: colors?.text }} numberOfLines={1}>
                          {s.device_label || s.user_agent || 'Aparelho'}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
                          {!!s.ip && (
                            <>
                              <IconMapPin size={10} color={colors?.textTertiary} />
                              <Text style={{ fontSize: 11, color: colors?.textTertiary, marginLeft: 3, marginRight: 8 }} numberOfLines={1}>{s.ip}</Text>
                            </>
                          )}
                          {!!last && (
                            <>
                              <IconClock size={10} color={colors?.textTertiary} />
                              <Text style={{ fontSize: 11, color: colors?.textTertiary, marginLeft: 3 }}>{last}</Text>
                            </>
                          )}
                        </View>
                      </View>
                      {revokingHash === hash
                        ? <ActivityIndicator size="small" color={colors?.textTertiary} />
                        : <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#ef444418' }}>
                            <Text style={{ fontSize: 12, color: '#ef4444', fontWeight: '600' }}>
                              {t?.('common.remove') || 'Sair'}
                            </Text>
                          </View>
                      }
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TouchableOpacity onPress={revokeAllOther} style={{ marginTop: 16, marginHorizontal: 16, paddingVertical: 14, borderRadius: 12, backgroundColor: '#ef444412', alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: '#ef4444', fontWeight: '600' }}>
                  {t?.('settings.signOutAllOther') || 'Sair de todos os outros aparelhos'}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {/* Footer info */}
          <View style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <IconShield size={14} color={colors?.textTertiary} style={{ marginTop: 2 }} />
              <Text style={{ flex: 1, fontSize: 11, color: colors?.textTertiary, marginLeft: 8, lineHeight: 16 }}>
                Não reconhece um aparelho? Encerre a sessão e troque sua senha. O endereço IP é onde a conexão se conectou da última vez.
              </Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

// Util — verifica se colors está no modo escuro pelo background
function isDarkColors(colors) {
  if (!colors) return false;
  const bg = (colors.background || colors.bg || '').toString();
  return bg.startsWith('#0') || bg.startsWith('#1') || bg.startsWith('#2');
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
    phone_visibility: 'contacts',
    // Telegram Cloud parity: default TRUE (server-stored + multi-device).
    // When toggled OFF, new conversations the user creates inherit
    // cloud_storage=false → chat_send relays via WS only, peers store
    // locally in SQLite. Tradeoff surfaced in description.
    cloud_chats_default: true,
  });
  const [loading, setLoading] = useState(true);
  // Default ON: strip EXIF (location/camera/date) on photo send. The flag
  // lives only in AsyncStorage — sender-local privacy decision, no server
  // round-trip needed. Read by chat-conversation.js before upload.
  const [stripExif, setStripExif] = useState(true);
  // Sealed-sender (Signal-mode metadata hiding). Local AsyncStorage flag —
  // chat-conversation.js reads it via opts.sealed when calling chatSend.
  // OFF by default because sealed mode weakens spam control.
  const [sealedSender, setSealedSender] = useState(false);
  // Global default disappearing-messages timer (seconds). Server-side state
  // surfaced through chat_privacy_get's `default_disappearing_seconds`. 0 = off.
  const [defaultDisappearing, setDefaultDisappearing] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.apiCall?.('chat_privacy_get', {}, 'POST');
        if (r?.success && r.data) {
          setSettings(prev => ({ ...prev, ...r.data }));
          // chat_privacy_get now also surfaces the user's global default
          // disappearing-messages timer in seconds (0 = off).
          if (typeof r.data.default_disappearing_seconds === 'number') {
            setDefaultDisappearing(r.data.default_disappearing_seconds | 0);
          }
        }
      } catch {}
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        // [FIX cross-account leak 2026-10-05] Read per-account (with one-time
        // migration from the legacy global key).
        const v = await _readAcctFlag(AsyncStorage, 'chatyy_strip_exif');
        // Default ON when key is absent — only flip OFF on explicit 'false'.
        const stripVal = v === 'false' ? false : true;
        if (v === 'false') setStripExif(false);
        // Sealed-sender flag persists locally — chat-conversation.js /
        // imageSendPipeline.js read the GLOBAL key when dispatching sends, so
        // we keep the global key in sync with the active account below.
        const ss = await _readAcctFlag(AsyncStorage, 'chatyy_sealed_sender');
        const sealedVal = ss === 'true';
        if (ss === 'true') setSealedSender(true);
        // Re-assert the ACTIVE account's resolved values onto the legacy
        // global keys the chat-send readers still use. Without this, after an
        // account switch those readers would keep using the previous account's
        // choice (the cross-account leak) until the user next toggled. Safe
        // direction only (defaults are the privacy-preserving values).
        try {
          await AsyncStorage.setItem(_acctKey('chatyy_strip_exif'), stripVal ? 'true' : 'false');
          await AsyncStorage.setItem('chatyy_strip_exif', stripVal ? 'true' : 'false');
          await AsyncStorage.setItem(_acctKey('chatyy_sealed_sender'), sealedVal ? 'true' : 'false');
          await AsyncStorage.setItem('chatyy_sealed_sender', sealedVal ? 'true' : 'false');
        } catch {}
        // Phone_visibility is now authoritative on the server (chat.php
        // chat_user_privacy.phone_visibility). We only fall back to the
        // local cache if chat_privacy_get didn't return it (cold start with
        // no network) — this avoids the previous bug where stale local
        // state silently overrode the server's current value.
        if (!settings.phone_visibility) {
          const pv = await _readAcctFlag(AsyncStorage, 'privacy_phone_visibility');
          if (pv) setSettings(prev => (prev.phone_visibility ? prev : { ...prev, phone_visibility: pv }));
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const update = async (patch) => {
    setSettings(prev => ({ ...prev, ...patch }));
    if (patch.phone_visibility) {
      // Mirror to local cache for offline hydration. Backend
      // chat_user_privacy.phone_visibility is authoritative — the cache is
      // only read when chat_privacy_get hasn't returned yet on cold start.
      // Per-account key only (no external reader of this cache).
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem(_acctKey('privacy_phone_visibility'), patch.phone_visibility);
      } catch {}
    }
    try { await api.apiCall?.('chat_privacy_set', patch, 'POST'); } catch {}
  };

  const updateStripExif = async (v) => {
    setStripExif(v);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      // Dual-write: per-account key (isolates the UI state) + legacy global
      // key (so chat-conversation.js / imageSendPipeline.js keep reading the
      // active account's choice without touching those files).
      await AsyncStorage.setItem(_acctKey('chatyy_strip_exif'), v ? 'true' : 'false');
      await AsyncStorage.setItem('chatyy_strip_exif', v ? 'true' : 'false');
    } catch {}
  };

  const updateSealedSender = async (v) => {
    setSealedSender(v);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem(_acctKey('chatyy_sealed_sender'), v ? 'true' : 'false');
      await AsyncStorage.setItem('chatyy_sealed_sender', v ? 'true' : 'false');
    } catch {}
  };

  // Cycle through the allowed disappearing-timer values: Off → 24h → 7d → 90d.
  // Mirrors the chat_set_default_disappearing whitelist on the server (we
  // include only the most useful subset so the picker stays simple — server
  // also accepts 1h / 30d but a 4-state picker covers the practical range).
  const DISAPPEARING_OPTS = [0, 86400, 604800, 7776000];
  const updateDefaultDisappearing = async (next) => {
    const allowed = DISAPPEARING_OPTS.includes(next) ? next : 0;
    setDefaultDisappearing(allowed);
    try {
      await api.apiCall?.('chat_set_default_disappearing', { seconds: allowed }, 'POST');
    } catch {}
  };
  const cycleDefaultDisappearing = () => {
    const idx = DISAPPEARING_OPTS.indexOf(defaultDisappearing);
    const nxt = DISAPPEARING_OPTS[(idx + 1) % DISAPPEARING_OPTS.length];
    updateDefaultDisappearing(nxt);
  };
  const labelDisappearing = (s) => {
    if (s >= 7776000) return t?.('privacy.disappearing90d') || '90 dias';
    if (s >= 604800)  return t?.('privacy.disappearing7d')  || '7 dias';
    if (s >= 86400)   return t?.('privacy.disappearing24h') || '24 horas';
    return t?.('privacy.disappearingOff') || 'Desligado';
  };

  // Triple-state row: tap cycles everyone → contacts → nobody → everyone.
  // Backend `chat_privacy_set` aceita qualquer subset desses 3 valores.
  const PrivacyRow = ({ Icon, label, field, options }) => {
    const OPTS = options || ['everyone', 'contacts', 'nobody'];
    const labels = {
      everyone: t?.('profile.privacyEveryone') || 'Qualquer um',
      all:      t?.('profile.privacyEveryone') || 'Qualquer um',
      contacts: t?.('profile.privacyContactsOnly') || 'Só meus contatos',
      nobody:   t?.('profile.privacyNobody') || 'Ninguém',
      // [online/invisible 2026-06-10] last-seen/online 'nobody' surfaces as
      // "invisible mode" so users understand they also appear offline.
      invisible: t?.('settings.privacyInvisible') || 'Modo invisível',
      close_friends: t?.('settings.privacyCloseFriends') || 'Amigos próximos',
      except:        t?.('settings.privacyStatusExcept') || 'Ocultar status de…',
    };
    const cur = settings[field] || OPTS[0];
    return (
      <Row
        icon={Icon}
        label={label}
        value={(field === 'online' && cur === 'nobody') ? labels.invisible : (labels[cur] || cur)}
        onPress={() => update({ [field]: OPTS[(OPTS.indexOf(cur) + 1) % OPTS.length] })}
        colors={colors}
      />
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
        {/* Online / invisible mode — backend column `online`. 'nobody' here
            = invisible (appear offline). Distinct from last_seen above. */}
        <PrivacyRow
          Icon={IconEyeOff}
          label={t?.('settings.privacyOnline') || 'Online'}
          field="online"
          options={['everyone', 'contacts', 'nobody']}
        />
        <PrivacyRow
          Icon={IconPhone}
          label={t?.('privacy.phoneNumber') || 'Quem pode ver meu número de telefone'}
          field="phone_visibility"
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
        {/* Status visibility — now includes "Amigos próximos" (close_friends);
            curate the list from Settings → Privacidade → Amigos próximos. */}
        <PrivacyRow
          Icon={IconStar}
          label={t?.('privacy.status') || 'Quem vê meu status'}
          field="story_privacy"
          options={['all', 'contacts', 'close_friends', 'nobody']}
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
        {/* [keep_archived 2026-06-10] WhatsApp default: archived chats stay
            archived even when a new message arrives. Default TRUE; flip OFF
            to un-archive on new messages. */}
        <ToggleRow
          icon={IconArchive}
          label={t?.('settings.privacyKeepArchived') || 'Manter conversas arquivadas'}
          description={t?.('settings.privacyKeepArchivedDesc') || 'Conversas arquivadas continuam arquivadas mesmo com mensagens novas.'}
          value={settings.keep_archived !== false}
          onChange={(v) => update({ keep_archived: !!v })}
          colors={colors}
        />
        {/* Strip EXIF (GPS/camera/date) from photos before send. Default ON
            — protects users who forget cameras geotag every shot. Read by
            chat-conversation.js#kickoff before compress/upload. */}
        <ToggleRow
          icon={IconMapPin}
          label={t?.('privacy.stripExif') || 'Remover dados de localização das fotos'}
          description={t?.('privacy.stripExifDesc') || 'Protege sua privacidade ao compartilhar fotos'}
          value={stripExif}
          onChange={updateStripExif}
          colors={colors}
        />
        {/* Telegram Cloud parity: when ON, conversations created from this
            account persist server-side and sync between devices. When OFF,
            chat_send only relays via WebSocket — peers store locally in
            SQLite and messages disappear if both are offline. Tradeoff
            spelled out inline (avoids new i18n keys / tooltip surface). */}
        <ToggleRow
          icon={IconStar}
          label={t?.('privacy.cloudChats') || 'Salvar conversas na nuvem (sincronizar entre dispositivos)'}
          description={t?.('privacy.cloudChatsDesc') || 'Quando desligado, mensagens só ficam nos aparelhos dos dois e somem se ambos estiverem offline.'}
          value={settings.cloud_chats_default !== false}
          onChange={(v) => update({ cloud_chats_default: !!v })}
          colors={colors}
        />
        {/* Sealed sender (Signal-mode metadata hiding). When on, every chat
            message goes out with `sealed=true` so the server stores no
            who-sent-what record for peers. The sender's own clients still
            render their messages normally (they own the local SQLite).
            Trade-off displayed inline so the user understands the cost. */}
        <ToggleRow
          icon={IconLock}
          label={t?.('privacy.sealedSender') || 'Modo sealed sender'}
          description={t?.('privacy.sealedSenderDesc') || 'Oculta quem enviou no servidor (Signal-mode, spam control mais fraco)'}
          value={sealedSender}
          onChange={updateSealedSender}
          colors={colors}
        />
        {/* Default disappearing-messages timer (global). Tap-to-cycle row
            mirrors the PrivacyRow shape so the visual stays consistent
            with the rest of the list. Backend stores in chat_user_defaults
            and applies it to every chat_create going forward. */}
        <Row
          icon={IconClock}
          label={t?.('privacy.disappearingTitle') || 'Apagar mensagens automaticamente'}
          value={labelDisappearing(defaultDisappearing)}
          onPress={cycleDefaultDisappearing}
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
      <Footnote colors={colors}>
        {t?.('privacy.note') || 'Pra bloquear um usuário específico, abra o perfil dele e toque nos três pontos.'}
      </Footnote>
    </ScrollView>
  );
}

// ─── Screen: Notifications ───────────────────────────────────────────
function NotificationsScreen({ colors, t, router, onClose }) {
  const [prefs, setPrefs] = useState({
    push_enabled: true,
    sound: true,
    vibration: true,
    group_by_conversation: true,
  });
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
        }
        // Per-device push master switch. Read per-account (FIX cross-account
        // leak) so intent survives restart AND doesn't bleed between accounts.
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const v = await _readAcctFlag(AsyncStorage, 'push_enabled');
        const enabled = v !== 'false';
        setPrefs(p => ({ ...p, push_enabled: enabled }));
        // Sync the notification handler's in-memory master flag so the local
        // foreground gate reflects the stored intent as soon as the user
        // opens this screen (belt-and-suspenders beside the server-side
        // token unregister).
        try {
          const push = await import('../services/pushNotifications');
          push.setPushMasterEnabled?.(enabled);
        } catch {}
      } catch {}
      setLoading(false);
    })();
  }, []);

  const update = async (patch) => {
    setPrefs(prev => ({ ...prev, ...patch }));
    try {
      if ('push_enabled' in patch) {
        const enabled = !!patch.push_enabled;
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem(_acctKey('push_enabled'), enabled ? 'true' : 'false');
        // [FIX push no-op 2026-10-05] The master switch used to only write a
        // dead flag. Now drive the REAL push pipeline:
        //  - gate the local foreground notification handler immediately;
        //  - OFF → unregister this device's token so the backend STOPS
        //    delivering; ON → re-register so it resumes.
        try {
          const push = await import('../services/pushNotifications');
          push.setPushMasterEnabled?.(enabled);
          if (enabled) {
            // ignoreMaster: this IS the explicit user re-enable; don't let the
            // freshly-written pref read race against us.
            push.ensurePushTokenFresh?.({ force: true, ignoreMaster: true })?.catch?.(() => {});
          } else {
            push.removeTokenFromBackend?.()?.catch?.(() => {});
          }
        } catch {}
        // Persist the preference server-side via the settings endpoint already
        // used here so the backend can also skip delivery for this user.
        try { if (api.updateSettings) await api.updateSettings({ push_enabled: enabled }); } catch {}
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

  // [FIX 2026-10-05] Rich notification controls (Do Not Disturb schedule,
  // mention-only, keywords, preview privacy, lock-screen visibility, respect
  // system DND) live in /notification-preferences. Deep-link there instead of
  // the panel's old DND writer, which wrote `dnd_window` that nothing read and
  // duplicated the real dnd_enabled/dnd_start_time screen. Navigate BEFORE
  // closing the sheet (iOS cancels a post-dismiss push) — mirrors
  // SecurityScreen.goDetailedSettings.
  const goNotifPrefs = () => {
    try { router?.push('/notification-preferences'); } catch {}
    setTimeout(() => { try { onClose?.(); } catch {} }, 60);
  };

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
      <Section title={t?.('settings.notifications') || 'Notificações'} colors={colors}>
        <Row
          icon={IconClock}
          label={t?.('notif.moreOptions') || 'Mais opções de notificação'}
          value={t?.('notif.moreOptionsDesc') || 'Menções, palavras-chave, preview e tela de bloqueio'}
          onPress={goNotifPrefs}
          colors={colors}
        />
      </Section>
    </ScrollView>
  );
}

// [fix 2026-10-01] SVG flag glyphs — replaces emoji flags (🇧🇷🇺🇸🇪🇸) which
// violate the SVG-only UI rule and render inconsistently across platforms.
function FlagGlyph({ flag }) {
  const cid = 'flagclip-' + flag;
  return (
    <Svg width={24} height={18} viewBox="0 0 24 18" style={{ marginRight: 14 }}>
      <SvgDefs><SvgClipPath id={cid}><SvgRect x="0" y="0" width="24" height="18" rx="3" /></SvgClipPath></SvgDefs>
      <SvgG clipPath={`url(#${cid})`}>
        {flag === 'BR' ? (
          <>
            <SvgRect x="0" y="0" width="24" height="18" fill="#009739" />
            <SvgPolygon points="12,2.5 21.5,9 12,15.5 2.5,9" fill="#FEDD00" />
            <SvgCircle cx="12" cy="9" r="3.3" fill="#012169" />
          </>
        ) : flag === 'US' ? (
          <>
            <SvgRect x="0" y="0" width="24" height="18" fill="#fff" />
            {[0,1,2,3,4,5,6].map(i => (
              <SvgRect key={i} x="0" y={i * (18 / 6.5)} width="24" height={18 / 13} fill="#B22234" />
            ))}
            <SvgRect x="0" y="0" width="10" height={18 * 7 / 13} fill="#3C3B6E" />
          </>
        ) : (
          <>
            <SvgRect x="0" y="0" width="24" height="18" fill="#AA151B" />
            <SvgRect x="0" y="4.5" width="24" height="9" fill="#F1BF00" />
          </>
        )}
      </SvgG>
    </Svg>
  );
}

// ─── Screen: Language ────────────────────────────────────────────────
function LanguageScreen({ colors, t }) {
  const LANGS = [
    { code: 'pt-BR', label: 'Português (Brasil)', flag: 'BR' },
    { code: 'en', label: 'English', flag: 'US' },
    { code: 'es', label: 'Español', flag: 'ES' },
  ];
  // [fix 2026-10-01] The picker used to write AsyncStorage key 'language' and
  // tell the user to restart — but LanguageContext reads 'app_language_manual'
  // via changeLanguage(), so NOTHING ever changed. Drive the real context: it
  // live-updates every screen AND cross-device-syncs, no restart needed.
  const { language, changeLanguage } = useLanguage();
  const current = language || 'pt-BR';
  const pick = (code) => { try { changeLanguage(code); } catch {} };

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
            <FlagGlyph flag={l.flag} />
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
function AboutScreen({ colors, t, closeAndRun }) {
  // Pull version from app.json via expo-constants so we never drift from
  // the canonical version source. Fallback to the last-known string only
  // if Constants is unavailable (e.g. during a partial test environment).
  let appVersion = '2.4.5';
  try {
    appVersion = require('expo-constants').default?.expoConfig?.version || appVersion;
  } catch {}
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
        <Row label={t?.('plans.termsOfUse') || 'Termos de Uso (EULA)'} onPress={() => { const go = () => require('expo-router').router.push({ pathname: '/legal', params: { doc: 'terms' } }); closeAndRun ? closeAndRun(go) : go(); }} colors={colors} />
        <Row label={t?.('plans.privacyPolicy') || 'Política de Privacidade'} onPress={() => { const go = () => require('expo-router').router.push({ pathname: '/legal', params: { doc: 'privacy' } }); closeAndRun ? closeAndRun(go) : go(); }} colors={colors} />
        <Row label={t?.('settings.support') || 'Suporte'} onPress={() => require('../utils/inAppBrowser').openInApp('https://chatyy.com.br/suporte/')} colors={colors} />
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
function SupportScreen({ colors, t, router, onClose }) {
  // Compose direto na tela do app — `mailto:` no iOS dispara o scheme próprio
  // (onemundomail://) que cai em "Unmatched Route" do expo-router.
  const openSupportCompose = () => {
    onClose?.();
    setTimeout(() => {
      router?.push('/compose?to=suporte%40chatyy.com.br&subject=Chatyy%20-%20Ajuda');
    }, 150);
  };
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('support.contact') || 'Contato'} colors={colors}>
        <Row icon={IconMessageSquare} label={t?.('support.email') || 'Enviar email para suporte'}
          onPress={openSupportCompose}
          colors={colors}
          value="suporte@chatyy.com.br"
        />
        <Row icon={IconGlobe} label={t?.('support.website') || 'Central de ajuda'}
          onPress={() => require('../utils/inAppBrowser').openInApp('https://chatyy.com.br/suporte/')}
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

  // What goes into the export — surfaced as a checklist so the user sees
  // exactly what they'll get instead of trusting the abstract "JSON file".
  const items = [
    { icon: IconUser,      label: t?.('settings.exportItemProfile')  || 'Perfil e configurações' },
    { icon: IconMessageSquare, label: t?.('settings.exportItemChats')    || 'Lista de conversas' },
    { icon: IconMail,      label: t?.('settings.exportItemEmail')    || 'Pastas e mensagens de email' },
    { icon: IconImage,     label: t?.('settings.exportItemPosts')    || 'Posts do feed e mídias' },
    { icon: IconBell,      label: t?.('settings.exportItemNotifs')   || 'Histórico de notificações' },
  ];

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Hero — big icon + title + sub */}
      <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 18, paddingHorizontal: 24 }}>
        <View style={{
          width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
          backgroundColor: ACCENT + '18', marginBottom: 14,
        }}>
          <IconDatabase size={32} color={ACCENT} />
        </View>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors?.text, marginBottom: 6, textAlign: 'center' }}>
          {t?.('settings.exportHeroTitle') || 'Sua cópia, do seu jeito'}
        </Text>
        <Text style={{ fontSize: 13, color: colors?.textSecondary, textAlign: 'center', lineHeight: 19, maxWidth: 320 }}>
          {t?.('settings.exportHeroSub') || 'Empacotamos tudo num arquivo JSON. Você baixa, guarda offline, importa onde quiser.'}
        </Text>
      </View>

      {/* What's included — tile list */}
      <View style={{ paddingHorizontal: 16, marginBottom: 14 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors?.textTertiary, marginLeft: 6, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t?.('settings.exportIncludes') || 'O que entra'}
        </Text>
        <View style={{ backgroundColor: colors?.surface, borderRadius: 14, overflow: 'hidden' }}>
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <View key={i} style={{
                flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13,
                borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors?.border,
              }}>
                <View style={{ width: 28, alignItems: 'center', marginRight: 12 }}>
                  <Icon size={18} color={ACCENT} />
                </View>
                <Text style={{ fontSize: 14, color: colors?.text, flex: 1 }}>{it.label}</Text>
                <IconCheckCircle size={16} color="#16a34a" />
              </View>
            );
          })}
        </View>
      </View>

      {/* Limits note */}
      <View style={{ marginHorizontal: 16, marginBottom: 18, padding: 12, backgroundColor: colors?.surfaceVariant || (colors?.background === '#000' ? 'rgba(255,255,255,0.04)' : '#F4F4F6'), borderRadius: 10 }}>
        <Text style={{ fontSize: 12, color: colors?.textSecondary, lineHeight: 17 }}>
          {t?.('settings.exportLimitNote') || 'Link válido por 24h. Limite de 1 exportação a cada 24 horas.'}
        </Text>
      </View>

      {/* Result card — only when ready */}
      {result?.url ? (
        <View style={{ marginHorizontal: 16, marginBottom: 14, padding: 14, borderRadius: 12, backgroundColor: '#10B98114', borderWidth: 1, borderColor: '#10B98140' }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#059669', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t?.('settings.exportReady') || 'Pronto pra baixar'}
          </Text>
          <TouchableOpacity onPress={() => openUrl(result.url)} activeOpacity={0.7}>
            <Text style={{ fontSize: 13, color: ACCENT, fontWeight: '600' }} numberOfLines={2}>{result.url}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!!error && (
        <View style={{ marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 10, backgroundColor: '#fef2f2' }}>
          <Text style={{ color: '#dc2626', fontSize: 13 }}>{error}</Text>
        </View>
      )}

      {/* CTA */}
      <View style={{ paddingHorizontal: 16 }}>
        <TouchableOpacity
          disabled={working}
          onPress={requestExport}
          style={{
            backgroundColor: ACCENT, paddingVertical: 15, borderRadius: 14, alignItems: 'center',
            opacity: working ? 0.6 : 1,
            ...Platform.select({
              ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 10 },
              android: { elevation: 3 },
              web: { boxShadow: `0 6px 20px ${ACCENT}40` },
            }),
          }}
          accessibilityRole="button"
        >
          {working
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 }}>
                {result?.url
                  ? (t?.('settings.exportRedo') || 'Gerar nova cópia')
                  : (t?.('settings.exportData') || 'Baixar meus dados')}
              </Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Screen: Aparência (tema / cor / idioma / moeda) ─────────────────
function AppearanceScreen({ colors, isDark, t, push }) {
  const { themeMode, setThemeMode } = useTheme();
  const { language } = useLanguage();
  const { currency, setCurrency, resetCurrency, autoDetected, supported, symbols } = useCurrency();
  const langLabel = { 'pt-BR': 'Português (Brasil)', en: 'English', es: 'Español' }[language] || language || 'Português (Brasil)';
  const mode = themeMode || 'system';
  const glyph = (sym) => ({ color }) => (
    <Text style={{ fontSize: 13, fontWeight: '700', color }}>{sym}</Text>
  );
  const check = <IconCheck size={18} color={colors?.text || '#111'} />;
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('settings.theme.label') || 'Tema'} colors={colors}>
        <View style={{ padding: 16 }}>
          <SettingsSegmented
            colors={colors}
            isDark={isDark}
            value={mode}
            onChange={(v) => { try { setThemeMode?.(v); } catch {} }}
            options={[
              { value: 'light', label: t?.('settings.theme.light') || 'Claro' },
              { value: 'dark', label: t?.('settings.theme.dark') || 'Escuro' },
              { value: 'system', label: t?.('settings.theme.system') || 'Sistema' },
            ]}
          />
        </View>
      </Section>
      <Section title={t?.('settings.accentColor') || 'Cor do destaque'} colors={colors}>
        <AccentColorRow colors={colors} t={t} />
      </Section>
      <Section title={t?.('settings.language') || 'Idioma'} colors={colors}>
        <Row icon={IconGlobe} label={t?.('settings.language') || 'Idioma'} value={langLabel} onPress={() => push('language')} colors={colors} />
      </Section>
      <Section title={t?.('settings.currencyLabel') || 'Moeda'} colors={colors}>
        <Row
          icon={IconStar}
          label={t?.('settings.currencyAuto') || 'Auto'}
          value={t?.('settings.currencyAutoDesc') || 'Segue a região do aparelho'}
          onPress={() => { try { resetCurrency?.(); } catch {} }}
          right={autoDetected ? check : null}
          colors={colors}
        />
        {(supported || []).map((c) => (
          <Row
            key={c}
            icon={glyph(symbols?.[c] || c)}
            label={t?.('settings.currency.' + c) || c}
            value={c}
            onPress={() => { try { setCurrency?.(c); } catch {} }}
            right={(!autoDetected && currency === c) ? check : null}
            colors={colors}
          />
        ))}
      </Section>
      <Footnote colors={colors}>
        {t?.('settings.currencyDesc') || 'Usada para exibir valores no app.'}
      </Footnote>
    </ScrollView>
  );
}

// ─── Screen: Armazenamento e dados ───────────────────────────────────
// Download automático = segmented Nunca / Wi-Fi / Sempre por tipo de mídia.
// Mapeia pra matriz do servidor (chat_set_auto_download_policy, célula a célula):
//   Nunca  = mobile 0 + wifi 0 · Wi-Fi = mobile 0 + wifi 1 · Sempre = mobile 1 + wifi 1
// (roaming nunca é tocado — segue o valor salvo).
const AUTO_DL_DEFAULT = {
  photos:    { mobile: 1, wifi: 1, roaming: 0 },
  audio:     { mobile: 1, wifi: 1, roaming: 0 },
  videos:    { mobile: 0, wifi: 1, roaming: 0 },
  documents: { mobile: 0, wifi: 1, roaming: 0 },
};
function autoDlMode(row) {
  if (row?.mobile) return 'always';
  if (row?.wifi) return 'wifi';
  return 'never';
}
function fmtBytesSheet(b) {
  const v = Number(b) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2).replace('.', ',') + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB';
  if (v >= 1024 ** 2) return Math.round(v / 1024 ** 2) + ' MB';
  return Math.round(v / 1024) + ' KB';
}

function StorageDataScreen({ colors, isDark, t, push }) {
  const [policy, setPolicy] = useState(AUTO_DL_DEFAULT);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.chatGetUserDefaults();
        const p = r?.data?.auto_download_policy;
        if (alive && r?.success && p && typeof p === 'object') setPolicy(prev => ({ ...prev, ...p }));
      } catch {}
      try {
        const r = await api.storageUsage();
        if (alive && r?.success && r.data) setUsage(r.data);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  const setMode = (bucket, mode) => {
    const mobile = mode === 'always' ? 1 : 0;
    const wifi = mode === 'never' ? 0 : 1;
    setPolicy(prev => {
      const cur = prev[bucket] || { mobile: 0, wifi: 0, roaming: 0 };
      const next = { ...prev, [bucket]: { ...cur, mobile, wifi } };
      try {
        const mc = require('../services/mediaCache');
        if (mc && typeof mc.setAutoDownloadPolicy === 'function') mc.setAutoDownloadPolicy(next);
      } catch {}
      return next;
    });
    // Fire-and-forget, célula a célula (API existente).
    api.chatSetAutoDownloadPolicy({ bucket, column: 'mobile', value: mobile }).catch(() => {});
    api.chatSetAutoDownloadPolicy({ bucket, column: 'wifi', value: wifi }).catch(() => {});
  };

  const buckets = [
    { key: 'photos',    label: t?.('settings.autoDownload.photos') || 'Fotos',          Icon: IconImage },
    { key: 'audio',     label: t?.('settings.autoDownload.audio') || 'Áudios',          Icon: IconMusic },
    { key: 'videos',    label: t?.('settings.autoDownload.videos') || 'Vídeos',         Icon: IconFilm },
    { key: 'documents', label: t?.('settings.autoDownload.documents') || 'Documentos', Icon: IconFileText },
  ];
  const modeOptions = [
    { value: 'never',  label: t?.('settings.autoDownload.never') || 'Nunca' },
    { value: 'wifi',   label: t?.('settings.autoDownload.wifiOnly') || 'Wi-Fi' },
    { value: 'always', label: t?.('settings.autoDownload.always') || 'Sempre' },
  ];

  const used = Number(usage?.used_bytes);
  const limit = Number(usage?.limit_bytes) || 0;
  const hasUsage = Number.isFinite(used) && limit > 0;
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;

  const clearCache = () => {
    const doIt = async () => {
      try {
        const keys = ['chatyy_notif_prefs', 'chatyy_sticker_recents', 'chat_draft_', 'link_preview_'];
        if (Platform.OS === 'web') {
          const rm = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (keys.some(p => k?.startsWith(p))) rm.push(k);
          }
          rm.forEach(k => localStorage.removeItem(k));
        } else {
          const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
          const all = await AsyncStorage.getAllKeys();
          const rm = all.filter(k => keys.some(p => k.startsWith(p)));
          if (rm.length) await AsyncStorage.multiRemove(rm);
        }
        try { const ac = require('../services/audioCache'); await ac.clearAudioCache?.(); } catch {}
        Alert.alert('Chatyy', t?.('config.cacheCleared') || 'Cache limpo!');
      } catch {}
    };
    if (Platform.OS === 'web') { doIt(); return; }
    Alert.alert(
      t?.('config.clearCache') || 'Limpar cache',
      t?.('storageData.clearCacheConfirm') || 'Remove arquivos temporários deste aparelho. Suas conversas não são apagadas.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('common.clear') || 'Limpar', style: 'destructive', onPress: doIt },
      ],
    );
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <Section title={t?.('settings.autoDownload.title') || 'Download automático'} colors={colors}>
        {buckets.map(b => (
          <View key={b.key} style={{ paddingHorizontal: 16, paddingVertical: 13, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 34, height: 34, borderRadius: 9, backgroundColor: colors?.surfaceVariant || '#f1f5f9', alignItems: 'center', justifyContent: 'center' }}>
                <b.Icon size={18} color={colors?.text || '#111'} />
              </View>
              <Text style={{ flex: 1, fontSize: 15.5, fontWeight: '500', letterSpacing: -0.1, color: colors?.text }}>{b.label}</Text>
            </View>
            <SettingsSegmented
              colors={colors}
              isDark={isDark}
              compact
              value={autoDlMode(policy[b.key])}
              onChange={(m) => setMode(b.key, m)}
              options={modeOptions}
            />
          </View>
        ))}
      </Section>
      <Footnote colors={colors}>
        {t?.('settings.autoDownload.subtitle') || 'Escolha quando o app baixa mídias automaticamente'}
      </Footnote>

      <Section title={t?.('storageData.cloud') || 'Nuvem'} colors={colors}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 15.5, fontWeight: '600', color: colors?.text }}>
              {hasUsage ? fmtBytesSheet(used) : '—'}
              <Text style={{ fontWeight: '400', color: colors?.textSecondary }}>
                {hasUsage ? ` ${t?.('chatyyOne.of') || 'de'} ${fmtBytesSheet(limit)}` : ''}
              </Text>
            </Text>
            {hasUsage ? <Text style={{ fontSize: 12.5, color: colors?.textSecondary }}>{Math.round(pct)}%</Text> : null}
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: colors?.surfaceVariant || '#eee', overflow: 'hidden' }}>
            <View style={{ width: pct + '%', height: '100%', borderRadius: 4, backgroundColor: pct >= 95 ? '#ef4444' : pct >= 80 ? '#f59e0b' : (colors?.tint || '#0a84ff') }} />
          </View>
        </View>
        <Row icon={IconCloud} label="Chatyy One" value={t?.('chatyyOne.rowDesc') || 'Plano, pagamento e upgrade'} onPress={() => push('one')} colors={colors} />
      </Section>

      <Section title={t?.('storageData.device') || 'Neste aparelho'} colors={colors}>
        <Row icon={IconArchive} label={t?.('config.clearCache') || 'Limpar cache'} onPress={clearCache} colors={colors} />
      </Section>
    </ScrollView>
  );
}

// ─── Screen: Chatyy One (plano + pagamento + upgrade) ────────────────
// Dados: api.planInfo() (plan_info) + api.storageUsage() (chat_storage_usage).
// Pagamento: openStripePortal() (stripe_portal → WebBrowser) — SÓ fora do iOS
// (isStripeCardAvailable). No iOS: "Gerencie pelo site chatyy.com.br".
// Upgrade: StorageShopSheet existente (nada de pagamento reimplementado aqui).
function ChatyyOneScreen({ colors, isDark, t }) {
  const [plan, setPlan] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState(false);
  const [busy, setBusy] = useState(false);
  const { language } = useLanguage();

  const load = useCallback(async () => {
    try {
      const [p, u] = await Promise.all([
        api.planInfo().catch(() => null),
        api.storageUsage().catch(() => null),
      ]);
      if (p?.success && p.data) setPlan(p.data);
      if (u?.success && u.data) setUsage(u.data);
    } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const tier = String(usage?.tier || 'free');
  const planKey = String(plan?.plan || 'free');
  const isPaid = tier !== 'free' || planKey !== 'free';
  const used = Number(usage?.used_bytes ?? plan?.storage_used);
  const limit = Number(usage?.limit_bytes ?? plan?.storage_limit) || 20 * 1024 ** 3;
  const hasUsage = Number.isFinite(used);
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const barColor = pct >= 95 ? '#ef4444' : pct >= 80 ? '#f59e0b' : (colors?.tint || '#0a84ff');
  const isIOS = Platform.OS === 'ios';
  const stripeOk = isStripeCardAvailable();

  const fmtDate = (iso) => {
    if (!iso) return null;
    const d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    try { return d.toLocaleDateString(language === 'pt-BR' ? 'pt-BR' : language, { day: '2-digit', month: 'long', year: 'numeric' }); } catch { return d.toISOString().slice(0, 10); }
  };
  const renews = fmtDate(plan?.expires_at);
  const period = plan?.billing_period === 'annual' || plan?.billing_period === 'yearly'
    ? (t?.('chatyyOne.annual') || 'Anual') : (t?.('chatyyOne.monthly') || 'Mensal');

  const manage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await openStripePortal();
      if (!r?.success) {
        Alert.alert(t?.('common.error') || 'Erro', t?.('storage.portalFailed') || 'Nenhuma assinatura com cartão encontrada.');
      } else {
        load();
      }
    } finally { setBusy(false); }
  };

  const openSite = () => { Linking.openURL('https://chatyy.com.br').catch(() => {}); };

  if (loading) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={colors?.text} /></View>;
  }

  const gbTxt = fmtBytesSheet(limit);
  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Cartão do plano atual */}
        <View style={{
          marginHorizontal: 16, marginTop: 18, borderRadius: 20, padding: 20,
          backgroundColor: colors?.surface || '#fff',
          borderWidth: StyleSheet.hairlineWidth, borderColor: colors?.border || 'rgba(0,0,0,0.08)',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: colors?.text || '#111', alignItems: 'center', justifyContent: 'center' }}>
              <IconCloud size={24} color={colors?.background || '#fff'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: colors?.text }}>
                {isPaid ? `Chatyy One ${gbTxt}` : (t?.('chatyyOne.freeTitle') || 'Chatyy One Grátis')}
              </Text>
              <Text style={{ fontSize: 13, color: colors?.textSecondary, marginTop: 2 }}>
                {isPaid ? (t?.('chatyyOne.activePlan') || 'Plano ativo') : `${gbTxt} ${t?.('chatyyOne.included') || 'incluídos'}`}
              </Text>
            </View>
            <View style={{
              paddingHorizontal: 10, height: 24, borderRadius: 12, justifyContent: 'center',
              backgroundColor: isPaid ? 'rgba(22,163,74,0.14)' : (colors?.surfaceVariant || '#eee'),
            }}>
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: isPaid ? '#16a34a' : colors?.textSecondary }}>
                {isPaid ? (t?.('chatyyOne.statusActive') || 'Ativo') : (t?.('chatyyOne.statusFree') || 'Grátis')}
              </Text>
            </View>
          </View>

          <View style={{ marginTop: 20 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors?.text }}>
                {hasUsage ? fmtBytesSheet(used) : '—'}
                <Text style={{ fontWeight: '400', color: colors?.textSecondary }}> {t?.('chatyyOne.of') || 'de'} {gbTxt}</Text>
              </Text>
              {hasUsage ? <Text style={{ fontSize: 12.5, color: colors?.textSecondary }}>{Math.round(pct)}%</Text> : null}
            </View>
            <View style={{ height: 10, borderRadius: 5, backgroundColor: colors?.surfaceVariant || '#eee', overflow: 'hidden' }}>
              <View style={{ width: pct + '%', height: '100%', borderRadius: 5, backgroundColor: barColor }} />
            </View>
            {pct >= 80 ? (
              <Text style={{ fontSize: 12.5, color: pct >= 95 ? '#ef4444' : '#b45309', marginTop: 8 }}>
                {t?.('chatyyOne.nearFull') || 'Seu armazenamento está quase cheio.'}
              </Text>
            ) : null}
          </View>

          {MONETIZATION_ENABLED ? (
            <Pressable
              onPress={() => setShop(true)}
              accessibilityRole="button"
              style={({ pressed }) => ({
                marginTop: 20, height: 48, borderRadius: 14, flexDirection: 'row', gap: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: colors?.text || '#111', opacity: pressed ? 0.85 : 1,
              })}
            >
              <IconZap size={18} color={colors?.background || '#fff'} />
              <Text style={{ fontSize: 15.5, fontWeight: '700', color: colors?.background || '#fff' }}>
                {isPaid ? (t?.('chatyyOne.changePlan') || 'Mudar de plano') : (t?.('chatyyOne.upgrade') || 'Fazer upgrade')}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* Assinatura */}
        {isPaid ? (
          <Section title={t?.('chatyyOne.subscription') || 'Assinatura'} colors={colors}>
            <Row icon={IconCheckCircle} label={t?.('chatyyOne.status') || 'Status'} value={t?.('chatyyOne.statusActive') || 'Ativo'} noChevron colors={colors} />
            <Row icon={IconClock} label={t?.('chatyyOne.billing') || 'Cobrança'} value={period} noChevron colors={colors} />
            {renews ? (
              <Row icon={IconClock} label={t?.('chatyyOne.renewal') || 'Renovação / vigência até'} value={renews} noChevron colors={colors} />
            ) : null}
          </Section>
        ) : null}

        {/* Pagamento */}
        <Section title={t?.('chatyyOne.payment') || 'Pagamento'} colors={colors}>
          {isIOS ? (
            <Row
              icon={IconCreditCard}
              label={t?.('chatyyOne.manageOnWeb') || 'Gerencie pelo site chatyy.com.br'}
              value={t?.('chatyyOne.iosNote') || 'Assinaturas feitas no iPhone ficam na sua conta Apple.'}
              onPress={openSite}
              colors={colors}
            />
          ) : (
            <>
              <Row
                icon={IconCreditCard}
                label={t?.('chatyyOne.method') || 'Método de pagamento'}
                value={isPaid ? (t?.('chatyyOne.methodCard') || 'Cartão (processado pelo Stripe)') : (t?.('chatyyOne.methodNone') || 'Nenhum — plano gratuito')}
                noChevron
                colors={colors}
              />
              {stripeOk ? (
                <Row
                  icon={IconBrush}
                  label={isPaid ? (t?.('chatyyOne.managePayment') || 'Gerenciar pagamento e assinatura') : (t?.('chatyyOne.managePaymentFree') || 'Gerenciar pagamento')}
                  onPress={manage}
                  right={busy ? <ActivityIndicator size="small" color={colors?.textSecondary} /> : undefined}
                  colors={colors}
                />
              ) : null}
            </>
          )}
        </Section>
        <Footnote colors={colors}>
          {isIOS
            ? (t?.('chatyyOne.iosFootnote') || 'Por regras da Apple, cartão e portal de assinatura ficam no site. Acesse chatyy.com.br para gerenciar.')
            : (t?.('chatyyOne.footnote') || 'Trocar ou remover cartão e cancelar a assinatura abre o portal seguro do Stripe. O Chatyy nunca vê o número do seu cartão.')}
        </Footnote>
      </ScrollView>

      {MONETIZATION_ENABLED ? (
        <StorageShopSheet
          visible={shop}
          onClose={() => { setShop(false); load(); }}
          currentTier={tier}
          usedBytes={hasUsage ? used : undefined}
          limitBytes={limit}
        />
      ) : null}
    </>
  );
}

// ─── Main component ──────────────────────────────────────────────────
const SCREEN_TITLES = {
  main: 'settings.title',
  security: 'settings.security',
  devices: 'settings.linkedDevices',
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
  appearance: 'settings.appearance',
  storage: 'config.storage',
  one: 'chatyyOne.title',
};
const SCREEN_TITLE_FALLBACK = {
  main: 'Configurações',
  security: 'Segurança e senha',
  devices: 'Aparelhos conectados',
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
  appearance: 'Aparência',
  storage: 'Armazenamento e dados',
  one: 'Chatyy One',
};

export default function ProfileSettingsSheet({
  visible, onClose, colors, isDark, t, router, onLogout, onEditProfile, userEmail,
  userName, username, avatarUrl,
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
  // Logout confirmation — destructive, cleans local cache. We surface the
  // consequence ("backups e mensagens locais serão removidos") so users
  // don't tap by accident expecting "soft" logout. Runs the actual
  // logout via closeAndRun so the sheet animates away cleanly first.
  const handleLogout = useCallback(() => {
    Alert.alert(
      t?.('settings.logoutConfirmTitle') || 'Sair da conta?',
      t?.('settings.logoutConfirmMessage') || 'Você precisará fazer login novamente. Backups e mensagens locais serão removidos.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('settings.logout') || 'Sair', style: 'destructive', onPress: () => closeAndRun(() => onLogout?.()) },
      ]
    );
  }, [closeAndRun, onLogout, t]);

  const title = (t?.(SCREEN_TITLES[currentScreen]) || SCREEN_TITLE_FALLBACK[currentScreen]);

  const renderBody = () => {
    switch (currentScreen) {
      case 'security':      return <SecurityScreen colors={colors} t={t} router={router} onClose={onClose} />;
      case 'devices':       return <DevicesScreen colors={colors} t={t} onClose={onClose} />;
      case 'privacy':       return <PrivacyScreen colors={colors} t={t} />;
      case 'notifications': return <NotificationsScreen colors={colors} t={t} router={router} onClose={onClose} />;
      case 'language':      return <LanguageScreen colors={colors} t={t} />;
      case 'reading':       return <ReadingScreen colors={colors} t={t} />;
      case 'email':         return <EmailComposeScreen colors={colors} t={t} push={push} />;
      case 'ai':            return <AIFeaturesScreen colors={colors} t={t} />;
      case 'invite':        return <InviteScreen colors={colors} t={t} />;
      case 'about':         return <AboutScreen colors={colors} t={t} closeAndRun={closeAndRun} />;
      case 'support':       return <SupportScreen colors={colors} t={t} router={router} onClose={onClose} />;
      case 'delete':        return <DeleteAccountScreen colors={colors} t={t} onClose={onClose} onLogout={handleLogout} />;
      case 'export':        return <ExportDataScreen colors={colors} t={t} />;
      case 'vacation':      return <VacationScreen colors={colors} t={t} />;
      case 'appearance':    return <AppearanceScreen colors={colors} isDark={isDark} t={t} push={push} />;
      case 'storage':       return <StorageDataScreen colors={colors} isDark={isDark} t={t} push={push} />;
      case 'one':           return <ChatyyOneScreen colors={colors} isDark={isDark} t={t} />;
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
            userEmail={userEmail}
            userName={userName}
            username={username}
            avatarUrl={avatarUrl}
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
            // Grouped background (iOS/Instagram-style): a soft grey canvas in
            // light mode so the white surface cards read as discrete, elevated
            // groups; in dark mode the darkest background already lets the
            // (lighter) surface cards pop, so we keep it.
            backgroundColor: isDark
              ? (colors?.background || '#000')
              : (colors?.surfaceVariant || colors?.background || '#f3f4f6'),
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
