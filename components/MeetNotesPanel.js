import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconX } from './Icons';

export default function MeetNotesPanel({ visible, onClose, notes = '', onUpdateNotes }) {
  const { t } = useLanguage();
  const [text, setText] = useState(notes);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => { setText(notes); }, [notes]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const debouncedSave = useCallback((val) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setSaving(true);
      onUpdateNotes?.(val);
      setTimeout(() => { if (mountedRef.current) setSaving(false); }, 800);
    }, 3000);
  }, [onUpdateNotes]);

  const handleChange = (val) => {
    setText(val);
    debouncedSave(val);
  };

  if (!visible) return null;

  return (
    <View style={[s.panel, Platform.OS === 'web' && s.panelGlass]}>
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.headerTitle}>{t('meetNotes.title')}</Text>
          {saving && <Text style={s.savingLabel}>{t('meetNotes.saving')}</Text>}
        </View>
        <TouchableOpacity onPress={onClose} style={s.closeBtn}>
          <IconX size={18} color="#94a3b8" />
        </TouchableOpacity>
      </View>
      <TextInput
        style={s.editor}
        multiline
        value={text}
        onChangeText={handleChange}
        placeholder={t('meetNotes.placeholder')}
        placeholderTextColor="#475569"
        textAlignVertical="top"
      />
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: 340, maxWidth: '40%',
    backgroundColor: '#0f172a', borderLeftWidth: 1, borderLeftColor: '#1e293b', zIndex: 50,
  },
  panelGlass: { backgroundColor: 'rgba(15,23,42,0.95)', backdropFilter: 'blur(12px)' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1e293b',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { color: '#f1f5f9', fontSize: 16, fontWeight: '600' },
  savingLabel: { color: '#60a5fa', fontSize: 12, fontStyle: 'italic' },
  closeBtn: { padding: 4 },
  editor: {
    flex: 1, color: '#e2e8f0', fontSize: 14, lineHeight: 22,
    padding: 16, backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
});
