import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function MeetCaptionsOverlay({ enabled, captions = [] }) {
  const [visible, setVisible] = useState([]);

  useEffect(() => {
    if (!enabled) { setVisible([]); return; }
    const recent = captions.slice(-3);
    setVisible(recent);
    const timer = setTimeout(() => setVisible([]), 5000);
    return () => clearTimeout(timer);
  }, [enabled, captions]);

  if (!enabled || visible.length === 0) return null;

  return (
    <View pointerEvents="none" style={s.container}>
      {visible.map((cap) => (
        <View key={cap.id} style={s.line}>
          <Text style={s.speaker}>{cap.speaker}: </Text>
          <Text style={s.text}>{cap.text}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 90, left: 20, right: 20,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 10, zIndex: 40,
  },
  line: {
    flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4,
  },
  speaker: {
    color: '#60a5fa', fontSize: 14, fontWeight: '600',
  },
  text: {
    color: '#f1f5f9', fontSize: 14, flexShrink: 1,
  },
});
