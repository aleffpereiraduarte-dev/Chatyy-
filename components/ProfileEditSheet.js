/**
 * ProfileEditSheet — inline edit for the signed-in user's profile.
 * Instagram-style: bottom sheet with name, username, bio, website.
 * Saves via update_profile. Avatar upload stays in the legacy /profile
 * screen for now since it needs the image picker pipeline.
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable,
  ScrollView, ActivityIndicator, Platform, StyleSheet, KeyboardAvoidingView,
} from 'react-native';
import * as api from '../services/api';
import AvatarCircle from './AvatarCircle';
import { IconX } from './Icons';

const MAX_BIO = 150;

function Field({ label, value, onChangeText, placeholder, multiline, maxLength, colors }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
      <Text style={{ fontSize: 12, color: colors?.textSecondary, fontWeight: '600' }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors?.textTertiary}
        style={{
          fontSize: 15, color: colors?.text,
          paddingVertical: 8, paddingHorizontal: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors?.border || '#eee',
          minHeight: multiline ? 60 : 36,
        }}
        multiline={!!multiline}
        maxLength={maxLength}
      />
      {multiline && maxLength && (
        <Text style={{ fontSize: 11, color: colors?.textTertiary, textAlign: 'right' }}>
          {value?.length || 0} / {maxLength}
        </Text>
      )}
    </View>
  );
}

export default function ProfileEditSheet({
  visible, onClose, initial, onSaved, colors, isDark, t, currentEmail,
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Hydrate from profile_get identity every time the sheet opens
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name || '');
    setUsername(initial?.username || '');
    setBio(initial?.bio || '');
    setWebsite(initial?.website || '');
    setErr('');
  }, [visible, initial]);

  const handleSave = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.updateProfile({
        name: name.trim(),
        username: username.trim().replace(/^@+/, ''),
        bio: bio.trim(),
        website: website.trim(),
      });
      if (r?.success) {
        onSaved?.({ name, username, bio, website });
        onClose?.();
      } else {
        setErr(r?.message || t?.('profile.saveFailed') || 'Não foi possível salvar');
      }
    } catch (e) {
      setErr(e?.message || t?.('common.networkError') || 'Erro de rede');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <Pressable
            style={{
              backgroundColor: colors?.background || '#fff',
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              maxHeight: '92%',
            }}
            onPress={e => e.stopPropagation?.()}
          >
            {/* Drag handle */}
            <View style={{ alignItems: 'center', paddingTop: 10 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
            </View>

            {/* Header with Cancel / Save */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
              <TouchableOpacity onPress={onClose} disabled={saving}>
                <Text style={{ fontSize: 15, color: colors?.textSecondary }}>{t?.('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors?.text }}>
                {t?.('profile.edit') || 'Editar perfil'}
              </Text>
              <TouchableOpacity onPress={handleSave} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#7C3AED" /> : (
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#7C3AED' }}>
                    {t?.('common.save') || 'Salvar'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Avatar hint — points to legacy /profile for full upload flow */}
              <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                <AvatarCircle name={name || initial?.name} email={currentEmail} size={84} />
                <Text style={{ fontSize: 12, color: colors?.textTertiary, marginTop: 8 }}>
                  {t?.('profile.avatarHint') || 'Avatar — alterar em Conta'}
                </Text>
              </View>

              <Field
                label={t?.('profile.name') || 'NOME'}
                value={name}
                onChangeText={setName}
                placeholder={t?.('profile.namePh') || 'Seu nome'}
                maxLength={50}
                colors={colors}
              />
              <Field
                label={t?.('profile.username') || 'USUÁRIO'}
                value={username}
                onChangeText={(v) => setUsername(v.replace(/[^a-z0-9._-]/gi, '').toLowerCase())}
                placeholder={t?.('profile.usernamePh') || 'usuario'}
                maxLength={30}
                colors={colors}
              />
              <Field
                label={t?.('profile.bio') || 'BIO'}
                value={bio}
                onChangeText={setBio}
                placeholder={t?.('profile.bioPh') || 'Conte algo sobre você'}
                multiline
                maxLength={MAX_BIO}
                colors={colors}
              />
              <Field
                label={t?.('profile.website') || 'LINK'}
                value={website}
                onChangeText={setWebsite}
                placeholder="https://..."
                maxLength={120}
                colors={colors}
              />

              {!!err && (
                <Text style={{ color: '#ef4444', fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 }}>
                  {err}
                </Text>
              )}

              <View style={{ height: Platform.OS === 'ios' ? 40 : 20 }} />
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
