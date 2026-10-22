// [privado 2026-10-22] Pedidos para seguir (perfil privado nível Instagram) + remover seguidores.
// Abas: Pedidos (follow_request_list → Confirmar / Excluir) · Seguidores (get_followers do dono → Remover).
// Rotas de entrada: meu perfil (linha "Pedidos para seguir"), Atividade, push "pediu para seguir você",
// Ajustes → Privacidade (Perfil privado).
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft } from '../components/Icons';
import { a11yLabel } from '../utils/a11yLabel';
import { useFollowRequestState, setPendingCount, refreshFollowRequestState } from '../services/followRequests';

// helpers fora do componente (React Compiler não otimiza try/catch com condicionais dentro do componente)
async function _safe(p) { try { return await p; } catch { return null; } }
function _haptic() { try { const h = require('../services/haptics'); if (h && h.hapticEvent) h.hapticEvent('success'); } catch {} }
function _toast(message) { try { require('../components/ui/Toast').showToast({ message, kind: 'error' }); } catch {} }
function _go(router, path) { try { router.push(path); } catch {} }
function _back(router) { try { if (router.canGoBack()) router.back(); else router.replace('/chat'); } catch {} }
function _confirm(title, msg, cancel, ok, onOk) {
  const buttons = [{ text: cancel, style: 'cancel' }, { text: ok, style: 'destructive', onPress: onOk }];
  try { require('../services/alerts').safeAlert(title, msg, buttons); return; } catch {}
  try { require('react-native').Alert.alert(title, msg, buttons); } catch { onOk(); }
}

function EmptyGlyph({ color, kind }) {
  // SVG próprio (sem emoji): pessoa + relógio (pedidos) / duas pessoas (seguidores)
  if (kind === 'followers') {
    return (
      <Svg width={56} height={56} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <Circle cx={9} cy={7} r={4} />
        <Path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </Svg>
    );
  }
  return (
    <Svg width={56} height={56} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={9} cy={7} r={4} />
      <Path d="M2 21v-2a4 4 0 0 1 4-4h5" />
      <Circle cx={17.5} cy={17.5} r={4.5} />
      <Path d="M17.5 15.5v2l1.4 1.2" />
    </Svg>
  );
}

