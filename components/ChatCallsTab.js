import NativeSwitch from './NativeSwitch'; // [2026-10-07 app-feel-ui] themed native toggle
import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Animated, Alert, ActivityIndicator, Dimensions, Modal, FlatList, TextInput, Switch, AppState, Share } from 'react-native';
import Svg, { Path, Polyline, Circle as SvgCircle, Line, Rect } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import BrandFab from './BrandFab';
import { isPstnEnabled } from '../constants/featureFlags';
import ChatyyMascot from './mascot/ChatyyMascot'; // [2026-10-16 mascote]
import { IconPhone, IconVideo, IconInfo, IconX, IconPhoneOff, IconMic, IconMicOff, IconVolume2, IconVolumeX, IconGrid, IconUserPlus, IconTrash, IconSmartphone, IconCheck, IconCalendar, IconVerifiedBadge, IconLink, IconMoreHorizontal, IconFlag, IconCopy, IconShield, IconChevronRight } from './Icons';
import Sheet from './ui/Sheet'; import ActionList from './ui/ActionList'; // [2026-10-14 vis-audit] menu "…" do histórico
import { USE_NATIVE_SHEETS, NativeSheet, runAfterNativeSheet } from './NativeSheet'; // [2026-10-15 native-sheets-v2]
import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-15 native-sheets-v2]
import SwipeAction from './SwipeAction';
import ScheduleCallModal from './ScheduleCallModal';
import { callHistoryList, callHistoryAdd, callHistoryDelete, callHistoryClear, voipCall, voipToken, voipSipCredentials, voipMinutesRemaining, voipUpdateDuration, searchContacts, voipVerifiedNumberRequest, voipVerifiedNumberConfirm, getProfile, callNotify as apiCallNotify } from '../services/api';
import { getCached, setCache } from '../services/cache';
import { useCall } from '../context/CallContext';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext'; // [2026-10-08 polish-leftovers]
import { PLAN_NAME } from '../services/brandPlan'; // [2026-10-17 brand-plan]
import { ensureContactIndex, lookupName as lookupDeviceContactName, noteContactsPermission, contactsDeniedForever, openContactsSettings, alertContactsDenied } from '../services/deviceContactLookup';
import { CallListSkeleton } from './SkeletonLoader';
import { haptic, Typography, BorderRadius, hairlineColor, Colors as _LC, DarkColors as _DC } from '../constants/theme';
// [2026-10-20 grafite] tokens do tema fora do contexto (subcomponentes só recebem isDark).
const _tc = (d) => (d ? _DC : _LC);
import { setActiveInterval } from '../utils/activeInterval'; // [2026-10-10 perf-battery]
import { LargeTitle, useLargeTitleCollapse } from './LargeTitleHeader'; // [2026-10-15 nav-motion]
import PressableScale from './PressableScale'; // [2026-10-15 nav-motion]
import FadeSlideIn from './FadeSlideIn'; // [2026-10-15 nav-motion]
const _NOFLEX = { flex: 0 };
// [2026-10-15 native-calls] Histórico em lista NATIVA (UICollectionView /
// RecyclerView). Binário sem a view → isCallListAvailable() false → ScrollView
// JS abaixo (idêntico ao antigo). Desligar por OTA: globalThis.__chatyy_native_calls = false.
import NativeCallList from './calls/NativeCallList';
import MyCallLinksSheet from './calls/MyCallLinksSheet'; // [2026-10-16 wave12-D]
import CreateCallLinkSheet from './calls/CreateCallLinkSheet'; // [call-link 2026-10-19]
import NewCallSheet from './calls/NewCallSheet'; // [2026-10-17 sem-pstn] "Nova chamada" (só Chatyy) no lugar do discador
import CallInfoSheet from './calls/CallInfoSheet'; // [2026-10-19 callinfo] info da chamada nível iOS Telefone / WhatsApp
import { addMyCallLink, useMyCallLinks, callLinkState } from './calls/myCallLinks';
import { useSilenceUnknownCallers } from './calls/silenceUnknownCallers';
import { isCallListAvailable as _nativeCallsAvailable } from '../modules/expo-chat-conversation-list';
// SIP call — dynamic import to prevent crash if native WebRTC module fails
let _sip = null;
try { _sip = require('../services/sipCall'); } catch {}
const startSipCall = _sip?.startSipCall || (async () => ({ success: false }));
const hangupSipCall = _sip?.hangupSipCall || (() => {});
// PSTN dialer (ligar pra qualquer número) via LiveKit + Vonage — substitui Telnyx.
// [2026-10-07 coldstart] LAZY: app/chat.js imports this tab statically, and
// pstnCall pulls `livekit-client` + `@livekit/react-native` at module eval —
// i.e. the whole LiveKit JS SDK was evaluated on the launch→chat-list path.
// Now it is required on the first PSTN dial/hangup only.
let _pstn; // undefined = not loaded yet, null = failed to load
// [2026-10-11 boot-split] dynamic import() (not require) so Metro splits
// pstnCall + livekit-client into their own async chunk on web; on native the
// import() resolves synchronously-bundled code, behavior unchanged.
let _pstnP = null;
function _loadPstn() {
  if (_pstn !== undefined) return Promise.resolve(_pstn);
  if (!_pstnP) _pstnP = import('../services/pstnCall').then((m) => { _pstn = m || null; return _pstn; }, () => { _pstn = null; return null; });
  return _pstnP;
}
const startPstnCall = (...args) => _loadPstn().then((m) => { const f = m?.startPstnCall; return f ? f(...args) : undefined; });
// Never loaded → no PSTN call can be active → nothing to hang up.
const hangupPstnCall = (...args) => { if (_pstn === undefined) return undefined; const f = _pstn?.hangupPstnCall; return f ? f(...args) : undefined; };
const muteSipCall = _sip?.muteSipCall || (() => {});
const sipSendDTMF = _sip?.sendDTMF || (() => {});

// [beauty 2026-10-01] De-iOS'd the calls tab palette so it stops reading like a
// different (blue/green system) app. GREEN now matches the theme success green
// (call-status semantics kept — green answer/arrows is universal); BLUE, which
// was iOS system blue on info/close/add/caller-id chrome, is now the app's
// neutral accent (#111111).
const GREEN = '#16a34a';
const GREEN_DARK = '#15803d';
const RED = '#E53935';
const BLUE = '#111111';
// [2026-10-08 polish-leftovers] link/info ink: BLUE (#111) vanished on the dark
// surfaces — dark mode uses the theme's white primary instead.
const blueInk = (isDark) => (isDark ? '#F5F5F7' : BLUE);
const ACCENT = '#111111';
const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_DIALER_WIDTH = 400;

// ── DTMF Tone Generator (Web Audio API) ──
// Real phone frequencies: each key = mix of two frequencies
const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

let _audioCtx = null;
function playDTMFTone(digit) {
  try {
    const freqs = DTMF_FREQS[digit];
    if (!freqs) return;
    if (!_audioCtx) {
      const AudioCtx = typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
      if (!AudioCtx) return;
      _audioCtx = new AudioCtx();
    }
    const ctx = _audioCtx;
    const duration = 0.15;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    gain.connect(ctx.destination);
    freqs.forEach(freq => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    });
  } catch (e) { /* silent */ }
}

// Native DTMF tones — works on iOS/Android/Web
function playDTMFNative(digit) {
  // Always vibrate on native
  if (Platform.OS !== 'web') {
    try { haptic.light(); } catch {}
  }
  // Web Audio API works on all platforms (including React Native via JSC/Hermes)
  playDTMFTone(digit);
}

// ── Phone Contacts Integration ──
let _phoneContacts = null;
let _phoneContactsLoading = false;

async function loadPhoneContacts() {
  if (_phoneContacts) return _phoneContacts;
  if (_phoneContactsLoading) return [];
  if (Platform.OS === 'web') return [];
  _phoneContactsLoading = true;
  try {
    const Contacts = require('expo-contacts');
    const _perm = await Contacts.requestPermissionsAsync();
    noteContactsPermission(_perm);
    const status = _perm?.status;
    if (status !== 'granted') { _phoneContactsLoading = false; return []; }
    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Image, Contacts.Fields.Emails],
      sort: Contacts.SortTypes.FirstName,
    });
    _phoneContacts = (data || []).filter(c => c.phoneNumbers && c.phoneNumbers.length > 0).map(c => ({
      id: c.id,
      name: c.name || c.firstName || '',
      phone: c.phoneNumbers?.[0]?.number || '',
      phones: (c.phoneNumbers || []).map(p => ({ number: p.number, label: p.label })),
      email: c.emails?.[0]?.email || '',
      image: c.image?.uri || null,
      source: 'phone',
    }));
    _phoneContactsLoading = false;
    return _phoneContacts;
  } catch (e) {
    console.warn('[Contacts] Error:', e.message);
    _phoneContactsLoading = false;
    return [];
  }
}

// Beautify a Chatyy email/handle into a human display name when the backend
// didn't fill `contactName`. "anacarla.pereiraramos@chatyy.com.br"
// → "Anacarla Pereiraramos". Phone numbers and other strings pass through.
function prettifyHandle(s) {
  if (!s || typeof s !== 'string') return s || '?';
  // Pure phone number — leave as-is
  if (/^\+?\d[\d\s\-()]{4,}$/.test(s.trim())) return s;
  // Strip our own domain suffix
  let local = s.replace(/@(chatyy\.com\.br|chatyy\.com|onemundo\.com\.br)$/i, '');
  // Strip generic email domain (keeps everything before @)
  if (local.includes('@')) local = local.split('@')[0];
  // Replace separators with spaces
  local = local.replace(/[._-]+/g, ' ').trim();
  if (!local) return s;
  // Capitalize each word
  return local.replace(/\b(\w)/g, c => c.toUpperCase());
}

// Get most called contacts from history
function getMostCalled(history, phoneContacts) {
  if (!history || history.length === 0) return [];
  const counts = {};
  history.forEach(h => {
    const key = h.to_number || h.contactEmail || '';
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const contact = phoneContacts?.find(c => c.phone?.replace(/\D/g, '')?.includes(key.replace(/\D/g, '')));
      const histItem = history.find(h => (h.to_number || h.contactEmail) === key);
      return {
        key,
        name: contact?.name || histItem?.contactName || histItem?.contact_name || key,
        phone: key,
        count,
        source: contact ? 'phone' : 'chatyy',
      };
    });
}

// --- Country flags ---
const COUNTRY_FLAGS = {
  '1':   { flag: '\u{1F1FA}\u{1F1F8}', name: 'US/CA' },
  '55':  { flag: '\u{1F1E7}\u{1F1F7}', name: 'Brasil' },
  '44':  { flag: '\u{1F1EC}\u{1F1E7}', name: 'UK' },
  '351': { flag: '\u{1F1F5}\u{1F1F9}', name: 'Portugal' },
  '34':  { flag: '\u{1F1EA}\u{1F1F8}', name: 'Espa\u00F1a' },
  '33':  { flag: '\u{1F1EB}\u{1F1F7}', name: 'France' },
  '49':  { flag: '\u{1F1E9}\u{1F1EA}', name: 'Germany' },
  '39':  { flag: '\u{1F1EE}\u{1F1F9}', name: 'Italy' },
  '81':  { flag: '\u{1F1EF}\u{1F1F5}', name: 'Japan' },
  '86':  { flag: '\u{1F1E8}\u{1F1F3}', name: 'China' },
  '91':  { flag: '\u{1F1EE}\u{1F1F3}', name: 'India' },
  '52':  { flag: '\u{1F1F2}\u{1F1FD}', name: 'M\u00E9xico' },
  '57':  { flag: '\u{1F1E8}\u{1F1F4}', name: 'Colombia' },
  '54':  { flag: '\u{1F1E6}\u{1F1F7}', name: 'Argentina' },
  '56':  { flag: '\u{1F1E8}\u{1F1F1}', name: 'Chile' },
  '58':  { flag: '\u{1F1FB}\u{1F1EA}', name: 'Venezuela' },
};

function detectCountry(number) {
  if (!number || !number.startsWith('+')) return null;
  const digits = number.slice(1);
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (COUNTRY_FLAGS[code]) return COUNTRY_FLAGS[code];
  }
  return null;
}

function formatPhoneDisplay(number) {
  if (!number) return '';
  if (!number.startsWith('+')) return number;
  const digits = number.slice(1);

  // BR numbers: +55 (XX) XXXXX-XXXX (mobile) or +55 (XX) XXXX-XXXX (landline)
  // Mobile numbers start with 9 after the DDD area code
  if (digits.startsWith('55')) {
    const local = digits.slice(2);
    if (local.length === 0) return '+55';
    if (local.length <= 2) return `+55 (${local}`;
    const ddd = local.slice(0, 2);
    const rest = local.slice(2);
    if (rest.length === 0) return `+55 (${ddd})`;
    const isMobile = rest.charAt(0) === '9';
    const splitAt = isMobile ? 5 : 4;
    if (rest.length <= splitAt) return `+55 (${ddd}) ${rest}`;
    return `+55 (${ddd}) ${rest.slice(0, splitAt)}-${rest.slice(splitAt)}`;
  }

  // US/CA numbers: +1 (XXX) XXX-XXXX
  if (digits.startsWith('1')) {
    const local = digits.slice(1);
    if (local.length === 0) return '+1';
    if (local.length <= 3) return `+1 (${local}`;
    const area = local.slice(0, 3);
    const rest = local.slice(3);
    if (rest.length === 0) return `+1 (${area})`;
    if (rest.length <= 3) return `+1 (${area}) ${rest}`;
    return `+1 (${area}) ${rest.slice(0, 3)}-${rest.slice(3)}`;
  }

  // Other countries: +CC XXXX XXXX (groups of 4)
  const cc = digits.length > 3 ? digits.slice(0, 2) : digits;
  const rest = digits.slice(cc.length);
  if (rest.length === 0) return `+${cc}`;
  const groups = [];
  for (let i = 0; i < rest.length; i += 4) {
    groups.push(rest.slice(i, i + 4));
  }
  return `+${cc} ${groups.join(' ')}`;
}

// --- SVG Icons ---
function ArrowOutgoing({ size = 14, color = '#6c6c70' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 17L17 7" />
      <Polyline points="7 7 17 7 17 17" />
    </Svg>
  );
}

function ArrowIncoming({ size = 14, color = '#6c6c70' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 7L7 17" />
      <Polyline points="17 17 7 17 7 7" />
    </Svg>
  );
}

function IconBackspace({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
      <Path d="M18 9l-6 6M12 9l6 6" />
    </Svg>
  );
}

function IconMissedCall({ size = 14, color = RED }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 2L16 8M16 2l6 6" />
      <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
    </Svg>
  );
}

function IconInfoCircle({ size = 20, color = BLUE }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx={12} cy={12} r={10} />
      <Line x1={12} y1={16} x2={12} y2={12} />
      <Line x1={12} y1={8} x2={12.01} y2={8} />
    </Svg>
  );
}

function IconCheckCircle({ size = 16, color = GREEN }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <Polyline points="22 4 12 14.01 9 11.01" />
    </Svg>
  );
}

// --- Signal bars icon for call quality ---
function IconSignalBars({ size = 20, color = '#fff', bars = 3 }) {
  const barCount = 4;
  const barWidth = size / (barCount * 2);
  const gap = barWidth;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      {Array.from({ length: barCount }, (_, i) => {
        const h = ((i + 1) / barCount) * 14 + 2;
        const x = i * (barWidth + gap) + 1;
        const y = 18 - h;
        const opacity = i < bars ? 1 : 0.25;
        return <Rect key={i} x={x} y={y} width={barWidth} height={h} rx={1} fill={color} opacity={opacity} />;
      })}
    </Svg>
  );
}

// --- API helpers ---
// [2026-10-11 boot-split] moved to services/callHistoryStore.js (re-exported below).
import {
  CALL_HISTORY_CACHE_KEY, _readCallHistoryCache, _writeCallHistoryCache, callDirection,
  getCallHistory, getCallHistoryCached, prefetchCallHistory, markMissedCallsRead, addCallToHistory, removeCallFromHistory,
} from '../services/callHistoryStore';
export { getCallHistory, getCallHistoryCached, prefetchCallHistory, markMissedCallsRead, addCallToHistory, removeCallFromHistory };

// --- Formatting ---
function formatCallTime(timestamp, t, locale) {
  const date = new Date(timestamp);
  const now = new Date();
  const loc = locale || undefined;
  const timeStr = date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });

  // Use calendar boundaries (toDateString) so row label matches section header.
  // Elapsed-time bucketing would say "Hoje" for a yesterday-23h call viewed at 00:30.
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();
  const dateStr = date.toDateString();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  // [2026-10-16 polish3] Hoje/Ontem já são o cabeçalho da seção ("HOJE") —
  // repetir "Hoje 09:31" em toda linha era ruído (WhatsApp mostra só a hora).
  if (dateStr === todayStr || dateStr === yesterdayStr) return timeStr;
  if (diffDays < 7) {
    // toLocaleDateString(undefined, ...) was returning English ("Sat", "Fri")
    // on iOS sim regardless of app locale because the system default is en-US.
    // Use translated weekday array from i18n keyed by 0=Sun.
    const days = t?.('time.days');
    if (Array.isArray(days) && days.length === 7) {
      return `${days[date.getDay()]} ${timeStr}`;
    }
    return date.toLocaleDateString(loc, { weekday: 'short' }) + ` ${timeStr}`;
  }
  return date.toLocaleDateString(loc, { day: '2-digit', month: '2-digit' }) + ` ${timeStr}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `0:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatDurationLong(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// [2026-10-06 UX2] Direction resolver. Server rows (chat_call_history_list)
// carry the MEDIA kind in `type` (audio|video|group), the direction in
// `direction` (outgoing|incoming) and the outcome in `status` (answered|
// missed|declined|busy|ringing). Local rows (addCallToHistory / voip merge)
// still use the legacy `type` = outgoing|incoming|missed. Rendering code was
// checking `item.type === 'outgoing'` only, so every server row fell through
// to the "incoming" branch and labels showed raw "audio". Single source of
// truth here — never read direction from `type` directly again.
// callDirection: see services/callHistoryStore.js
// [2026-10-06 UX2] Media kind (audio vs video) — distinct from direction.
function callIsVideo(item) {
  return !!(item && (item.video || item.is_video || String(item.type || '').toLowerCase() === 'video'));
}

function getCallLabel(type, t) {
  if (t) {
    const keys = { outgoing: 'calls.outgoing', incoming: 'calls.incoming', missed: 'calls.missed' };
    const translated = t(keys[type]);
    if (translated && translated !== keys[type]) return translated;
  }
  // [2026-10-06 UX2] pt-BR fallbacks (project default language); t() first.
  switch (type) {
    case 'outgoing': return 'Realizada';
    case 'incoming': return 'Recebida';
    case 'missed': return 'Perdida';
    default: return type;
  }
}

// --- Dial pad keys ---
const DIAL_KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

// --- DTMF dial pad keys (for in-call keypad) ---
const DTMF_KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

// ============================================================
// FILTER CHIPS (Todas / Perdidas (n) / Chatyy / Telefone)
// [2026-10-16 wave12-D] era um segmento de 3 (Recentes/Chatyy/Telefone) sem
// "Perdidas". Chips P&B (ativo = preenchido); contador de perdidas no vermelho
// padrão das ligações perdidas. "Telefone" só com PSTN ou histórico de telefone.
// ============================================================
// [2026-10-17 sem-pstn] Sem PSTN toda ligação é Chatyy → só "Todas / Perdidas"
// (igual WhatsApp); "Chatyy" e "Telefone" só voltam com o kill switch ligado.
const CallFilterChips = memo(function CallFilterChips({ activeTab, onTabChange, isDark, t, missedCount, showPhone }) {
  const tabs = [
    { key: 'recent', label: t?.('calls.filterAll') || 'Todas' },
    { key: 'missed', label: t?.('calls.filterMissed') || 'Perdidas', count: missedCount },
    showPhone ? { key: 'chatyy', label: t?.('calls.chatyy') || 'Chatyy' } : null,
    showPhone ? { key: 'phone', label: t?.('calls.phone') || 'Telefone' } : null,
  ].filter(Boolean);
  const ink = isDark ? '#F5F5F7' : '#111111';
  const onInk = isDark ? '#000000' : '#ffffff';
  // (translúcido de propósito: a página de Ligações é cinza agrupado — um #f2f2f2 sólido sumia nela)
  const idleBg = isDark ? 'rgba(255, 255, 255,0.12)' : 'rgba(17, 17, 17,0.07)';
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -16, flexGrow: 0 }}
      contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 }}
      accessibilityRole="tablist"
    >
      {tabs.map((tab) => {
        const active = activeTab === tab.key;
        return (
          <PressableScale
            key={tab.key}
            haptic="select"
            scaleTo={0.95}
            onPress={() => onTabChange(tab.key)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, minHeight: 32,
              backgroundColor: active ? ink : idleBg,
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.count ? `${tab.label} ${tab.count}` : tab.label}
            testID={`calls-filter-${tab.key}`}
          >
            <Text style={{ fontSize: Typography.subhead.fontSize, letterSpacing: Typography.subhead.letterSpacing, fontWeight: active ? '600' : '500', color: active ? onInk : ink }}>
              {tab.label}
            </Text>
            {tab.count > 0 && (
              <View style={{
                minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
                alignItems: 'center', justifyContent: 'center', backgroundColor: RED,
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#ffffff' }}>
                  {tab.count > 99 ? '99+' : tab.count}
                </Text>
              </View>
            )}
          </PressableScale>
        );
      })}
    </ScrollView>
  );
});

