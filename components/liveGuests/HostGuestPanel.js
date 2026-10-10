// [multi-guest 2026-10-10] Painel do HOST p/ o palco multi-convidados:
//   • No palco (n/4): silenciar mic, desligar câmera, remover
//   • Pedidos (badge): aceitar / recusar
//   • Convidar: quem está assistindo agora → convite (o espectador confirma
//     com prévia de câmera; nunca liga a câmera de ninguém sem consentimento)
// Folha inferior absoluta (mesmo padrão dos outros sheets da live).
import React, { memo, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconMicOff, IconVideoOff, IconX, IconUserPlus, IconCheck } from '../Icons';

function Section({ title, right, children }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right ? <Text style={styles.sectionRight}>{right}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function RoundBtn({ onPress, label, children, busy, active }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.roundBtn, active && styles.roundBtnActive, pressed && { opacity: 0.6 }]}
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : children}
    </Pressable>
  );
}

function PillBtn({ onPress, label, primary, disabled, busy }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.pill, primary ? styles.pillPrimary : styles.pillGhost,
        (disabled && !busy) && { opacity: 0.4 }, pressed && { opacity: 0.7 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={primary ? '#000' : '#fff'} />
        : <Text style={[styles.pillText, primary && styles.pillTextPrimary]}>{label}</Text>}
    </Pressable>
  );
}

/**
 * props:
 *  visible, onClose, t, bottomInset, max
 *  guests:   [{ email, name, micMuted, camOff }]
 *  requests: [{ email, name }]
 *  viewers:  [{ email, name }]    (já sem host/convidados)
 *  invited:  Set<email>           (convites pendentes)
 *  busy:     Set<string>          (`${action}:${email}` em andamento)
 *  onAccept(email), onDecline(email), onInvite(email),
 *  onRemove(email), onMute(email, 'audio'|'video')
 */