function LockGlyph({ color }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={4} y={11} width={16} height={10} rx={2} />
      <Path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

export default function FollowRequestsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const tr = useCallback((k, fb) => { const v = t?.(k); return v && v !== k ? v : fb; }, [t]);
  const auth = useAuth();
  const me = String((auth && auth.user && auth.user.email) || '').toLowerCase();
  const fr = useFollowRequestState();

  const [tab, setTab] = useState('requests');
  const [reqs, setReqs] = useState({ items: [], loading: true, loaded: false, cursor: null, hasMore: false });
  const [fols, setFols] = useState({ items: [], loading: false, loaded: false, page: 1, hasMore: false });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState({}); // email → 'accept' | 'decline' | 'remove'
  const [done, setDone] = useState({}); // email → 'accepted' | 'declined' | 'removed'

  const loadReqs = useCallback(async (more = false) => {
    setReqs((s) => ({ ...s, loading: true }));
    const r = await _safe(api.followRequestList('incoming', more ? reqs.cursor : ''));
    if (r && r.success && r.data) {
      const list = Array.isArray(r.data.requests) ? r.data.requests : [];
      setReqs((s) => ({ items: more ? [...s.items, ...list] : list, loading: false, loaded: true, cursor: r.data.next_cursor || null, hasMore: !!r.data.has_more }));
      if (!more) setPendingCount(Number(r.data.count) || list.length);
    } else {
      setReqs((s) => ({ ...s, loading: false, loaded: true }));
    }
  }, [reqs.cursor]);

  const loadFols = useCallback(async (page = 1) => {
    if (!me) return;
    setFols((s) => ({ ...s, loading: true }));
    const r = await _safe(api.getFollowers(me, page));
    const list = r && r.success ? (Array.isArray(r.data?.users) ? r.data.users : []) : null;
    if (list) setFols((s) => ({ items: page > 1 ? [...s.items, ...list] : list, loading: false, loaded: true, page, hasMore: list.length >= 50 }));
    else setFols((s) => ({ ...s, loading: false, loaded: true }));
  }, [me]);

  useEffect(() => { loadReqs(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'followers' && !fols.loaded && !fols.loading) loadFols(1); }, [tab, fols.loaded, fols.loading, loadFols]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setDone({});
    await (tab === 'requests' ? loadReqs(false) : loadFols(1)).catch(() => {});
    refreshFollowRequestState();
    setRefreshing(false);
  }, [tab, loadReqs, loadFols]);

  const respond = useCallback(async (email, accept) => {
    if (!email || busy[email]) return;
    setBusy((b) => ({ ...b, [email]: accept ? 'accept' : 'decline' }));
    const r = await _safe(api.followRequestRespond(email, accept));
    setBusy((b) => { const n = { ...b }; delete n[email]; return n; });
    if (r && r.success) {
      setDone((d) => ({ ...d, [email]: accept ? 'accepted' : 'declined' }));
      setPendingCount(Number(r.data?.pending_count) || 0);
      if (accept) setFols((s) => ({ ...s, loaded: false }));
      _haptic();
    } else {
      _toast(tr('followReq.error', 'Não foi possível agora. Tente de novo.'));
    }
  }, [busy, tr]);

  const removeFollower = useCallback((u) => {
    const email = u && u.email;
    if (!email || busy[email]) return;
    const name = u.name || u.username || email.split('@')[0];
    const go = async () => {
      setBusy((b) => ({ ...b, [email]: 'remove' }));
      const r = await _safe(api.followerRemove(email));
      setBusy((b) => { const n = { ...b }; delete n[email]; return n; });
      if (r && r.success) setDone((d) => ({ ...d, [email]: 'removed' }));
      else _toast(tr('followReq.error', 'Não foi possível agora. Tente de novo.'));
    };
    const title = tr('followReq.removeTitle', 'Remover seguidor?');
    const msg = tr('followReq.removeBody', '{name} não será avisado de que foi removido dos seus seguidores.').split('{name}').join(name);
    _confirm(title, msg, tr('common.cancel', 'Cancelar'), tr('followReq.remove', 'Remover'), go);
  }, [busy, tr]);

  const openUser = useCallback((email) => {
    if (!email) return;
    _go(router, `/u/${encodeURIComponent(email)}`);
  }, [router]);

  const btn = (label, onPress, primary, loading, key) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      disabled={!!loading}
      activeOpacity={0.8}
      style={[st.btn, { backgroundColor: primary ? colors.text : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.07)') }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? <ActivityIndicator size="small" color={primary ? colors.background : colors.text} />
        : <Text style={[st.btnTxt, { color: primary ? colors.background : colors.text }]} numberOfLines={1}>{label}</Text>}
    </TouchableOpacity>
  );

  const renderReq = ({ item }) => {
    const email = String(item.email || '').toLowerCase();
    const state = done[email];
    const b = busy[email];
    return (
      <TouchableOpacity onPress={() => openUser(email)} activeOpacity={0.7} style={st.row}>
        <AvatarCircle email={email} name={item.name || email} size={48} />
        <View style={st.mid}>
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>{item.name || email.split('@')[0]}</Text>
          <Text style={[st.sub, { color: colors.textSecondary }]} numberOfLines={1}>
            {state === 'accepted' ? tr('followReq.acceptedRow', 'Agora segue você')
              : state === 'declined' ? tr('followReq.declinedRow', 'Pedido excluído')
                : (item.username ? `@${item.username}` : tr('followReq.wantsToFollow', 'Quer seguir você'))}
          </Text>
        </View>
        {!state ? (
          <View style={st.btns}>
            {btn(tr('followReq.confirm', 'Confirmar'), () => respond(email, true), true, b === 'accept', 'a')}
            {btn(tr('followReq.delete', 'Excluir'), () => respond(email, false), false, b === 'decline', 'd')}
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };

  const renderFol = ({ item }) => {
    const email = String(item.email || '').toLowerCase();
    if (!email || email === me) return null;
    const removed = done[email] === 'removed';
    return (
      <TouchableOpacity onPress={() => openUser(email)} activeOpacity={0.7} style={st.row}>
        <AvatarCircle email={email} name={item.name || email} size={48} />
        <View style={st.mid}>
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>{item.name || email.split('@')[0]}</Text>
          <Text style={[st.sub, { color: colors.textSecondary }]} numberOfLines={1}>
            {removed ? tr('followReq.removedRow', 'Removido dos seguidores') : `@${item.username || email.split('@')[0]}`}
          </Text>
        </View>
        {!removed ? <View style={st.btns}>{btn(tr('followReq.remove', 'Remover'), () => removeFollower(item), false, busy[email] === 'remove', 'r')}</View> : null}
      </TouchableOpacity>
    );
  };

  const isReq = tab === 'requests';
  const cur = isReq ? reqs : fols;
  const pendingN = fr.pending || 0;

  const header = (
    <View>
      <View style={[st.seg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.06)' }]}>
        {[['requests', tr('followReq.tabRequests', 'Pedidos') + (pendingN > 0 ? ` (${pendingN})` : '')], ['followers', tr('followReq.tabFollowers', 'Seguidores')]].map(([k, label]) => {
          const on = tab === k;
          return (
            <TouchableOpacity key={k} onPress={() => setTab(k)} style={[st.segBtn, on && { backgroundColor: colors.background }]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
              <Text style={[st.segTxt, { color: on ? colors.text : colors.textSecondary }]} numberOfLines={1}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {isReq ? (
        <View style={st.hint}>
          <LockGlyph color={colors.textSecondary} />
          <Text style={[st.hintTxt, { color: colors.textSecondary }]}>
            {fr.private ? tr('followReq.hintPrivate', 'Sua conta é privada: só quem você aprovar vê suas publicações, o Mural e o Status.')
              : tr('followReq.hintPublic', 'Sua conta é pública. Ative "Perfil privado" em Ajustes → Privacidade para aprovar quem segue você.')}
          </Text>
        </View>
      ) : null}
    </View>
  );

  const empty = cur.loading && !cur.items.length ? (
    <View style={st.empty}><ActivityIndicator color={colors.textSecondary} /></View>
  ) : cur.loaded && !cur.items.length ? (
    <View style={st.empty}>
      <EmptyGlyph color={colors.textSecondary} kind={isReq ? 'requests' : 'followers'} />
      <Text style={[st.emptyT, { color: colors.text }]}>{isReq ? tr('followReq.emptyTitle', 'Nenhum pedido para seguir') : tr('followReq.emptyFollowers', 'Ninguém segue você ainda')}</Text>
      <Text style={[st.emptyS, { color: colors.textSecondary }]}>
        {isReq ? tr('followReq.emptyHint', 'Quando alguém pedir para seguir você, o pedido aparece aqui para você confirmar ou excluir.')
          : tr('followReq.emptyFollowersHint', 'Quem seguir você aparece aqui. Você pode remover qualquer seguidor.')}
      </Text>
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: tr('followReq.title', 'Pedidos para seguir') })} />
      ) : (
        <View style={[st.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
          <TouchableOpacity onPress={() => _back(router)} style={st.headerBtn} accessibilityRole="button" accessibilityLabel={a11yLabel('common.back', 'Voltar')}>
            <IconArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[st.headerTitle, { color: colors.text }]} numberOfLines={1}>{tr('followReq.title', 'Pedidos para seguir')}</Text>
          <View style={st.headerBtn} />
        </View>
      )}
      <FlatList
        {...nativeScrollInsetProps()}
        data={cur.items}
        keyExtractor={(it, i) => `${tab}:${it.email || i}`}
        renderItem={isReq ? renderReq : renderFol}
        extraData={[busy, done, tab]}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (cur.loading || !cur.hasMore) return;
          if (isReq) loadReqs(true); else loadFols((fols.page || 1) + 1);
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
        contentContainerStyle={{ paddingBottom: (insets.bottom || 0) + 24 }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  seg: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, padding: 3 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segTxt: { fontSize: 14, fontWeight: '600' },
  hint: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4 },
  hintTxt: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  mid: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12.5, marginTop: 2 },
  btns: { flexDirection: 'row', gap: 6 },
  btn: { minWidth: 82, height: 34, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  btnTxt: { fontSize: 13.5, fontWeight: '700' },
  empty: { alignItems: 'center', paddingHorizontal: 36, paddingTop: 56, gap: 10 },
  emptyT: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  emptyS: { fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
});