// ============================================================
// DIAL KEY - iPhone Phone app style
// ============================================================
const DIAL_KEY_SIZE = 77;
const DialKey = memo(function DialKey({ digit, sub, onPress, onLongPress, isDark, size }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.93,
      tension: 300,
      friction: 10,
      useNativeDriver: true,
    }).start();
  }, [scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 200,
      friction: 10,
      useNativeDriver: true,
    }).start();
  }, [scaleAnim]);

  // iPhone uses a light gray circle for dial keys
  const keyBg = isDark ? '#3a3a3c' : '#d4d7dc';
  const keyColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#aeaeb2' : '#000000';

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[s.dialKey, { backgroundColor: keyBg }, size ? { width: size, height: size, borderRadius: size / 2 } : null]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.5}
        accessibilityLabel={digit}
        accessibilityRole="button"
      >
        <Text style={[s.dialKeyDigit, { color: keyColor }, size && size < 70 ? { fontSize: 28 } : null]}>{digit}</Text>
        {sub ? (
          <Text style={[s.dialKeySub, { color: subColor }]}>{sub}</Text>
        ) : (
          <View style={{ height: digit === '1' ? 14 : 11 }} />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
});

// ============================================================
// CALL HISTORY ROW - iPhone style
// ============================================================
// Silence unknown callers — state persists in AsyncStorage
// [2026-10-16 wave12-D] estado compartilhado com Configurações > Privacidade.
function SilenceToggle({ isDark }) {
  const [on, setOn] = useSilenceUnknownCallers();
  return (
    <NativeSwitch
      value={on}
      onValueChange={setOn}
      trackColor={{ false: isDark ? '#39393d' : '#e9e9ea', true: GREEN }}
      thumbColor="#ffffff"
    />
  );
}

// [2026-10-17 polish-calls-wa] Subtítulo estilo WhatsApp: "Recebida" / "Efetuada" /
// "Perdida" (+ ícone de vídeo/duração ao lado). Antes toda linha Chatyy dizia só
// "Chatyy" — sem PSTN isso não informa nada. Linha de telefone antiga segue com o número.
function _callSubLabel(item, direction, t) {
  if (item && item.to_number && item.source !== 'chat') return formatPhoneDisplay(item.to_number);
  return getCallLabel(direction, t);
}
function _rowCount(item) {
  return Number(item?.count || item?.call_count || 0) || 0;
}

const CallHistoryRow = memo(function CallHistoryRow({ item, isDark, t, language, onPress, onInfoPress, onCallBack, onLongPress }) {
  // [2026-05-28] Server-sourced rows carry the kind in `item.type`
  // (audio|video|group) and the outcome in `item.status` (missed|answered|
  // declined|busy|ringing). Checking only `item.type === 'missed'` meant
  // server rows NEVER went red — only locally-added missed entries did
  // (#949 regression). Honor both, and never paint an outgoing call red.
  // [2026-10-06 UX2] direction via callDirection() (direction > status > legacy type).
  const direction = callDirection(item);
  const isMissed = direction === 'missed';
  const nameColor = isMissed ? RED : (isDark ? '#ffffff' : '#000000');
  // [2026-10-13 visual] light #8e8e93 on white = 3.3:1 (fails AA) -> #6c6c70
  const subColor = isDark ? '#8e8e93' : '#6c6c70';
  const label = getCallLabel(direction, t);
  const isVideoCall = callIsVideo(item);
  const durationStr = formatDuration(item.duration);
  const country = detectCountry(item.to_number || item.contactEmail);
  const isChatyy = item.source === 'chat';
  const rawName = item.contactName || item.contact_name || item.to_number || item.contactEmail || '?';
  // History rows often store the raw phone as contactName (we don't know the
  // saved name at write time). When that's the case (number-looking), try
  // resolving against the device contact index so the row reads "Mãe"
  // instead of "+5511…". Falls back to prettifyHandle otherwise. Index is
  // already warm via DialerModal's mount + IncomingCallListener's lookup.
  const hasSavedName = !!(item.contactName || item.contact_name) && !/^\+?\d[\d\s\-()]{3,}$/.test(String(rawName).trim());
  const phoneForLookup = item.to_number || (typeof rawName === 'string' && /^\+?\d/.test(rawName) ? rawName : '');
  const lookedUp = !hasSavedName && phoneForLookup ? lookupDeviceContactName(phoneForLookup) : null;
  // [FIX 2026-10-03] A "saved name" that is actually a raw email handle
  // (lowercase, dot/underscore separated, e.g. "sara.costa") was shown as-is
  // because hasSavedName was true — but it should read "Sara Costa". Prettify
  // those too; real names (with spaces or mixed case) are left untouched.
  // [2026-10-14 vis3] handle de 1 palavra minúscula ("qa2") também → "Qa2", igual à lista de conversas.
  const _isRawHandle = (n) => typeof n === 'string' && /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(String(n).trim()) && !/^\d+$/.test(String(n).trim());
  const displayName = lookedUp
    || ((hasSavedName && !_isRawHandle(rawName)) ? rawName : prettifyHandle(rawName));

  return (
    <TouchableOpacity
      style={s.historyRow}
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress?.(item)}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      {/* Left: Avatar or flag (red ring for missed, transparent otherwise) */}
      <View style={[s.historyLeft, isMissed && s.historyLeftMissed]}>
        {isChatyy && (item.contactName || item.contactEmail) ? (
          <AvatarCircle
            name={item.contactName || item.contactEmail || '?'}
            email={item.contactEmail}
            size={44}
          />
        ) : (
          <View style={[s.historyAvatar, { backgroundColor: _tc(isDark).surfaceVariant }]}>
            {/* [2026-10-16 polish-calls] sem emoji de bandeira na UI → glifo de linha */}
            <IconPhone size={20} color={subColor} />
          </View>
        )}
      </View>

      {/* Middle: Name + type */}
      <View style={s.historyMiddle}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[s.historyName, { color: nameColor }]} numberOfLines={1}>
            {displayName}
            {/* [2026-10-17 polish-calls-wa] "(3)" agrupado igual ao WhatsApp (a célula nativa já mostrava). */}
            {_rowCount(item) > 1 ? <Text style={{ fontWeight: '400' }}>{` (${_rowCount(item)})`}</Text> : null}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          {/* Semantic colors: missed=red; incoming/outgoing = cinza (P&B 2026-10-16 —
              verde fica só no botão de ligar/atender). */}
          {isMissed ? (
            <ArrowIncoming size={12} color={RED} />
          ) : direction === 'outgoing' ? ( // [2026-10-06 UX2]
            <ArrowOutgoing size={12} color={isDark ? '#8e8e93' : '#6c6c70'} />
          ) : (
            <ArrowIncoming size={12} color={isDark ? '#8e8e93' : '#6c6c70'} />
          )}
          <Text style={[s.historyType, { color: subColor }]}>
            {_callSubLabel(item, direction, t)}
          </Text>
          {isVideoCall && ( // [2026-10-06 UX2] media kind, not direction
            <IconVideo size={12} color={subColor} />
          )}
          {durationStr ? (
            <Text style={[s.historyType, { color: subColor }]}>{durationStr}</Text>
          ) : null}
          {/* Voicemail indicator: tiny mic icon when the missed/declined
              call has an attached voicemail. Tapping the row already opens
              the conversation, where the bubble is visible. */}
          {(item.has_voicemail || item.voicemail_id) ? (
            <View
              style={{ marginLeft: 4 }}
              accessibilityLabel={t?.('voicemail.attached') || 'Mensagem de voz'}
            >
              <IconMic size={12} color={RED} />
            </View>
          ) : null}
        </View>
      </View>

      {/* Right: Time + callback + info */}
      <View style={s.historyRight}>
        <Text style={[s.historyTime, { color: subColor }]}>
          {formatCallTime(item.timestamp || item.created_at, t, language)}
        </Text>
        {/* [2026-10-17 sem-pstn] linha de telefone (PSTN) antiga: sem botão de rediscar. */}
        {(!item.to_number || isPstnEnabled()) && (
        <TouchableOpacity
          style={s.callBackBtn}
          onPress={() => { haptic.medium(); onCallBack?.(item); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={t?.('calls.callBack') || 'Call back'}
          accessibilityRole="button"
        >
          {/* [2026-10-17 polish-calls-wa] glifo limpo (sem disco cinza) e do MESMO tipo da
              ligação — vídeo rediscar com câmera, igual WhatsApp. */}
          {isVideoCall
            ? <IconVideo size={21} color={blueInk(isDark)} />
            : <IconPhone size={19} color={blueInk(isDark)} />}
        </TouchableOpacity>
        )}
        <TouchableOpacity
          style={s.infoBtn}
          onPress={() => onInfoPress(item)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={t?.('calls.callInfo') || 'Info'}
          accessibilityRole="button"
        >
          <IconInfoCircle size={20} color={blueInk(isDark)} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}, (prev, next) => {
  // Custom comparator — compare data props, ignore function reference changes.
  // Without this the row re-renders every time the parent re-creates onPress/onInfoPress.
  if (prev.isDark !== next.isDark) return false;
  if (prev.t !== next.t) return false;
  if (prev.language !== next.language) return false;
  const a = prev.item, b = next.item;
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  if ((a.type || '') !== (b.type || '')) return false;
  if ((a.duration || 0) !== (b.duration || 0)) return false;
  if ((a.timestamp || a.created_at || '') !== (b.timestamp || b.created_at || '')) return false;
  if ((a.contactName || a.contact_name || '') !== (b.contactName || b.contact_name || '')) return false;
  if ((a.contactEmail || a.contact_email || '') !== (b.contactEmail || b.contact_email || '')) return false;
  if ((a.to_number || '') !== (b.to_number || '')) return false;
  if ((a.video || false) !== (b.video || false)) return false;
  if ((a.source || '') !== (b.source || '')) return false;
  // [2026-10-17 polish-calls-wa] ringing→missed / contagem / correio de voz mudam a linha.
  if ((a.status || '') !== (b.status || '')) return false;
  if ((a.direction || '') !== (b.direction || '')) return false;
  if (_rowCount(a) !== _rowCount(b)) return false;
  if (!!(a.has_voicemail || a.voicemail_id) !== !!(b.has_voicemail || b.voicemail_id)) return false;
  return true;
});

// [2026-10-15 native-calls] Mesmas regras de exibição do CallHistoryRow, em
// dados planos para a lista nativa (components/calls/NativeCallList.js).
function _describeCallRow(item, t, language) {
  const direction = callDirection(item);
  const isMissed = direction === 'missed';
  const isVideoCall = callIsVideo(item);
  const country = detectCountry(item.to_number || item.contactEmail);
  const isChatyy = item.source === 'chat';
  const rawName = item.contactName || item.contact_name || item.to_number || item.contactEmail || '?';
  const hasSavedName = !!(item.contactName || item.contact_name) && !/^\+?\d[\d\s\-()]{3,}$/.test(String(rawName).trim());
  const phoneForLookup = item.to_number || (typeof rawName === 'string' && /^\+?\d/.test(rawName) ? rawName : '');
  const lookedUp = !hasSavedName && phoneForLookup ? lookupDeviceContactName(phoneForLookup) : null;
  const _isRawHandle = (n) => typeof n === 'string' && /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(String(n).trim()) && !/^\d+$/.test(String(n).trim());
  const title = lookedUp
    || ((hasSavedName && !_isRawHandle(rawName)) ? rawName : prettifyHandle(rawName));
  const sub = _callSubLabel(item, direction, t);
  const dur = formatDuration(item.duration);
  const time = formatCallTime(item.timestamp || item.created_at, t, language);
  const label = getCallLabel(direction, t);
  return {
    title: String(title || '?'),
    dir: isMissed ? 'missed' : (direction === 'outgoing' ? 'out' : 'in'),
    video: isVideoCall,
    sub,
    dur,
    vm: !!(item.has_voicemail || item.voicemail_id),
    time,
    count: _rowCount(item),
    isChatyy: isChatyy && !!(item.contactName || item.contactEmail),
    avatarName: item.contactName || item.contactEmail || '?',
    avatarEmail: item.contactEmail || '',
    flag: '', // [2026-10-16 polish-calls] sem emoji de bandeira (célula nativa cai no ícone de telefone)
    a11y: [title, label, isVideoCall ? (t?.('calls.video') || 'Vídeo') : '', dur, time].filter(Boolean).join(', '),
  };
}

// Mesmo agrupamento do groupedCalls (Hoje / Ontem / Esta Semana / Anteriores).
function _callSectionLabel(item, t) {
  const d = new Date(item?.timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t?.('calls.today') || 'Hoje';
  if (d.toDateString() === yesterday.toDateString()) return t?.('calls.yesterday') || 'Ontem';
  const diffDays = Math.floor((today - d) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) return t?.('calls.thisWeek') || 'Esta Semana';
  return t?.('calls.earlier') || 'Anteriores';
}

// ============================================================
// EMPTY ILLUSTRATION — phone with three pulsing signal rings.
// Why: a single grey circle + icon felt unfinished. The expanding rings hint
// that the screen is "live, just waiting" rather than a dead zone, and the
// violet matches the rest of the app's brand polish from R14/R17.
// ============================================================
function CallEmptyIllustration({ isDark, ink = '#111111', onInk = '#fff' }) {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Why: 3 rings staggered by 600ms over 1800ms feels like a phone "looking
    // for a connection" — calm and continuous, not jittery.
    const make = (anim, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 1800, useNativeDriver: true }),
      ])
    );
    const a1 = make(ring1, 0);
    const a2 = make(ring2, 600);
    const a3 = make(ring3, 1200);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);

  const ringStyle = (anim) => ({
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 999, borderWidth: 2,
    borderColor: isDark ? 'rgba(245,245,247,0.45)' : 'rgba(17, 17, 17,0.45)',
    transform: [
      { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 2.4] }) },
    ],
    opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.6, 0] }),
  });

  return (
    <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center', marginBottom: 22 }}>
      {/* Three expanding rings */}
      <View style={{ position: 'absolute', width: 60, height: 60 }}>
        <Animated.View style={ringStyle(ring1)} />
        <Animated.View style={ringStyle(ring2)} />
        <Animated.View style={ringStyle(ring3)} />
      </View>
      {/* Violet phone disc */}
      <View style={{
        width: 64, height: 64, borderRadius: 32,
        alignItems: 'center', justifyContent: 'center',
        ...Platform.select({
          ios: { shadowColor: isDark ? '#000' : ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.32, shadowRadius: 14 },
          android: { elevation: 6 },
          web: { boxShadow: isDark ? '0 6px 20px rgba(0,0,0,0.5)' : '0 6px 20px rgba(17, 17, 17,0.32)' },
        }),
        // [2026-10-08 polish-leftovers] theme ink (white disc + black glyph in dark)
        backgroundColor: ink,
      }}>
        <IconPhone size={26} color={onInk} />
      </View>
    </View>
  );
}

// ============================================================
// LOADING SKELETON
// ============================================================
// ============================================================
// PLAN STATUS BADGE
// ============================================================
function PlanBadge({ minutesInfo, isDark, t }) {
  if (!minutesInfo) return null;
  const limit = minutesInfo.minutes_limit || 0;
  const used = minutesInfo.minutes_used || 0;
  const isPaid = limit > 0;
  const isUnlimited = limit >= 9999;

  if (isPaid) {
    const badgeText = isUnlimited
      ? (t?.('calls.unlimited') || 'Chamadas ilimitadas')
      : `${used}/${limit} min`;
    return (
      <View style={[s.planBadge, { backgroundColor: _tc(isDark).surface }]}>
        <IconCheckCircle size={16} color={blueInk(isDark)} />
        <Text style={[s.planBadgeText, { color: blueInk(isDark) }]}>
          {badgeText}
        </Text>
      </View>
    );
  }

  return (
    <View style={[s.planBadge, { backgroundColor: _tc(isDark).surfaceVariant }]}>
      <Text style={[s.planBadgeText, { color: isDark ? '#8e8e93' : '#6c6c70', fontSize: 12 }]}>
        {t?.('calls.needsPlan') || ('Assine o ' + PLAN_NAME + ' para chamadas ilimitadas')}
      </Text>
    </View>
  );
}

// [2026-10-19 callinfo] CALL INFO → components/calls/CallInfoSheet.js

// ============================================================
// AUDIO WAVEFORM ANIMATION - subtle bars when connected
// ============================================================
function AudioWaveform({ active }) {
  const BAR_COUNT = 5;
  const anims = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.3))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach(a => a.setValue(0.3));
      return;
    }
    const animations = anims.map((anim, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.4 + Math.random() * 0.6,
            duration: 300 + i * 80,
            useNativeDriver: false,
          }),
          Animated.timing(anim, {
            toValue: 0.15 + Math.random() * 0.25,
            duration: 250 + i * 60,
            useNativeDriver: false,
          }),
        ])
      );
    });
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, [active]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 3, marginTop: 12 }}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            borderRadius: 1.5,
            backgroundColor: 'rgba(255,255,255,0.5)',
            height: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [4, 24],
            }),
          }}
        />
      ))}
    </View>
  );
}

