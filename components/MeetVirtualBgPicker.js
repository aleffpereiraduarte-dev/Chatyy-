import { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Pressable, ScrollView } from 'react-native';
import { useLanguage } from '../context/LanguageContext';

function getBackgrounds(t) {
  return [
    { key: 'none', label: t('virtualBg.none'), icon: '\u274C', type: 'none' },
    { key: 'blur', label: t('virtualBg.blur'), icon: '\uD83D\uDCA7', type: 'blur' },
    { key: 'blur-light', label: t('virtualBg.blurLight'), icon: '\u2600\uFE0F', type: 'blur-light' },
    { key: 'gradient-ocean', label: t('virtualBg.ocean'), icon: '\uD83C\uDF0A', type: 'gradient', value: 'ocean', colors: ['#0077b6', '#00b4d8', '#90e0ef'] },
    { key: 'gradient-sunset', label: t('virtualBg.sunset'), icon: '\uD83C\uDF07', type: 'gradient', value: 'sunset', colors: ['#ff6b35', '#c2185b', '#4a148c'] },
    { key: 'gradient-forest', label: t('virtualBg.forest'), icon: '\uD83C\uDF33', type: 'gradient', value: 'forest', colors: ['#1b5e20', '#2e7d32', '#4caf50'] },
    { key: 'gradient-space', label: t('virtualBg.space'), icon: '\uD83C\uDF0C', type: 'gradient', value: 'space', colors: ['#000000', '#1a237e', '#0d0d2b'] },
    { key: 'gradient-aurora', label: t('virtualBg.aurora'), icon: '\u2728', type: 'gradient', value: 'aurora', colors: ['#0f0c29', '#302b63', '#92fe9d'] },
    { key: 'image-office', label: t('virtualBg.office'), icon: '\uD83C\uDFE2', type: 'image', value: '/meet/bg/office.jpg' },
    { key: 'image-beach', label: t('virtualBg.beach'), icon: '\uD83C\uDFD6\uFE0F', type: 'image', value: '/meet/bg/beach.jpg' },
  ];
}

function GradientPreview({ colors }) {
  if (!colors || colors.length < 2) return null;
  // Approximate gradient with horizontal color blocks
  return (
    <View style={previewStyles.gradient}>
      {colors.map((c, i) => (
        <View key={i} style={[previewStyles.colorBlock, { backgroundColor: c, flex: 1 }]} />
      ))}
    </View>
  );
}

const previewStyles = StyleSheet.create({
  gradient: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    flexDirection: 'row', borderRadius: 8, overflow: 'hidden', opacity: 0.5,
  },
  colorBlock: { height: '100%' },
});

export default function MeetVirtualBgPicker({ visible, onClose, onSelect, currentEffect }) {
  const { t } = useLanguage();

  if (!visible) return null;

  const BACKGROUNDS = getBackgrounds(t);

  const activeKey = !currentEffect ? 'none' :
    currentEffect === 'blur' ? 'blur' :
    currentEffect === 'blur-light' ? 'blur-light' :
    currentEffect.startsWith?.('gradient:') ? 'gradient-' + currentEffect.replace('gradient:', '') :
    currentEffect.includes?.('/') ? 'image-' + currentEffect.split('/').pop()?.replace('.jpg', '') : 'none';

  return (
    <Pressable style={s.backdrop} onPress={onClose}>
      <Pressable style={s.container} onPress={(e) => e.stopPropagation()}>
        <View style={s.handle} />
        <Text style={s.title}>{t('virtualBg.title')}</Text>
        <Text style={s.subtitle}>{t('virtualBg.subtitle')}</Text>

        <ScrollView horizontal={false} style={s.grid} contentContainerStyle={s.gridContent}>
          {BACKGROUNDS.map((bg) => {
            const isActive = activeKey === bg.key;
            return (
              <TouchableOpacity
                key={bg.key}
                style={[s.option, isActive && s.optionActive]}
                activeOpacity={0.7}
                onPress={() => {
                  onSelect?.(bg.type, bg.value);
                  if (bg.type === 'none') onClose?.();
                }}
              >
                {bg.colors && <GradientPreview colors={bg.colors} />}
                <Text style={s.optionIcon}>{bg.icon}</Text>
                <Text style={[s.optionLabel, isActive && s.optionLabelActive]}>{bg.label}</Text>
                {isActive && <View style={s.checkmark}><Text style={s.checkmarkText}>{'\u2713'}</Text></View>}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 250, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  container: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    paddingTop: 12,
    paddingHorizontal: 16,
    maxHeight: '55%',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignSelf: 'center', marginBottom: 12,
  },
  title: {
    color: '#fff', fontSize: 18, fontWeight: '700',
    textAlign: 'center', marginBottom: 4,
  },
  subtitle: {
    color: '#94a3b8', fontSize: 13,
    textAlign: 'center', marginBottom: 16,
  },
  grid: { flexGrow: 0 },
  gridContent: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', gap: 10,
    paddingBottom: 8,
  },
  option: {
    width: 80, height: 72, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'transparent',
    overflow: 'hidden',
  },
  optionActive: {
    borderColor: '#3b82f6',
    backgroundColor: 'rgba(59,130,246,0.15)',
  },
  optionIcon: {
    fontSize: 24, marginBottom: 4,
  },
  optionLabel: {
    color: '#cbd5e1', fontSize: 11, fontWeight: '600',
  },
  optionLabelActive: {
    color: '#60a5fa',
  },
  checkmark: {
    position: 'absolute', top: 4, right: 4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#3b82f6',
    alignItems: 'center', justifyContent: 'center',
  },
  checkmarkText: {
    color: '#fff', fontSize: 11, fontWeight: '700',
  },
});
