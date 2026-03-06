import { TouchableOpacity, View, Text, StyleSheet, Platform, Pressable, ScrollView } from 'react-native';
import { Colors } from '../constants/theme';

export default function MeetMoreMenu({ visible, onClose, isHost, options }) {
  if (!visible || !options?.length) return null;

  // Group options by section
  const sections = {};
  options.forEach(opt => {
    const sec = opt.section || 'Geral';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(opt);
  });
  const sectionEntries = Object.entries(sections);

  return (
    <Pressable style={s.backdrop} onPress={onClose}>
      <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
        {/* Drag handle */}
        <View style={s.handleWrap}>
          <View style={s.handle} />
        </View>

        <ScrollView style={s.scrollArea} showsVerticalScrollIndicator={false}>
          {sectionEntries.map(([sectionName, items], si) => (
            <View key={sectionName}>
              {sectionEntries.length > 1 && (
                <Text style={s.sectionTitle}>{sectionName}</Text>
              )}
              {items.map((opt, i) => (
                <TouchableOpacity
                  key={opt.label}
                  style={s.row}
                  onPress={() => { opt.onPress?.(); onClose(); }}
                  activeOpacity={0.6}
                >
                  {opt.icon ? (
                    <View style={s.iconWrap}>
                      {(() => { const IC = opt.icon; return <IC size={20} color={Colors.meetText} />; })()}
                    </View>
                  ) : <View style={s.iconWrap} />}
                  <Text style={[s.label, opt.destructive && s.destructive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
              {si < sectionEntries.length - 1 && <View style={s.divider} />}
            </View>
          ))}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 300, justifyContent: 'flex-end', alignItems: 'center',
    backgroundColor: Colors.overlay,
  },
  sheet: {
    backgroundColor: Colors.meetSurfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    width: '100%', maxWidth: 420, maxHeight: '60%',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }
      : { elevation: 10 }),
  },
  handleWrap: {
    alignItems: 'center', paddingVertical: 12,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.meetBorder,
  },
  scrollArea: {
    paddingHorizontal: 8, paddingBottom: 24,
  },
  sectionTitle: {
    color: Colors.meetTextSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 10, marginHorizontal: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.meetBorder,
    marginVertical: 8, marginHorizontal: 16,
  },
  iconWrap: { width: 28, marginRight: 14, alignItems: 'center', justifyContent: 'center' },
  label: { color: Colors.meetText, fontSize: 15, fontWeight: '500', flex: 1 },
  destructive: { color: '#f87171' },
});