// ============================================================
// DTMF KEYPAD OVERLAY - for IVR menus during a call
// ============================================================
function DTMFKeypad({ visible, onClose, onDigit, isDark, t }) {
  if (!visible) return null;

  // iOS Phone-app style: bigger keys, white-on-dark with letter sub,
  // pressed-state highlight, larger gap between rows.
  const DTMF_KEY_SIZE = 78;

  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.92)',
      alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}>
      {/* Close button — top-left, generous hit area */}
      <TouchableOpacity
        style={{
          position: 'absolute',
          top: Platform.OS === 'web' ? 20 : 56,
          left: 20,
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: 'rgba(255,255,255,0.12)',
          alignItems: 'center', justifyContent: 'center',
          zIndex: 101,
        }}
        onPress={onClose}
        accessibilityLabel={t?.('common.close') || 'Fechar'}
      >
        <IconX size={22} color="#fff" />
      </TouchableOpacity>

      {/* Title — clean, no all-caps "TECLADO DTMF" */}
      <Text style={{
        color: '#fff', fontSize: 20, fontWeight: '600',
        marginBottom: 28, letterSpacing: 0.2,
      }}>
        {t?.('calls.keypad') || 'Teclado'}
      </Text>

      {/* 4x3 grid — iPhone style spacing (24pt gap, larger keys) */}
      <View style={{ alignItems: 'center' }}>
        {[0, 1, 2, 3].map(row => (
          <View key={row} style={{ flexDirection: 'row', gap: 24, marginBottom: 18 }}>
            {DTMF_KEYS.slice(row * 3, row * 3 + 3).map((k) => (
              <TouchableOpacity
                key={k.digit}
                style={{
                  width: DTMF_KEY_SIZE, height: DTMF_KEY_SIZE,
                  borderRadius: DTMF_KEY_SIZE / 2,
                  backgroundColor: 'rgba(255,255,255,0.18)',
                  borderWidth: 0.5,
                  borderColor: 'rgba(255,255,255,0.05)',
                  alignItems: 'center', justifyContent: 'center',
                  ...Platform.select({
                    ios: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
                    android: { elevation: 2 },
                  }),
                }}
                onPress={() => {
                  if (Platform.OS !== 'web') {
                    try { haptic.light(); } catch {}
                  }
                  onDigit(k.digit);
                }}
                activeOpacity={0.55}
                accessibilityLabel={k.digit}
                accessibilityRole="button"
              >
                <Text style={{
                  color: '#fff',
                  fontSize: 34,
                  fontWeight: '400',
                  lineHeight: 40,
                }}>
                  {k.digit}
                </Text>
                {k.sub ? (
                  <Text style={{
                    color: 'rgba(255,255,255,0.55)',
                    fontSize: 10,
                    fontWeight: '600',
                    letterSpacing: 2,
                    marginTop: -2,
                  }}>{k.sub}</Text>
                ) : (
                  <View style={{ height: 12 }} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// ACTIVE CALL SCREEN - Modern iPhone/WhatsApp style
// ============================================================
function ActiveCallScreen({
  visible, number, contactName, isDark, t, onHangup, callState, duration,
  isMuted, onToggleMute, isSpeaker, onToggleSpeaker, onSendDTMF, onMinimize,
}) {
  const insets = useSafeAreaInsets(); // [2026-10-18 safe-area] topo real (era 50 fixo no iOS)
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRingAnim = useRef(new Animated.Value(0)).current;
  const [showKeypad, setShowKeypad] = useState(false);

  // Pulsing avatar ring when ringing/connecting
  useEffect(() => {
    if (!visible || callState === 'connected' || callState === 'ended') {
      pulseRingAnim.setValue(0);
      return;
    }
    const ringPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseRingAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseRingAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ])
    );
    ringPulse.start();
    return () => ringPulse.stop();
  }, [visible, callState]);

  // Pulsing scale for avatar
  useEffect(() => {
    if (!visible || callState === 'connected' || callState === 'ended') {
      pulseAnim.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [visible, callState]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const isConnected = callState === 'connected';
  const isRinging = callState === 'ringing' || callState === 'connecting' || callState === 'phone_ringing';

  const stateLabel = callState === 'connecting' ? (t?.('calls.connecting') || 'Conectando...')
    : callState === 'ringing' ? (t?.('calls.ringing') || 'Chamando...')
    : callState === 'connected' ? (t?.('calls.inCall') || 'Em chamada')
    : callState === 'ended' ? (t?.('calls.ended') || 'Chamada encerrada')
    : callState === 'phone_ringing' ? (t?.('calls.phoneRinging') || 'Atenda seu telefone...')
    : (t?.('calls.connecting') || 'Conectando...');

  // Quality indicator (simulated: good quality after 3s connected)
  const qualityBars = isConnected ? (duration < 3 ? 2 : duration < 10 ? 3 : 4) : 0;

  if (!visible) return null;

  // Pulsing ring interpolations
  const ringScale = pulseRingAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.5],
  });
  const ringOpacity = pulseRingAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.4, 0.15, 0],
  });

  // Initial of contact name for avatar
  const initial = (contactName || number || '?').charAt(0).toUpperCase();

  return (
    <Modal visible={visible} animationType="fade" transparent={false}>
      <View style={activeCallStyles.container}>
        {/* Gradient background layers */}
        <View style={activeCallStyles.gradientTop} />
        <View style={activeCallStyles.gradientBottom} />

        {/* Top bar: minimize button (left) + quality indicator (right) */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? insets.top + 6 : androidTopInset(20), left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 18, zIndex: 10,
        }}>
          {onMinimize ? (
            <TouchableOpacity
              onPress={onMinimize}
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: 'rgba(255,255,255,0.16)',
                alignItems: 'center', justifyContent: 'center',
              }}
              accessibilityLabel={t?.('call.minimize') || 'Minimizar'}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <Polyline points="6 9 12 15 18 9" />
              </Svg>
            </TouchableOpacity>
          ) : <View style={{ width: 40 }} />}
          {isConnected ? (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: 'rgba(255,255,255,0.12)',
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
            }}>
              <IconSignalBars size={14} color="#fff" bars={qualityBars} />
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>HD</Text>
            </View>
          ) : <View style={{ width: 40 }} />}
        </View>

        {/* Call quality indicator - top right (legacy, hidden now) */}
        {false && isConnected && (
          <View style={activeCallStyles.qualityContainer}>
            <IconSignalBars size={16} color="rgba(255,255,255,0.7)" bars={qualityBars} />
          </View>
        )}

        {/* Avatar area with pulsing ring */}
        <View style={activeCallStyles.avatarSection}>
          {/* Expanding pulse ring (visible when ringing) */}
          {isRinging && (
            <Animated.View style={[
              activeCallStyles.pulseRing,
              { transform: [{ scale: ringScale }], opacity: ringOpacity },
            ]} />
          )}
          {/* Second ring */}
          {isRinging && (
            <Animated.View style={[
              activeCallStyles.pulseRing,
              {
                transform: [{ scale: pulseRingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.3] }) }],
                opacity: pulseRingAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 0.1, 0] }),
              },
            ]} />
          )}

          {/* Avatar circle */}
          <Animated.View style={{ transform: [{ scale: isRinging ? pulseAnim : 1 }] }}>
            <View style={activeCallStyles.avatarOuter}>
              <View style={activeCallStyles.avatarInner}>
                <Text style={activeCallStyles.avatarInitial}>{initial}</Text>
              </View>
            </View>
          </Animated.View>
        </View>

        {/* Name / Number */}
        <Text style={activeCallStyles.contactName} numberOfLines={1}>
          {contactName || number}
        </Text>
        {contactName && number && (
          <Text style={activeCallStyles.contactNumber}>{formatPhoneDisplay(number)}</Text>
        )}

        {/* Status label */}
        <Text style={activeCallStyles.stateLabel}>{stateLabel}</Text>

        {/* Duration timer - large and prominent when connected */}
        {isConnected && (
          <Text style={activeCallStyles.durationTimer}>{formatTime(duration)}</Text>
        )}

        {/* Audio waveform when connected */}
        <AudioWaveform active={isConnected} />

        {/* Spacer */}
        <View style={{ flex: 1 }} />

        {/* Action buttons row: Mute | Keypad | Speaker */}
        <View style={activeCallStyles.actionRow}>
          {/* Mute */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, isMuted && activeCallStyles.actionBtnActive]}
            onPress={onToggleMute}
            activeOpacity={0.7}
            accessibilityLabel={isMuted ? (t?.('calls.unmute') || 'Ativar microfone') : (t?.('calls.mute') || 'Silenciar')}
            accessibilityRole="button"
          >
            {isMuted ? (
              <IconMicOff size={24} color="#fff" />
            ) : (
              <IconMic size={24} color="#fff" />
            )}
            <Text style={activeCallStyles.actionLabel}>
              {isMuted ? (t?.('calls.muted') || 'Mudo') : (t?.('calls.mute') || 'Silenciar')}
            </Text>
          </TouchableOpacity>

          {/* Keypad */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, showKeypad && activeCallStyles.actionBtnActive]}
            onPress={() => setShowKeypad(prev => !prev)}
            activeOpacity={0.7}
            accessibilityLabel={t?.('calls.keypad') || 'Teclado'}
            accessibilityRole="button"
          >
            <IconGrid size={24} color="#fff" />
            <Text style={activeCallStyles.actionLabel}>
              {t?.('calls.keypad') || 'Teclado'}
            </Text>
          </TouchableOpacity>

          {/* Speaker */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, isSpeaker && activeCallStyles.actionBtnActive]}
            onPress={onToggleSpeaker}
            activeOpacity={0.7}
            accessibilityLabel={isSpeaker ? (t?.('calls.speakerOff') || 'Desligar alto-falante') : (t?.('calls.speakerOn') || 'Alto-falante')}
            accessibilityRole="button"
          >
            {isSpeaker ? (
              <IconVolume2 size={24} color="#fff" />
            ) : (
              <IconVolumeX size={24} color="#fff" />
            )}
            <Text style={activeCallStyles.actionLabel}>
              {isSpeaker ? (t?.('calls.speaker') || 'Alto-falante') : (t?.('calls.speaker') || 'Alto-falante')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Hangup button */}
        <TouchableOpacity
          style={activeCallStyles.hangupBtn}
          onPress={onHangup}
          activeOpacity={0.8}
          accessibilityLabel={t?.('calls.tapToEnd') || 'Encerrar chamada'}
          accessibilityRole="button"
        >
          <IconPhoneOff size={32} color="#fff" />
        </TouchableOpacity>
        <Text style={activeCallStyles.hangupLabel}>
          {t?.('calls.tapToEnd') || 'Encerrar'}
        </Text>

        <View style={{ height: Platform.OS === 'web' ? 24 : 40 }} />

        {/* DTMF keypad overlay */}
        <DTMFKeypad
          visible={showKeypad}
          onClose={() => setShowKeypad(false)}
          onDigit={(digit) => { if (onSendDTMF) onSendDTMF(digit); }}
          isDark={true}
          t={t}
        />
      </View>
    </Modal>
  );
}

// ActiveCallScreen styles
const activeCallStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
    alignItems: 'center',
    paddingTop: Platform.OS === 'web' ? 60 : 80,
  },
  // Gradient layers (approximated with solid + opacity views)
  gradientTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: '50%',
    backgroundColor: '#161618',
    opacity: 0.8,
  },
  gradientBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: '55%',
    backgroundColor: '#0b0b0b', // [2026-10-08 dark-black] was navy #0d1b2a
    opacity: 0.9,
  },
  qualityContainer: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 16 : 56,
    right: 20,
    zIndex: 10,
  },
  avatarSection: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  pulseRing: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: 'rgba(17, 17, 17,0.5)',
  },
  avatarOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(17, 17, 17,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(17, 17, 17,0.3)',
  },
  avatarInner: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 40,
    fontWeight: '600',
  },
  contactName: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '600',
    marginTop: 20,
    paddingHorizontal: 24,
    textAlign: 'center',
    zIndex: 1,
  },
  contactNumber: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 16,
    marginTop: 4,
    zIndex: 1,
  },
  stateLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 15,
    marginTop: 8,
    fontWeight: '500',
    letterSpacing: 0.2,
    zIndex: 1,
  },
  durationTimer: {
    color: '#fff',
    fontSize: 46,
    fontWeight: '200',
    marginTop: 8,
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
    zIndex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 32,
    marginBottom: 40,
    zIndex: 1,
  },
  actionBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  // Active state reads as "on" — brand-tinted fill (white icons stay legible).
  actionBtnActive: {
    backgroundColor: 'rgba(17, 17, 17,0.55)',
    borderColor: 'rgba(17, 17, 17,0.6)',
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
    textAlign: 'center',
    position: 'absolute',
    bottom: -20,
    width: 80,
  },
  hangupBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: RED,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    zIndex: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 20px rgba(255,59,48,0.5)',
    } : Platform.OS === 'ios' ? {
      shadowColor: RED,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 16,
    } : { elevation: 8 }),
  },
  hangupLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    marginTop: 10,
    fontWeight: '400',
    zIndex: 1,
  },
});

// ============================================================
// (Twilio WebRTC call manager REMOVED — Twilio/Telnyx accounts cancelled.
//  PSTN dialing now routes through LiveKit + Vonage via startPstnCall;
//  the old `@twilio/voice-sdk` dependency and its WebView fallback are gone.)
// ============================================================

// ============================================================
// DIALER MODAL - iPhone Phone app style (pixel-perfect)
// ============================================================
// T9 mapping: number → letters
const T9_MAP = { '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl', '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz' };

function t9Match(digits, name) {
  if (!digits || !name) return false;
  const lower = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Check if digits match the START of any word in the name
  const words = lower.split(/\s+/);
  for (const word of words) {
    let match = true;
    for (let i = 0; i < digits.length && i < word.length; i++) {
      const letters = T9_MAP[digits[i]];
      if (!letters || !letters.includes(word[i])) { match = false; break; }
    }
    if (match && digits.length <= word.length) return true;
  }
  // Also check if digits match consecutive first letters (e.g., 27 → Ana Paula)
  const initials = words.map(w => w[0]).join('');
  let initialsMatch = true;
  for (let i = 0; i < digits.length && i < initials.length; i++) {
    const letters = T9_MAP[digits[i]];
    if (!letters || !letters.includes(initials[i])) { initialsMatch = false; break; }
  }
  return initialsMatch && digits.length <= initials.length;
}

// Renders an i18n string where **segments** are bold (keeps translations in
// one key instead of splitting sentences around inline <Text> runs).
function boldify(str, boldStyle) {
  return String(str || '').split('**').map((part, i) => (i % 2 ? <Text key={i} style={boldStyle}>{part}</Text> : part));
}

