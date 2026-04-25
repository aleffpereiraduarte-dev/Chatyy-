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
import { Image as ExpoImage } from 'expo-image';

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
  // Avatar preview takes priority over the cached AvatarCircle image so the
  // user sees their new photo instantly after upload — no waiting for the
  // server-side cache bust to propagate.
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Hydrate from profile_get identity every time the sheet opens
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name || '');
    setUsername(initial?.username || '');
    setBio(initial?.bio || '');
    setWebsite(initial?.website || '');
    setErr('');
    setAvatarPreview(null);
  }, [visible, initial]);

  const handlePickAvatar = async () => {
    if (uploadingAvatar) return;
    setErr('');
    try {
      let file = null;
      if (Platform.OS === 'web') {
        // Web: hidden <input type=file> picker
        await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.onchange = (e) => {
            const f = e.target.files?.[0];
            if (f) file = f;
            resolve();
          };
          input.click();
        });
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
        if (!perm?.granted) {
          setErr(t?.('profile.photoPermissionDenied') || 'Permissão de fotos necessária');
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.85,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const a = result.assets[0];
        file = { uri: a.uri, name: a.fileName || 'avatar.jpg', type: a.mimeType || 'image/jpeg' };
      }
      if (!file) return;
      // Optimistic preview — show the new image right away
      const localUri = Platform.OS === 'web' && file instanceof File
        ? URL.createObjectURL(file)
        : (file.uri || null);
      if (localUri) setAvatarPreview(localUri);
      setUploadingAvatar(true);
      const r = await api.uploadAvatar(file);
      if (!r?.success) {
        setAvatarPreview(null);
        setErr(r?.message || t?.('profile.photoUploadFailed') || 'Falha ao enviar foto');
      }
    } catch (e) {
      setAvatarPreview(null);
      setErr(e?.message || t?.('common.networkError') || 'Erro de rede');
    } finally {
      setUploadingAvatar(false);
    }
  };

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
              {/* Avatar — tap to change. Preview overlays the cached avatar
                  during upload so the user sees the new image immediately. */}
              <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.75} disabled={uploadingAvatar} accessibilityRole="button" accessibilityLabel={t?.('profile.changePhoto') || 'Trocar foto'}>
                  <View style={{ width: 84, height: 84, borderRadius: 42, overflow: 'hidden', backgroundColor: colors?.surface }}>
                    {avatarPreview ? (
                      <ExpoImage source={{ uri: avatarPreview }} style={{ width: 84, height: 84 }} contentFit="cover" />
                    ) : (
                      <AvatarCircle name={name || initial?.name} email={currentEmail} size={84} />
                    )}
                    {uploadingAvatar && (
                      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator color="#fff" size="small" />
                      </View>
                    )}
                  </View>
                  {/* Camera badge — Instagram/WhatsApp style */}
                  <View style={{ position: 'absolute', right: -2, bottom: -2, width: 28, height: 28, borderRadius: 14, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors?.background || '#fff' }}>
                    <Text style={{ fontSize: 14 }}>📷</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity onPress={handlePickAvatar} disabled={uploadingAvatar} style={{ marginTop: 10 }} activeOpacity={0.6}>
                  <Text style={{ fontSize: 14, color: '#7C3AED', fontWeight: '600' }}>
                    {t?.('profile.changePhoto') || 'Trocar foto'}
                  </Text>
                </TouchableOpacity>
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
