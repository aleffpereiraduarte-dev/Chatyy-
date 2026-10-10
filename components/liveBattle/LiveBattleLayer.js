// [live-pk 2026-10-10] Camada de interação da Batalha PK (host):
//   • folha "Batalha": lives no ar (amigos/seguidos primeiro) + Aleatório
//   • cartão "aguardando resposta" (30s, cancelar)
//   • cartão de convite recebido (30s, recusar/aceitar)
//   • confirmação "Encerrar batalha?"
//   • aviso curto (recusou, sem resposta, indisponível…)
// Espectador: só o aviso (nada de convites).
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Animated, Easing, StyleSheet } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconRefresh, IconZap } from '../Icons';
import { PHASE } from './battleLogic';
import { battleState } from './battleApi';
import {
  useBattleSelector, selPhase, selInvite, selSheet, selCandidates, selCandidatesLoading, selBusy, selNotice, selOffset,
} from './battleStore';

function Btn({ label, onPress, primary, busy, disabled, style, a11y }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={a11y || label}
      style={({ pressed }) => [styles.btn, primary ? styles.btnPrimary : styles.btnGhost, (disabled && !busy) && { opacity: 0.4 }, pressed && { opacity: 0.7 }, style]}
    >
      {busy ? <ActivityIndicator size="small" color={primary ? '#000' : '#fff'} />
        : <Text style={[styles.btnText, primary && styles.btnTextPrimary]} numberOfLines={1}>{label}</Text>}
    </Pressable>
  );
}

/** Barra de contagem regressiva (30s) — Animated nativo, sem re-render. */
function Countdown({ expiresAt, offset }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const total = 30000;
    const left = Math.max(0, (expiresAt || 0) - (Date.now() + (offset || 0)));
    v.setValue(Math.min(1, left / total));
    const a = Animated.timing(v, { toValue: 0, duration: left, easing: Easing.linear, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [expiresAt, offset, v]);
  return (
    <View style={styles.cdTrack}>
      <Animated.View style={[styles.cdFill, { transform: [{ scaleX: v }] }]} />
    </View>
  );
}

function useSecondsLeft(expiresAt, offset) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return Math.max(0, Math.ceil(((expiresAt || 0) - (now + (offset || 0))) / 1000));
}

function relationLabel(t, rel) {
  if (rel === 'friend') return t('liveBattle.friend');
  if (rel === 'following') return t('liveBattle.following');
  return '';
}

