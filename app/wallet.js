// /wallet — diamond wallet hub.
//
// Renders:
//   • Big balance header with "Comprar diamantes" CTA (opens DiamondTopUpSheet).
//   • Pending creator payout pill (only visible if > 0).
//   • Quick-actions row: Enviar diamantes (placeholder picker — for now we
//     surface the action only from a profile peek; here it points at chat).
//   • Paginated ledger feed:
//       credit  → green +N ◆     (topup, receive, tip_recv)
//       debit   → red    -N ◆    (send, tip_send, promote)
//
// All data comes from wallet_history (server returns balance + items in one
// shot so the header paints without a second round-trip).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  RefreshControl, Platform, StatusBar, Alert, Modal, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconDiamond, IconX, IconSearch } from '../components/Icons';
import DiamondTopUpSheet from '../components/DiamondTopUpSheet';
import SendDiamondSheet from '../components/SendDiamondSheet';
import AvatarCircle from '../components/AvatarCircle';
import { formatInt } from '../utils/dateFormat';

function LedgerRow({ item, colors, isDark, t, lang }) {
  const isCredit = item.direction === 'credit';
  const sign = isCredit ? '+' : '-';
  const color = isCredit ? '#10B981' : '#EF4444';
  const kindLabel = (() => {
    const map = {
      topup:     t('wallet.kind.topup')    || 'Compra',
      send:      t('wallet.kind.send')     || 'Enviado',
      receive:   t('wallet.kind.receive')  || 'Recebido',
      tip_send:  t('wallet.kind.tipSend')  || 'Gorjeta enviada',
      tip_recv:  t('wallet.kind.tipRecv')  || 'Gorjeta recebida',
      promote:   t('wallet.kind.promote')  || 'Promoção',
      bonus:     t('wallet.kind.bonus')    || 'Bônus',
      daily_bonus: t('wallet.kind.bonus')  || 'Bônus',
    };
    // [WAVE 36 2026-05-20] When the row has no kind OR an unknown kind AND
    // amount > 0 credited, fall back to "Bônus" instead of showing a raw
    // server enum like "ledger_grant". QA saw "-0 ◆" rows with empty label.
    const fallback = (isCredit && (!item.kind || !map[item.kind]))
      ? (t('wallet.kind.bonus') || 'Bônus')
      : (item.kind || '');
    return map[item.kind] || fallback;
  })();
  const when = (() => {
    const ts = Number(item.created_at_ts) * 1000;
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  })();
  return (
    <View style={[styles.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)' }]}>
      <View style={styles.rowLeft}>
        <Text style={[styles.rowKind, { color: colors.text }]} numberOfLines={1}>{kindLabel}</Text>
        {item.counterparty ? (
          <Text style={[styles.rowCp, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.counterparty}
          </Text>
        ) : null}
        <Text style={[styles.rowWhen, { color: colors.textTertiary }]}>{when}</Text>
      </View>
      <Text style={[styles.rowAmount, { color }]}>
        {sign}{formatInt(item.amount, lang)} ◆
      </Text>
    </View>
  );
}

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();

  const [items, setItems] = useState([]);
  const [balance, setBalance] = useState(0);
  const [pendingPayout, setPendingPayout] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  // [WAVE 38 2026-05-20] "Enviar" botão precisa abrir um picker de contato
  // antes do SendDiamondSheet. Antes só fazia router.push('/chat') — user
  // reportou "botão não funciona". Agora abrimos um sheet que lista as
  // conversas diretas + tap leva ao SendDiamondSheet com o peer alvo.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerConvs, setPickerConvs] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [sendTarget, setSendTarget] = useState(null); // { email, name, avatar }

  const openSendPicker = useCallback(async () => {
    setPickerOpen(true);
    setPickerLoading(true);
    setPickerQuery('');
    try {
      const r = await api.chatConversations();
      // chat_list responses come in a couple shapes (Rust + PHP). Normalize
      // to a flat list of direct DMs only — group convs can't receive a
      // P2P diamond transfer.
      const raw = Array.isArray(r?.conversations) ? r.conversations
        : Array.isArray(r?.data?.conversations) ? r.data.conversations
        : Array.isArray(r?.data) ? r.data
        : Array.isArray(r) ? r
        : [];
      const directs = raw.filter(c => {
        const type = String(c.type || c.conv_type || 'direct').toLowerCase();
        if (type !== 'direct') return false;
        // Filter out self / saved-messages (chat com você mesmo) — can't
        // send diamonds to your own account.
        const peer = String(c.peer_email || c.other_email || c.email || '').toLowerCase();
        return peer && peer !== 'me' && peer !== 'self';
      });
      setPickerConvs(directs);
    } catch (e) {
      setPickerConvs([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const onPickerSelect = useCallback((conv) => {
    const email = conv.peer_email || conv.other_email || conv.email;
    const name = conv.peer_name || conv.name || conv.title || (email ? email.split('@')[0] : '');
    const avatar = conv.peer_avatar_url || conv.avatar_url || conv.photo_url;
    if (!email) return;
    setSendTarget({ email, name, avatar });
    setPickerOpen(false);
  }, []);

  const filteredPickerConvs = React.useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return pickerConvs;
    return pickerConvs.filter(c => {
      const name = String(c.peer_name || c.name || c.title || '').toLowerCase();
      const email = String(c.peer_email || c.other_email || c.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [pickerConvs, pickerQuery]);

  const load = useCallback(async ({ append = false } = {}) => {
    try {
      const offset = append ? items.length : 0;
      const r = await api.walletHistory({ limit: 50, offset });
      if (r?.success && r.data) {
        // [WAVE 36 2026-05-20] Drop zero/near-zero rows (Math.abs<1). Server
        // sometimes emits ledger no-ops (refunded promote, reconciled tip)
        // with amount=0 — these used to render as "-0 ◆" with an empty
        // label, which QA flagged as confusing. Keep credit rows even
        // amount=0 IF kind suggests a real event (e.g., daily bonus with
        // amount=0 because already-granted); those are filtered server-side.
        const next = (Array.isArray(r.data.items) ? r.data.items : [])
          .filter(it => Number.isFinite(Number(it?.amount)) && Math.abs(Number(it.amount)) >= 1);
        setItems(prev => append ? [...prev, ...next] : next);
        setBalance(Number(r.data.diamond_balance) || 0);
        setPendingPayout(Number(r.data.pending_payout_cents) || 0);
        setHasMore(!!r.data.has_more);
      }
    } catch (e) {
      // Silent — empty state will render.
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [items.length]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Daily login bonus — backend is idempotent (one grant per UTC day),
  // so cheap to call on every mount. If granted, show a quick toast
  // and bump the local balance so the user sees the new total without
  // a second roundtrip. Silent on already_today / network errors.
  const bonusFiredRef = useRef(false);
  useEffect(() => {
    if (bonusFiredRef.current) return;
    bonusFiredRef.current = true;
    (async () => {
      try {
        const r = await api.walletDailyBonus?.();
        if (r?.success && r?.data?.granted) {
          const amt = Number(r.data.amount) || 0;
          const streak = Number(r.data.streak_days) || 1;
          const newBal = Number(r.data.diamond_balance);
          if (!isNaN(newBal)) setBalance(newBal);
          const title = t('wallet.dailyBonusTitle') || 'Bem-vindo de volta!';
          const body = (t('wallet.dailyBonusBody') || '+{n} ◆ por entrar hoje.').replace('{n}', amt);
          const streakLine = streak > 1
            ? '\n' + (t('wallet.streakDays') || 'Sequência de {n} dias').replace('{n}', streak)
            : '';
          Alert.alert(title, body + streakLine);
          load();
        }
      } catch {}
    })();
  }, [t, load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const onEndReached = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    load({ append: true });
  }, [hasMore, load, loadingMore]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: (insets.top || 0) + 8 }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={styles.headBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.back') || 'Voltar'}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headTitle, { color: colors.text }]}>
          {t('wallet.myDiamonds') || 'Meus diamantes'}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      {/* Balance card */}
      <View style={[styles.balanceCard, {
        backgroundColor: isDark ? 'rgba(168,85,247,0.18)' : 'rgba(168,85,247,0.10)',
        borderColor: isDark ? 'rgba(168,85,247,0.40)' : 'rgba(168,85,247,0.25)',
      }]}>
        <Text style={[styles.balLabel, { color: colors.textSecondary }]}>
          {t('wallet.currentBalance') || 'Saldo atual'}
        </Text>
        <View style={styles.balRow}>
          <IconDiamond size={28} color="#A855F7" style={{ marginRight: 8 }} />
          <Text style={[styles.balVal, { color: colors.text }]}>
            {formatInt(balance, language)}
          </Text>
        </View>
        {pendingPayout > 0 ? (
          <TouchableOpacity
            onPress={() => router.push('/creator-earnings')}
            accessibilityRole="button"
            accessibilityLabel={t('creatorEarnings.title') || 'Meus Ganhos'}
            style={styles.payoutPillRow}
          >
            <Text style={[styles.payoutPill, { color: '#10B981' }]}>
              {t('wallet.pendingPayout') || 'Saque pendente'}: R$ {(pendingPayout / 100).toFixed(2).replace('.', ',')}
            </Text>
            <View style={styles.payoutCta}>
              <Text style={styles.payoutCtaText}>
                {t('creatorEarnings.cta') || 'Ver ganhos'}
              </Text>
            </View>
          </TouchableOpacity>
        ) : null}

        <View style={styles.ctaRow}>
          <TouchableOpacity
            onPress={() => router.push('/diamond-shop')}
            style={[styles.ctaBtn, { backgroundColor: '#A855F7' }]}
            accessibilityRole="button"
          >
            <Text style={styles.ctaBtnText}>{t('wallet.topup') || 'Comprar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={openSendPicker}
            style={[styles.ctaBtn, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#A855F7' }]}
            accessibilityRole="button"
            accessibilityLabel={t('wallet.sendAction') || 'Enviar diamantes'}
          >
            <Text style={[styles.ctaBtnText, { color: '#A855F7' }]}>
              {t('wallet.sendAction') || 'Enviar'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/wallet-cashout')}
            style={[styles.ctaBtn, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#10B981' }]}
            accessibilityRole="button"
            accessibilityLabel={t('wallet.cashoutAction') || 'Sacar via PIX'}
          >
            <Text style={[styles.ctaBtnText, { color: '#10B981' }]}>
              {t('wallet.cashoutAction') || 'Sacar'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={[styles.histTitle, { color: colors.textSecondary }]}>
        {t('wallet.history') || 'Histórico'}
      </Text>

      {loading ? (
        <View style={{ paddingTop: 30 }}>
          <ActivityIndicator color="#A855F7" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <LedgerRow item={item} colors={colors} isDark={isDark} t={t} lang={language} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A855F7" />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={(
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('wallet.historyEmpty') || 'Nenhuma transação ainda. Compre diamantes para começar.'}
            </Text>
          )}
          ListFooterComponent={loadingMore ? (
            <View style={{ paddingVertical: 12 }}>
              <ActivityIndicator color="#A855F7" size="small" />
            </View>
          ) : null}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}

      <DiamondTopUpSheet
        visible={topUpOpen}
        onClose={() => { setTopUpOpen(false); load(); }}
        onBalanceChange={(b) => { if (typeof b === 'number') setBalance(b); }}
      />

      {/* [WAVE 38] Picker sheet — listar conversas diretas para escolher
          o destinatário do envio de diamantes. Aparece quando user toca
          "Enviar" no header. Tap em contato → SendDiamondSheet. */}
      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: Math.max(insets.bottom, 16) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 }}>
              <View style={{ width: 34 }} />
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                {t('wallet.pickRecipient') || 'Enviar diamantes para'}
              </Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: isDark ? '#2a2a2a' : '#f1f1f4' }}>
              <IconSearch size={16} color={colors.textTertiary} />
              <TextInput
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder={t('common.search') || 'Buscar'}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 14, padding: 0 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
            {pickerLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color="#A855F7" />
              </View>
            ) : filteredPickerConvs.length === 0 ? (
              <View style={{ paddingVertical: 40, paddingHorizontal: 24 }}>
                <Text style={{ textAlign: 'center', color: colors.textTertiary, fontSize: 13 }}>
                  {pickerQuery
                    ? (t('common.noResults') || 'Nenhum contato encontrado')
                    : (t('wallet.noContactsBody') || 'Sem conversas ainda. Inicie um chat para enviar diamantes.')
                  }
                </Text>
              </View>
            ) : (
              <FlatList
                data={filteredPickerConvs}
                keyExtractor={(item, idx) => String(item.id || item.peer_email || idx)}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const email = item.peer_email || item.other_email || item.email || '';
                  const name = item.peer_name || item.name || item.title || (email ? email.split('@')[0] : '');
                  const avatar = item.peer_avatar_url || item.avatar_url || item.photo_url;
                  return (
                    <TouchableOpacity
                      onPress={() => onPickerSelect(item)}
                      activeOpacity={0.7}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12 }}
                    >
                      <AvatarCircle size={42} email={email} name={name} avatarUrl={avatar} />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={1}>{name || email}</Text>
                        {!!email && email !== name && (
                          <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 1 }} numberOfLines={1}>{email}</Text>
                        )}
                      </View>
                      <IconDiamond size={18} color="#A855F7" />
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* [WAVE 38] After picker selects a target, mount SendDiamondSheet.
          The sheet handles balance check + amount picker + wallet_send POST.
          On close we clear sendTarget and reload the wallet history so the
          new transfer surfaces in the ledger immediately. */}
      <SendDiamondSheet
        visible={!!sendTarget}
        onClose={() => setSendTarget(null)}
        toEmail={sendTarget?.email}
        toName={sendTarget?.name}
        toAvatarUrl={sendTarget?.avatar}
        onSent={() => { setSendTarget(null); load(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 14 },
  headBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 16, fontWeight: '700' },
  balanceCard: {
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    padding: 18, marginBottom: 16,
  },
  balLabel: { fontSize: 13 },
  balRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  balVal: { fontSize: 36, fontWeight: '900' },
  balDiamond: { fontSize: 28, color: '#A855F7' },
  payoutPill: { fontSize: 12, fontWeight: '700' },
  payoutPillRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 6, gap: 10,
  },
  payoutCta: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: '#10B981',
  },
  payoutCtaText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  ctaRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  ctaBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  ctaBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  histTitle: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flex: 1, paddingRight: 12 },
  rowKind: { fontSize: 14, fontWeight: '700' },
  rowCp: { fontSize: 12, marginTop: 2 },
  rowWhen: { fontSize: 11, marginTop: 2 },
  rowAmount: { fontSize: 16, fontWeight: '800' },
  empty: { textAlign: 'center', fontSize: 13, paddingVertical: 40 },
});
