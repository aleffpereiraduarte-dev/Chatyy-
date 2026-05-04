import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Platform } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconX } from './Icons';

export default function MeetBreakoutPanel({
  visible, onClose, isHost, breakoutRooms, onCreateBreakout, onEndBreakout, onAssign,
}) {
  const [creating, setCreating] = useState(false);
  const [roomCount, setRoomCount] = useState('2');
  const [roomNames, setRoomNames] = useState([]);
  const [timerMin, setTimerMin] = useState('');

  const { t } = useLanguage();

  if (!visible) return null;

  const handleStartCreate = () => {
    const n = Math.max(1, Math.min(10, parseInt(roomCount) || 2));
    const names = Array.from({ length: n }, (_, i) => `${t('meetBreakout.room')} ${i + 1}`);
    setRoomNames(names);
    setCreating(true);
  };

  const handleConfirmCreate = () => {
    const rooms = roomNames.map(name => ({ name, participants: [] }));
    onCreateBreakout?.(rooms, timerMin ? parseInt(timerMin) * 60 : null);
    setCreating(false);
    setRoomNames([]);
  };

  const updateRoomName = (index, text) => {
    setRoomNames(prev => prev.map((n, i) => i === index ? text : n));
  };

  const active = breakoutRooms && breakoutRooms.length > 0;

  return (
    <View style={s.overlay}>
      <View style={s.panel}>
        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>{t('meetBreakout.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <IconX size={20} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        {/* Active breakout rooms */}
        {active && (
          <FlatList
            data={breakoutRooms}
            keyExtractor={(_, i) => String(i)}
            style={s.list}
            renderItem={({ item, index }) => (
              <View style={s.roomCard}>
                <View style={s.roomHeader}>
                  <Text style={s.roomName}>{item.name}</Text>
                  <Text style={s.roomCount}>{t('meetBreakout.peopleCount', { count: item.participants?.length || 0 })}</Text>
                </View>
                {item.participants?.map((p, pi) => (
                  <Text key={pi} style={s.participant}>{p.displayName || p.email}</Text>
                ))}
                <TouchableOpacity
                  style={s.openBtn}
                  onPress={() => onAssign?.(index)}
                  activeOpacity={0.7}
                >
                  <Text style={s.openBtnText}>{t('meetBreakout.open')}</Text>
                </TouchableOpacity>
              </View>
            )}
            ListFooterComponent={
              isHost ? (
                <TouchableOpacity style={s.endAllBtn} onPress={onEndBreakout} activeOpacity={0.7}>
                  <Text style={s.endAllText}>{t('meetBreakout.endAll')}</Text>
                </TouchableOpacity>
              ) : null
            }
          />
        )}

        {/* Create form */}
        {!active && isHost && !creating && (
          <View style={s.createSection}>
            <Text style={s.label}>{t('meetBreakout.roomCount')}</Text>
            <TextInput
              style={s.input}
              value={roomCount}
              onChangeText={setRoomCount}
              keyboardType="number-pad"
              placeholderTextColor="#64748b"
              maxLength={2}
            />
            <TouchableOpacity style={s.createBtn} onPress={handleStartCreate} activeOpacity={0.7}>
              <Text style={s.createBtnText}>{t('meetBreakout.createRooms')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Name editing */}
        {!active && creating && (
          <View style={s.createSection}>
            <Text style={s.label}>{t('meetBreakout.roomNames')}</Text>
            {roomNames.map((name, i) => (
              <TextInput
                key={i}
                style={s.input}
                value={name}
                onChangeText={t => updateRoomName(i, t)}
                placeholderTextColor="#64748b"
              />
            ))}
            <Text style={s.label}>{t('meetBreakout.timerLabel')}</Text>
            <TextInput
              style={s.input}
              value={timerMin}
              onChangeText={setTimerMin}
              keyboardType="number-pad"
              placeholder={t('meetBreakout.noLimit')}
              placeholderTextColor="#64748b"
              maxLength={3}
            />
            <View style={s.row}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setCreating(false)} activeOpacity={0.7}>
                <Text style={s.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.createBtn} onPress={handleConfirmCreate} activeOpacity={0.7}>
                <Text style={s.createBtnText}>{t('meetBreakout.createAndOpen')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Not host */}
        {!active && !isHost && (
          <View style={s.empty}>
            <Text style={s.emptyText}>{t('meetBreakout.noActiveRooms')}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute', top: 0, bottom: 80, right: 0,
    width: Platform.OS === 'web' ? 340 : '100%',
    zIndex: 200, padding: 8,
  },
  panel: {
    flex: 1, backgroundColor: '#1e293b', borderRadius: 12,
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 24px rgba(0,0,0,0.4)' } : { elevation: 8 }),
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  title: { color: '#f1f5f9', fontSize: 16, fontWeight: '700' },
  list: { flex: 1, padding: 12 },
  roomCard: {
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10,
    padding: 12, marginBottom: 10,
  },
  roomHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  roomName: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  roomCount: { color: '#64748b', fontSize: 12 },
  participant: { color: '#94a3b8', fontSize: 13, paddingVertical: 2, paddingLeft: 4 },
  openBtn: {
    marginTop: 8, backgroundColor: '#A78BFA', borderRadius: 6,
    paddingVertical: 6, alignItems: 'center',
  },
  openBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  endAllBtn: {
    marginTop: 8, backgroundColor: '#dc2626', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center',
  },
  endAllText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  createSection: { padding: 16 },
  label: { color: '#94a3b8', fontSize: 13, marginBottom: 6, marginTop: 8 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, color: '#fff', fontSize: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', marginBottom: 8,
  },
  createBtn: {
    backgroundColor: '#A78BFA', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center', flex: 1,
  },
  createBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cancelBtn: {
    backgroundColor: '#374151', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center', flex: 1, marginRight: 8,
  },
  cancelBtnText: { color: '#94a3b8', fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', marginTop: 8 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyText: { color: '#64748b', fontSize: 14 },
});
