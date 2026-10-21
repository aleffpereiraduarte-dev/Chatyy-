import { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconX, IconMic, IconMicOff, IconVideo, IconVideoOff, IconUsers, IconRaisedHand, IconMoreVert } from './Icons';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
// [2026-10-15 meet-v2] reunião é sempre escura (preto verdadeiro), independente do tema do app
const MEET_DARK = { surface: '#0b0b0b', text: '#fff', textSecondary: 'rgba(255,255,255,0.6)', textTertiary: 'rgba(255,255,255,0.4)', border: 'rgba(255,255,255,0.10)', error: '#FF453A', warning: '#fff' };

const AVATAR_COLORS = ['#5C5C5C', '#4A4A4A', '#6B6B6B', '#3D3D3D', '#545454', '#636363']; // [2026-10-10] P&B neutro

function hashColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function Avatar({ name, size = 36 }) {
  const letter = (name || '?')[0].toUpperCase();
  const bg = hashColor(name);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>{letter}</Text>
    </View>
  );
}

function LobbyRow({ peer, onAdmit, onDeny, colors, t }) {
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Avatar name={peer.displayName} />
      <View style={styles.rowInfo}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{peer.displayName}</Text>
        {peer.email ? <Text style={[styles.email, { color: colors.textSecondary }]} numberOfLines={1}>{peer.email}</Text> : null}
      </View>
      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#fff' }]} onPress={() => onAdmit(peer.peerId)}>
        <Text style={[styles.actionBtnText, { color: '#000' }]}>{t('meetParticipants.admit')}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: 'rgba(255,255,255,0.14)', marginLeft: 6 }]} onPress={() => onDeny(peer.peerId)}>
        <Text style={styles.actionBtnText}>{t('meetParticipants.deny')}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ParticipantRow({ participant, isHost, colors, onMute, onKick, onPromote, t }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Avatar name={participant.displayName} />
      <View style={styles.rowInfo}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{participant.displayName}{participant.isLocal ? ` (${t('meet.you')})` : ''}</Text>
          {(participant.role === 'host' || participant.role === 'co-host') && (
            <View style={[styles.badge, { backgroundColor: participant.role === 'host' ? '#111111' : '#111111' }]}>
              <Text style={styles.badgeText}>{participant.role === 'host' ? t('meetParticipants.host') : t('meetParticipants.coHost')}</Text>
            </View>
          )}
          {participant.handRaised && <IconRaisedHand size={16} color="#fff" />}
        </View>
        {participant.email ? <Text style={[styles.email, { color: colors.textSecondary }]} numberOfLines={1}>{participant.email}</Text> : null}
      </View>
      <View style={styles.statusIcons}>
        {participant.audioMuted
          ? <IconMicOff size={16} color={colors.textSecondary} />
          : <IconMic size={16} color={colors.textSecondary} />}
        <View style={{ width: 6 }} />
        {participant.videoMuted
          ? <IconVideoOff size={16} color={colors.textSecondary} />
          : <IconVideo size={16} color={colors.textSecondary} />}
      </View>
      {isHost && !participant.isLocal && participant.role !== 'host' && (
        <View style={styles.hostActions}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.more', 'Mais')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.kebab} onPress={() => setMenuOpen(!menuOpen)}>
            <IconMoreVert size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          {menuOpen && (
            <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TouchableOpacity style={styles.menuItem} onPress={() => { onMute(participant.peerId); setMenuOpen(false); }}>
                <Text style={[styles.menuText, { color: colors.text }]}>{t('meetParticipants.mute')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.menuItem} onPress={() => { onPromote(participant.peerId); setMenuOpen(false); }}>
                <Text style={[styles.menuText, { color: colors.text }]}>{t('meetParticipants.promote')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.menuItem} onPress={() => { onKick(participant.peerId); setMenuOpen(false); }}>
                <Text style={[styles.menuText, { color: '#dc2626' }]}>{t('meetParticipants.remove')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// strings usam {{count}} e o t() troca só {count} → sobrava "{2}"
const tc = (t, key, count) => String(t(key) || '').replace(/\{\{\s*count\s*\}\}|\{count\}/g, String(count));

export default function MeetParticipantsPanel({ visible, onClose, participants = [], lobbyPeers = [], isHost, onAdmit, onDeny, onKick, onMute, onPromote, topInset = 0 }) {
  useTheme();
  const colors = MEET_DARK;
  const { t } = useLanguage();

  if (!visible) return null;

  const panelWidth = Platform.OS === 'web' ? 320 : '100%';

  return (
    <View style={styles.overlay}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={[styles.panel, { width: panelWidth, backgroundColor: colors.surface, paddingTop: Platform.OS === 'web' ? 0 : topInset }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <IconUsers size={18} color={colors.text} />
          <Text style={[styles.headerTitle, { color: colors.text }]}>{tc(t, 'meetParticipants.title', participants.length)}</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {isHost && lobbyPeers.length > 0 && (
            <>
              <View style={[styles.sectionHeader, { borderLeftColor: '#d97706' }]}>
                <Text style={[styles.sectionTitle, { color: colors.warning || '#d97706' }]}>{tc(t, 'meetParticipants.lobby', lobbyPeers.length)}</Text>
              </View>
              {lobbyPeers.map(p => (
                <LobbyRow key={p.peerId} peer={p} onAdmit={onAdmit} onDeny={onDeny} colors={colors} t={t} />
              ))}
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
            </>
          )}

          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{tc(t, 'meetParticipants.inMeeting', participants.length)}</Text>
          </View>

          {participants.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textTertiary }]}>{t('meetParticipants.noParticipants')}</Text>
          ) : (
            participants.map(p => (
              <ParticipantRow key={p.peerId} participant={p} isHost={isHost} colors={colors}
                onMute={onMute} onKick={onKick} onPromote={onPromote} t={t} />
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    zIndex: 100,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  panel: {
    height: '100%',
    maxWidth: Platform.OS === 'web' ? 320 : 480,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    zIndex: 101,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    gap: Spacing.sm,
  },
  headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: '600' },
  body: { flex: 1 },
  bodyContent: { paddingBottom: Spacing.xl },
  sectionHeader: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  divider: { height: 1, marginVertical: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowInfo: { flex: 1, marginLeft: Spacing.sm },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: FontSize.base, fontWeight: '500', flexShrink: 1 },
  email: { fontSize: FontSize.xs, marginTop: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700' },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: BorderRadius.sm },
  badgeText: { color: '#fff', fontSize: FontSize.xs, fontWeight: '600' },
  hand: { fontSize: 14 },
  statusIcons: { flexDirection: 'row', alignItems: 'center', marginLeft: Spacing.sm },
  hostActions: { position: 'relative', marginLeft: 4 },
  kebab: { padding: 4 },
  kebabDots: { fontSize: 18, fontWeight: '700', lineHeight: 20 },
  menu: {
    position: 'absolute',
    right: 0,
    top: 28,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingVertical: 4,
    minWidth: 120,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    zIndex: 200,
  },
  menuItem: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  menuText: { fontSize: FontSize.base },
  actionBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: BorderRadius.sm },
  actionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  empty: { textAlign: 'center', paddingVertical: Spacing.xl, fontSize: FontSize.base },
});