export function CallerIdVerifyContent({ onClose, onVerified, isDark, t }) {
  const [step, setStep] = useState('intro'); // intro | pin | done
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  // Telnyx Verified Numbers API delivers the code by SMS (default) or voice
  // call; user types the 6-digit code back into the app. Differs from the
  // legacy Twilio OutgoingCallerIds flow where Twilio called the user with
  // a PIN to type on the phone keypad.
  const [method, setMethod] = useState('sms');

  useEffect(() => {
    setStep('intro');
    setPin('');
    setError('');
    // Pre-load phone from profile
    getProfile?.().then(r => {
      if (r?.success) {
        if (r.data?.telnyx_caller_id_verified) setStep('done');
        setPhone(r.data?.verified_phone || r.data?.phone || '');
      }
    }).catch(() => {});
  }, []);

  const bg = isDark ? '#1c1c1e' : '#fff';
  const txt = isDark ? '#fff' : '#000';
  const sub = isDark ? '#8e8e93' : '#636366';
  // [2026-10-08 polish-leftovers] brand ink follows the theme: dark primary is
  // white (#F5F5F7) with black content on it; the old '#111111' fills/labels
  // were dark-on-dark here (PIN input text, "POR QUE ISSO?", step dots, CTAs).
  const { colors: tc } = useTheme();
  const ink = tc.primary;
  const onInk = tc.onPrimary || '#fff';

  // Request step: asks Telnyx to send the user a 6-digit code (SMS by default,
  // voice call if method='call'). User then types the code back into the app
  // and we POST to /v2/verified_numbers/{phone}/actions/verify.
  const handleStartVerify = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await voipVerifiedNumberRequest(undefined, method);
      if (r?.success) {
        if (r.data?.already_verified) {
          setStep('done');
          onVerified?.();
        } else {
          // Reset any stale code from a previous attempt
          setPin('');
          setStep('pin');
        }
      } else {
        setError(r?.message || t?.('callerIdVerify.startError') || 'Erro ao iniciar verificação');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  // User types the 6-digit code Telnyx sent and we POST it to confirm.
  const handleSubmitPin = async () => {
    if (!/^\d{6}$/.test(pin)) {
      setError(t?.('callerIdVerify.enterSixDigits') || 'Digite os 6 dígitos do código.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await voipVerifiedNumberConfirm(pin);
      if (r?.success) {
        setStep('done');
        onVerified?.();
      } else {
        setError(r?.message || t?.('callerIdVerify.wrongCode') || 'Código incorreto ou expirado');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ backgroundColor: bg, borderRadius: 22, padding: 0, overflow: 'hidden', maxWidth: 420, alignSelf: 'center', width: '100%' }}>

          {/* Hero header */}
          <View style={{
            paddingHorizontal: 24, paddingTop: 28, paddingBottom: 22,
            backgroundColor: step === 'done' ? '#16a34a' : ink,
            alignItems: 'center',
          }}>
            <View style={{
              width: 76, height: 76, borderRadius: 38,
              backgroundColor: step === 'done' || !isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)',
              borderWidth: 2, borderColor: step === 'done' || !isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.25)',
              alignItems: 'center', justifyContent: 'center', marginBottom: 14,
            }}>
              {step === 'done' ? (
                <IconCheck size={38} color="#fff" />
              ) : step === 'pin' ? (
                <IconSmartphone size={38} color={onInk} />
              ) : (
                <IconPhone size={38} color={onInk} />
              )}
            </View>
            <Text style={{ fontSize: 20, fontWeight: '800', color: step === 'done' ? '#fff' : onInk, textAlign: 'center', letterSpacing: -0.3 }}>
              {step === 'done' ? (t?.('callerIdVerify.doneTitle') || 'Número verificado!') : step === 'pin' ? (t?.('callerIdVerify.pinTitle') || 'Confirme o código') : (t?.('callerIdVerify.introTitle') || 'Verificar seu número')}
            </Text>
            {step !== 'done' && (
              <Text style={{ fontSize: 13, color: onInk, opacity: 0.88, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                {step === 'pin' ? (t?.('callerIdVerify.pinSubtitle') || 'Digite o código de 6 dígitos que você recebeu') : (t?.('callerIdVerify.introSubtitle') || 'Mostre seu número de verdade nas ligações')}
              </Text>
            )}
          </View>

          <View style={{ padding: 22 }}>

          {step === 'done' ? (
            <>
              <Text style={{ fontSize: 15, color: txt, lineHeight: 22, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {phone}
              </Text>
              <Text style={{ fontSize: 13, color: sub, lineHeight: 19, textAlign: 'center', marginBottom: 22 }}>
                {t?.('callerIdVerify.doneBody') || 'Pronto! Quando você ligar pelo Chatyy, esse número vai aparecer para quem receber a chamada — não mais um número desconhecido.'}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={{ height: 50, borderRadius: 12, backgroundColor: '#16a34a', alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{t?.('callerIdVerify.gotIt') || 'Entendi'}</Text>
              </TouchableOpacity>
            </>
          ) : step === 'intro' ? (
            <>
              {/* Why card */}
              <View style={{
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                borderRadius: 12, padding: 14, marginBottom: 14,
                borderLeftWidth: 3, borderLeftColor: ink,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: ink, marginBottom: 4, letterSpacing: 0.4 }}>
                  {t?.('callerIdVerify.whyTitle') || 'POR QUE ISSO?'}
                </Text>
                <Text style={{ fontSize: 13, color: txt, lineHeight: 19 }}>
                  {boldify(t?.('callerIdVerify.whyBody') || 'Por exigência regulatória (ANATEL/FCC), as operadoras só permitem mostrar seu número real nas ligações se você confirmar que ele é seu. **Só uma vez na vida**.', { fontWeight: '700' })}
                </Text>
              </View>

              {/* How it works */}
              <View style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: ink, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: onInk, fontSize: 12, fontWeight: '800' }}>1</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    {boldify(method === 'call'
                      ? (t?.('callerIdVerify.step1Call') || 'Você vai receber **uma ligação** com um código de 6 dígitos.')
                      : (t?.('callerIdVerify.step1Sms') || 'Você vai receber **um SMS** com um código de 6 dígitos.'), { fontWeight: '700' })}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: ink, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: onInk, fontSize: 12, fontWeight: '800' }}>2</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    {t?.('callerIdVerify.step2') || 'Digite o código aqui no app para confirmar que esse número é seu.'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: ink, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: onInk, fontSize: 12, fontWeight: '800' }}>3</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    {boldify(t?.('callerIdVerify.step3') || 'Pronto — **verificado para sempre**. Suas ligações vão mostrar seu número real.', { fontWeight: '700' })}
                  </Text>
                </View>
              </View>

              {/* Method toggle: SMS (default) vs voice call */}
              <View style={{ flexDirection: 'row', backgroundColor: _tc(isDark).surfaceVariant, borderRadius: 10, padding: 3, marginBottom: 14 }}>
                <TouchableOpacity
                  onPress={() => setMethod('sms')}
                  style={{ flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: method === 'sms' ? (isDark ? '#3a3a3c' : '#fff') : 'transparent' }}
                >
                  <Text style={{ fontSize: 13, fontWeight: method === 'sms' ? '700' : '500', color: method === 'sms' ? txt : sub }}>SMS</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setMethod('call')}
                  style={{ flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: method === 'call' ? (isDark ? '#3a3a3c' : '#fff') : 'transparent' }}
                >
                  <Text style={{ fontSize: 13, fontWeight: method === 'call' ? '700' : '500', color: method === 'call' ? txt : sub }}>{t?.('callerIdVerify.methodCall') || 'Ligação'}</Text>
                </TouchableOpacity>
              </View>

              {phone ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: _tc(isDark).surfaceVariant, borderRadius: 10,
                  paddingVertical: 11, paddingHorizontal: 14, marginBottom: 14, gap: 8,
                }}>
                  <IconSmartphone size={18} color={txt} />
                  <Text style={{ fontSize: 14, color: txt, fontWeight: '700' }}>{phone}</Text>
                </View>
              ) : null}

              {!!error && <Text style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{error}</Text>}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  onPress={onClose}
                  style={{ flex: 1, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: _tc(isDark).surfaceVariant }}
                >
                  <Text style={{ color: txt, fontWeight: '600' }}>{t?.('common.notNow') || 'Agora não'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={loading}
                  onPress={handleStartVerify}
                  style={{ flex: 1.4, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: ink, opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? <ActivityIndicator color={onInk} /> : <Text style={{ color: onInk, fontWeight: '700', fontSize: 15 }}>{t?.('parental.startVerification') || 'Iniciar verificação'}</Text>}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 6, marginBottom: 16 }}>
                <IconSmartphone size={14} color={sub} style={{ marginTop: 2 }} />
                <Text style={{ fontSize: 13, color: sub, lineHeight: 19, textAlign: 'center', flexShrink: 1 }}>
                  {method === 'call'
                    ? boldify(t?.('callerIdVerify.pinHintCall') || 'Atenda a ligação e **digite o código de 6 dígitos** aqui no app:', { fontWeight: '700', color: txt })
                    : boldify(t?.('callerIdVerify.pinHintSms') || 'Enviamos um **SMS com código de 6 dígitos**. Digite abaixo:', { fontWeight: '700', color: txt })}
                </Text>
              </View>

              {/* 6-digit code input — the user types what Telnyx sent them */}
              <TextInput
                value={pin}
                onChangeText={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                placeholder="000000"
                placeholderTextColor={sub}
                style={{
                  backgroundColor: _tc(isDark).surfaceVariant,
                  borderRadius: 16, paddingVertical: 22, paddingHorizontal: 20,
                  textAlign: 'center', marginBottom: 16,
                  borderWidth: 2, borderColor: ink,
                  fontSize: 36, fontWeight: '900', color: ink,
                  letterSpacing: 8, fontVariant: ['tabular-nums'], height: 93, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */,
                }}
              />

              {!!error && <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 4, marginBottom: 8, textAlign: 'center' }}>{error}</Text>}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <TouchableOpacity
                  onPress={() => { setStep('intro'); setPin(''); setError(''); }}
                  style={{ flex: 1, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: _tc(isDark).surfaceVariant }}
                >
                  <Text style={{ color: txt, fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={loading || pin.length !== 6}
                  onPress={handleSubmitPin}
                  style={{ flex: 1.4, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: ink, opacity: (loading || pin.length !== 6) ? 0.4 : 1 }}
                >
                  {loading ? <ActivityIndicator color={onInk} /> : <Text style={{ color: onInk, fontWeight: '700', fontSize: 15 }}>{t?.('common.confirm') || 'Confirmar'}</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
          </View>
    </View>
  );
}

function DialerModal({ visible, onClose, isDark, t, minutesInfo, onCallPlaced, callerIdVerified: cidVerifiedProp, onVerified, prefill, autoDial, onAutoDialConsumed }) {
  const { startCall: ctxStartCall, endCall: ctxEndCall } = useCall();
  const { width: winWidth, height: winHeight } = require('react-native').useWindowDimensions();
  // Responsive key size: shrink keypad on narrow viewports
  const safeWidth = Math.min(winWidth - 32, 380);
  const computedKeySize = Math.max(56, Math.min(77, Math.floor((safeWidth - 48) / 3)));
  const dialerScale = computedKeySize / 77;
  // Embedded caller ID verify overlay (rendered inside this Modal so iOS doesn't refuse to show it)
  const [verifyOverlayVisible, setVerifyOverlayVisible] = useState(false);
  const [callerIdVerified, setCallerIdVerifiedLocal] = useState(!!cidVerifiedProp);
  useEffect(() => { setCallerIdVerifiedLocal(!!cidVerifiedProp); }, [cidVerifiedProp]);
  const onVerifyCallerId = () => setVerifyOverlayVisible(true);
  const [number, setNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [allContacts, setAllContacts] = useState([]);
  const [phoneContactsList, setPhoneContactsList] = useState([]);
  const [t9Suggestions, setT9Suggestions] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [activeCall, setActiveCall] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const searchTimerRef = useRef(null);
  const durationRef = useRef(null);
  const durationCountRef = useRef(0);
  const nativeWebViewRef = useRef(null);

  // Allow calls if plan check hasn't loaded yet (assume allowed, server will reject if not)
  const isPaid = minutesInfo === null ? true : (minutesInfo?.minutes_limit || 0) > 0;

  // Load all contacts (server + phone) once
  useEffect(() => {
    if (visible && allContacts.length === 0) {
      // Server contacts
      searchContacts('').then(r => {
        if (r?.success && Array.isArray(r.data)) setAllContacts(r.data);
      }).catch(() => {});
      // Phone contacts
      loadPhoneContacts().then(pc => {
        if (pc && pc.length > 0) setPhoneContactsList(pc);
      }).catch(() => {});
      // Also warm the lightweight phone→name suffix index so the active-call
      // screen can swap the raw number for "Mãe" / "João" instantly when the
      // call goes through. Network-free, runs in parallel with the heavier
      // loads above.
      ensureContactIndex().catch(() => {});
      // Favorites from call history
      callHistoryList().then(r => {
        if (r?.success && Array.isArray(r.data?.calls)) {
          loadPhoneContacts().then(pc => {
            setFavorites(getMostCalled(r.data.calls, pc));
          });
        }
      }).catch(() => {});
    }
  }, [visible]);

  // Reset mute/speaker when call ends
  useEffect(() => {
    if (!activeCall) {
      setIsMuted(false);
      setIsSpeaker(false);
    }
  }, [activeCall]);

  // T9 predictive search + number search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!number || number.length < 2) {
      setContacts([]);
      setT9Suggestions([]);
      return;
    }

    // T9 + digit search: matches against BOTH server contacts (allContacts)
    // AND iPhone contacts (phoneContactsList). Why: user reported that
    // typing a phone number on the dialer should surface their iOS Contacts
    // match — not just the Chatyy-registered ones. Now both feed t9Suggestions
    // and we dedupe by normalized phone (digits only) so a contact present
    // in both stores doesn't show up twice.
    const digits = number.replace(/[^0-9]/g, '');
    if (digits.length >= 2) {
      const norm = (s) => (s || '').replace(/[^0-9]/g, '');
      const matchesServer = !number.startsWith('+') ? allContacts.filter(c =>
        t9Match(digits, c.name || c.display_name || '') ||
        (c.phone && norm(c.phone).includes(digits)) ||
        (c.email && c.email.includes(digits))
      ) : [];
      // Phone contacts: match by name (T9) OR by any of the phones in c.phones[].
      const matchesPhone = phoneContactsList.filter(c => {
        if (t9Match(digits, c.name || '')) return true;
        if (Array.isArray(c.phones)) {
          for (const p of c.phones) {
            if (norm(p?.number).includes(digits)) return true;
          }
        } else if (c.phone && norm(c.phone).includes(digits)) {
          return true;
        }
        return false;
      });
      // Dedupe by normalized primary phone (server contacts win — they're
      // already on Chatyy so calling is "free"; phone-only contacts go to
      // SIP/PSTN).
      const seen = new Set();
      const merged = [];
      for (const c of matchesServer) {
        const key = norm(c.phone) || (c.email || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...c, _src: 'server' });
      }
      for (const c of matchesPhone) {
        const key = norm(c.phone);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...c, _src: 'phone' });
      }
      setT9Suggestions(merged.slice(0, 8));
    } else {
      setT9Suggestions([]);
    }
  }, [number, allContacts, phoneContactsList]);

  // Exact-match contact: when the digits the user typed match (full digit
  // suffix, ≥7 digits) any phone in iPhone contacts or Chatyy contacts,
  // we treat it as "this number IS that contact" and swap the giant
  // dialer number for the contact name. iOS-Phone-app behavior.
  const dialerMatch = useMemo(() => {
    const digits = (number || '').replace(/[^0-9]/g, '');
    if (digits.length < 7) return null;
    const norm = (s) => (s || '').replace(/[^0-9]/g, '');
    // Match by full-suffix on any candidate phone (handles +55 vs 55 vs 11…).
    const isFullMatch = (cand) => {
      const cd = norm(cand);
      if (cd.length < 7) return false;
      // Either side may include a country code; compare last min(len) digits.
      const tail = Math.min(digits.length, cd.length);
      return digits.slice(-tail) === cd.slice(-tail);
    };
    for (const c of t9Suggestions) {
      if (Array.isArray(c.phones)) {
        for (const p of c.phones) if (isFullMatch(p?.number)) return c;
      }
      if (c.phone && isFullMatch(c.phone)) return c;
    }
    return null;
  }, [number, t9Suggestions]);

  useEffect(() => {
    if (number.length >= 3) {
      searchTimerRef.current = setTimeout(() => {
        searchContacts(number).then(r => {
          if (r?.success && Array.isArray(r.data)) setContacts(r.data.slice(0, 3));
          else setContacts([]);
        }).catch(() => setContacts([]));
      }, 300);
    }
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [number, allContacts]);

  const appendDigit = useCallback((digit) => {
    playDTMFNative(digit);
    setNumber(prev => prev + digit);
    setCallResult(null);
  }, []);

  const deleteDigit = useCallback(() => {
    setNumber(prev => prev.slice(0, -1));
  }, []);

  // Toggle: internet (SIP) or callback (Telnyx calls your phone)
  const [callMode, setCallMode] = useState('internet'); // 'internet' | 'callback'

  const handleCallStateChange = useCallback((state) => {
    if (state === 'tick') {
      // Duration tick from native WebView
      durationCountRef.current += 1;
      setActiveCall(prev => prev ? { ...prev, duration: durationCountRef.current } : null);
      return;
    }
    if (state.startsWith('error:')) {
      console.warn('[Call] Error:', state);
      state = 'ended';
    }
    setActiveCall(prev => prev ? { ...prev, state } : null);
    if (state === 'connected') {
      durationCountRef.current = 0;
      if (Platform.OS === 'web') {
        durationRef.current = setInterval(() => {
          durationCountRef.current += 1;
          setActiveCall(prev => prev ? { ...prev, duration: durationCountRef.current } : null);
        }, 1000);
      }
      // Native: ticks come from WebView onMessage
    }
    if (state === 'ended') {
      if (durationRef.current) clearInterval(durationRef.current);
      setTimeout(() => {
        setActiveCall(null);
        durationCountRef.current = 0;
      }, 2000);
    }
  }, []);

  const handleHangup = useCallback(() => {
    // Para o ringback imediatamente ao encerrar (mesmo durante a discagem).
    try { require('../services/ringtone').stopRingtone(); } catch {}
    // Always try SIP hangup first (works for both web and native via the unified sipCall service)
    try { hangupSipCall(); } catch {}
    try { hangupPstnCall(); } catch {}
    if (nativeWebViewRef.current?.current) {
      try { nativeWebViewRef.current.current.injectJavaScript('hangup(); true;'); } catch {}
    }
    handleCallStateChange('ended');
    // Force-close the active call UI immediately even if signaling fails
    setActiveCall(null);
    setCallResult(null);
    try { ctxEndCall(); } catch {}
    try { const { setOngoingCall } = require('./OngoingCallBar'); setOngoingCall(null); } catch {}
    // ⭐ Native audio session teardown — same cleanup as /call's handleEndCall.
    // Without this, proximity stays on, audio session stays in voiceChat
    // mode, and other apps (Spotify) don't get their session back. This
    // was the "desliga mas continua em chamada" feeling.
    try {
      const ExpoAudioSession = require('../modules/expo-audio-session').default;
      ExpoAudioSession?.enableProximitySensor?.(false);
      ExpoAudioSession?.deactivate?.().catch?.(() => {});
    } catch {}
  }, [handleCallStateChange, ctxEndCall]);

  // Mute toggle handler
  const handleToggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    // Unified mute: try sipCall (covers Telnyx Verto path used on native).
    try {
      const { muteSipCall } = require('../services/sipCall');
      muteSipCall?.(newMuted);
    } catch {}
    if (nativeWebViewRef.current?.current) {
      nativeWebViewRef.current.current.injectJavaScript(`conn.mute(${newMuted}); true;`);
    }
  }, [isMuted]);

  // Speaker toggle handler — uses native AVAudioSession on iOS for proper
  // speaker/earpiece routing. Matches /call and Chatyy P2P behavior.
  const handleToggleSpeaker = useCallback(() => {
    const newSpeaker = !isSpeaker;
    setIsSpeaker(newSpeaker);
    try {
      const ExpoAudioSession = require('../modules/expo-audio-session').default;
      ExpoAudioSession?.setSpeaker?.(newSpeaker);
      // While on speaker, proximity sensor doesn't make sense (screen
      // should stay on so user can see). Disable it on speaker on, re-enable
      // on speaker off.
      ExpoAudioSession?.enableProximitySensor?.(!newSpeaker);
    } catch {}
    if (Platform.OS === 'web' && nativeWebViewRef.current?.current) {
      // Web: no direct audio output API via Twilio SDK — visual toggle only.
      nativeWebViewRef.current.current.injectJavaScript(
        `try { Twilio.Device.audio.speakerMode(${newSpeaker}); } catch(e) {} true;`
      );
    }
  }, [isSpeaker]);

  // DTMF send handler
  const handleSendDTMF = useCallback((digit) => {
    if (nativeWebViewRef.current?.current) {
      nativeWebViewRef.current.current.injectJavaScript(`conn.sendDigits('${digit}'); true;`);
    }
  }, []);

  const handleCall = useCallback(async () => {
    if (!number.trim() || calling || !isPaid) return;
    if (number.trim().length < 4) return;
    setCalling(true);
    setCallResult(null);

    let phoneNum = number.trim();
    if (!phoneNum.startsWith('+')) phoneNum = '+55' + phoneNum;

    // Look up the saved contact name from the device address book so the
    // call screen + green ongoing-bar show "João" instead of "+5511…".
    // Falls back to a dialerMatch hit (already resolved by the T9 logic),
    // then null → screen falls back to the raw number. Cheap (Map lookup).
    const resolvedName = (dialerMatch?.name || dialerMatch?.display_name)
      || lookupDeviceContactName(phoneNum)
      || lookupDeviceContactName(number)
      || '';

    try {
      if (callMode === 'internet') {
        // PSTN dialer via LiveKit + Vonage (substitui Telnyx, conta suspensa).
        // Backend (pstn_dial) cria sala LK + manda a Vonage LIGAR pro número e
        // conectar o áudio no livekit-sip; o app entra na MESMA sala (2-vias).
        setActiveCall({ number: phoneNum, contactName: resolvedName, state: 'connecting', duration: 0 });
        setCallResult({ success: true, message: t?.('calls.connecting') || 'Connecting...' });
        // Show green bar globally via CallContext
        ctxStartCall({ contactName: resolvedName || phoneNum, contactEmail: phoneNum, isVideo: false, isCaller: true, callType: 'pstn' });

        // Ringback "tuuum...tuuum" enquanto o número toca. O app entra na sala
        // LiveKit em SILÊNCIO (o áudio da pessoa só entra quando ela atende via
        // ponte SIP), então sem esse tom local o usuário não ouve nada durante a
        // discagem. Parado em 'connected'/'ended'/'error' abaixo.
        try { require('../services/ringtone').startCallingTone(); } catch {}

        // Proximity sensor → tela apaga no ouvido. NÃO chamamos
        // ExpoAudioSession.activateForCall: o LiveKit (pstnCall.js) é dono do
        // AVAudioSession agora — disputar a sessão causaria o mudo.
        try {
          const ExpoAudioSession = require('../modules/expo-audio-session').default;
          ExpoAudioSession?.enableProximitySensor?.(true);
        } catch {}
        const _proximityOff = () => {
          try {
            const ExpoAudioSession = require('../modules/expo-audio-session').default;
            ExpoAudioSession?.enableProximitySensor?.(false);
          } catch {}
        };

        // Track call timing so we can persist duration to history on end.
        const _callStartTs = Date.now();
        let _callConnectedAt = 0;
        let _callDuration = 0;
        const _persistCallHistory = () => {
          try {
            // Backend requires non-empty callId — stable one tied to start ts +
            // phone so retries dedup via ON CONFLICT DO NOTHING.
            const _callId = `pstn_${_callStartTs}_${phoneNum.replace(/[^0-9]/g,'')}`;
            callHistoryAdd({
              contactEmail: phoneNum,                 // phone number as identifier
              contactName: resolvedName || phoneNum,  // device-book name when known
              callId: _callId,
              type: 'outgoing',
              video: 0,
              timestamp: _callStartTs,
              duration: _callDuration,
              isGroup: 0,
              participants: [],
            }).catch(() => {});
          } catch {}
        };
        await startPstnCall(phoneNum, resolvedName, (state) => {
          if (state === 'ringing') {
            setActiveCall(prev => prev ? { ...prev, state: 'ringing' } : null);
            setCallResult({ success: true, message: t?.('calls.ringing') || 'Ringing...' });
          } else if (state === 'connected') {
            // Atendeu → para o ringback; agora entra o áudio real da pessoa.
            try { require('../services/ringtone').stopRingtone(); } catch {}
            _callConnectedAt = Date.now();
            setActiveCall(prev => prev ? { ...prev, state: 'connected' } : null);
            setCallResult({ success: true, message: t?.('calls.callStarted') || 'Call started!' });
          } else if (state === 'ended') {
            try { require('../services/ringtone').stopRingtone(); } catch {}
            _persistCallHistory();
            setActiveCall(null); setCallResult(null); ctxEndCall();
            _proximityOff();
          } else if (state === 'tick') {
            _callDuration = (_callDuration || 0) + 1;
            setActiveCall(prev => prev ? { ...prev, duration: (prev.duration || 0) + 1 } : null);
          } else if (state?.startsWith?.('error:')) {
            try { require('../services/ringtone').stopRingtone(); } catch {}
            _persistCallHistory();
            setActiveCall(null); ctxEndCall();
            setCallResult({ success: false, message: state.replace('error:', '') });
            _proximityOff();
          }
        });
      } else {
        // Callback mode: Telnyx calls your phone, then bridges to destination
        setActiveCall({ number: phoneNum, contactName: resolvedName, state: 'phone_ringing', duration: 0 });
        const r = await voipCall(phoneNum, '', true);
        if (r?.success) {
          setCallResult({ success: true, message: t?.('calls.answerPhone') || 'Answer your phone to connect the call' });
          setTimeout(() => { setActiveCall(null); setCallResult(null); }, 60000);
        } else {
          let msg = r?.message || (t?.('calls.callFailed') || 'Call failed');
          if (/limite|limit/i.test(msg)) msg = t?.('calls.minutesLimitReached') || 'Minutes limit reached';
          else if (/telefone.*perfil|cadastre/i.test(msg)) msg = t?.('calls.registerPhone') || 'Register your phone in profile';
          setCallResult({ success: false, message: msg });
          setActiveCall(null);
        }
      }
      if (onCallPlaced) onCallPlaced();
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.warn('Call error:', errMsg);
      setCallResult({ success: false, message: `${t?.('common.error') || 'Error'}: ${errMsg}` });
      setActiveCall(null);
    } finally {
      setCalling(false);
    }
  }, [number, calling, isPaid, onCallPlaced, handleCallStateChange]);

  // Ref pra handleCall — usado por handleHistoryPress pra discar direto
  // (precisa de ref pq history press fica acima de handleCall declaration).
  const handleCallRef = useRef(null);
  useEffect(() => { handleCallRef.current = handleCall; }, [handleCall]);

  // Prefill + auto-dial (redial a partir do histórico). ChatCallsTab seta
  // prefill/autoDial via props — setNumber e handleCall vivem AQUI DENTRO do
  // DialerModal, então o pai não consegue chamá-los direto (escopos separados;
  // era a causa do ReferenceError: setNumber is not defined).
  const autoDialFiredRef = useRef(false);
  useEffect(() => {
    if (visible && prefill) setNumber(prefill);
    if (!visible) autoDialFiredRef.current = false;
  }, [visible, prefill]);
  useEffect(() => {
    if (visible && autoDial && !autoDialFiredRef.current && number && number.length >= 4 && !calling) {
      autoDialFiredRef.current = true;
      const id = setTimeout(() => { try { handleCallRef.current?.(); } catch {} try { onAutoDialConsumed?.(); } catch {} }, 350);
      return () => clearTimeout(id);
    }
  }, [visible, autoDial, number, calling]);

  const country = detectCountry(number);
  const canCall = isPaid && number.trim().length >= 4 && !calling;

  const bgColor = isDark ? '#000000' : '#ffffff';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#8e8e93';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={[s.dialerContainer, { backgroundColor: bgColor }]}>
        {/* Minimized ongoing call banner — shows when ActiveCallScreen is hidden */}
        {activeCall?.minimized && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => setActiveCall(prev => prev ? { ...prev, minimized: false } : prev)}
            style={{
              // [2026-10-16 polish-calls] P&B igual à pílula global (CallStatusBar); era verde
              backgroundColor: isDark ? '#F2F2F2' : '#111111',
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              marginHorizontal: 8, marginTop: 4, borderRadius: 22, minHeight: 44,
              paddingHorizontal: 16, paddingVertical: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: _tc(isDark).surface }} />
              <Text style={{ color: isDark ? '#111111' : '#fff', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                {activeCall?.contactName || activeCall?.number || t?.('call.inProgress') || 'Em ligação'}
              </Text>
              <Text style={{ color: isDark ? 'rgba(17,17,17,0.62)' : 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                {`${Math.floor((activeCall?.duration || 0) / 60).toString().padStart(2, '0')}:${((activeCall?.duration || 0) % 60).toString().padStart(2, '0')}`}
              </Text>
            </View>
            <Text style={{ color: isDark ? '#111111' : '#fff', fontSize: 12, fontWeight: '700' }}>{t?.('call.tapToReturn') || 'Toque para voltar'}</Text>
          </TouchableOpacity>
        )}
        {/* Close button - top left, iOS style */}
        <View style={s.dialerHeader}>
          <TouchableOpacity
            onPress={() => {
              // If a call is active, hang it up before closing the dialer so the
              // WebView teardown doesn't drop a still-running call mid-state.
              if (activeCall) { try { handleHangup(); } catch {} }
              onClose();
            }}
            hitSlop={6 /* [2026-10-18 polish2] 36+12 = alvo ≥44 */}
            style={[s.dialerCloseBtn, {
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              alignItems: 'center', justifyContent: 'center',
              paddingVertical: 0,
            }]}
            accessibilityLabel={t?.('common.close') || 'Fechar'}
          >
            <IconX size={18} color={isDark ? '#fff' : '#1c1c1e'} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            onPress={() => onVerifyCallerId?.()}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
              backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)', // [2026-10-16 polish-calls] P&B (era azul/verde)
            }}
          >
            {callerIdVerified ? <IconVerifiedBadge size={13} color={blueInk(isDark)} /> : null}
            <Text style={{ fontSize: 13, fontWeight: '700', color: blueInk(isDark) }}>
              {callerIdVerified ? (t?.('profile.verified') || 'Verificado') : (t?.('callerIdVerify.verifyShort') || 'Verificar nº')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={s.dialerBody}>
          {/* Number display area - large, centered, iPhone style.
              When the typed digits match an iPhone/Chatyy contact 100% (full
              suffix), swap the big number for the contact name and demote the
              number to the line below. iOS Phone-app behavior. */}
          <View style={s.dialerDisplay}>
            {dialerMatch ? (
              <>
                <View style={s.dialerNumberContainer}>
                  <Text
                    style={[s.dialerNumber, {
                      color: textColor,
                      fontSize: 32,
                    }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {dialerMatch.name || dialerMatch.display_name}
                  </Text>
                </View>
                <Text style={[s.dialerCountry, { color: subColor }]}>
                  {formatPhoneDisplay(number)}
                </Text>
              </>
            ) : (
              <>
                <View style={s.dialerNumberContainer}>
                  <Text
                    style={[s.dialerNumber, {
                      color: number ? textColor : (isDark ? '#636366' : '#c7c7cc'),
                      fontSize: number.length > 18 ? 22 : number.length > 14 ? 26 : number.length > 10 ? 30 : 36,
                    }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {number ? formatPhoneDisplay(number) : (t?.('calls.addNumber') || 'Adicionar número')}
                  </Text>
                </View>
                {country && number.length > 0 && (
                  <Text style={[s.dialerCountry, { color: subColor }]}>{country.name}</Text>
                )}
              </>
            )}
          </View>

          {/* T9 suggestions + Contact matches */}
          {(t9Suggestions.length > 0 || contacts.length > 0) && (
            <View style={[s.dialerContacts, { backgroundColor: _tc(isDark).surfaceVariant }]}>
              {/* T9 suggestions (local, instant) — combines server + iPhone contacts.
                  The badge differentiates: green "Chatyy" = registered user
                  (in-app call, free), gray "iPhone" = phone contact (SIP/PSTN). */}
              {t9Suggestions.map((c, idx) => {
                const fromPhone = c._src === 'phone';
                const badgeText = fromPhone ? (t?.('calls.iphoneContact') || 'iPhone') : 'Chatyy';
                const badgeColor = fromPhone ? (isDark ? '#8e8e93' : '#636366') : '#16a34a';
                return (
                  <TouchableOpacity
                    key={'t9_' + (c.id || c.email || c.phone || idx)}
                    style={s.dialerContactRow}
                    onPress={() => {
                      const phone = c.phone || c.email;
                      if (phone) setNumber(phone);
                    }}
                    activeOpacity={0.6}
                  >
                    <AvatarCircle name={c.name || c.display_name || c.email || c.phone} email={c.email} uri={c.image} size={32} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={[s.dialerContactName, { color: textColor }]} numberOfLines={1}>{c.name || c.display_name || c.email || c.phone}</Text>
                      {c.phone && <Text style={{ fontSize: 12, color: isDark ? '#8e8e93' : '#636366' }} numberOfLines={1}>{c.phone}</Text>}
                    </View>
                    <Text style={{ fontSize: 11, color: badgeColor, fontWeight: '700' }}>{badgeText}</Text>
                  </TouchableOpacity>
                );
              })}
              {/* Server search results — dedupe by phone OR email (t9 may have phone-only entries) */}
              {contacts.filter(c => {
                const norm = (s) => (s || '').replace(/[^0-9]/g, '');
                return !t9Suggestions.find(t =>
                  (t.email && t.email === c.email) ||
                  (t.phone && c.phone && norm(t.phone) === norm(c.phone))
                );
              }).map((c, idx) => (
                <TouchableOpacity
                  key={c.email || idx}
                  style={s.dialerContactRow}
                  onPress={() => { const phone = c.phone || c.email; if (phone) setNumber(phone); }}
                  activeOpacity={0.6}
                >
                  <AvatarCircle name={c.name || c.email} email={c.email} size={32} />
                  <Text style={[s.dialerContactName, { color: textColor }]} numberOfLines={1}>{c.name || c.email}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Call result toast */}
          {callResult && (
            <View style={[s.dialerResult, {
              backgroundColor: callResult.success ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)',
            }]}>
              <Text style={{ color: callResult.success ? GREEN : RED, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
                {callResult.success ? (callResult.message || t?.('voip.callStarted') || 'Ligação iniciada!') : callResult.message}
              </Text>
            </View>
          )}

          {/* Favorites + Contacts when no number typed */}
          {!number && favorites.length > 0 && (
            <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
              <Text style={{ color: subColor, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('calls.frequent') || 'Frequent'}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                {favorites.map((fav, idx) => (
                  <TouchableOpacity
                    key={fav.key + idx}
                    style={{ alignItems: 'center', marginRight: 16, width: 60 }}
                    onPress={() => setNumber(fav.phone.replace(/\D/g, ''))}
                    activeOpacity={0.6}
                  >
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: isDark ? '#2c2c2e' : '#e5e7eb', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                      <Text style={{ fontSize: 18, fontWeight: '600', color: isDark ? '#fff' : '#333' }}>{(fav.name || '?').charAt(0).toUpperCase()}</Text>
                    </View>
                    <Text style={{ fontSize: 10, color: textColor, textAlign: 'center' }} numberOfLines={1}>{fav.name}</Text>
                    <Text style={{ fontSize: 9, color: subColor }}>{fav.count}x</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Phone contacts button */}
          {!number && (
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 6 }}
              onPress={() => setShowContacts(!showContacts)}
              activeOpacity={0.7}
            >
              <IconUserPlus size={16} color={blueInk(isDark)} />
              <Text style={{ color: blueInk(isDark), fontSize: 14, fontWeight: '500' }}>
                {showContacts ? (t?.('calls.hideContacts') || 'Esconder contatos') : (t?.('calls.showContacts') || 'Contatos do celular')}
              </Text>
            </TouchableOpacity>
          )}

          {/* [2026-10-17 p2] agenda negada de vez → explica + "Abrir ajustes" */}
          {!number && showContacts && phoneContactsList.length === 0 && Platform.OS !== 'web' && contactsDeniedForever() && (
            <View style={{ marginHorizontal: 16, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, backgroundColor: _tc(isDark).surfaceVariant, alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 13, color: subColor, textAlign: 'center' }}>
                {t?.('chatConv.contactsPermission') || 'Permita acesso aos contatos nas configurações.'}
              </Text>
              <TouchableOpacity onPress={openContactsSettings} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ color: blueInk(isDark), fontSize: 14, fontWeight: '600' }}>{t?.('common.openSettings') || 'Abrir ajustes'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Phone contacts list */}
          {!number && showContacts && phoneContactsList.length > 0 && (
            <FlatList
              data={phoneContactsList.slice(0, 50)}
              keyExtractor={(item, idx) => item.id || String(idx)}
              style={{ maxHeight: 200, marginHorizontal: 16, borderRadius: 10, backgroundColor: _tc(isDark).surfaceVariant }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? '#2c2c2e' : '#e5e7eb' }}
                  onPress={() => { setNumber(item.phone.replace(/\D/g, '')); setShowContacts(false); }}
                  activeOpacity={0.6}
                >
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: isDark ? '#3a3a3c' : '#d4d7dc', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#333' }}>{(item.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: textColor, fontWeight: '500' }} numberOfLines={1}>{item.name}</Text>
                    <Text style={{ fontSize: 12, color: subColor }}>{item.phone}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity onPress={() => { setNumber(item.phone.replace(/\D/g, '')); setShowContacts(false); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <IconPhone size={18} color={GREEN} />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}

          {/* Keypad - 4x3 grid, iPhone spacing */}
          <View style={[s.dialerKeypad, computedKeySize < 70 && { paddingHorizontal: 8 }]}>
            {[0, 1, 2].map(row => (
              <View key={row} style={[s.dialerKeypadRow, computedKeySize < 70 && { gap: 14, marginBottom: 10 }]}>
                {DIAL_KEYS.slice(row * 3, row * 3 + 3).map((k) => (
                  <DialKey
                    key={k.digit}
                    digit={k.digit}
                    sub={k.sub}
                    isDark={isDark}
                    size={computedKeySize}
                    onPress={() => {
                      if (k.digit === '0' && number === '') appendDigit('+');
                      else appendDigit(k.digit);
                    }}
                    onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
                  />
                ))}
              </View>
            ))}
            {/* Last row: * 0 # */}
            <View style={[s.dialerKeypadRow, computedKeySize < 70 && { gap: 14, marginBottom: 10 }]}>
              {DIAL_KEYS.slice(9, 12).map((k) => (
                <DialKey
                  key={k.digit}
                  digit={k.digit}
                  sub={k.sub}
                  isDark={isDark}
                  size={computedKeySize}
                  onPress={() => {
                    if (k.digit === '0' && number === '') appendDigit('+');
                    else appendDigit(k.digit);
                  }}
                  onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
                />
              ))}
            </View>
          </View>

          {/* Bottom row: [empty] [call button] [backspace] - iPhone layout */}
          <View style={s.dialerBottomRow}>
            {/* Left: Add to contacts (native) */}
            <View style={s.dialerBottomSide}>
              {number.length >= 4 && (
                <TouchableOpacity
                  style={s.dialerAddContact}
                  onPress={async () => {
                    const phoneNum = number.startsWith('+') ? number : '+55' + number;
                    try {
                      if (Platform.OS !== 'web') {
                        const Contacts = require('expo-contacts');
                        const _perm = await Contacts.requestPermissionsAsync();
                        noteContactsPermission(_perm);
                        const status = _perm?.status;
                        // [2026-10-17 p2] negado de vez → "Abrir ajustes" (antes caía no tel: sem explicar)
                        if (status !== 'granted' && contactsDeniedForever()) { alertContactsDenied(t); return; }
                        if (status === 'granted') {
                          await Contacts.presentFormAsync(null, {
                            [Contacts.Fields.PhoneNumbers]: [{ number: phoneNum, label: 'mobile' }],
                          });
                          // Reload phone contacts after adding
                          _phoneContacts = null;
                          loadPhoneContacts().then(pc => setPhoneContactsList(pc || []));
                          return;
                        }
                      }
                      // Fallback: open native contacts app
                      const { Linking } = require('react-native');
                      Linking.openURL(`tel:${phoneNum}`);
                    } catch (e) {
                      console.warn('[AddContact] Error:', e.message);
                    }
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <IconUserPlus size={22} color={isDark ? '#8e8e93' : '#636366'} />
                </TouchableOpacity>
              )}
            </View>

            {/* Center: green call button */}
            <TouchableOpacity
              style={[s.dialerCallBtn, !canCall && { opacity: 0.35 }]}
              onPress={handleCall}
              disabled={!canCall}
              activeOpacity={0.7}
            >
              {calling ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <IconPhone size={33} color="#fff" />
              )}
            </TouchableOpacity>

            {/* Right: backspace button (only visible when number has digits) */}
            <View style={s.dialerBottomSide}>
              {number.length > 0 && (
                <TouchableOpacity
                  style={s.dialerBackspace}
                  onPress={deleteDigit}
                  onLongPress={() => setNumber('')}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel={t?.('calls.backspace') || 'Backspace'}
                  accessibilityRole="button"
                >
                  <IconBackspace size={28} color={isDark ? '#8e8e93' : '#636366'} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Call mode toggle */}
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 8 }}
            onPress={() => setCallMode(prev => prev === 'internet' ? 'callback' : 'internet')}
            activeOpacity={0.7}
          >
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: callMode === 'internet' ? '#16a34a' : '#FF9500' }} />
            <Text style={{ fontSize: 13, color: isDark ? '#8e8e93' : '#636366' }}>
              {callMode === 'internet' ? (t?.('calls.callbackOff') || 'Call via internet (default)') : (t?.('calls.callbackOn') || 'Bad internet? Receive a free callback')}
            </Text>
          </TouchableOpacity>

          {/* Plan badge at very bottom */}
          <PlanBadge minutesInfo={minutesInfo} isDark={isDark} t={t} />
        </View>
      </View>

      {/* Active call overlay */}
      <ActiveCallScreen
        visible={!!activeCall && !activeCall?.minimized}
        number={activeCall?.number || ''}
        contactName={activeCall?.contactName || ''}
        isDark={isDark}
        t={t}
        onHangup={handleHangup}
        callState={activeCall?.state || 'connecting'}
        duration={activeCall?.duration || 0}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        isSpeaker={isSpeaker}
        onToggleSpeaker={handleToggleSpeaker}
        onSendDTMF={handleSendDTMF}
        onMinimize={() => {
          // Hide ActiveCallScreen overlay; keep DialerModal mounted so the
          // NativeTwilioCall WebView (which holds the live call) is not unmounted.
          // The in-dialer "ongoing call" bar (rendered below) lets the user
          // restore the call view.
          setActiveCall(prev => prev ? { ...prev, minimized: true } : prev);
          try {
            const { setOngoingCall } = require('./OngoingCallBar');
            setOngoingCall({
              number: activeCall?.number,
              contactName: activeCall?.contactName,
              duration: activeCall?.duration || 0,
              type: 'sip',
              onResume: () => {
                setActiveCall(prev => prev ? { ...prev, minimized: false } : prev);
              },
            });
          } catch {}
        }}
      />

      {/* Caller ID verify overlay — rendered inside the dialer Modal so iOS allows it */}
      {verifyOverlayVisible && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20, zIndex: 9999,
        }}>
          <CallerIdVerifyContent
            isDark={isDark}
            t={t}
            onClose={() => setVerifyOverlayVisible(false)}
            onVerified={() => {
              setCallerIdVerifiedLocal(true);
              if (typeof onVerified === 'function') onVerified();
            }}
          />
        </View>
      )}
    </Modal>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

// Pre-load cached calls synchronously at module level (native only — web uses async IndexedDB).
// This gives the first render instant data so there's no empty-list flash.
let _preloadedCalls = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_calls');
    if (raw) _preloadedCalls = JSON.parse(raw);
  } catch {}
}

// Fingerprint: id + status + duration + created_at. If unchanged we skip setState
// so FlatList/ScrollView doesn't re-render and flicker.
function _callsFingerprint(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map(c => `${c.id}:${c.status ?? c.type ?? ''}:${c.duration ?? 0}:${c.created_at ?? c.timestamp ?? ''}`).join('|');
}

// ── Synchronous, account-scoped first-paint seed ────────────────────────────
// Local-first (WhatsApp-style): the Calls tab must paint from on-device storage
// BEFORE any network, and must NEVER wait on a BR→NY fetch to show the list.
// Sources, in priority order:
//   1. services/cache `call_history` — PER-ACCOUNT (key hashed by the logged-in
//      email). Privacy-safe (P0: never another account's log) + instant + it
//      persists to disk (MMKV→AsyncStorage, hydrated by the splash gate).
//   2. legacy unscoped `omc_call_history` (getCallHistoryCached) — kept as a
//      fallback for installs that haven't written the scoped key yet; it is
//      wiped on account switch (AuthContext.clearAccountScopedMmkv) so it can't
//      leak across accounts.
//   3. the module-load `chat_calls` snapshot — last resort.
// All three are synchronous, so the very first render already has rows and the
// loading spinner is skipped whenever anything is cached. This runs at mount,
// after the splash cache-ready gate, so the stores are hydrated by now.
function _seedCallHistorySync() {
  try {
    const { getCachedSync } = require('../services/cache');
    const scoped = getCachedSync('call_history');
    if (Array.isArray(scoped) && scoped.length) return scoped;
  } catch {}
  try {
    const c = getCallHistoryCached();
    if (Array.isArray(c) && c.length) return c;
  } catch {}
  return Array.isArray(_preloadedCalls) ? _preloadedCalls : [];
}

function ChatCallsTab({ colors, isDark, t, user, router, largeTitle, onLargeTitleCollapsedChange, tabActive }) {
  // [2026-10-15 nav-motion] Título grande "Ligações" que rola 1:1 com a lista
  // e colapsa no header compacto do /chat (mesmo padrão da aba Conversas).
  // Sem `largeTitle` (web/kids/desktop) o layout é o de antes.
  const _lt = useLargeTitleCollapse(onLargeTitleCollapsedChange, { enabled: !!largeTitle });
  const { language } = useLanguage();
  const [activeTab, setActiveTab] = useState('recent');
  // [2026-10-14 offline-first] minutos salvos (por conta) lidos síncronos → card sem piscar.
  const [minutesInfo, setMinutesInfo] = useState(() => { try { return require('../services/cache').getCachedSync('voip_minutes') || null; } catch { return null; } });
  const [loadingMinutes, setLoadingMinutes] = useState(() => !minutesInfo);
  const [voipHistory, setVoipHistory] = useState([]);
  // Seed the first render from on-device storage via _seedCallHistorySync()
  // (account-scoped call_history → legacy omc_call_history → chat_calls preload,
  // all synchronous). This runs at mount — after the splash cache-ready gate —
  // so the stores are hydrated and the list paints instantly without waiting on
  // the BR→NY network fetch. Not the module-load snapshot `_preloadedCalls`,
  // which can be empty if the module loaded before MMKV hydrated.
  const [chatCalls, setChatCalls] = useState(() => _seedCallHistorySync());
  // Skip the loading spinner if we already painted from cache. Never show a
  // blocking skeleton when there's ANY on-device log — the network refresh
  // below is silent (SWR), so a warm cache = instant, flicker-free open.
  const [loadingHistory, setLoadingHistory] = useState(() => {
    try { const c = _seedCallHistorySync(); if (Array.isArray(c) && c.length) return false; } catch {}
    return true;
  });
  const lastCallsFpRef = useRef(_callsFingerprint(_seedCallHistorySync()));
  const [dialerVisible, setDialerVisible] = useState(false);
  const [dialerPrefill, setDialerPrefill] = useState('');
  const [dialerAutoDial, setDialerAutoDial] = useState(false);
  const [scheduleVisible, setScheduleVisible] = useState(false);
  const [infoItem, setInfoItem] = useState(null);
  const [showCallerIdModal, setShowCallerIdModal] = useState(false);
  const [callerIdVerified, setCallerIdVerified] = useState(false);
  const [phoneContactsList, setPhoneContactsList] = useState([]);

  // Progressive render window. A warm cache holds up to 200 rows, and the list
  // is a plain (non-virtualized) ScrollView — rendering all of them in one
  // synchronous pass was a visible hitch the instant the user tapped the Calls
  // tab ("ainda demora a página ligação"). Paint the first screenful right away
  // (covers the viewport), then expand to the full list once the mount
  // interaction settles — one frame later, imperceptible. Segment-tab switches
  // and later refreshes render in full (the limit only clamps the first paint).
  const [renderLimit, setRenderLimit] = useState(24);
  const expandRenderLimit = useCallback(() => setRenderLimit(Infinity), []);
  // [2026-10-15 native-calls] lista nativa: falha → volta ao ScrollView JS (sessão inteira).
  const [_nativeCallsFailed, _setNativeCallsFailed] = useState(() => !!globalThis.__chatyy_native_calls_failed);
  const _onNativeCallsFailure = useCallback((msg) => {
    try { globalThis.__chatyy_native_calls_failed = true; console.warn('[native-calls] fallback JS:', msg); try { require('../services/crashReporter').reportNativeFallback('native_calls', msg); } catch {} } catch {}
    _setNativeCallsFailed(true);
  }, []);
  const _nativeDescribe = useCallback((item) => _describeCallRow(item, t, language), [t, language]);
  const _nativeSectionOf = useCallback((item) => _callSectionLabel(item, t), [t]);
  const _nativeCallLabels = useMemo(() => ({
    callBack: t?.('calls.callBack') || 'Ligar de volta',
    info: t?.('calls.callInfo') || 'Info',
    delete: t?.('common.delete') || 'Apagar',
    block: t?.('calls.blockCaller') || 'Bloquear contato',
    report: t?.('calls.reportSpam') || 'Denunciar spam',
    addContact: t?.('calls.addToContacts') || 'Adicionar aos contatos',
    copyNumber: t?.('calls.copyNumber') || 'Copiar número',
  }), [t]);
  useEffect(() => {
    let timer = null;
    let task = null;
    try {
      const { InteractionManager } = require('react-native');
      task = InteractionManager.runAfterInteractions(expandRenderLimit);
    } catch {
      timer = setTimeout(expandRenderLimit, 120);
    }
    return () => {
      try { task?.cancel?.(); } catch {}
      if (timer) clearTimeout(timer);
    };
  }, [expandRenderLimit]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await import('../services/api').then(m => m.getProfile?.());
        if (alive && r?.success && r.data?.telnyx_caller_id_verified) setCallerIdVerified(true);
      } catch {}
      try {
        const pc = await loadPhoneContacts();
        if (alive && Array.isArray(pc)) setPhoneContactsList(pc);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Load data on mount.
  // Strategy: if MMKV preload already painted the list, skip the async cache read
  // entirely and go straight to a silent background delta sync (no flicker).
  // Otherwise fall back to the async cache and then the network fetch.
  useEffect(() => {
    const _cachedNow = (() => { try { return _seedCallHistorySync(); } catch { return null; } })();
    const alreadyHasVisible = (Array.isArray(_cachedNow) && _cachedNow.length > 0);

    // Minutes info loads independently (doesn't affect history flicker)
    if (!minutesInfo) setLoadingMinutes(true);
    getCached('voip_minutes').then(cached => {
      if (cached) setMinutesInfo(cached);
      // [2026-10-17 sem-pstn] histórico PSTN antigo continua visível (só leitura).
      if (cached && Array.isArray(cached.history) && cached.history.length) setVoipHistory(prev => (prev.length ? prev : cached.history));
      setLoadingMinutes(false);
    }).catch(() => { setLoadingMinutes(false); });

    // FAST PATH: data is already on screen from MMKV preload → silent delta sync only
    if (alreadyHasVisible) {
      setLoadingHistory(false);
    } else {
      setLoadingHistory(true);
      // SLOW PATH: check async cache, then fall through to the network fetch below
      getCached('call_history').then(cached => {
        if (Array.isArray(cached) && cached.length > 0) {
          const fp = _callsFingerprint(cached);
          if (fp !== lastCallsFpRef.current) {
            lastCallsFpRef.current = fp;
            setChatCalls(cached);
          }
        }
        setLoadingHistory(false);
      }).catch(() => { setLoadingHistory(false); });
    }

    // Hard safety: max 2.5s in loading regardless of outcome
    const safety = setTimeout(() => {
      setLoadingHistory(false);
      setLoadingMinutes(false);
    }, 2500);

    // Fetch fresh in background — does NOT toggle loading.
    if (isPstnEnabled()) voipMinutesRemaining().then(r => {
      if (r?.success && r.data) {
        setMinutesInfo(r.data);
        setCache('voip_minutes', r.data, 2592000000).catch(() => {});
        if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
      }
    }).catch(() => {});

    getCallHistory().then(h => {
      if (!Array.isArray(h)) return;
      const fp = _callsFingerprint(h);
      if (fp === lastCallsFpRef.current) return; // unchanged — skip setState (no flicker)
      lastCallsFpRef.current = fp;
      setChatCalls(h);
      setCache('call_history', h, 2592000000).catch(() => {});
      // Persist to MMKV so next cold start paints instantly
      try {
        const { setString } = require('../services/mmkv');
        setString('chat_calls', JSON.stringify(h.slice(0, 200)));
      } catch {}
    }).catch(() => {});

    return () => clearTimeout(safety);
  }, []);

  // Refresh on interval — uses fingerprint dedup so unchanged data doesn't re-render.
  // [2026-10-21 tg3] bateria: só com a aba Ligações VISÍVEL (o /chat mantém a aba
  // montada e escondida) e a tela em foco; ao voltar p/ a aba depois de ≥30 s
  // atualiza na hora. Kill: __chatyy_calls_poll_visible=false (poll de antes).
  const _callsPollGate = (() => { try { return globalThis.__chatyy_calls_poll_visible !== false; } catch { return true; } })();
  const _scrFocused = useIsFocused();
  const _callsVisible = !_callsPollGate || ((tabActive === undefined || !!tabActive) && _scrFocused);
  const _callsLastPollRef = useRef(Date.now());
  useEffect(() => {
    if (!_callsVisible) return undefined;
    // [2026-10-10 perf-battery] paused while backgrounded (utils/activeInterval).
    const _tick = () => {
      _callsLastPollRef.current = Date.now();
      if (isPstnEnabled()) voipMinutesRemaining().then(r => {
        if (r?.success && r.data) {
          setMinutesInfo(r.data);
          if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
        }
      }).catch(() => {});
      getCallHistory().then(h => {
        if (!Array.isArray(h)) return;
        const fp = _callsFingerprint(h);
        if (fp === lastCallsFpRef.current) return; // no change — skip setState (no flicker)
        lastCallsFpRef.current = fp;
        setChatCalls(h);
        setCache('call_history', h, 2592000000).catch(() => {});
        try {
          const { setString } = require('../services/mmkv');
          setString('chat_calls', JSON.stringify(h.slice(0, 200)));
        } catch {}
      }).catch(() => {});
    };
    if (Date.now() - _callsLastPollRef.current >= 30000) _tick();
    const interval = setActiveInterval(_tick, 30000);
    return () => interval();
  }, [_callsVisible]);

  const refreshData = useCallback(() => {
    if (isPstnEnabled()) voipMinutesRemaining().then(r => {
      if (r?.success && r.data) {
        setMinutesInfo(r.data);
        if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
      }
    }).catch(() => {});
    getCallHistory().then(h => {
      if (!Array.isArray(h)) return;
      const fp = _callsFingerprint(h);
      if (fp === lastCallsFpRef.current) return;
      lastCallsFpRef.current = fp;
      setChatCalls(h);
      setCache('call_history', h, 2592000000).catch(() => {});
      try {
        const { setString } = require('../services/mmkv');
        setString('chat_calls', JSON.stringify(h.slice(0, 200)));
      } catch {}
    }).catch(() => {});
  }, []);

  const handleHistoryPress = useCallback(async (item) => {
    if (item.to_number) {
      // [2026-10-10 sem-telnyx-vonage] sem discagem PSTN.
      // [2026-10-17 sem-pstn] Linha de telefone antiga: se o número é de alguém no
      // Chatyy → ligação Chatyy; senão "Convidar para o Chatyy". Nunca rediscar PSTN.
      if (!isPstnEnabled()) {
        try {
          require('../services/chatyyOnlyCalls').callPhoneViaChatyy({
            phone: item.to_number, name: item.contactName || item.contact_name || '', video: false, router, t,
          });
        } catch {}
        return;
      }
      // 2026-05-09: WhatsApp parity — tap em phone history disca direto
      // (antes só abria o teclado vazio, user tinha que retiar o numero).
      // Preenche o number state + abre o dialer com auto-dial flag.
      const cleanNum = item.to_number.replace(/[^0-9+]/g, '');
      const dialNum = cleanNum.startsWith('+') ? cleanNum.slice(1) : cleanNum;
      // Preenche o dialer + auto-disca via PROPS do DialerModal. setNumber e
      // handleCall vivem DENTRO do DialerModal (escopo separado) — chamá-los
      // daqui dava ReferenceError: setNumber is not defined e travava o app
      // ao tocar num item de histórico (não deixava ligar pela web).
      setDialerPrefill(dialNum);
      setDialerAutoDial(true);
      setDialerVisible(true);
      return;
    }
    if (!router) return;
    const email = item.contactEmail || item.contact_email || '';
    const name = item.contactName || item.contact_name || '';
    if (!email) return;
    // [gap H5 2026-05-20] Missed-call rows pre-fill the chat input with a
    // "Voltei sua ligação" draft so the user can shoot a quick context
    // message before re-dialing. chat-conversation.js reads ?prefill=.
    const isMissed = callDirection(item) === 'missed'; // [2026-10-06 UX2]
    const prefillText = isMissed
      ? (t?.('calls.callBackPrefill') || 'Voltei sua ligação')
      : '';
    const prefillQ = prefillText
      ? `&prefill=${encodeURIComponent(prefillText)}`
      : '';
    // Resolve (or create) the direct conversation FIRST so the chat screen
    // gets a real `id` param. Without this, the screen opened with id=0
    // and the message loader skipped, leaving an infinite skeleton.
    try {
      const { chatCreate } = require('../services/api');
      const r = await chatCreate([email], '', 'direct');
      const convId = r?.data?.conversation_id || r?.data?.id;
      if (r?.success && convId) {
        require('../services/openConversation').openConversation(`/chat-conversation?id=${convId}&name=${encodeURIComponent(r?.data?.name || name)}&type=direct&email=${encodeURIComponent(email)}${prefillQ}`);
        return;
      }
    } catch {}
    // Fallback: open with email only — chat-conversation has its own resolver
    // for direct chats with a known peer.
    require('../services/openConversation').openConversation({
      pathname: '/chat-conversation',
      params: { id: '0', type: 'direct', email, name, ...(prefillText ? { prefill: prefillText } : {}) },
    });
  }, [router, t]);

  // [gap H2 2026-05-20] WhatsApp-parity row actions:
  //   • Right-swipe → delete that one entry (calls chat_call_history_delete).
  //   • Long-press → ActionSheetIOS (iOS) / Alert (Android+web) with:
  //     Block caller, Report spam, Add to contacts, Copy number, Delete.
  const handleDeleteEntry = useCallback(async (item) => {
    if (!item?.id) return;
    // [2026-10-19 callinfo] a lista mescla ids como "chat_<id>" (servidor) / "voip_<id>" (PSTN):
    // mandar "chat_123" pro servidor virava (int) 0 → 400 e a linha voltava no próximo refresh.
    const _rawId = String(item.id);
    const _srvId = /^voip_/.test(_rawId) ? 0 : Number(_rawId.replace(/^chat_/, ''));
    if (_srvId > 0) { try { await callHistoryDelete(_srvId); } catch {} }
    // Optimistic: drop from local state right away. The next refresh
    // catches any server-side disagreement.
    setChatCalls(prev => Array.isArray(prev) ? prev.filter(c => c.id !== item.id && !(_srvId > 0 && Number(c.id) === _srvId)) : prev);
  }, []);
  // [2026-10-19 callinfo] "Apagar do histórico" na folha de info → some da lista + caches.
  const handleInfoDeleted = useCallback((peerKey) => {
    const key = String(peerKey || '').toLowerCase();
    if (!key) return;
    const _match = (c) => {
      const e = String(c?.contactEmail || c?.contact_email || '').trim().toLowerCase();
      if (e && e === key) return true;
      const ph = String(c?.to_number || '').replace(/[^0-9+]/g, '');
      return !!ph && key === 'tel:' + ph;
    };
    setChatCalls(prev => {
      if (!Array.isArray(prev)) return prev;
      const next = prev.filter(c => !_match(c));
      try { _writeCallHistoryCache(next); } catch {}
      return next;
    });
  }, []);

  // [2026-10-15 native-calls] Ações do menu da linha por chave — usadas pelo
  // ActionSheet/Alert (JS) e pelo menu nativo da lista (NativeCallList).
  const runRowMenuAction = useCallback(async (kind, item) => {
    if (!item) return;
    const caller = item.contactEmail || item.contact_email || '';
    const number = item.to_number || '';
    const name = item.contactName || item.contact_name || '';
    if (kind === 'delete') return handleDeleteEntry(item);
    if (kind === 'copyNumber') {
      try {
        const Clipboard = require('expo-clipboard');
        await Clipboard.setStringAsync(number || caller || '');
      } catch {}
      return;
    }
    if (kind === 'block') {
      // Block surfaces via existing voipBlockCaller / addBlockedCaller helper
      // when present; fallback Alert if not wired.
      try {
        const api = require('../services/api');
        // [2026-10-19 callinfo] voipBlockCaller/addBlockedCaller nunca existiram →
        // bloquear não fazia nada. Contato Chatyy (e-mail) = chatBlockUser real.
        if (caller && String(caller).includes('@') && typeof api.chatBlockUser === 'function') {
          await api.chatBlockUser(String(caller));
        } else if (typeof api.voipBlockCaller === 'function') {
          await api.voipBlockCaller(caller || number);
        } else if (typeof api.addBlockedCaller === 'function') {
          await api.addBlockedCaller(caller || number);
        }
      } catch {}
      return;
    }
    if (kind === 'report') {
      try {
        const api = require('../services/api');
        if (typeof api.voipReportSpam === 'function') {
          await api.voipReportSpam(caller || number);
        } else if (typeof api.reportSpamCaller === 'function') {
          await api.reportSpamCaller(caller || number);
        }
      } catch {}
      return;
    }
    if (kind === 'addContact') {
      try {
        const Contacts = require('expo-contacts');
        if (Contacts?.presentFormAsync) {
          await Contacts.presentFormAsync(null, {
            [Contacts.Fields.Name]: name || '',
            [Contacts.Fields.PhoneNumbers]: number ? [{ number, label: 'mobile' }] : [],
            [Contacts.Fields.Emails]: caller ? [{ email: caller, label: 'work' }] : [],
          });
        }
      } catch {}
    }
  }, [handleDeleteEntry]);

  const [rowMenu, setRowMenu] = useState(null);
  const handleRowLongPress = useCallback((item) => {
    if (!item) return;
    const caller = item.contactEmail || item.contact_email || '';
    const number = item.to_number || '';
    const name = item.contactName || item.contact_name || '';
    const optBlock = t?.('calls.blockCaller') || 'Bloquear contato';
    const optReport = t?.('calls.reportSpam') || 'Denunciar spam';
    const optAddContact = t?.('calls.addToContacts') || 'Adicionar aos contatos';
    const optCopyNumber = t?.('calls.copyNumber') || 'Copiar número';
    const optDelete = t?.('common.delete') || 'Apagar';
    const cancel = t?.('common.cancel') || 'Cancelar';

    const handleSelected = (label) => {
      if (label === optDelete) return runRowMenuAction('delete', item);
      if (label === optCopyNumber) return runRowMenuAction('copyNumber', item);
      if (label === optBlock) return runRowMenuAction('block', item);
      if (label === optReport) return runRowMenuAction('report', item);
      if (label === optAddContact) return runRowMenuAction('addContact', item);
    };

    // [2026-10-16 polish-r2] Folha P&B do design system nas 3 plataformas
    // (Android: o Alert do sistema só mostra 3 botões e cortava "Apagar").
    void cancel;
    setRowMenu({
      title: name || number || caller || '',
      items: [
        { key: 'block', label: optBlock, icon: IconShield, onPress: () => handleSelected(optBlock) },
        { key: 'report', label: optReport, icon: IconFlag, onPress: () => handleSelected(optReport) },
        { key: 'add', label: optAddContact, icon: IconUserPlus, onPress: () => handleSelected(optAddContact) },
        { key: 'copy', label: optCopyNumber, icon: IconCopy, onPress: () => handleSelected(optCopyNumber) },
        { separator: true, key: 'sep' },
        { key: 'delete', label: optDelete, icon: IconTrash, destructive: true, onPress: () => handleSelected(optDelete) },
      ],
    });
  }, [t, runRowMenuAction]);

  // Memory #832: tap on the green phone icon in a call history row should
  // redial the Chatyy call directly (WhatsApp parity), NOT just re-open the
  // chat conversation. The row tap itself still opens the conversation
  // (memory #452), but the explicit phone button is now a true callback.
  // For phone-call rows it delegates to handleHistoryPress (auto-dial via
  // dialer). For Chatyy rows it pushes /call as a fresh caller.
  const handleHistoryCallBack = useCallback((item) => {
    if (item?.to_number) {
      handleHistoryPress(item);
      return;
    }
    if (!router) return;
    const email = item.contactEmail || item.contact_email || '';
    const name = item.contactName || item.contact_name || '';
    // [2026-10-20 wa2] Linha de chamada em GRUPO: ligar de volta abria uma chamada 1:1 com
    // contact_email (quem iniciou). Abre a conversa do grupo, onde a chamada em grupo começa.
    if (item.isGroup && item.conversation_id) {
      try {
        require('../services/openConversation').openConversation(`/chat-conversation?id=${item.conversation_id}&name=${encodeURIComponent(name)}&type=group`);
      } catch {
        router.push({ pathname: '/chat-conversation', params: { id: String(item.conversation_id), name, type: 'group' } });
      }
      return;
    }
    if (!email) return;
    // [2026-10-17 polish-calls-wa] linha do servidor traz type='video' (não item.video):
    // rediscar uma chamada de vídeo saía como voz.
    const _vid = callIsVideo(item);
    const isVideo = _vid ? '1' : '0';
    // [2026-05-20 restore foreground gate] voipNative now short-circuits to
    // the JS /call.js screen when the app is foreground (the common case
    // for redial — user tapped a row inside the app). When backgrounded
    // (Siri shortcut etc), it falls through to native CallView/CallActivity.
    // `onWebFallback` is invoked in both the web path and the foreground
    // gate; the caller stays untouched and just supplies the router.push
    // it wants to run.
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      (async () => {
        try {
          const voipNative = require('../services/voipNative');
          const conversationId = item.conversation_id || item.conversationId || '';
          // [CALL-TRACE 2026-05-21 ROUND3] Step 1b/12 — ChatCallsTab redial
          // tap. Snapshot the row payload so we can see if a history entry
          // is missing contactEmail / contact_email (e.g. a row scraped
          // from VoIP/SIP history that only has to_number).
          try {
            console.log('[CALL-TRACE][1b/12] ChatCallsTab redial tap', {
              email,
              name,
              video: _vid,
              conversationId,
              itemKeys: Object.keys(item || {}),
              ts: Date.now(),
            });
          } catch {}
          // Defensive guard — voipNative will throw CALLEE_EMAIL_EMPTY but
          // surfacing the user-facing Alert here makes the intent obvious.
          if (!email || !String(email).trim()) {
            try {
              console.warn('[CALL-TRACE][1b/12][FAIL] empty calleeEmail in redial', { item });
            } catch {}
            Alert.alert(
              (t && t('common.error')) || 'Erro',
              (t && t('chat.calleeNotIdentified')) || 'Não foi possível identificar o destinatário',
            );
            return;
          }
          const _jsRoute = (cid) => {
            router.push(`/call?callId=${cid}&contactName=${encodeURIComponent(name)}&contactEmail=${encodeURIComponent(email)}&isVideo=${isVideo}&conversationId=${conversationId}&isCaller=1`);
          };
          const { callId, native } = await voipNative.startOutgoingCall({
            calleeEmail: email,
            calleeName: name,
            isVideo: _vid,
            conversationId,
            onWebFallback: _jsRoute,
            // [WAVE 141] WhatsApp arch: native owns call UI, no JS route foreground.
          });
          if (!native) {
            // [WAVE 117A] Mobile = 100% native. onWebFallback already gated.
            // No router.push on mobile — native module handles the UI.
          }
        } catch (e) {
          console.warn('[handleHistoryCallBack] startOutgoingCall failed:', e);
          // [WAVE 117A] Web only — mobile shows no fallback JS screen.
          if (Platform.OS === 'web') {
            router.push(`/call?contactName=${encodeURIComponent(name)}&contactEmail=${encodeURIComponent(email)}&isVideo=${isVideo}&isCaller=1`);
          } else {
            // [2026-10-20 wa2] Falha ao ligar no celular ficava muda (nada acontecia ao tocar).
            try {
              Alert.alert(
                (t && t('common.error')) || 'Erro',
                (t && t('calls.callFailed')) || 'Não foi possível iniciar a chamada. Tente de novo.',
              );
            } catch {}
          }
        }
      })();
      return;
    }
    // Web fallback: keep /call.js
    router.push(`/call?contactName=${encodeURIComponent(name)}&contactEmail=${encodeURIComponent(email)}&isVideo=${isVideo}&isCaller=1`);
  }, [router, handleHistoryPress, t]);

  // [2026-10-17 sem-pstn] "Nova chamada" (só Chatyy) — substitui o discador.
  // Recentes = pessoas Chatyy do histórico (sem linhas de telefone).
  const [newCallOpen, setNewCallOpen] = useState(false);
  const handleNewCallStart = useCallback(({ email, name, video }) => {
    if (!email) return;
    handleHistoryCallBack({ contactEmail: email, contactName: name || '', video: !!video });
  }, [handleHistoryCallBack]);
  // O botão de telefone do topo da aba (app/chat.js) abre esta folha.
  useEffect(() => {
    const open = () => { setNewCallOpen(true); return true; };
    try { globalThis.__chatyyOpenNewCall = open; } catch {}
    return () => { try { if (globalThis.__chatyyOpenNewCall === open) globalThis.__chatyyOpenNewCall = undefined; } catch {} };
  }, []);

  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const handleClearAll = useCallback(() => {
    const doIt = async () => {
      try {
        await callHistoryClear();
        lastCallsFpRef.current = '';
        setChatCalls([]);
        // Clear ALL three on-device stores together (scoped call_history +
        // legacy omc_call_history + chat_calls). Clearing only two left the
        // unscoped mirror populated, so the cold-start seed resurrected the
        // just-cleared list on the next open.
        try { _writeCallHistoryCache([]); } catch {}
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (confirm(t?.('calls.clearConfirm') || 'Limpar todo o histórico de ligações?')) doIt();
    } else {
      Alert.alert(
        t?.('calls.clearHistory') || 'Limpar Histórico',
        t?.('calls.clearConfirm') || 'Limpar todo o histórico de ligações?',
        [
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t?.('calls.clearAll') || 'Limpar Tudo', style: 'destructive', onPress: doIt },
        ]
      );
    }
  }, [t]);

  // ─── Shareable call link (WhatsApp "Create call link") ───
  // Creates a standalone link anyone can tap to join a call (voice/video),
  // then opens the native share sheet with the returned url. Backend contract:
  //   chat_create_call_link { call_type } → { link_id, url, is_video }
  const [creatingLink, setCreatingLink] = useState(false);
  // [2026-10-16 wave12-D] "Meus links de chamada" (revogar/copiar/compartilhar).
  const [myLinksOpen, setMyLinksOpen] = useState(false);
  const [createLinkOpen, setCreateLinkOpen] = useState(false); // [call-link 2026-10-19] folha nível WhatsApp
  const myLinks = useMyCallLinks();
  const myLinksActive = myLinks.reduce((n, l) => n + (callLinkState(l) === 'active' ? 1 : 0), 0);
  const createAndShareLink = useCallback(async (callType) => {
    if (creatingLink) return;
    setCreatingLink(true);
    try {
      const api = require('../services/api');
      const r = await api.chatCreateCallLink(callType);
      const data = r?.data || r;
      const url = data?.url;
      if (!r || r.success === false || !url) {
        const msg = String(r?.message || '');
        Alert.alert(
          t?.('calls.callLink') || 'Link de chamada',
          msg || t?.('calls.callLinkFailed') || 'Não foi possível criar o link. Tente novamente.'
        );
        return;
      }
      // [2026-10-16 wave12-D] guarda em "Meus links" (cache por conta) p/ revogar depois.
      try { addMyCallLink({ link_id: data?.link_id || String(url).split('/').pop(), url, is_video: data?.is_video ?? callType === 'video' }); } catch {}
      try {
        if (Platform.OS === 'web') {
          // Web: no native share sheet — copy to clipboard, fall back to prompt.
          try {
            if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(url);
          } catch {}
          Alert.alert(t?.('calls.callLink') || 'Link de chamada', url);
        } else if (Share?.share) {
          await Share.share({
            message: (t?.('calls.callLinkShareMsg') || 'Entre na minha chamada no Chatyy: ') + url,
            url,
          });
        }
      } catch {}
    } catch (e) {
      if (__DEV__) console.warn('[ChatCallsTab.createLink]', e?.message);
      Alert.alert(
        t?.('calls.callLink') || 'Link de chamada',
        t?.('calls.callLinkFailed') || 'Não foi possível criar o link. Tente novamente.'
      );
    } finally {
      setCreatingLink(false);
    }
  }, [creatingLink, t]);

  const handleCreateCallLink = useCallback(() => {
    if (creatingLink) return;
    // [call-link 2026-10-19] Folha Vídeo/Áudio + nome → link + Copiar/Compartilhar/Enviar no Chatyy/Entrar agora.
    // Kill switch OTA: globalThis.__chatyy_call_link_sheet = false → fluxo antigo (Alert + share).
    if (globalThis.__chatyy_call_link_sheet !== false) { setCreateLinkOpen(true); return; }
    const videoLabel = t?.('calls.videoCall') || 'Chamada de vídeo';
    const voiceLabel = t?.('calls.voiceCall') || 'Chamada de voz';
    const cancelLabel = t?.('common.cancel') || 'Cancelar';
    if (Platform.OS === 'web') {
      // Minimal chooser on web (no ActionSheet) — default to video, offer voice.
      const wantVoice = typeof confirm === 'function'
        ? !confirm((t?.('calls.callLinkTypePrompt') || 'Criar link de chamada de vídeo?') + '\n\n' + (t?.('calls.callLinkVoiceHint') || 'OK = vídeo, Cancelar = voz'))
        : false;
      createAndShareLink(wantVoice ? 'audio' : 'video');
      return;
    }
    Alert.alert(
      t?.('calls.callLink') || 'Link de chamada',
      t?.('calls.callLinkChooseType') || 'Que tipo de chamada?',
      [
        { text: videoLabel, onPress: () => createAndShareLink('video') },
        { text: voiceLabel, onPress: () => createAndShareLink('audio') },
        { text: cancelLabel, style: 'cancel' },
      ]
    );
  }, [creatingLink, t, createAndShareLink]);

  // Merge and filter history
  const allHistory = useMemo(() => {
    const merged = [];
    for (const v of voipHistory) {
      merged.push({
        id: `voip_${v.id}`,
        // [2026-10-20 wa2] Ligação feita por nós nunca é "perdida" (WhatsApp não pinta de vermelho a própria saída).
        type: 'outgoing',
        direction: 'outgoing', // [2026-10-06 UX2] PSTN rows are always placed by us
        contactName: v.contact_name || '',
        contactEmail: '',
        to_number: v.to_number,
        duration: v.duration_seconds || 0,
        timestamp: v.created_at,
        video: false,
        source: 'voip',
      });
    }
    for (const c of chatCalls) {
      // Twilio phone calls share the chat_call_history table but the
      // contact_email column holds the phone number ("+5533...") rather
      // than an email. Detect by leading "+" or all-digits to route them
      // to the 'voip' bucket so the "Telefone" tab finds them.
      const ce = (c.contactEmail || c.contact_email || '').trim();
      const isPhone = c.phoneCall === 1 || c.phone_call === 1
                   || !!c.phoneCall || !!c.phone_call
                   || /^\+?\d{6,}$/.test(ce.replace(/[\s()-]/g, ''));
      // Resolver nome via contatos do iPhone se o backend nao tem (ou tem
      // só o número). 2026-05-09: user reclamou que "mãe" aparecia e sumia.
      // Causa: backend retorna contact_name vazio em refresh subsequente,
      // re-render mostrava só o número. Agora qualquer phone history busca
      // match em phoneContactsList por digits e prefere o nome local.
      let resolvedName = c.contactName || c.contact_name || '';
      if (isPhone && ce) {
        const digits = ce.replace(/\D/g, '');
        const match = phoneContactsList.find(p => {
          if (!p?.phone) return false;
          const pd = p.phone.replace(/\D/g, '');
          // last 8 digits = same subscriber line (ignora país/DDD prefix variants)
          return pd && digits && pd.slice(-8) === digits.slice(-8);
        });
        if (match?.name) resolvedName = match.name;
      }
      // [2026-10-06 UX2] Server rows: type=audio|video|group (media kind),
      // direction=outgoing|incoming, status=answered|missed|..., duration in
      // `duration_seconds`, time in `started_at`. The merge used to drop
      // direction/status and read `c.type` as the direction, so every server
      // call rendered as "incoming"/"audio". Carry the resolved direction +
      // raw status through, and fall back to the server field names.
      merged.push({
        id: `chat_${c.id}`,
        type: c.type || 'outgoing',
        direction: callDirection(c),
        status: c.status,
        contactName: resolvedName,
        contactEmail: c.contactEmail || c.contact_email || '',
        to_number: isPhone ? (c.contactEmail || c.contact_email || '') : '',
        duration: c.duration || c.duration_seconds || 0,
        timestamp: c.timestamp || c.created_at || c.started_at,
        video: callIsVideo(c),
        source: isPhone ? 'voip' : 'chat',
        // [2026-10-20 wa2] Campos do servidor que o merge descartava: ícone de recado de voz,
        // filtro de grupo em "Recentes" e ligar de volta para a conversa certa.
        isGroup: !!(c.isGroup || c.is_group || c.type === 'group'),
        conversation_id: c.conversation_id || c.conversationId || null,
        has_voicemail: c.has_voicemail,
        voicemail_message_id: c.voicemail_message_id,
        voicemail_url: c.voicemail_url,
        voicemail_duration: c.voicemail_duration,
        call_id: c.call_id,
      });
    }
    // Null-safe sort: if either side has no timestamp (backend returned
    // a partial row, or both .timestamp + .created_at are undefined),
    // new Date(undefined) is Invalid Date and the subtraction yields NaN,
    // which makes sort order non-deterministic and can swap "Hoje" rows
    // into "Ontem" buckets on subsequent renders. Treat missing times as 0
    // so they sink to the bottom predictably.
    // [2026-10-17 sem-pstn] Sem PSTN: histórico de telefone (+55…) não aparece em
    // lugar nenhum (Todas, Perdidas, contador). Kill switch religa tudo.
    if (!isPstnEnabled()) {
      for (let i = merged.length - 1; i >= 0; i--) if (merged[i].source === 'voip') merged.splice(i, 1);
    }
    merged.sort((a, b) => {
      const ta = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return merged;
  }, [voipHistory, chatCalls, phoneContactsList]);

  // [2026-10-17 sem-pstn] filtro 'phone'/'chatyy' sem chip visível → volta p/ Todas.
  const _filterTab = (!isPstnEnabled() && (activeTab === 'phone' || activeTab === 'chatyy')) ? 'recent' : activeTab;
  useEffect(() => { if (_filterTab !== activeTab) setActiveTab('recent'); }, [_filterTab, activeTab]);
  const filteredHistory = useMemo(() => {
    switch (_filterTab) {
      case 'missed': return allHistory.filter(h => callDirection(h) === 'missed');
      case 'chatyy': return allHistory.filter(h => h.source === 'chat');
      case 'phone': return allHistory.filter(h => h.source === 'voip');
      default: return allHistory;
    }
  }, [allHistory, _filterTab]);
  // [2026-10-16 wave12-D] contador do chip "Perdidas" + "Telefone" só se fizer sentido.
  const missedCount = useMemo(() => allHistory.reduce((n, h) => n + (callDirection(h) === 'missed' ? 1 : 0), 0), [allHistory]);
  // [2026-10-17 sem-pstn] recentes da folha "Nova chamada" (só contas Chatyy, 1:1).
  const newCallRecent = useMemo(() => {
    const out = []; const seen = new Set();
    for (const h of allHistory) {
      if (h.source !== 'chat' || h.isGroup) continue;
      const em = String(h.contactEmail || '').trim();
      if (!em || !em.includes('@') || seen.has(em.toLowerCase())) continue;
      seen.add(em.toLowerCase());
      out.push({ email: em, name: h.contactName || '' });
      if (out.length >= 30) break;
    }
    return out;
  }, [allHistory]);

  // Group calls by date
  const groupedCalls = useMemo(() => {
    const groups = [];
    let currentGroup = null;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // First paint renders only the viewport window (see renderLimit); the
    // effect expands it to Infinity a frame after mount. filteredHistory is
    // already sorted desc, so slicing the head preserves correct grouping.
    const rows = renderLimit === Infinity ? filteredHistory : filteredHistory.slice(0, renderLimit);
    for (const call of rows) {
      const d = new Date(call.timestamp);
      let groupLabel;
      if (d.toDateString() === today.toDateString()) {
        groupLabel = t?.('calls.today') || 'Hoje';
      } else if (d.toDateString() === yesterday.toDateString()) {
        groupLabel = t?.('calls.yesterday') || 'Ontem';
      } else {
        const diffDays = Math.floor((today - d) / (1000 * 60 * 60 * 24));
        if (diffDays < 7) {
          groupLabel = t?.('calls.thisWeek') || 'Esta Semana';
        } else {
          groupLabel = t?.('calls.earlier') || 'Anteriores';
        }
      }

      if (!currentGroup || currentGroup.label !== groupLabel) {
        currentGroup = { label: groupLabel, data: [] };
        groups.push(currentGroup);
      }
      currentGroup.data.push(call);
    }
    return groups;
  }, [filteredHistory, t, renderLimit]);

  const bgColor = isDark ? '#000000' : '#f2f2f7';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#6c6c70';
  const cardBg = isDark ? '#1c1c1e' : '#ffffff';
  // Only block render on history loading. Minutes (Telnyx PSTN balance) loads independently
  // and shouldn't delay showing the chat call history.
  const isLoading = loadingHistory;

  const _headerChrome = (
    <>
      {/* Header with tabs */}
      <View style={[s.header, { backgroundColor: _tc(isDark).background }]}>
        {/* [2026-10-11 visual polish] Chip row scrolls horizontally from the
            16px gutter. It was a right-aligned (flex-end) row that overflowed
            on phones: "Agendar" was clipped against the left screen edge. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal: -16, marginBottom: 8, flexGrow: 0 }}
          contentContainerStyle={{ flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, minHeight: 24 }}
        >
          <PressableScale haptic="select" scaleTo={0.95}
            onPress={() => setScheduleVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 5,
              paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
              // [2026-10-16 polish-calls] AÇÕES em contorno → não se confundem com os FILTROS
              // (Todas/Perdidas/Chatyy, preenchidos) logo abaixo — antes eram 2 fileiras iguais.
              backgroundColor: 'transparent', borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(17,17,17,0.16)',
            }}
            accessibilityRole="button"
            accessibilityLabel={t?.('calls.schedule') || 'Agendar'}
          >
            <IconCalendar size={13} color={isDark ? '#F5F5F7' : '#111111'} />
            <Text style={{ color: isDark ? '#F5F5F7' : '#111111', fontSize: 13, fontWeight: '600' }}>
              {t?.('calls.schedule') || 'Agendar'}
            </Text>
          </PressableScale>
          {router && (
            <PressableScale haptic="select" scaleTo={0.95}
              onPress={() => router.push('/call-schedule')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 5,
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
                backgroundColor: 'transparent', borderWidth: 1,
                borderColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(17,17,17,0.16)',
              }}
              accessibilityRole="button"
              accessibilityLabel={t?.('calls.scheduledList') || 'Agendadas'}
            >
              {/* [2026-10-14 vis3] chip abre a LISTA → "Agendadas" (era "Chamada agendada", singular) */}
              <Text style={{ color: isDark ? '#F5F5F7' : '#111111', fontSize: 13, fontWeight: '600' }}>
                {t?.('calls.scheduledList') || 'Agendadas'}
              </Text>
            </PressableScale>
          )}
          {/* [2026-10-14 vis-audit] "Limpar tudo" saiu da fileira de ações (chip vermelho ao lado
              de Agendar) → menu "…" do histórico; a ação mantém a confirmação (handleClearAll). */}
          {filteredHistory.length > 0 && (
            <>
              <View style={{ flex: 1 }} />
              <PressableScale haptic="select" scaleTo={0.95}
                onPress={() => setHistoryMenuOpen(true)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{
                  width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(255, 255, 255,0.12)' : 'rgba(17, 17, 17,0.07)',
                }}
                accessibilityRole="button"
                accessibilityLabel={t?.('common.more') || 'Mais'}
              >
                <IconMoreHorizontal size={18} color={isDark ? '#F5F5F7' : '#111111'} />
              </PressableScale>
            </>
          )}
        </ScrollView>
        <Sheet native visible={!!rowMenu} onClose={() => setRowMenu(null)} title={rowMenu?.title}>
          <ActionList onDone={() => setRowMenu(null)} items={rowMenu?.items || []} />
        </Sheet>
        <Sheet native visible={historyMenuOpen} onClose={() => setHistoryMenuOpen(false)}>
          <ActionList
            onDone={() => setHistoryMenuOpen(false)}
            items={[{ key: 'clear', label: t?.('calls.clearHistory') || 'Limpar histórico', icon: IconTrash, destructive: true, onPress: handleClearAll }]}
          />
        </Sheet>
        <CallFilterChips
          activeTab={_filterTab}
          onTabChange={setActiveTab}
          isDark={isDark}
          t={t}
          missedCount={missedCount}
          showPhone={isPstnEnabled()}
        />
        <MyCallLinksSheet visible={myLinksOpen} onClose={() => setMyLinksOpen(false)} t={t} language={language} />
        <CreateCallLinkSheet visible={createLinkOpen} onClose={() => setCreateLinkOpen(false)} t={t} router={router} currentEmail={user?.email} />
      </View>

      {/* Plan status */}
      {isPstnEnabled() && !loadingMinutes && (
        <PlanBadge minutesInfo={minutesInfo} isDark={isDark} t={t} />
      )}
    </>
  );

  // [2026-10-15 native-calls] Cartões "Silenciar desconhecidas" e "Criar link":
  // os mesmos na lista JS (ScrollView) e no cabeçalho da lista nativa.
  const _topCards = (
    <>
      {/* Silence unknown callers */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        marginHorizontal: 16, marginTop: 8, marginBottom: 4,
        paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, minHeight: 64,
        // [2026-10-10 visual] was #f2f2f7 = same as the light page bg (card vanished)
        backgroundColor: cardBg,
      }}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: textColor }}>
            {t?.('calls.silenceUnknown') || 'Silenciar chamadas desconhecidas'}
          </Text>
          <Text style={{ fontSize: 13, lineHeight: 17, color: subColor, marginTop: 2 }}>
            {t?.('calls.silenceUnknownDesc') || 'Chamadas de números fora dos contatos serão silenciadas'}
          </Text>
        </View>
        <SilenceToggle isDark={isDark} />
      </View>

      {/* Create shareable call link (WhatsApp parity) */}
      <PressableScale
        onPress={handleCreateCallLink}
        activeOpacity={0.7}
        disabled={creatingLink}
        style={{
          flexDirection: 'row', alignItems: 'center',
          marginHorizontal: 16, marginTop: 8, marginBottom: 4,
          paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, minHeight: 64,
          backgroundColor: cardBg,
          opacity: creatingLink ? 0.6 : 1,
        }}
        accessibilityRole="button"
        accessibilityLabel={t?.('calls.createCallLink') || 'Criar link de chamada'}
      >
        <View style={{
          width: 40, height: 40, borderRadius: 20, marginRight: 12,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255, 255, 255,0.10)' : 'rgba(17, 17, 17,0.07)',
        }}>
          {creatingLink
            ? <ActivityIndicator size="small" color={isDark ? '#F5F5F7' : '#111111'} />
            : <IconLink size={20} color={isDark ? '#F5F5F7' : '#111111'} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: textColor }}>
            {t?.('calls.createCallLink') || 'Criar link de chamada'}
          </Text>
          <Text style={{ fontSize: 13, lineHeight: 17, color: subColor, marginTop: 2 }}>
            {t?.('calls.createCallLinkDesc') || 'Compartilhe um link para uma chamada'}
          </Text>
        </View>
      </PressableScale>

      {/* [2026-10-16 wave12-D] Meus links de chamada — só depois do 1º link criado aqui. */}
      {myLinks.length > 0 && (
        <PressableScale
          onPress={() => setMyLinksOpen(true)}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row', alignItems: 'center',
            marginHorizontal: 16, marginTop: 8, marginBottom: 4,
            paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, minHeight: 56,
            backgroundColor: cardBg,
          }}
          accessibilityRole="button"
          accessibilityLabel={t?.('calls.myCallLinks') || 'Meus links de chamada'}
          testID="calls-my-links"
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: textColor }}>
              {t?.('calls.myCallLinks') || 'Meus links de chamada'}
            </Text>
            <Text style={{ fontSize: 13, lineHeight: 17, color: subColor, marginTop: 2 }}>
              {t?.('calls.myCallLinksActive', { n: myLinksActive }) || `Ativos: ${myLinksActive}`}
            </Text>
          </View>
          <IconChevronRight size={18} color={subColor} />
        </PressableScale>
      )}
    </>
  );

  // [2026-10-15 native-calls] Lista nativa só com histórico carregado e não
  // vazio (esqueleto/vazio seguem no ScrollView JS). Kill switch por OTA:
  // globalThis.__chatyy_native_calls = false. Erro → volta ao JS na hora.
  const _useNativeCalls = Platform.OS !== 'web' && !_nativeCallsFailed
    && globalThis.__chatyy_native_calls !== false && !isLoading && filteredHistory.length > 0
    && _nativeCallsAvailable();

  return (
    <View style={[s.container, { backgroundColor: bgColor }]}>
      {/* [2026-10-15 nav-motion] chips/segmento/plano: fixos em cima (sem título
          grande) ou rolando logo abaixo do título grande. */}
      {!largeTitle && _headerChrome}

      {/* Call history */}
      {_useNativeCalls ? (
        <NativeCallList
          calls={filteredHistory}
          isDark={isDark}
          labels={_nativeCallLabels}
          describe={_nativeDescribe}
          sectionOf={_nativeSectionOf}
          bottomInset={100}
          header={(
            <>
              {!!largeTitle && <LargeTitle title={largeTitle} color={textColor} />}
              {!!largeTitle && _headerChrome}
              {_topCards}
            </>
          )}
          onPress={handleHistoryPress}
          onCallBack={handleHistoryCallBack}
          onInfoPress={setInfoItem}
          onDelete={handleDeleteEntry}
          onMenuAction={runRowMenuAction}
          onCollapsedChange={largeTitle ? onLargeTitleCollapsedChange : undefined}
          onFailure={_onNativeCallsFailure}
        />
      ) : (
      <ScrollView
        style={s.scrollView}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={renderLimit === Infinity ? undefined : expandRenderLimit}
        onScroll={_lt.onScroll}
        scrollEventThrottle={_lt.scrollEventThrottle}
      >
        {!!largeTitle && <LargeTitle title={largeTitle} color={textColor} />}
        {!!largeTitle && _headerChrome}
        {/* [2026-10-14 vis3] os 2 cartões agora rolam junto com o histórico (antes ficavam fixos e
            comiam ~170px da lista em telas pequenas). */}
        {_topCards}
        {isLoading ? (
          <CallListSkeleton count={6} />
        ) : filteredHistory.length === 0 ? (
          <View style={s.emptyState}>
            <ChatyyMascot pose="sleep" size={132} dark={isDark} />{/* [2026-10-16 mascote] era CallEmptyIllustration */}
            <Text style={[s.emptyTitle, { color: textColor }]}>
              {activeTab === 'missed'
                ? (t?.('calls.noMissedTitle') || 'Nenhuma ligação perdida')
                : (t?.('calls.noCallsTitle') || 'Nenhuma ligação recente')}
            </Text>
            <Text style={[s.emptySubtitle, { color: subColor }]}>
              {activeTab === 'missed'
                ? (t?.('calls.noMissedSubtitle') || 'Ligações que você não atender aparecem aqui')
                : (isPstnEnabled()
                  ? (t?.('calls.noCallsSubtitle') || 'Seu histórico de ligações aparecerá aqui')
                  : (t?.('calls.freeViaChatyy') || 'Ligações grátis pelo Chatyy, voz e vídeo'))}
            </Text>
            {/* [2026-10-17 sem-pstn] CTA "Nova chamada" (contatos do Chatyy) no lugar de "Abrir teclado". */}
            {!isPstnEnabled() && activeTab !== 'missed' && (
            <PressableScale
              style={[s.emptyCtaBtn, colors?.primary ? { backgroundColor: colors.primary, ...(Platform.OS === 'web' ? { backgroundImage: 'none', boxShadow: isDark ? 'none' : '0 6px 18px rgba(17, 17, 17,0.35)' } : null) } : null]}
              onPress={() => setNewCallOpen(true)}
              activeOpacity={0.85}
              accessibilityLabel={t?.('calls.newCall') || 'Nova chamada'}
              accessibilityRole="button"
            >
              <Text style={[s.emptyCtaText, colors?.onPrimary ? { color: colors.onPrimary } : null]}>
                {t?.('calls.newCall') || 'Nova chamada'}
              </Text>
            </PressableScale>
            )}
            {/* CTA — primes the user to make a call instead of staring at nothing. */}
            {isPstnEnabled() && (
            <PressableScale
              style={[s.emptyCtaBtn, colors?.primary ? { backgroundColor: colors.primary, ...(Platform.OS === 'web' ? { backgroundImage: 'none', boxShadow: isDark ? 'none' : '0 6px 18px rgba(17, 17, 17,0.35)' } : null) } : null]}
              onPress={() => setDialerVisible(true)}
              activeOpacity={0.85}
              accessibilityLabel={t?.('calls.dialer') || 'Teclado'}
              accessibilityRole="button"
            >
              <Text style={[s.emptyCtaText, colors?.onPrimary ? { color: colors.onPrimary } : null]}>
                {t?.('calls.openDialer') || 'Abrir teclado'}
              </Text>
            </PressableScale>
            )}
          </View>
        ) : (
          groupedCalls.map((group, gIdx) => (
            // [2026-10-15 nav-motion] entrada suave escalonada só nas 3 primeiras
            // seções (o resto nasce assentado — custo zero em histórico longo).
            <FadeSlideIn key={group.label + gIdx} skip={gIdx > 2} delay={gIdx * 50} distance={8} style={_NOFLEX}>
              {/* Section header */}
              <Text style={[s.sectionHeader, { color: subColor }]}>
                {group.label}
              </Text>
              {/* Cards */}
              <View style={[s.sectionCard, { backgroundColor: cardBg }]}>
                {group.data.map((item, idx) => (
                  <React.Fragment key={item.id || idx}>
                    {idx > 0 && (
                      <View style={[s.separator, { backgroundColor: hairlineColor(isDark) /* [2026-10-18 elegance] token único de hairline */ }]} />
                    )}
                    <SwipeAction
                      onSwipeLeft={() => handleDeleteEntry(item)}
                      rightContent={(
                        <View style={{
                          width: 80,
                          height: '100%',
                          backgroundColor: RED,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}>
                          <IconTrash size={20} color="#fff" />
                        </View>
                      )}
                    >
                      <CallHistoryRow
                        item={item}
                        isDark={isDark}
                        t={t}
                        language={language}
                        onPress={handleHistoryPress}
                        onInfoPress={setInfoItem}
                        onCallBack={handleHistoryCallBack}
                        onLongPress={handleRowLongPress}
                      />
                    </SwipeAction>
                  </React.Fragment>
                ))}
              </View>
            </FadeSlideIn>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>
      )}

      {/* FAB - Dialer button (Telegram-grade glass orb, green tint) */}
      {/* [2026-10-19] sem FAB: o botão de ligar já fica no topo da aba */}
      {false && isPstnEnabled() && (
      <BrandFab
        style={{ position: 'absolute', right: 20, bottom: 24 }}
        size={56}
        color={colors?.primary || ACCENT}
        onPress={() => setDialerVisible(true)}
        accessibilityLabel={t?.('calls.dialer') || 'Teclado'}
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={colors?.onPrimary || '#ffffff'} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
        </Svg>
      </BrandFab>
      )}

      {/* [2026-10-17 sem-pstn] FAB "Nova chamada" (só Chatyy) — no lugar do teclado. */}
      {false && !isPstnEnabled() && (
      <BrandFab
        style={{ position: 'absolute', right: 20, bottom: 24 }}
        size={56}
        color={colors?.primary || ACCENT}
        onPress={() => setNewCallOpen(true)}
        accessibilityLabel={t?.('calls.newCall') || 'Nova chamada'}
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={colors?.onPrimary || '#ffffff'} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
          <Path d="M15 3v6M12 6h6" />
        </Svg>
      </BrandFab>
      )}
      <NewCallSheet
        visible={newCallOpen}
        onClose={() => setNewCallOpen(false)}
        recent={newCallRecent}
        onStartCall={handleNewCallStart}
      />

      {/* Dialer modal */}
      {isPstnEnabled() && (
      <DialerModal
        visible={dialerVisible}
        onClose={() => { setDialerVisible(false); setDialerAutoDial(false); setDialerPrefill(''); }}
        isDark={isDark}
        t={t}
        minutesInfo={minutesInfo}
        onCallPlaced={refreshData}
        callerIdVerified={callerIdVerified}
        onVerified={() => setCallerIdVerified(true)}
        prefill={dialerPrefill}
        autoDial={dialerAutoDial}
        onAutoDialConsumed={() => setDialerAutoDial(false)}
      />
      )}

      {/* Schedule a call — opens the date+title+participants picker.
          On success the participants get a system DM with a tap-to-add
          entry and we send the user to the scheduled-list screen. */}
      <ScheduleCallModal
        visible={scheduleVisible}
        onClose={() => setScheduleVisible(false)}
        onScheduled={() => {
          setScheduleVisible(false);
          if (router) router.push('/call-schedule');
        }}
      />

      {/* [2026-10-19 callinfo] Informações da chamada: todas as ligações com a pessoa */}
      <CallInfoSheet
        item={infoItem}
        visible={!!infoItem}
        onClose={() => setInfoItem(null)}
        calls={allHistory}
        onCall={handleHistoryCallBack}
        onMessage={handleHistoryPress}
        onDeleted={handleInfoDeleted}
      />
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================
const s = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginBottom: 8,
    minHeight: 24,
  },
  editBtn: {
    paddingVertical: 4,
  },

  // Plan badge
  planBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  planBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },

  // Section headers — tighter, brand-weighted (R-callspolish)
  // [2026-10-13 visual] header aligned to the card's text inset (16+16),
  // card on the same 16 gutter/14 radius as the toggles above; no tinted shadow
  // (the old slate #0f172a shadow read blue-ish on the P&B brand).
  // [2026-10-18 elegance] = Typography.sectionHeader (mesmo cabeçalho das Configurações).
  sectionHeader: {
    fontSize: Typography.sectionHeader.fontSize,
    lineHeight: Typography.sectionHeader.lineHeight,
    fontWeight: Typography.sectionHeader.fontWeight,
    textTransform: 'uppercase',
    letterSpacing: Typography.sectionHeader.letterSpacing,
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionCard: {
    marginHorizontal: 16,
    borderRadius: BorderRadius.card,
    overflow: 'hidden',
  },

  // History rows
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    minHeight: 66,
  },
  // [2026-10-17 polish-calls-wa] sem anel vermelho no avatar da perdida (no WhatsApp
  // só o NOME fica vermelho; anel em volta do avatar lê como "tem status").
  historyLeft: {
    marginEnd: 13,
  },
  historyLeftMissed: {},
  historyAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyMiddle: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    marginEnd: 10,
  },
  // WhatsApp-grade: name is semibold so it reads as the row's anchor.
  historyName: {
    fontSize: 17, // [2026-10-18 polish2] HIG body 17 = mesma âncora da lista de conversas (rowName)
    fontWeight: '600',
    letterSpacing: -0.2,
    flex: 1,
  },
  historyType: {
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: -0.1,
  },
  historyRight: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  historyTime: {
    fontSize: 13, // [2026-10-18 polish2] HIG footnote 13 (era 12)
    fontWeight: '500',
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  infoBtn: {
    padding: 4,
  },
  // Round call-back affordance — sized to a comfortable 40pt tap target.
  callBackBtn: {
    borderRadius: 20,
    width: 36,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 16 pad + 44 avatar + 13 gap = 73 -> separator starts under the name
  separator: {
    height: StyleSheet.hairlineWidth,
    marginStart: 73,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20, // [2026-10-18 polish2] HIG title3 20/700 (era 21/800) = igual ScreenEmptyState
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: -0.4,
  },
  emptySubtitle: {
    fontSize: 15, // [2026-10-18 polish2] HIG subhead 15 (era 14.5)
    textAlign: 'center',
    lineHeight: 21,
    fontWeight: '500',
    maxWidth: 280,
    opacity: 0.9,
  },
  // Brand purple gradient CTA — opens dialer to make first call.
  emptyCtaBtn: {
    marginTop: 22,
    minHeight: 46, justifyContent: 'center', // [2026-10-16 polish-calls] toque >= 44
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: '#111111',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 6px 18px rgba(17, 17, 17,0.35)',
      backgroundImage: 'linear-gradient(135deg, #111111 0%, #111111 100%)',
    } : Platform.OS === 'ios' ? {
      shadowColor: '#111111',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.32,
      shadowRadius: 14,
    } : { elevation: 5 }),
  },
  emptyCtaText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(52,199,89,0.4)',
    } : Platform.OS === 'ios' ? {
      shadowColor: GREEN,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
    } : { elevation: 8 }),
  },

  // Dialer modal - iPhone Phone app style
  dialerContainer: {
    flex: 1,
    ...(Platform.OS === 'web' ? { paddingTop: 0 } : { paddingTop: 50 }),
  },
  dialerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dialerCloseBtn: {
    paddingVertical: 6,
  },
  dialerBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: Platform.OS === 'web' ? 32 : 48,
    maxWidth: MAX_DIALER_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  dialerDisplay: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    alignItems: 'center',
    minHeight: 70,
    width: '100%',
    justifyContent: 'center',
  },
  dialerNumberContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    minHeight: 44,
  },
  dialerFlag: {
    fontSize: 24,
  },
  dialerNumber: {
    fontWeight: '300',
    letterSpacing: 1.5,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  dialerCountry: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
    letterSpacing: 0.4,
  },
  dialerContacts: {
    marginHorizontal: 24,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
    width: '100%',
    paddingHorizontal: 24,
  },
  dialerContactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  dialerContactName: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  dialerResult: {
    marginHorizontal: 24,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
    width: '100%',
  },
  dialerKeypad: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
    width: '100%',
  },
  dialerKeypadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 26,
    marginBottom: 16,
  },
  dialerBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: 20,
    marginTop: 10,
    marginBottom: 12,
  },
  dialerBottomSide: {
    width: DIAL_KEY_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerBackspace: {
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerAddContact: {
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerCallBtn: {
    width: DIAL_KEY_SIZE,
    height: DIAL_KEY_SIZE,
    borderRadius: DIAL_KEY_SIZE / 2,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 24,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 6px 20px rgba(52,199,89,0.45)',
    } : Platform.OS === 'ios' ? {
      shadowColor: GREEN,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.45,
      shadowRadius: 16,
    } : { elevation: 8 }),
  },

  // Dial key - iPhone circular buttons
  dialKey: {
    width: DIAL_KEY_SIZE,
    height: DIAL_KEY_SIZE,
    borderRadius: DIAL_KEY_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialKeyDigit: {
    fontSize: 33,
    fontWeight: '400',
    lineHeight: 38,
  },
  dialKeySub: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 1,
    opacity: 0.7,
  },

  // Chatyy badge
  chatyyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },

  // Call info modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: Platform.OS === 'web' ? 24 : 40,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalContactSection: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  modalAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContactName: {
    fontSize: 22,
    fontWeight: '600',
  },
  modalContactSub: {
    fontSize: 15,
  },
  modalDetails: {
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  modalDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  modalDetailSep: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  modalDetailLabel: {
    fontSize: 15,
  },
  modalDetailValue: {
    fontSize: 15,
  },
  callAgainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: GREEN,
    borderRadius: 12,
    paddingVertical: 14,
  },
  callAgainText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
});

export default memo(ChatCallsTab);
