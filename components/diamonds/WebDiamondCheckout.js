/**
 * WebDiamondCheckout — compra de diamantes por cartão (Stripe) SÓ no web.
 * iOS nunca monta isto (diretriz 3.1.1); Android usa Play Billing.
 *
 * Fluxo: stripe_diamond_payment_intent(sku) → client_secret →
 *   stripe.confirmCardPayment(client_secret, { payment_method: { card } })
 *   (3DS tratado pelo Stripe.js) → o webhook payment_intent.succeeded credita
 *   (idempotente por payment_intent_id) → re-lê o saldo algumas vezes.
 * Cartão salvo: um toque (payment_method_id) — o servidor confirma na hora.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import * as api from '../../services/api';
import { refreshWallet } from '../../services/diamonds';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconDiamond } from '../Icons';
import { formatInt } from '../../utils/dateFormat';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

let _stripePromise = null;
let _stripeKey = '';
function loadStripe(pk) {
  if (Platform.OS !== 'web' || !pk) return Promise.resolve(null);
  if (_stripePromise && _stripeKey === pk) return _stripePromise;
  _stripeKey = pk;
  _stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) { resolve(window.Stripe(pk)); return; }
    const sc = document.createElement('script');
    sc.src = 'https://js.stripe.com/v3/';
    const to = setTimeout(() => { _stripePromise = null; reject(new Error('stripe_timeout')); }, 15000);
    sc.onload = () => { clearTimeout(to); resolve(window.Stripe(pk)); };
    sc.onerror = () => { clearTimeout(to); _stripePromise = null; reject(new Error('stripe_load_failed')); };
    document.head.appendChild(sc);
  });
  return _stripePromise;
}

function brl(v) {
  const n = Number(v) || 0;
  try { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); } catch { return 'R$ ' + n.toFixed(2).replace('.', ','); }
}

export default function WebDiamondCheckout({ pack, publishableKey, onClose, onDone }) {
  const { t, language } = useLanguage();
  const [stage, setStage] = useState('form'); // form | paying | done | error
  const [msg, setMsg] = useState('');
  const [cards, setCards] = useState([]);
  const stripeRef = useRef(null);
  const cardRef = useRef(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || !pack) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const lc = await api.stripeDiamondListCards?.();
        const list = lc?.data?.cards || lc?.data?.payment_methods || lc?.data;
        if (!cancelled && Array.isArray(list)) setCards(list.slice(0, 3));
      } catch {}
      try {
        const stripe = await loadStripe(publishableKey);
        if (cancelled || !stripe) return;
        stripeRef.current = stripe;
        let el = null;
        for (let i = 0; i < 60 && !el; i++) {
          el = document.getElementById('dmd-card-element');
          if (!el) await new Promise(r => setTimeout(r, 50));
        }
        if (!el || cancelled) return;
        const card = stripe.elements().create('card', {
          hidePostalCode: true,
          style: { base: { fontSize: '16px', color: '#ffffff', '::placeholder': { color: '#8a8a8a' }, iconColor: '#bdbdbd' }, invalid: { color: '#ff6b6b' } },
        });
        card.mount(el);
        cardRef.current = card;
      } catch {
        if (!cancelled) { setStage('error'); setMsg(tr(t, 'diamondShop.webCardLoadFailed', 'Não foi possível carregar o pagamento por cartão. Tente novamente.')); }
      }
    })();
    return () => {
      cancelled = true;
      try { cardRef.current?.unmount(); } catch {}
      cardRef.current = null;
    };
  }, [pack, publishableKey, t]);

  const finish = useCallback(async () => {
    setStage('done');
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 800 : 1500));
      const w = await refreshWallet();
      if (w && typeof w.diamonds === 'number') onDone?.(w.diamonds);
    }
  }, [onDone]);

  const pay = useCallback(async (savedPmId) => {
    if (stage === 'paying') return;
    setStage('paying'); setMsg('');
    try {
      const r = await api.stripeDiamondPaymentIntent(pack.sku, savedPmId || null, false);
      if (!r?.success) {
        setStage('error');
        setMsg(r?.data?.feature_disabled ? tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.') : (r?.message && !/^[a-z_]+$/.test(r.message) ? r.message : tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.')));
        return;
      }
      const d = r.data || {};
      if (d.status === 'succeeded') { await finish(); return; }
      const stripe = stripeRef.current;
      if (!stripe || !d.client_secret) { setStage('error'); setMsg(tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.')); return; }
      const res = savedPmId
        ? await stripe.confirmCardPayment(d.client_secret)
        : await stripe.confirmCardPayment(d.client_secret, { payment_method: { card: cardRef.current } });
      if (res?.error) { setStage('error'); setMsg(res.error.message || tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.')); return; }
      await finish();
    } catch (e) {
      setStage('error'); setMsg(tr(t, 'gifts.network', 'Sem conexão. Nada foi cobrado.'));
    }
  }, [pack, stage, finish, t]);

  if (Platform.OS !== 'web' || !pack) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={stage === 'paying' ? undefined : onClose} />
      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.head}>
            <IconDiamond size={22} />
            <Text style={styles.title}>{formatInt(pack.diamonds, language)}</Text>
            <View style={{ flex: 1 }} />
            <Text style={styles.price}>{brl(pack.priceBrl)}</Text>
            <TouchableOpacity onPress={onClose} disabled={stage === 'paying'} style={styles.x} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
              <IconX size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          {stage === 'done' ? (
            <View style={{ alignItems: 'center', paddingVertical: 18 }}>
              <Text style={styles.okTitle}>{tr(t, 'diamondShop.webPaid', 'Pagamento aprovado')}</Text>
              <Text style={styles.sub}>{tr(t, 'diamondShop.webCrediting', 'Seus diamantes aparecem no saldo em instantes.')}</Text>
              <TouchableOpacity onPress={onClose} style={[styles.btn, { marginTop: 16 }]}><Text style={styles.btnText}>{tr(t, 'common.done', 'Concluir')}</Text></TouchableOpacity>
            </View>
          ) : (
            <>
              {cards.length ? cards.map((c) => (
                <TouchableOpacity key={c.id} onPress={() => pay(c.id)} disabled={stage === 'paying'} style={styles.saved} accessibilityRole="button">
                  <Text style={styles.savedText}>{`${String(c.brand || 'card').toUpperCase()} •••• ${c.last4 || ''}`}</Text>
                  <Text style={styles.savedPay}>{tr(t, 'diamondShop.payNow', 'Pagar')}</Text>
                </TouchableOpacity>
              )) : null}
              <Text style={styles.label}>{tr(t, 'diamondShop.cardLabel', 'Cartão de crédito')}</Text>
              <View style={styles.cardBox}>
                {/* eslint-disable-next-line react/no-unknown-property */}
                <div id="dmd-card-element" style={{ padding: '14px 12px', minHeight: 22 }} />
              </View>
              {msg ? <Text style={styles.err}>{msg}</Text> : null}
              <TouchableOpacity onPress={() => pay(null)} disabled={stage === 'paying'} style={styles.btn} accessibilityRole="button">
                {stage === 'paying' ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>{tr(t, 'diamondShop.payAmount', 'Pagar {amount}').replace('{amount}', brl(pack.priceBrl))}</Text>}
              </TouchableOpacity>
              <Text style={styles.fine}>{tr(t, 'diamondShop.webSecure', 'Pagamento processado pela Stripe. O cartão fica salvo para a próxima compra.')}</Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, backgroundColor: '#0b0b0b', borderRadius: 20, padding: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  title: { color: '#fff', fontSize: 20, fontWeight: '900' },
  price: { color: '#fff', fontSize: 16, fontWeight: '800' },
  x: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  label: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '700', marginTop: 8, marginBottom: 6 },
  cardBox: { borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(255,255,255,0.04)' },
  saved: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 14, height: 48, marginBottom: 8 },
  savedText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  savedPay: { color: '#fff', fontSize: 13, fontWeight: '900' },
  err: { color: '#FF6B6B', fontSize: 13, marginTop: 10 },
  btn: { height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  btnText: { color: '#000', fontSize: 15, fontWeight: '900' },
  fine: { color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', marginTop: 10 },
  okTitle: { color: '#fff', fontSize: 18, fontWeight: '900' },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', marginTop: 4 },
});