function PickSheet({ battle, t, bottomInset }) {
  const list = useBattleSelector(battle, selCandidates);
  const loading = useBattleSelector(battle, selCandidatesLoading);
  const busy = useBattleSelector(battle, selBusy);
  const [sending, setSending] = useState('');
  const send = async (sid) => { setSending(sid || 'random'); try { await battle.invite(sid); } finally { setSending(''); } };
  return (
    <View style={styles.sheetRoot} pointerEvents="box-none">
      <Pressable style={styles.backdrop} onPress={() => battle.closeSheet()} accessibilityRole="button" accessibilityLabel={t('liveBattle.close')} />
      <View style={[styles.sheet, { paddingBottom: 16 + bottomInset }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sheetTitle}>{t('liveBattle.title')}</Text>
            <Text style={styles.sheetSub}>{t('liveBattle.subtitle')}</Text>
          </View>
          <Pressable onPress={() => battle.reloadCandidates()} hitSlop={6} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t('liveBattle.refresh')}>
            <IconRefresh size={18} color="#fff" />
          </Pressable>
          <Pressable onPress={() => battle.closeSheet()} hitSlop={6} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t('liveBattle.close')}>
            <IconX size={20} color="#fff" />
          </Pressable>
        </View>
        <Pressable
          onPress={() => send(null)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={t('liveBattle.random')}
          style={({ pressed }) => [styles.randomRow, pressed && { opacity: 0.75 }]}
        >
          <View style={styles.randomIcon}><IconZap size={20} color="#000" /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowName}>{t('liveBattle.random')}</Text>
            <Text style={styles.rowSub}>{t('liveBattle.randomSub')}</Text>
          </View>
          {sending === 'random' ? <ActivityIndicator size="small" color="#fff" /> : null}
        </Pressable>
        <Text style={styles.sectionTitle}>{t('liveBattle.liveNow')}</Text>
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingBottom: 4 }}>
          {loading && list.length === 0 ? (
            <View style={styles.empty}><ActivityIndicator color="#fff" /></View>
          ) : list.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyText}>{t('liveBattle.noCandidates')}</Text></View>
          ) : list.map((c) => {
            const rel = relationLabel(t, c.relation);
            return (
              <View key={c.session_id} style={styles.row}>
                <AvatarCircle email={c.host_email} name={c.host_name} size={40} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{c.host_name || c.host_email.split('@')[0]}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {[rel, t('liveBattle.viewers', { count: c.viewers || 0 })].filter(Boolean).join('  ·  ')}
                  </Text>
                </View>
                <Btn label={t('liveBattle.invite')} primary busy={sending === c.session_id} disabled={busy && sending !== c.session_id} onPress={() => send(c.session_id)} />
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

function ConfirmEndSheet({ battle, t, bottomInset }) {
  const busy = useBattleSelector(battle, selBusy);
  return (
    <View style={styles.sheetRoot} pointerEvents="box-none">
      <Pressable style={styles.backdrop} onPress={() => battle.closeSheet()} accessibilityRole="button" accessibilityLabel={t('liveBattle.close')} />
      <View style={[styles.sheet, { paddingBottom: 16 + bottomInset }]}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle}>{t('liveBattle.endConfirmTitle')}</Text>
        <Text style={[styles.sheetSub, { marginBottom: 16 }]}>{t('liveBattle.endConfirmBody')}</Text>
        <View style={styles.btnRow}>
          <Btn label={t('liveBattle.keepGoing')} onPress={() => battle.closeSheet()} style={{ flex: 1 }} />
          <Btn label={t('liveBattle.endBattle')} primary busy={busy} onPress={() => battle.endBattle('host_ended')} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

function OutgoingCard({ battle, invite, t, top }) {
  const offset = useBattleSelector(battle, selOffset);
  const secs = useSecondsLeft(invite.inviteExpiresAt, offset);
  const name = invite.hostB.name || invite.hostB.email.split('@')[0];
  return (
    <View style={[styles.card, { top }]}>
      <View style={styles.cardRow}>
        <AvatarCircle email={invite.hostB.email} name={name} size={36} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{t('liveBattle.waiting', { name })}</Text>
          <Text style={styles.cardSub}>{t('liveBattle.secondsLeft', { count: secs })}</Text>
        </View>
        <Btn label={t('liveBattle.cancel')} onPress={() => battle.cancelInvite()} />
      </View>
      <Countdown expiresAt={invite.inviteExpiresAt} offset={offset} />
    </View>
  );
}

function IncomingCard({ battle, invite, t, top }) {
  const offset = useBattleSelector(battle, selOffset);
  const busy = useBattleSelector(battle, selBusy);
  const secs = useSecondsLeft(invite.inviteExpiresAt, offset);
  const name = invite.fromName || invite.hostA.name || invite.hostA.email.split('@')[0];
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }).start();
  }, [enter]);
  return (
    <Animated.View
      style={[styles.card, { top, opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }] }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.cardRow}>
        <AvatarCircle email={invite.hostA.email} name={name} size={40} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.cardTitle} numberOfLines={2}>{t('liveBattle.incoming', { name })}</Text>
          <Text style={styles.cardSub}>{t('liveBattle.incomingSub', { count: secs })}</Text>
        </View>
      </View>
      <View style={[styles.btnRow, { marginTop: 10 }]}>
        <Btn label={t('liveBattle.decline')} onPress={() => battle.respond(false)} disabled={busy} style={{ flex: 1 }} />
        <Btn label={t('liveBattle.accept')} primary busy={busy} onPress={() => battle.respond(true)} style={{ flex: 1 }} />
      </View>
      <Countdown expiresAt={invite.inviteExpiresAt} offset={offset} />
    </Animated.View>
  );
}

function Notice({ battle, t, top }) {
  const n = useBattleSelector(battle, selNotice);
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!n) return undefined;
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    const id = setTimeout(() => {
      Animated.timing(v, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => battle.clearNotice());
    }, 2600);
    return () => clearTimeout(id);
  }, [n, v, battle]);
  if (!n) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.notice, { top, opacity: v }]}>
      <Text style={styles.noticeText}>{t(n.key, n.params || undefined)}</Text>
    </Animated.View>
  );
}

/**
 * props: battle, t, isHost, topInset, bottomInset
 */
