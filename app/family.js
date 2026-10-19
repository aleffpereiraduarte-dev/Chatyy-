/**
 * Família — hub premium (Compartilhamento Familiar da Apple + Life360) em
 * preto e branco, ligado ao backend REAL `family_*` (email.php).
 *
 * [2026-10-19 family-hub] Redesenho completo (antes: botão/blocos azuis,
 * avatar grande único, recursos escondidos em linhas com chevron):
 *   • Título GRANDE nativo ("Família", colapsa ao rolar) + pull-to-refresh.
 *   • Capa: avatares empilhados, nome (lápis p/ o responsável), contagem,
 *     selo do meu papel e o CTA "Convidar familiar" em pílula (colors.primary
 *     → segue o destaque do usuário; P&B por padrão).
 *   • Membros: fileira horizontal de cartões (avatar, nome, papel, status ao
 *     vivo: online / localização há X / visto há X). Família só comigo →
 *     estado vazio com chips Pai · Mãe · Cônjuge · Filho(a) (já abre o
 *     convite com o papel certo).
 *   • Atalhos: grade 3 colunas com ícones monocromáticos em quadrado grafite.
 *   • Prévias reais: 3 itens da lista de compras (marcar/adicionar ali mesmo),
 *     4 últimas fotos do álbum, próximo evento do calendário.
 *   • Folhas nativas: convite (papel → contato/QR/código), ver tudo de cada
 *     recurso, renomear, entrar com convite.
 *
 * Contrato real:
 *   family_info → { data:{ family:{id,name,photo_url,owner_email,share_plan},
 *                   members:[{email,name,online,last_seen,presence,role}],
 *                   my_role, is_owner } }  (auto-cria a família solo)
 *   family_invite {target, role} → { data:{ token, role, link } }
 *   family_join {token} · family_update {name} · family_remove_member {email}
 *   family_leave · family_location_all → { locations:[{email,updated_at,…}] }
 *   compras / álbum / calendário → components/family/FamilyShared.js
 *
 * Deep link: onemundomail://family/join/<token> → app/+native-intent.js →
 * /family?join=<token> → abre a folha "Entrar com convite" preenchida.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Platform, Alert, ActivityIndicator, TextInput, RefreshControl, Animated, Easing, useWindowDimensions } from 'react-native';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton, nativeScrollInsetProps, NativeInsetView } from '../components/nativeHeader';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconUsers, IconPlus, IconShield, IconStar, IconMessageCircle,
  IconLogout, IconKey, IconEdit, IconCalendar, IconImage,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import ErrorBoundary from '../components/ErrorBoundary';
import PressableScale from '../components/PressableScale';
import NativeSheetDialog from '../components/NativeSheetDialog';
import { haptic } from '../constants/theme';
import * as api from '../services/api';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { PLANS_ENABLED } from '../constants/featureFlags';
import { SettingsGroup, SettingsRow } from '../components/settings/SettingsKit';
import { useFamilyColors, IconCart, IconMap, GraphiteTile, HubSectionHeader, relativeAgo, memberLabel, firstName } from '../components/family/familyUi';
import { useFamilyShared, ShoppingPreview, AlbumPreview, NextEventPreview, ShoppingSheetBody, AlbumSheetBody, CalendarSheetBody } from '../components/family/FamilyShared';
import FamilyInviteSheet from '../components/family/FamilyInviteSheet';

const lower = (s) => String(s || '').toLowerCase();
const isOnline = (m) => !!m?.online || m?.presence === 'online';

// ── Avatares empilhados (capa) ────────────────────────────────────────────
function AvatarStack({ members, size = 58 }) {
  const c = useFamilyColors();
  const list = (members || []).slice(0, 4);
  const extra = Math.max(0, (members || []).length - list.length);
  const overlap = Math.round(size * 0.32);
  if (!list.length) {
    return <GraphiteTile Icon={IconUsers} size={size} radius={size / 2} />;
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {list.map((m, i) => (
        <View key={m.email || i} style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: 10 - i, borderRadius: (size + 6) / 2, padding: 3, backgroundColor: c.cardBg }}>
          <AvatarCircle email={m.email} name={m.name} size={size} />
        </View>
      ))}
      {extra > 0 && (
        <View style={{ marginLeft: -overlap, borderRadius: (size + 6) / 2, padding: 3, backgroundColor: c.cardBg }}>
          <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.tileBg, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: c.tileFg, fontWeight: '700', fontSize: size * 0.3 }}>+{extra}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Cartão de membro (fileira horizontal) ─────────────────────────────────
function MemberCard({ member, isMe, ownerEmail, location, onPress, index }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const tm = setTimeout(() => {
      Animated.timing(enter, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }, Math.min(index, 6) * 45);
    return () => clearTimeout(tm);
  }, [enter, index]);

  const online = isOnline(member);
  const isOwnerM = !!ownerEmail && lower(member.email) === lower(ownerEmail);
  const roleKey = isOwnerM ? 'family.role.owner'
    : member.role === 'spouse' ? 'family.role.spouse'
      : member.role === 'child' ? 'family.role.child'
        : 'family.hub.role.adult';
  const locAgo = location?.updated_at ? relativeAgo(location.updated_at, t) : null;
  const seenAgo = !online && member.last_seen ? relativeAgo(member.last_seen, t) : null;
  const status = online ? t('family.hub.onlineNow')
    : locAgo ? t('family.hub.locationAgo', { ago: locAgo })
      : seenAgo ? t('family.hub.seenAgo', { ago: seenAgo }) : '';
  const name = isMe ? t('family.hub.you') : firstName(member);

  return (
    <Animated.View style={{ opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>
      <PressableScale onPress={onPress} scaleTo={0.96} style={[st.memberCard, { backgroundColor: c.cardBg }]}
        accessibilityRole="button" accessibilityLabel={[memberLabel(member), t(roleKey), status].filter(Boolean).join(', ')}>
        <View>
          <AvatarCircle email={member.email} name={member.name} size={58} />
          {online && <View style={[st.onlineDot, { backgroundColor: c.online, borderColor: c.cardBg }]} />}
        </View>
        <Text style={[st.memberName, { color: c.text }]} numberOfLines={1}>{name}</Text>
        <Text style={[st.memberRole, { color: c.secondary }]} numberOfLines={1}>{t(roleKey)}</Text>
        {!!status && (
          <Text style={[st.memberStatus, { color: online ? c.online : c.secondary }]} numberOfLines={1}>{status}</Text>
        )}
      </PressableScale>
    </Animated.View>
  );
}

function AddMemberCard({ onPress }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  return (
    <PressableScale onPress={onPress} scaleTo={0.96} style={[st.memberCard, st.addCard, { borderColor: c.tertiary }]} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
      <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
        <IconPlus size={24} color={c.text} />
      </View>
      <Text style={[st.memberName, { color: c.text }]} numberOfLines={1}>{t('family.hub.inviteShort')}</Text>
      <Text style={[st.memberRole, { color: c.secondary }]} numberOfLines={1}>{t('family.hub.addSomeone')}</Text>
    </PressableScale>
  );
}

// ── Estado vazio: só eu na família ────────────────────────────────────────
function InviteEmpty({ onInvite }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const chips = [
    { k: 'father', role: 'parent', label: t('family.hub.chip.father') },
    { k: 'mother', role: 'parent', label: t('family.hub.chip.mother') },
    { k: 'spouse', role: 'spouse', label: t('family.hub.chip.spouse') },
    { k: 'child', role: 'child', label: t('family.hub.chip.child') },
  ];
  return (
    <View style={[st.emptyCard, { backgroundColor: c.cardBg }]}>
      <Text style={[st.emptyTitle, { color: c.text }]}>{t('family.hub.emptyTitle')}</Text>
      <Text style={[st.emptySub, { color: c.secondary }]}>{t('family.hub.emptySub')}</Text>
      <View style={st.chipsRow}>
        {chips.map(ch => (
          <Pressable key={ch.k} onPress={() => { try { haptic.select(); } catch {} onInvite(ch.role); }} accessibilityRole="button" accessibilityLabel={t('family.hub.inviteRoleA11y', { role: ch.label })}
            style={({ pressed }) => [st.roleChip, { backgroundColor: c.chip }, pressed && { opacity: 0.6 }]}>
            <IconPlus size={14} color={c.text} />
            <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>{ch.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ── Atalho da grade ───────────────────────────────────────────────────────
function QuickTile({ Icon, label, sub, onPress, width }) {
  const c = useFamilyColors();
  return (
    <PressableScale onPress={onPress} scaleTo={0.96} style={[st.tile, { backgroundColor: c.cardBg, width }]} accessibilityRole="button" accessibilityLabel={sub ? `${label}, ${sub}` : label}>
      <GraphiteTile Icon={Icon} size={40} />
      <Text style={[st.tileLabel, { color: c.text }]} numberOfLines={1}>{label}</Text>
      {!!sub && <Text style={[st.tileSub, { color: c.secondary }]} numberOfLines={1}>{sub}</Text>}
    </PressableScale>
  );
}

function FamilySkeleton() {
  const c = useFamilyColors();
  const b = (h, w = '100%', mb = 10, r = 14) => <View style={{ height: h, width: w, borderRadius: r, backgroundColor: c.placeholder, marginBottom: mb }} />;
  return (
    <View style={{ padding: 16 }}>
      <View style={[st.hero, { backgroundColor: c.cardBg }]}>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>{b(58, 58, 0, 29)}{b(58, 58, 0, 29)}{b(58, 58, 0, 29)}</View>
        {b(24, 190, 8, 8)}{b(14, 120, 18, 7)}{b(48, '100%', 0, 24)}
      </View>
      <View style={{ height: 24 }} />
      <View style={{ flexDirection: 'row', gap: 10 }}>{b(132, 118)}{b(132, 118)}{b(132, 118)}</View>
      <View style={{ height: 16 }} />
      {b(96)}{b(96)}
    </View>
  );
}

// Folha simples (renomear / entrar com convite).
function FormSheet({ visible, onClose, title, sub, children }) {
  const c = useFamilyColors();
  return (
    <NativeSheetDialog
      visible={visible}
      onClose={onClose}
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
      panelStyle={{ backgroundColor: c.pageBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 28, width: '100%', maxWidth: 560, alignSelf: 'center' }}
      animationType="slide"
    >
      <Text style={[st.sheetTitle, { color: c.text }]} accessibilityRole="header">{title}</Text>
      {!!sub && <Text style={[st.sheetSub, { color: c.secondary }]}>{sub}</Text>}
      {children}
    </NativeSheetDialog>
  );
}

// Folha "ver tudo" de um recurso compartilhado.
function ListSheet({ visible, onClose, children }) {
  const c = useFamilyColors();
  return (
    <NativeSheetDialog
      visible={visible}
      onClose={onClose}
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
      panelStyle={{ backgroundColor: c.pageBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 24, width: '100%', maxWidth: 640, alignSelf: 'center', maxHeight: '88%' }}
      animationType="slide"
    >
      {children}
    </NativeSheetDialog>
  );
}

function FamilyScreenInner() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const c = useFamilyColors();
  const { colors, isDark } = c;
  const { user } = useAuth();
  const { t } = useLanguage();
  const shared = useFamilyShared();

  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [family, setFamily] = useState(null);
  const [planShare, setPlanShare] = useState(null);
  const [locations, setLocations] = useState({}); // email → { updated_at, … }

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState('child');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [sheet, setSheet] = useState(null); // 'shopping' | 'album' | 'calendar' | 'calendarAdd'

  const myEmail = lower(user?.email);

  const loadInfo = useCallback(async () => {
    setErrored(false);
    try {
      const [r1, r2, r3] = await Promise.all([
        api.familyInfo(),
        PLANS_ENABLED ? api.familyPlanShare().catch(() => null) : Promise.resolve(null),
        api.familyLocationAll().catch(() => null), // também aquece a fonte do mapa
      ]);
      if (r1?.success && r1?.data) {
        const d = r1.data;
        // members é IRMÃO de family (data.members); my_role / is_owner no nível data.
        const members = Array.isArray(d.members) ? d.members.filter(m => m && typeof m.email === 'string' && m.email) : [];
        setFamily({ ...(d.family || {}), members, my_role: d.my_role, is_owner: !!d.is_owner });
      } else {
        // O backend auto-cria a família solo; isto é raro. Sintetiza uma família
        // mínima com o usuário logado p/ a tela nunca ficar em branco.
        setFamily({
          id: 'self', name: '', owner_email: myEmail, is_owner: true, my_role: 'parent',
          members: [{ email: myEmail || 'me', name: user?.name || myEmail || t('common.you'), online: true, presence: 'online', role: 'parent' }],
        });
      }
      if (r2?.success && r2.data) setPlanShare(r2.data);
      const locs = r3?.data?.locations || r3?.locations;
      if (Array.isArray(locs)) {
        const map = {};
        locs.forEach(l => { if (l?.email && l.updated_at) map[lower(l.email)] = l; });
        setLocations(map);
      }
    } catch {
      setErrored(true);
    } finally {
      setLoading(false);
    }
  }, [myEmail, user?.name, t]);

  useEffect(() => { loadInfo(); shared.loadAll(); }, [loadInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link /family?join=<token> → folha "Entrar com convite" preenchida.
  const joinParam = typeof params?.join === 'string' ? params.join : '';
  useEffect(() => {
    if (!joinParam) return;
    setJoinValue(joinParam);
    setJoinOpen(true);
  }, [joinParam]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { haptic.light(); } catch {}
    await Promise.all([loadInfo(), shared.loadAll()]);
    setRefreshing(false);
  }, [loadInfo, shared]);

  const members = useMemo(() => {
    const list = family?.members || [];
    // Eu primeiro, depois o responsável, depois quem está online.
    const owner = lower(family?.owner_email);
    return [...list].sort((a, b) => {
      const sa = (lower(a.email) === myEmail ? 4 : 0) + (lower(a.email) === owner ? 2 : 0) + (isOnline(a) ? 1 : 0);
      const sb = (lower(b.email) === myEmail ? 4 : 0) + (lower(b.email) === owner ? 2 : 0) + (isOnline(b) ? 1 : 0);
      return sb - sa;
    });
  }, [family?.members, family?.owner_email, myEmail]);
  const isOwner = !!family?.is_owner;
  const myRole = family?.my_role || (isOwner ? 'parent' : 'child');
  const isKid = myRole === 'child' && !isOwner;
  const canInvite = isOwner || myRole === 'parent' || myRole === 'spouse';
  const ownerEmail = family?.owner_email || '';
  const memberCount = members.length;
  const onlineCount = useMemo(() => members.filter(m => isOnline(m) && lower(m.email) !== myEmail).length, [members, myEmail]);

  const openInvite = useCallback((role = 'child') => {
    try { haptic.light(); } catch {}
    setInviteRole(role);
    setInviteOpen(true);
  }, []);

  // ── Entrar por link/código colado ──
  const handleJoin = async () => {
    const raw = joinValue.trim();
    if (!raw) { Alert.alert(t('family.invite.title'), t('family.join.needValue')); return; }
    const m = raw.match(/family\/join\/([^\s/?#]+)/i);
    const token = m ? m[1] : raw;
    setJoinBusy(true);
    try {
      const r = await api.familyJoin(token);
      if (r?.success) {
        try { haptic.success(); } catch {}
        setJoinOpen(false); setJoinValue('');
        setLoading(true);
        await loadInfo();
        shared.loadAll();
      } else {
        Alert.alert(t('family.invite.title'), r?.message || t('family.join.invalid'));
      }
    } catch { Alert.alert(t('family.invite.title'), t('common.networkError')); }
    finally { setJoinBusy(false); }
  };

  // ── Renomear (responsável, otimista) ──
  const openRename = () => {
    if (!isOwner) { Alert.alert(t('family.nameTitle'), t('family.ownerOnlyRename')); return; }
    setRenameValue(family?.name || '');
    setRenameOpen(true);
  };
  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    const prevName = family?.name;
    setFamily(prev => prev ? { ...prev, name } : prev);
    setRenameOpen(false);
    try { haptic.success(); } catch {}
    try { const r = await api.familyUpdate({ name }); if (!r?.success) setFamily(prev => prev ? { ...prev, name: prevName } : prev); }
    catch { setFamily(prev => prev ? { ...prev, name: prevName } : prev); }
  };

  // ── Remover membro (responsável) ──
  const confirmRemove = (member) => {
    const label = member.name || member.email;
    const doRemove = async () => { try { await api.familyRemoveMember(member.email); } catch {} loadInfo(); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(t('family.remove.confirm', { name: label }))) doRemove();
    } else {
      Alert.alert(t('family.remove.title'), t('family.remove.confirm', { name: label }), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.remove'), style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  // ── Sair (não responsável) ──
  const confirmLeave = () => {
    const doLeave = async () => { try { await api.familyLeave(); } catch {} setLoading(true); await loadInfo(); shared.loadAll(); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(t('family.leave.confirmWeb'))) doLeave();
    } else {
      Alert.alert(t('family.leave.title'), t('family.leave.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('community.leave'), style: 'destructive', onPress: doLeave },
      ]);
    }
  };

  // ── Encontrar minha família → pré-carrega e abre o mapa ──
  const openFamilyMap = () => {
    try { haptic.light(); } catch {}
    api.familyLocationAll().catch(() => {});
    try { require('../services/snapMapPrefetch').prefetchSnapMap(); } catch {} // [2026-10-12 snapmap-speed]
    router.push('/snap-map');
  };

  const openChatWith = (email) => {
    try { require('../services/openConversation').openConversation('/chat-conversation?email=' + encodeURIComponent(email), { source: 'family' }); }
    catch { router.push('/chat-conversation?email=' + encodeURIComponent(email)); }
  };

  // Toque no cartão: eu → nada além do toque; outros → mensagem / remover.
  const onMemberPress = (m, isMe) => {
    try { haptic.light(); } catch {}
    if (isMe) return;
    const label = memberLabel(m);
    const buttons = [{ text: t('family.hub.sendMessage'), onPress: () => openChatWith(m.email) }];
    if (isOwner) buttons.push({ text: t('common.remove'), style: 'destructive', onPress: () => confirmRemove(m) });
    buttons.push({ text: t('common.cancel'), style: 'cancel' });
    if (Platform.OS === 'web') { openChatWith(m.email); return; }
    Alert.alert(label, m.email, buttons);
  };

  const openSheet = (k) => { try { haptic.select(); } catch {} setSheet(k); };

  const header = USE_NATIVE_HEADER ? (
    <Stack.Screen options={nativeHeaderOptions({
      colors,
      isDark,
      title: t('menu.family'),
      largeTitle: true,
      headerShadowVisible: false,
      headerStyle: { backgroundColor: c.pageBg },
      headerLargeStyle: { backgroundColor: c.pageBg },
      contentStyle: { backgroundColor: c.pageBg },
      headerRight: canInvite && !loading && !errored ? () => (
        <HeaderIconButton onPress={() => openInvite('child')} accessibilityLabel={t('family.invite.cta')}>
          <IconPlus size={22} color={colors.text} />
        </HeaderIconButton>
      ) : () => null,
    })} />
  ) : (
    <View style={[st.webHeader, { paddingTop: insets.top + 6, backgroundColor: c.pageBg }]}>
      <Pressable onPress={() => router.back()} style={st.webBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
        <IconArrowLeft size={22} color={c.text} />
      </Pressable>
      <Text style={[st.webTitle, { color: c.text }]} accessibilityRole="header">{t('menu.family')}</Text>
      {canInvite && !loading && !errored ? (
        <Pressable onPress={() => openInvite('child')} style={st.webBtn} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
          <IconPlus size={22} color={c.text} />
        </Pressable>
      ) : <View style={st.webBtn} />}
    </View>
  );

  if (loading) {
    return (
      <View style={[st.container, { backgroundColor: c.pageBg }]}>
        {header}
        <NativeInsetView><FamilySkeleton /></NativeInsetView>
      </View>
    );
  }

  if (errored) {
    return (
      <View style={[st.container, { backgroundColor: c.pageBg }]}>
        {header}
        <NativeInsetView contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <GraphiteTile Icon={IconUsers} size={64} radius={32} />
          <Text style={{ fontSize: 20, fontWeight: '700', color: c.text, marginTop: 16, marginBottom: 6 }}>{t('family.loadErrorTitle')}</Text>
          <Text style={{ fontSize: 15, color: c.secondary, textAlign: 'center', marginBottom: 22, lineHeight: 20 }}>{t('family.loadErrorBody')}</Text>
          <PressableScale onPress={() => { try { require('../utils/userRetry').noteUserRetry(); } catch {} setLoading(true); loadInfo(); shared.loadAll(); }}
            style={[st.pill, { backgroundColor: c.pill }]} accessibilityRole="button" accessibilityLabel={t('common.tryAgain')}>
            <Text style={[st.pillText, { color: c.onPill }]}>{t('common.tryAgain')}</Text>
          </PressableScale>
        </NativeInsetView>
      </View>
    );
  }

  // Grade de atalhos (3 colunas; 2 em telas muito estreitas).
  const cols = width < 340 ? 2 : 3;
  const gridW = Math.min(width, 720) - 32;
  const tileW = Math.floor((gridW - (cols - 1) * 10) / cols);
  const pendingShop = (shared.shopping || []).filter(x => !x.checked).length;
  const tiles = [
    { k: 'map', Icon: IconMap, label: t('family.hub.tile.map'), sub: onlineCount > 0 ? t('family.onlineCount', { n: onlineCount }) : t('family.hub.tile.mapSub'), onPress: openFamilyMap },
    { k: 'chat', Icon: IconMessageCircle, label: t('family.hub.tile.chat'), sub: t('family.hub.tile.chatSub'), onPress: () => router.push('/chat-new') },
    { k: 'shop', Icon: IconCart, label: t('family.hub.tile.shopping'), sub: pendingShop ? t('family.hub.pendingN', { n: pendingShop }) : t('family.hub.tile.shoppingSub'), onPress: () => openSheet('shopping') },
    { k: 'album', Icon: IconImage, label: t('family.hub.tile.album'), sub: shared.album && shared.album.length ? t('family.hub.photosN', { n: shared.album.length }) : t('family.hub.tile.albumSub'), onPress: () => openSheet('album') },
    { k: 'cal', Icon: IconCalendar, label: t('family.hub.tile.calendar'), sub: shared.upcoming && shared.upcoming.length ? t('family.hub.eventsN', { n: shared.upcoming.length }) : t('family.hub.tile.calendarSub'), onPress: () => openSheet('calendar') },
    !isKid && { k: 'parental', Icon: IconShield, label: t('family.hub.tile.parental'), sub: t('family.hub.tile.parentalSub'), onPress: () => router.push('/parental') },
  ].filter(Boolean);

  const myRoleLabel = isOwner ? t('family.role.owner')
    : myRole === 'spouse' ? t('family.role.spouse')
      : myRole === 'child' ? t('family.role.child') : t('family.hub.role.adult');

  return (
    <View style={[st.container, { backgroundColor: c.pageBg }]}>
      {header}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 + (USE_NATIVE_HEADER ? 0 : insets.bottom), paddingTop: USE_NATIVE_HEADER ? 8 : 4 }}
        {...nativeScrollInsetProps()}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.secondary} colors={[c.text]} />}
      >
        {/* ── Capa ── */}
        <View style={[st.hero, { backgroundColor: c.cardBg, marginHorizontal: 16 }]}>
          <AvatarStack members={members} />
          <Pressable onPress={openRename} disabled={!isOwner} accessibilityRole="button" accessibilityLabel={isOwner ? t('family.rename') : (family?.name || t('family.myFamily'))}
            style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }, pressed && { opacity: 0.6 }]}>
            <Text style={[st.heroTitle, { color: c.text }]} numberOfLines={2}>{family?.name || t('family.myFamily')}</Text>
            {isOwner && <IconEdit size={17} color={c.secondary} />}
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8 }}>
            <Text style={{ color: c.secondary, fontSize: 15 }}>
              {t(memberCount === 1 ? 'family.memberCount1' : 'family.memberCountN', { n: memberCount })}
              {onlineCount > 0 ? ` · ${t('family.onlineCount', { n: onlineCount })}` : ''}
            </Text>
            <View style={[st.badge, { borderColor: c.separator }]}>
              {isOwner && <IconStar size={11} color={c.text} />}
              <Text style={{ color: c.text, fontSize: 12, fontWeight: '600' }}>{myRoleLabel}</Text>
            </View>
          </View>
          {canInvite && (
            <PressableScale onPress={() => openInvite('child')} style={[st.pill, { backgroundColor: c.pill, marginTop: 18, alignSelf: 'stretch' }]} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
              <IconPlus size={18} color={c.onPill} />
              <Text style={[st.pillText, { color: c.onPill }]}>{t('family.invite.cta')}</Text>
            </PressableScale>
          )}
        </View>

        {/* ── Membros ── */}
        <HubSectionHeader title={t('community.members')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
          {members.map((m, idx) => {
            const me = lower(m.email) === myEmail;
            return (
              <MemberCard key={m.email || idx} member={m} index={idx} isMe={me} ownerEmail={ownerEmail}
                location={locations[lower(m.email)]} onPress={() => onMemberPress(m, me)} />
            );
          })}
          {canInvite && memberCount > 1 && <AddMemberCard onPress={() => openInvite('child')} />}
        </ScrollView>
        {canInvite && memberCount <= 1 && <View style={{ marginTop: 10 }}><InviteEmpty onInvite={openInvite} /></View>}

        {/* ── Atalhos ── */}
        <HubSectionHeader title={t('family.hub.quick')} />
        <View style={[st.grid, { width: gridW }]}>
          {tiles.map(tl => <QuickTile key={tl.k} Icon={tl.Icon} label={tl.label} sub={tl.sub} onPress={tl.onPress} width={tileW} />)}
        </View>

        {/* ── Prévias reais ── */}
        <HubSectionHeader title={t('family.hub.shared')} />
        <View style={{ gap: 12 }}>
          <ShoppingPreview data={shared} onOpen={() => openSheet('shopping')} />
          <NextEventPreview data={shared} onOpen={() => openSheet('calendar')} onAdd={() => openSheet('calendarAdd')} />
          <AlbumPreview data={shared} onOpen={() => openSheet('album')} />
        </View>

        {/* ── Plano (gated) ── */}
        {PLANS_ENABLED && (
          <SettingsGroup header={t('family.sharedSection')}>
            <SettingsRow
              icon={IconStar}
              title={planShare?.plan_name ? t('family.plan.named', { name: planShare.plan_name }) : t('family.plan.default')}
              subtitle={planShare?.shared ? t('family.plan.sharedWith', { n: planShare.shared_with || memberCount }) : t('family.plan.shareUpTo')}
              value={planShare?.shared ? t('plans.active') : undefined}
              onPress={() => router.push('/plans')}
            />
          </SettingsGroup>
        )}

        {/* ── Ajustes ── */}
        <SettingsGroup header={t('family.settings')}>
          <SettingsRow
            icon={IconUsers}
            title={t('family.nameTitle')}
            subtitle={isOwner ? (family?.name || t('family.setName')) : t('family.ownerOnlyEdits', { name: family?.name || '—' })}
            onPress={openRename}
          />
          {!isKid && (
            <SettingsRow icon={IconShield} title={t('settings.parentalControls')} subtitle={t('family.parental.sub')} onPress={() => router.push('/parental')} />
          )}
          <SettingsRow icon={IconKey} title={t('family.join.rowTitle')} subtitle={t('family.join.rowSub')} onPress={() => { setJoinValue(''); setJoinOpen(true); }} />
          {!isOwner && (
            <SettingsRow icon={IconLogout} title={t('family.leave.title')} subtitle={t('family.leave.sub')} destructive onPress={confirmLeave} />
          )}
        </SettingsGroup>
      </ScrollView>

      {/* ── Folhas ── */}
      <FamilyInviteSheet
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        initialRole={inviteRole}
        familyName={family?.name}
        members={members}
        myEmail={myEmail}
        onInvited={loadInfo}
      />

      <ListSheet visible={sheet === 'shopping'} onClose={() => setSheet(null)}>
        <ShoppingSheetBody data={shared} />
      </ListSheet>
      <ListSheet visible={sheet === 'album'} onClose={() => setSheet(null)}>
        <AlbumSheetBody data={shared} />
      </ListSheet>
      <ListSheet visible={sheet === 'calendar' || sheet === 'calendarAdd'} onClose={() => setSheet(null)}>
        <CalendarSheetBody data={shared} startAdding={sheet === 'calendarAdd'} />
      </ListSheet>

      <FormSheet visible={renameOpen} onClose={() => setRenameOpen(false)} title={t('family.nameTitle')}>
        <TextInput value={renameValue} onChangeText={setRenameValue} placeholder={t('family.renamePh')} placeholderTextColor={c.secondary}
          style={[st.input, { color: c.text, backgroundColor: c.cardBg }]} maxLength={60} autoFocus returnKeyType="done" onSubmitEditing={handleRename} />
        <View style={st.btnRow}>
          <Pressable onPress={() => setRenameOpen(false)} style={[st.btn, { backgroundColor: c.chip }]} accessibilityRole="button">
            <Text style={[st.btnText, { color: c.text }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable onPress={handleRename} disabled={!renameValue.trim()} style={[st.btn, { backgroundColor: c.pill, opacity: renameValue.trim() ? 1 : 0.5 }]} accessibilityRole="button">
            <Text style={[st.btnText, { color: c.onPill }]}>{t('common.save')}</Text>
          </Pressable>
        </View>
      </FormSheet>

      <FormSheet visible={joinOpen} onClose={() => setJoinOpen(false)} title={t('family.join.modalTitle')} sub={t('family.join.modalSub')}>
        <TextInput value={joinValue} onChangeText={setJoinValue} placeholder={t('family.join.ph')} placeholderTextColor={c.secondary}
          autoCapitalize="none" autoCorrect={false} autoFocus={!joinValue}
          style={[st.input, { color: c.text, backgroundColor: c.cardBg }]} returnKeyType="go" onSubmitEditing={handleJoin} />
        <View style={st.btnRow}>
          <Pressable onPress={() => setJoinOpen(false)} style={[st.btn, { backgroundColor: c.chip }]} accessibilityRole="button">
            <Text style={[st.btnText, { color: c.text }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable onPress={handleJoin} disabled={joinBusy} style={[st.btn, { backgroundColor: c.pill, opacity: joinBusy ? 0.6 : 1 }]} accessibilityRole="button">
            {joinBusy ? <ActivityIndicator color={c.onPill} /> : <Text style={[st.btnText, { color: c.onPill }]}>{t('meetings.join')}</Text>}
          </Pressable>
        </View>
      </FormSheet>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 8 },
  webBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  webTitle: { fontSize: 17, fontWeight: '600' },

  hero: { borderRadius: 24, alignItems: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 20 },
  heroTitle: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5, textAlign: 'center', flexShrink: 1 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 24 },
  pillText: { fontSize: 16, fontWeight: '600' },

  memberCard: { width: 118, borderRadius: 18, alignItems: 'center', paddingTop: 16, paddingBottom: 14, paddingHorizontal: 8 },
  addCard: { borderWidth: 1.2, borderStyle: 'dashed', backgroundColor: 'transparent' },
  onlineDot: { position: 'absolute', right: 1, bottom: 1, width: 15, height: 15, borderRadius: 8, borderWidth: 2.5 },
  memberName: { fontSize: 15, fontWeight: '600', marginTop: 10, maxWidth: '100%' },
  memberRole: { fontSize: 13, marginTop: 2 },
  memberStatus: { fontSize: 12, marginTop: 4, fontWeight: '500' },

  emptyCard: { marginHorizontal: 16, borderRadius: 18, padding: 18 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptySub: { fontSize: 15, lineHeight: 20, marginTop: 4 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  roleChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignSelf: 'center' },
  tile: { borderRadius: 18, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12, minHeight: 112 },
  tileLabel: { fontSize: 15, fontWeight: '600', marginTop: 12, letterSpacing: -0.2 },
  tileSub: { fontSize: 12, marginTop: 2 },

  sheetTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, paddingHorizontal: 4 },
  sheetSub: { fontSize: 15, lineHeight: 20, marginTop: 5, paddingHorizontal: 4 },
  input: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 11, fontSize: 16, marginTop: 16 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { flex: 1, borderRadius: 999, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
});

export default function FamilyScreen() {
  return <ErrorBoundary><FamilyScreenInner /></ErrorBoundary>;
}