function HostGuestPanel({
  visible, onClose, t, bottomInset = 0, max = 4,
  guests = [], requests = [], viewers = [], invited, busy,
  onAccept, onDecline, onInvite, onRemove, onMute,
}) {
  const [tab, setTab] = useState('requests');
  const full = guests.length >= max;
  const isBusy = (k) => !!(busy && busy.has && busy.has(k));
  const inv = invited || new Set();
  const tabs = useMemo(() => ([
    { key: 'requests', label: t('liveGuests.requests'), count: requests.length },
    { key: 'invite', label: t('liveGuests.invite'), count: 0 },
  ]), [t, requests.length]);
  if (!visible) return null;
  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('common.close')} />
      <View style={[styles.sheet, { paddingBottom: bottomInset + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.headRow}>
          <Text style={styles.title}>{t('liveGuests.panelTitle')}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={20} color="#fff" />
          </Pressable>
        </View>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingBottom: 6 }} keyboardShouldPersistTaps="handled">
          <Section title={t('liveGuests.onStage')} right={t('liveGuests.stageCount', { count: guests.length, max })}>
            {guests.length === 0 ? (
              <Text style={styles.empty}>{t('liveGuests.emptyStage')}</Text>
            ) : guests.map((g) => (
              <View key={g.email} style={styles.row}>
                <AvatarCircle email={g.email} name={g.name} size={36} />
                <Text style={styles.rowName} numberOfLines={1}>{g.name}</Text>
                <RoundBtn
                  label={t('liveGuests.muteMic')}
                  active={!!g.micMuted}
                  busy={isBusy(`audio:${g.email}`)}
                  onPress={() => !g.micMuted && onMute && onMute(g.email, 'audio')}
                >
                  <IconMicOff size={16} color={g.micMuted ? '#000' : '#fff'} />
                </RoundBtn>
                <RoundBtn
                  label={t('liveGuests.turnOffCam')}
                  active={!!g.camOff}
                  busy={isBusy(`video:${g.email}`)}
                  onPress={() => !g.camOff && onMute && onMute(g.email, 'video')}
                >
                  <IconVideoOff size={16} color={g.camOff ? '#000' : '#fff'} />
                </RoundBtn>
                <RoundBtn label={t('liveGuests.remove')} busy={isBusy(`remove:${g.email}`)} onPress={() => onRemove && onRemove(g.email)}>
                  <IconX size={16} color="#fff" />
                </RoundBtn>
              </View>
            ))}
          </Section>

          <View style={styles.tabs}>
            {tabs.map((tb) => (
              <Pressable
                key={tb.key}
                onPress={() => setTab(tb.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === tb.key }}
                style={[styles.tab, tab === tb.key && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>{tb.label}</Text>
                {tb.count > 0 ? (
                  <View style={[styles.badge, tab === tb.key && styles.badgeOnActive]}>
                    <Text style={[styles.badgeText, tab === tb.key && styles.badgeTextOnActive]}>{tb.count > 99 ? '99+' : String(tb.count)}</Text>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>

          {full ? <Text style={styles.fullNote}>{t('liveGuests.stageFull')}</Text> : null}

          {tab === 'requests' ? (
            requests.length === 0 ? <Text style={styles.empty}>{t('liveGuests.noRequests')}</Text>
              : requests.map((r) => (
                <View key={r.email} style={styles.row}>
                  <AvatarCircle email={r.email} name={r.name} size={36} />
                  <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                  <PillBtn label={t('liveGuests.decline')} busy={isBusy(`decline:${r.email}`)} onPress={() => onDecline && onDecline(r.email)} />
                  <PillBtn primary label={t('liveGuests.accept')} disabled={full} busy={isBusy(`accept:${r.email}`)} onPress={() => onAccept && onAccept(r.email)} />
                </View>
              ))
          ) : (
            viewers.length === 0 ? <Text style={styles.empty}>{t('liveGuests.noViewers')}</Text>
              : viewers.map((v) => {
                const done = inv.has(v.email);
                return (
                  <View key={v.email} style={styles.row}>
                    <AvatarCircle email={v.email} name={v.name} size={36} />
                    <Text style={styles.rowName} numberOfLines={1}>{v.name}</Text>
                    {done ? (
                      <View style={styles.invitedTag}>
                        <IconCheck size={14} color="rgba(255,255,255,0.75)" />
                        <Text style={styles.invitedText}>{t('liveGuests.invited')}</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => onInvite && onInvite(v.email)}
                        disabled={full || isBusy(`invite:${v.email}`)}
                        accessibilityRole="button"
                        accessibilityLabel={t('liveGuests.invite')}
                        style={({ pressed }) => [styles.pill, styles.pillPrimary, styles.inviteBtn, full && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
                      >
                        {isBusy(`invite:${v.email}`) ? <ActivityIndicator size="small" color="#000" /> : (
                          <>
                            <IconUserPlus size={14} color="#000" />
                            <Text style={[styles.pillText, styles.pillTextPrimary]}>{t('liveGuests.invite')}</Text>
                          </>
                        )}
                      </Pressable>
                    )}
                  </View>
                );
              })
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end', zIndex: 70, elevation: 70 },
  sheet: { backgroundColor: '#0b0b0b', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)' },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', alignSelf: 'center', marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  section: { marginTop: 8, marginBottom: 6 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sectionTitle: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  sectionRight: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  rowName: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600' },
  empty: { color: 'rgba(255,255,255,0.5)', fontSize: 13, paddingVertical: 12 },
  roundBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)' },
  roundBtnActive: { backgroundColor: '#fff' },
  pill: { minWidth: 76, height: 32, paddingHorizontal: 12, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pillPrimary: { backgroundColor: '#fff' },
  pillGhost: { backgroundColor: 'rgba(255,255,255,0.1)' },
  pillText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  pillTextPrimary: { color: '#000' },
  inviteBtn: { flexDirection: 'row', gap: 5 },
  invitedTag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  invitedText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.08)' },
  tabActive: { backgroundColor: '#fff' },
  tabText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: '#000' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  badgeOnActive: { backgroundColor: '#000' },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
  badgeTextOnActive: { color: '#fff' },
  fullNote: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 6 },
});

export default memo(HostGuestPanel);