function LiveBattleLayer({ battle, t, isHost = false, topInset = 0, bottomInset = 0 }) {
  const phase = useBattleSelector(battle, selPhase);
  const invite = useBattleSelector(battle, selInvite);
  const sheet = useBattleSelector(battle, selSheet);
  const cardTop = topInset + 72;
  return (
    <>
      {isHost && phase === PHASE.OUTGOING && invite ? <OutgoingCard battle={battle} invite={invite} t={t} top={cardTop} /> : null}
      {isHost && phase === PHASE.INCOMING && invite ? <IncomingCard battle={battle} invite={invite} t={t} top={cardTop} /> : null}
      {isHost && sheet === 'pick' ? <PickSheet battle={battle} t={t} bottomInset={bottomInset} /> : null}
      {isHost && sheet === 'confirmEnd' ? <ConfirmEndSheet battle={battle} t={t} bottomInset={bottomInset} /> : null}
      <Notice battle={battle} t={t} top={cardTop} />
    </>
  );
}

/** Botão "Batalha" do host (pílula 44pt). */
// [2026-10-10] Só mostra o botão quando o backend da batalha existe (OTA pode
// chegar antes do deploy do chat.php). Sonda 1× por sessão do app.
let _battleBackendOk = null;
let _battleProbe = null;
function probeBattleBackend() {
  if (_battleBackendOk !== null) return Promise.resolve(_battleBackendOk);
  if (!_battleProbe) {
    _battleProbe = battleState('', false)
      .then((r) => { const m = String(r?.message || r?.error || ''); _battleBackendOk = !/unknown chat action/i.test(m); return _battleBackendOk; })
      .catch((e) => { const m = String(e?.message || ''); _battleBackendOk = !/unknown chat action/i.test(m); if (_battleBackendOk === true && !m) _battleBackendOk = true; _battleProbe = null; return _battleBackendOk; });
  }
  return _battleProbe;
}

export const BattleHostButton = memo(function BattleHostButton({ battle, t, style, disabled, guard }) {
  const [backendOk, setBackendOk] = useState(_battleBackendOk);
  useEffect(() => { let on = true; probeBattleBackend().then((v) => { if (on) setBackendOk(v); }); return () => { on = false; }; }, []);
  const phase = useBattleSelector(battle, selPhase);
  const inBattle = phase === PHASE.ACTIVE;
  const label = inBattle ? t('liveBattle.endBattle') : t('liveBattle.button');
  if (backendOk !== true && !inBattle) return null;
  return (
    <Pressable
      onPress={() => {
        if (!inBattle && typeof guard === 'function' && guard()) return;
        if (inBattle) battle.askEnd(); else battle.openPicker();
      }}
      disabled={disabled || phase === PHASE.OUTGOING || phase === PHASE.INCOMING || phase === PHASE.ENDED}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.hostBtn, inBattle && styles.hostBtnActive, (disabled || phase === PHASE.OUTGOING || phase === PHASE.INCOMING || phase === PHASE.ENDED) && { opacity: 0.5 }, pressed && { opacity: 0.75 }, style]}
    >
      <IconZap size={14} color={inBattle ? '#000' : '#fff'} />
      <Text style={[styles.hostBtnText, inBattle && { color: '#000' }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  sheetRoot: { ...StyleSheet.absoluteFillObject, zIndex: 80, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: '#111', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  sheetSub: { color: 'rgba(255,255,255,0.65)', fontSize: 13, marginTop: 2 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  randomRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60,
    paddingHorizontal: 12, borderRadius: 14, backgroundColor: '#1d1d1d', marginBottom: 14,
  },
  randomIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingVertical: 6 },
  rowName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  rowSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 },
  empty: { paddingVertical: 28, alignItems: 'center' },
  emptyText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center' },
  btnRow: { flexDirection: 'row', gap: 10 },
  btn: { minHeight: 44, minWidth: 88, paddingHorizontal: 16, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#fff' },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.14)' },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  btnTextPrimary: { color: '#000' },
  card: {
    position: 'absolute', left: 12, right: 12, zIndex: 70, overflow: 'hidden',
    padding: 12, paddingBottom: 14, borderRadius: 16, backgroundColor: 'rgba(17,17,17,0.96)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  cardSub: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'] },
  cdTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.15)' },
  cdFill: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%', backgroundColor: '#fff', transformOrigin: 'left' },
  notice: {
    position: 'absolute', alignSelf: 'center', left: 24, right: 24, zIndex: 90, alignItems: 'center',
  },
  noticeText: {
    color: '#000', backgroundColor: '#fff', fontSize: 13, fontWeight: '700',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, overflow: 'hidden', textAlign: 'center',
  },
  hostBtn: {
    minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#111111',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  hostBtnActive: { backgroundColor: '#fff' },
  hostBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});

export default memo(LiveBattleLayer);
