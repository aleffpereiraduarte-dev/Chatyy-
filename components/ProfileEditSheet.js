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
import { IconX, IconCamera } from './Icons';
import { Image as ExpoImage } from 'expo-image';

const MAX_BIO = 150;

function Field({ label, value, onChangeText, placeholder, multiline, maxLength, colors, prefix }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
      <Text style={{ fontSize: 12, color: colors?.textSecondary, fontWeight: '600', letterSpacing: 0.4 }}>{label}</Text>
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border || '#eee',
      }}>
        {prefix ? (
          <Text style={{ fontSize: 15, color: colors?.textTertiary || '#999', paddingRight: 4 }}>{prefix}</Text>
        ) : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors?.textTertiary}
          style={{
            flex: 1,
            fontSize: 15, color: colors?.text,
            paddingVertical: 8, paddingHorizontal: 0,
            minHeight: multiline ? 60 : 36,
          }}
          multiline={!!multiline}
          maxLength={maxLength}
          autoCapitalize={prefix === '@' ? 'none' : 'sentences'}
          autoCorrect={prefix === '@' ? false : true}
        />
      </View>
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
  // Live availability check — debounced 400ms while user types.
  const [usernameStatus, setUsernameStatus] = useState({ checking: false, available: null, reason: null });
  const _usernameCheckTimer = React.useRef(null);
  const _usernameInitialRef = React.useRef('');
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
    _usernameInitialRef.current = String(initial?.username || '').toLowerCase();
    setUsernameStatus({ checking: false, available: null, reason: null });
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
        // Force JPEG regardless do mime do picker — allowsEditing+1:1 já força
        // re-encode pra JPEG mas alguns iPhones (HEIC default) reportam mime
        // errado e o backend rejeitava ('Formato inválido'). Override garante
        // que o tipo na request bate com bytes reais.
        file = { uri: a.uri, name: 'avatar.jpg', type: 'image/jpeg' };
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
    // Bloqueia save se o @username mudou e o check disse que não tá disponível.
    const cleanedUsername = username.trim().replace(/^@+/, '').toLowerCase();
    if (cleanedUsername && cleanedUsername !== _usernameInitialRef.current && usernameStatus.available === false) {
      setErr(t?.('profile.usernameNotAvailable') || 'Esse @ não está disponível');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const r = await api.updateProfile({
        name: name.trim(),
        username: cleanedUsername,
        bio: bio.trim(),
        website: website.trim(),
      });
      if (r?.success) {
        onSaved?.({ name, username: cleanedUsername, bio, website });
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

            {/* Header with Cancel / Save. The Save control switches between
                a flat text label (no changes pending — the sheet feels calm)
                and a filled pill (dirty form — clearly the primary action).
                Same iOS Settings.app pattern. */}
            {(() => {
              const isDirty =
                (name || '') !== (initial?.name || '') ||
                (username || '').toLowerCase() !== (initial?.username || '').toLowerCase() ||
                (bio || '') !== (initial?.bio || '') ||
                (website || '') !== (initial?.website || '');
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
                  <TouchableOpacity onPress={onClose} disabled={saving}>
                    <Text style={{ fontSize: 15, color: colors?.textSecondary }}>{t?.('common.cancel') || 'Cancelar'}</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors?.text }}>
                    {t?.('profile.edit') || 'Editar perfil'}
                  </Text>
                  <TouchableOpacity onPress={handleSave} disabled={saving || !isDirty} activeOpacity={0.75}>
                    {saving ? (
                      <ActivityIndicator size="small" color="#7C3AED" />
                    ) : isDirty ? (
                      <View style={{
                        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16,
                        backgroundColor: '#7C3AED',
                        ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(124,58,237,0.4)' } : {}),
                      }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>
                          {t?.('common.save') || 'Salvar'}
                        </Text>
                      </View>
                    ) : (
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors?.textTertiary || '#999' }}>
                        {t?.('common.save') || 'Salvar'}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              );
            })()}

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
                  {/* Camera badge — Instagram/WhatsApp style. SVG icon
                      replaces the 📷 emoji so it stays sharp on every density
                      and follows the project's no-emoji-in-UI rule. */}
                  <View style={{
                    position: 'absolute', right: -2, bottom: -2,
                    width: 28, height: 28, borderRadius: 14,
                    backgroundColor: '#7C3AED',
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: 2, borderColor: colors?.background || '#fff',
                    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(124,58,237,0.45)' } : {}),
                  }}>
                    <IconCamera size={15} color="#fff" />
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
                prefix="@"
                value={username}
                onChangeText={(v) => {
                  const cleaned = v.replace(/[^a-z0-9._-]/gi, '').toLowerCase().replace(/^@+/, '');
                  setUsername(cleaned);
                  // Debounced live check — só dispara se mudou do valor inicial.
                  if (_usernameCheckTimer.current) clearTimeout(_usernameCheckTimer.current);
                  if (cleaned === _usernameInitialRef.current) {
                    setUsernameStatus({ checking: false, available: null, reason: null });
                    return;
                  }
                  if (cleaned.length < 3) {
                    setUsernameStatus({ checking: false, available: false, reason: 'too_short' });
                    return;
                  }
                  setUsernameStatus({ checking: true, available: null, reason: null });
                  _usernameCheckTimer.current = setTimeout(async () => {
                    try {
                      const r = await api.usernameCheck(cleaned);
                      if (r?.success) {
                        setUsernameStatus({ checking: false, available: !!r.data?.available, reason: r.data?.reason || null });
                      } else {
                        setUsernameStatus({ checking: false, available: null, reason: null });
                      }
                    } catch {
                      setUsernameStatus({ checking: false, available: null, reason: null });
                    }
                  }, 400);
                }}
                placeholder={t?.('profile.usernamePh') || 'usuario'}
                maxLength={30}
                colors={colors}
              />
              {/* Status do @ — verde se disponível, vermelho se ocupado/reservado */}
              {(usernameStatus.checking || usernameStatus.available !== null) && (
                <Text style={{
                  fontSize: 12,
                  marginTop: -8,
                  marginBottom: 8,
                  marginLeft: 4,
                  color: usernameStatus.checking
                    ? (colors?.textTertiary || '#999')
                    : (usernameStatus.available ? '#10b981' : '#ef4444'),
                }}>
                  {usernameStatus.checking
                    ? (t?.('profile.usernameChecking') || 'Verificando...')
                    : usernameStatus.available
                      ? (t?.('profile.usernameAvailable') || `@${username} disponível`)
                      : usernameStatus.reason === 'taken'
                        ? (t?.('profile.usernameTaken') || 'Esse @ já está em uso')
                        : usernameStatus.reason === 'reserved'
                          ? (t?.('profile.usernameReserved') || 'Esse @ é reservado')
                          : usernameStatus.reason === 'too_short'
                            ? (t?.('profile.usernameTooShort') || 'Mínimo 3 caracteres')
                            : (t?.('profile.usernameInvalid') || 'Indisponível')}
                </Text>
              )}
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
