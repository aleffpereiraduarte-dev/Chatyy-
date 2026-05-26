/**
 * ProfileEditSheet — inline edit for the signed-in user's profile.
 * Instagram-style: bottom sheet with name, username, bio, website.
 * Saves via update_profile. Avatar upload stays in the legacy /profile
 * screen for now since it needs the image picker pipeline.
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable,
  ScrollView, ActivityIndicator, Platform, StyleSheet, KeyboardAvoidingView,
  Alert, Animated, Easing, Linking,
} from 'react-native';
import * as api from '../services/api';

// Request media-library permission with a clear, actionable prompt.
// Returns true only if granted. The old code just set a tiny error string at
// the BOTTOM of the sheet ("Permissão de fotos necessária") which testers
// never noticed. Now: if iOS/Android won't show the system dialog anymore
// (canAskAgain === false), we pop a real Alert that routes straight to
// system Settings so the user can actually flip the toggle.
async function ensurePhotoPermission(t) {
  try {
    const ImagePicker = require('expo-image-picker');
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync?.();
    if (perm?.granted) return true;
    // Ask via the system dialog while we still can.
    if (perm?.canAskAgain !== false) {
      perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
      if (perm?.granted) return true;
    }
    // Denied (likely permanently) → guide the user to Settings.
    return await new Promise((resolve) => {
      Alert.alert(
        t?.('profile.photoPermissionTitle') || 'Acesso às fotos',
        t?.('profile.photoPermissionMessage') ||
          'Para escolher uma foto, o Chatyy precisa de acesso à sua galeria. Ative nos Ajustes do aparelho.',
        [
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
          { text: t?.('common.openSettings') || 'Abrir Ajustes', onPress: () => { try { Linking.openSettings?.(); } catch {} resolve(false); } },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      );
    });
  } catch {
    return false;
  }
}
import AvatarCircle from './AvatarCircle';
import { IconX, IconCamera, IconLink, IconPlus, IconTrash } from './Icons';
import { Image as ExpoImage } from 'expo-image';

const MAX_BIO = 150;

// Instagram-style row: label on the left (textSecondary 13), input on the
// right (text 16, weight 500), hairline divider underneath. Replaces the
// old top-stacked label + input layout. Bio is multiline so the input
// wraps below the label, but we keep the same divider treatment.
function Row({
  label, value, onChangeText, placeholder, multiline, maxLength, colors,
  prefix, required, rightAdornment, showCounter, collapsible,
}) {
  // Bio-style collapse: default to 4 lines, "Ver mais" expands when the
  // input value visibly overflows the collapsed clamp.
  const [expanded, setExpanded] = useState(false);
  const [overflowed, setOverflowed] = useState(false);
  const collapseLines = collapsible ? 4 : undefined;
  const showVerMais = !!collapsible && multiline && !expanded && overflowed;
  return (
    <View style={{
      paddingHorizontal: 16,
      paddingVertical: multiline ? 14 : 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors?.border || 'rgba(0,0,0,0.08)',
    }}>
      <View style={{
        flexDirection: multiline ? 'column' : 'row',
        alignItems: multiline ? 'stretch' : 'center',
        gap: 12,
      }}>
        <Text style={{
          fontSize: 13,
          color: colors?.textSecondary || '#6b7280',
          fontWeight: '500',
          width: multiline ? undefined : 92,
        }}>
          {label}
          {required ? (
            <Text style={{ color: colors?.error || '#dc2626' }}>{' *'}</Text>
          ) : null}
        </Text>
        <View style={{
          flex: multiline ? undefined : 1,
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
        }}>
          {prefix ? (
            <Text style={{
              fontSize: 16, color: colors?.textTertiary || '#9ca3af',
              paddingRight: 2, fontWeight: '500',
            }}>{prefix}</Text>
          ) : null}
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors?.textTertiary || '#9ca3af'}
            onContentSizeChange={collapsible ? (e) => {
              // ~21px line height — flag overflow once content exceeds 4 lines.
              const h = e?.nativeEvent?.contentSize?.height || 0;
              setOverflowed(h > 21 * 4 + 4);
            } : undefined}
            numberOfLines={collapsible && !expanded ? collapseLines : undefined}
            style={{
              flex: 1,
              fontSize: 16,
              fontWeight: '500',
              color: colors?.text,
              paddingVertical: 4, paddingHorizontal: 0,
              minHeight: multiline ? 56 : 24,
              ...(collapsible && !expanded ? { maxHeight: 21 * 4 + 8 } : null),
              textAlignVertical: multiline ? 'top' : 'center',
            }}
            multiline={!!multiline}
            maxLength={maxLength}
            autoCapitalize={prefix === '@' ? 'none' : 'sentences'}
            autoCorrect={prefix === '@' ? false : true}
          />
          {rightAdornment ? (
            <View style={{ marginLeft: 8 }}>{rightAdornment}</View>
          ) : null}
        </View>
      </View>
      {showVerMais ? (
        <TouchableOpacity onPress={() => setExpanded(true)} style={{ marginTop: 4 }} accessibilityRole="button">
          <Text style={{ fontSize: 13, color: '#7C3AED', fontWeight: '600' }}>Ver mais</Text>
        </TouchableOpacity>
      ) : null}
      {showCounter && multiline && maxLength ? (
        <Text style={{
          fontSize: 12,
          color: (value?.length || 0) >= maxLength
            ? (colors?.error || '#ef4444')
            : (colors?.textTertiary || '#9ca3af'),
          textAlign: 'right',
          marginTop: 4,
        }}>
          {value?.length || 0} / {maxLength}
        </Text>
      ) : null}
    </View>
  );
}

// Animated availability indicator next to the @username input. Pulses
// subtly while checking, snaps to a green check or red x once the API
// answers. Stays compact (16px) so the input baseline doesn't shift.
function UsernameIndicator({ status, colors }) {
  const pulse = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (!status?.checking) { pulse.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [status?.checking, pulse]);

  if (status?.checking) {
    return (
      <Animated.View style={{
        width: 18, height: 18, borderRadius: 9,
        backgroundColor: '#f59e0b',
        opacity: pulse,
      }} />
    );
  }
  if (status?.available === true) {
    return (
      <View style={{
        width: 18, height: 18, borderRadius: 9,
        backgroundColor: '#10b981',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '900', lineHeight: 13 }}>✓</Text>
      </View>
    );
  }
  if (status?.available === false) {
    return (
      <View style={{
        width: 18, height: 18, borderRadius: 9,
        backgroundColor: '#ef4444',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '900', lineHeight: 13 }}>×</Text>
      </View>
    );
  }
  return null;
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
  const [pronouns, setPronouns] = useState('');
  // Legacy professional info — proCategory/proContact still exist on
  // data.json, now gated by accountType (radio) instead of a switch.
  const [proCategory, setProCategory] = useState('');
  const [proContact, setProContact] = useState('');
  // Profile-upgrade combo (2026-05-18): cover photo, multi-link list,
  // account type. Cover follows the same preview-overrides-server cache
  // pattern as the avatar so the user sees their new banner instantly.
  const [coverUrl, setCoverUrl] = useState('');
  const [coverPreview, setCoverPreview] = useState(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [links, setLinks] = useState([]); // array of { label, url }
  const [accountType, setAccountType] = useState('personal'); // personal | creator | business
  const _initialLinksRef = useRef('[]');
  const _initialAccountTypeRef = useRef('personal');
  const _initialCoverRef = useRef('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // Avatar preview takes priority over the cached AvatarCircle image so the
  // user sees their new photo instantly after upload — no waiting for the
  // server-side cache bust to propagate.
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // Pending avatar — picked but not yet confirmed. We show a preview modal
  // with a circular crop overlay so the user can review the framing before
  // we burn an upload (and the optimistic UI swap). null = no pending pick.
  const [pendingAvatar, setPendingAvatar] = useState(null);

  // Hydrate from profile_get identity every time the sheet opens
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name || '');
    setUsername(initial?.username || '');
    _usernameInitialRef.current = String(initial?.username || '').toLowerCase();
    setUsernameStatus({ checking: false, available: null, reason: null });
    setBio(initial?.bio || '');
    setWebsite(initial?.website || '');
    setPronouns(initial?.pronouns || '');
    setProCategory(initial?.proCategory || '');
    setProContact(initial?.proContact || '');
    // Profile-upgrade combo hydrate
    setCoverUrl(initial?.cover_url || initial?.coverUrl || '');
    _initialCoverRef.current = initial?.cover_url || initial?.coverUrl || '';
    setCoverPreview(null);
    const initLinks = Array.isArray(initial?.links) ? initial.links.slice(0, 5) : [];
    setLinks(initLinks);
    _initialLinksRef.current = JSON.stringify(initLinks);
    const initAcc = ['personal','creator','business'].includes(initial?.account_type || initial?.accountType)
      ? (initial?.account_type || initial?.accountType)
      : 'personal';
    setAccountType(initAcc);
    _initialAccountTypeRef.current = initAcc;
    setErr('');
    setAvatarPreview(null);
  }, [visible, initial]);

  // Cover photo picker — same flow as handlePickAvatar but skips the
  // circular preview modal (cover is a 3:1 banner, no crop overlay needed).
  // Backend resizes 1500×500 centre-out on receipt so portrait picks still
  // compose acceptably.
  const handlePickCover = async () => {
    if (uploadingCover) return;
    setErr('');
    try {
      let file = null;
      if (Platform.OS === 'web') {
        await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.onchange = (e) => { const f = e.target.files?.[0]; if (f) file = f; resolve(); };
          input.click();
        });
      } else {
        const ImagePicker = require('expo-image-picker');
        if (!(await ensurePhotoPermission(t))) return;
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [3, 1],
          quality: 0.85,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const a = result.assets[0];
        file = { uri: a.uri, name: 'cover.jpg', type: 'image/jpeg' };
      }
      if (!file) return;
      // Optimistic preview swap — we paint the local URI immediately so the
      // banner doesn't flash empty during the upload. On failure we revert.
      const localUri = Platform.OS === 'web' && file instanceof File
        ? URL.createObjectURL(file)
        : (file.uri || null);
      if (localUri) setCoverPreview(localUri);
      setUploadingCover(true);
      try {
        const r = await api.uploadCover(file);
        if (r?.success && r?.data?.cover_url) {
          setCoverUrl(r.data.cover_url);
          // Keep coverPreview around until the new URL has had a tick to
          // load — the cross-fade reads cleaner than a hard cut.
        } else {
          setCoverPreview(null);
          setErr(r?.message || t?.('profile.coverUploadFailed') || 'Falha ao enviar capa');
        }
      } catch (e) {
        setCoverPreview(null);
        setErr(e?.message || t?.('common.networkError') || 'Erro de rede');
      } finally {
        setUploadingCover(false);
      }
    } catch (e) {
      setErr(e?.message || t?.('common.networkError') || 'Erro de rede');
    }
  };

  const handleAddLink = () => {
    if (links.length >= 5) return;
    setLinks([...links, { label: '', url: '' }]);
  };
  const handleUpdateLink = (idx, key, value) => {
    setLinks(links.map((l, i) => i === idx ? { ...l, [key]: value } : l));
  };
  const handleRemoveLink = (idx) => {
    setLinks(links.filter((_, i) => i !== idx));
  };

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
        if (!(await ensurePhotoPermission(t))) return;
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
      // Stage the picked file in `pendingAvatar` and pop a preview modal
      // first — user reviews the framing inside a circular crop overlay
      // (avatar shape) before we burn an upload. Without this step a
      // mis-tap on the wrong photo immediately becomes the user's avatar
      // (the previous flow uploaded straight from the picker).
      const localUri = Platform.OS === 'web' && file instanceof File
        ? URL.createObjectURL(file)
        : (file.uri || null);
      if (!localUri) return;
      setPendingAvatar({ file, uri: localUri });
    } catch (e) {
      setErr(e?.message || t?.('common.networkError') || 'Erro de rede');
    }
  };

  // Run the actual upload after the user confirms the preview. Mirrors
  // the legacy handlePickAvatar tail: optimistic AvatarCircle swap, then
  // POST. On failure we drop the preview and surface the error.
  const confirmAvatarUpload = async () => {
    if (!pendingAvatar || uploadingAvatar) return;
    const { file, uri } = pendingAvatar;
    setAvatarPreview(uri);
    setPendingAvatar(null);
    setUploadingAvatar(true);
    setErr('');
    try {
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

  const cancelPendingAvatar = () => {
    // Web object URLs leak unless explicitly revoked.
    if (Platform.OS === 'web' && pendingAvatar?.uri && pendingAvatar.uri.startsWith('blob:')) {
      try { URL.revokeObjectURL(pendingAvatar.uri); } catch {}
    }
    setPendingAvatar(null);
  };

  // True when any field changed vs the initial snapshot. Used both for the
  // Save button affordance and for the "discard changes?" confirmation
  // when the user tries to close the sheet (swipe-down / X / backdrop).
  const isDirty = () =>
    (name || '') !== (initial?.name || '') ||
    (username || '').toLowerCase() !== (initial?.username || '').toLowerCase() ||
    (bio || '') !== (initial?.bio || '') ||
    (website || '') !== (initial?.website || '') ||
    (pronouns || '') !== (initial?.pronouns || '') ||
    (proCategory || '') !== (initial?.proCategory || '') ||
    (proContact || '') !== (initial?.proContact || '') ||
    // Profile-upgrade combo dirty checks
    (coverUrl || '') !== (_initialCoverRef.current || '') ||
    JSON.stringify(links || []) !== _initialLinksRef.current ||
    (accountType || 'personal') !== (_initialAccountTypeRef.current || 'personal');

  // Intercepts close attempts. If form has unsaved edits, prompt the user
  // before dismissing — same pattern iOS Settings / Instagram use.
  const requestClose = () => {
    if (saving) return; // never abort a save in flight
    if (!isDirty()) { onClose?.(); return; }
    Alert.alert(
      t?.('profile.discardTitle') || 'Descartar alterações?',
      t?.('profile.discardMessage') || 'Suas mudanças serão perdidas.',
      [
        { text: t?.('profile.keepEditing') || 'Continuar editando', style: 'cancel' },
        { text: t?.('common.discard') || 'Descartar', style: 'destructive', onPress: () => onClose?.() },
      ]
    );
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
      // Drop blank links before sending — empty rows are placeholder UI
      // and have no business persisting. Label may be empty (we fall back
      // to the host in the renderer), but URL is required.
      const cleanedLinks = (links || [])
        .map(l => ({ label: (l?.label || '').trim(), url: (l?.url || '').trim() }))
        .filter(l => l.url !== '')
        .slice(0, 5);
      // proCategory/proContact are only persisted for non-personal accounts;
      // dropping the showProfessional toggle in favour of the radio means
      // the account type itself gates visibility now.
      const showPro = (accountType === 'business' || accountType === 'creator');
      const r = await api.updateProfile({
        name: name.trim(),
        username: cleanedUsername,
        bio: bio.trim(),
        website: website.trim(),
        pronouns: pronouns.trim(),
        proCategory: showPro ? proCategory.trim() : '',
        proContact: showPro ? proContact.trim() : '',
        // Profile-upgrade combo
        cover_url: coverUrl || '',
        links: cleanedLinks,
        account_type: accountType || 'personal',
      });
      if (r?.success) {
        onSaved?.({
          name, username: cleanedUsername, bio, website,
          pronouns,
          proCategory: showPro ? proCategory : '',
          proContact: showPro ? proContact : '',
          cover_url: coverUrl,
          links: cleanedLinks,
          account_type: accountType,
        });
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

  const dirty = isDirty();
  const headerCanSave = dirty && !saving;

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={requestClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={requestClose}>
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

            {/* Header — Instagram pattern: X icon left, title center, "Concluído"
                pill right. Pill goes filled-purple when dirty, ghost-grey when
                clean — same affordance Instagram uses to telegraph "you have
                changes to commit". */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: 12, paddingVertical: 10,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors?.border || 'rgba(0,0,0,0.08)',
            }}>
              <TouchableOpacity
                onPress={requestClose}
                disabled={saving}
                style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
                accessibilityRole="button"
                accessibilityLabel={t?.('common.cancel') || 'Cancelar'}
              >
                <IconX size={22} color={colors?.text || '#111'} />
              </TouchableOpacity>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors?.text }}>
                {t?.('profile.edit') || 'Editar perfil'}
              </Text>
              <TouchableOpacity onPress={handleSave} disabled={saving || !dirty} activeOpacity={0.75}>
                {saving ? (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <ActivityIndicator size="small" color="#7C3AED" />
                  </View>
                ) : (
                  <View style={{
                    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18,
                    backgroundColor: headerCanSave ? '#7C3AED' : 'transparent',
                    ...(headerCanSave && Platform.OS === 'web'
                      ? { boxShadow: '0 2px 10px rgba(124,58,237,0.45)' }
                      : {}),
                  }}>
                    <Text style={{
                      fontSize: 15,
                      fontWeight: '700',
                      color: headerCanSave ? '#fff' : (colors?.textTertiary || '#9ca3af'),
                    }}>
                      {t?.('common.done') || 'Concluído'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Cover photo banner — 150px Instagram/X-style 3:1 strip
                  sitting above the avatar. Tap or use the "Alterar capa"
                  button to swap. Preview (coverPreview) wins over coverUrl
                  during upload so the user sees the new banner instantly.
                  Empty state shows a faint purple wash + camera prompt. */}
              <View style={{ width: '100%', height: 150, backgroundColor: 'rgba(124,58,237,0.08)', position: 'relative' }}>
                {(coverPreview || coverUrl) ? (
                  <ExpoImage
                    source={{ uri: coverPreview || coverUrl }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                  />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <IconCamera size={28} color="rgba(124,58,237,0.4)" />
                    <Text style={{ fontSize: 12, color: 'rgba(124,58,237,0.6)', marginTop: 6, fontWeight: '600' }}>
                      {t?.('profile.cover') || 'Capa'}
                    </Text>
                  </View>
                )}
                {uploadingCover && (
                  <View style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <ActivityIndicator color="#fff" />
                  </View>
                )}
                {/* "Alterar capa" floating pill — bottom-right of the banner */}
                <TouchableOpacity
                  onPress={handlePickCover}
                  disabled={uploadingCover}
                  activeOpacity={0.85}
                  style={{
                    position: 'absolute', right: 12, bottom: 12,
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    paddingHorizontal: 12, paddingVertical: 7,
                    borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.55)',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('profile.changeCover') || 'Alterar capa'}
                >
                  <IconCamera size={14} color="#fff" />
                  <Text style={{ fontSize: 12, color: '#fff', fontWeight: '700' }}>
                    {t?.('profile.changeCover') || 'Alterar capa'}
                  </Text>
                </TouchableOpacity>
              </View>
              {/* Hero photo section — 96px avatar centered over a subtle
                  purple radial-ish gradient. "Trocar foto" link below acts
                  as the secondary tap affordance (the avatar itself is also
                  tappable). Replaces the small camera-badge-only treatment. */}
              <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 20 }}>
                {/* Soft purple wash sitting behind the avatar */}
                <View pointerEvents="none" style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: 140,
                  backgroundColor: 'rgba(124,58,237,0.05)',
                }} />
                <TouchableOpacity
                  onPress={handlePickAvatar}
                  activeOpacity={0.8}
                  disabled={uploadingAvatar}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('profile.changePhoto') || 'Trocar foto'}
                  style={{
                    width: 104, height: 104, borderRadius: 52,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: 'rgba(124,58,237,0.10)',
                    // Defined brand ring around the avatar puck so it reads as
                    // a deliberate "edit photo" target (Instagram-grade) rather
                    // than a flat tinted blob.
                    borderWidth: 1.5,
                    borderColor: isDark ? 'rgba(167,139,250,0.35)' : 'rgba(124,58,237,0.22)',
                    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 24px rgba(124,58,237,0.18)' } : {}),
                  }}
                >
                  <View style={{
                    width: 96, height: 96, borderRadius: 48, overflow: 'hidden',
                    backgroundColor: colors?.surface || '#f5f5f5',
                    borderWidth: 3, borderColor: colors?.background || '#fff',
                  }}>
                    {avatarPreview ? (
                      <ExpoImage source={{ uri: avatarPreview }} style={{ width: 96, height: 96 }} contentFit="cover" />
                    ) : (
                      <AvatarCircle name={name || initial?.name} email={currentEmail} size={96} />
                    )}
                    {uploadingAvatar && (
                      <View style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.45)',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <ActivityIndicator color="#fff" size="small" />
                      </View>
                    )}
                  </View>
                  {/* Tiny camera badge — kept as a glanceable affordance even
                      though the "Trocar foto" link does the same thing. */}
                  <View style={{
                    position: 'absolute', right: 6, bottom: 6,
                    width: 28, height: 28, borderRadius: 14,
                    backgroundColor: '#7C3AED',
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: 2, borderColor: colors?.background || '#fff',
                    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(124,58,237,0.45)' } : {}),
                  }}>
                    <IconCamera size={15} color="#fff" />
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handlePickAvatar}
                  disabled={uploadingAvatar}
                  style={{ marginTop: 14, paddingVertical: 4, paddingHorizontal: 8 }}
                  activeOpacity={0.6}
                >
                  <Text style={{ fontSize: 15, color: '#7C3AED', fontWeight: '600' }}>
                    {t?.('profile.changePhoto') || 'Trocar foto'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Form rows — Instagram side-by-side label/input layout */}
              <Row
                label={t?.('profile.name') || 'Nome'}
                value={name}
                onChangeText={setName}
                placeholder={t?.('profile.namePh') || 'Seu nome'}
                maxLength={50}
                colors={colors}
              />
              <Row
                label={t?.('profile.username') || 'Usuário'}
                required
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
                rightAdornment={<UsernameIndicator status={usernameStatus} colors={colors} />}
              />
              {/* Status text — short helper below the username row */}
              {(usernameStatus.checking || usernameStatus.available !== null) ? (
                <Text style={{
                  fontSize: 12,
                  paddingHorizontal: 16,
                  paddingTop: 6,
                  paddingBottom: 2,
                  marginLeft: 92 + 12, // align under input column
                  color: usernameStatus.checking
                    ? (colors?.textTertiary || '#9ca3af')
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
              ) : null}
              <Row
                label={t?.('profile.pronouns') || 'Pronomes'}
                value={pronouns}
                onChangeText={setPronouns}
                placeholder={t?.('profile.pronounsPh') || 'Adicionar pronomes'}
                maxLength={40}
                colors={colors}
              />
              <Row
                label={t?.('profile.bio') || 'Bio'}
                value={bio}
                onChangeText={setBio}
                placeholder={t?.('profile.bioPh') || 'Conte algo sobre você'}
                multiline
                maxLength={MAX_BIO}
                colors={colors}
                showCounter
                collapsible
              />
              <Row
                label={t?.('profile.website') || 'Site'}
                value={website}
                onChangeText={setWebsite}
                placeholder="https://..."
                maxLength={120}
                colors={colors}
              />

              {/* Multi-link section — up to 5 link-in-bio chips that render
                  below the bio on the public profile. Each row: label (left,
                  optional, falls back to host in renderer) + URL (right) +
                  trash icon. "+ Adicionar link" button appears below the
                  list until the 5-link cap is hit. */}
              <View style={{ marginTop: 16, marginBottom: 4, paddingHorizontal: 16 }}>
                <Text style={{
                  fontSize: 12, fontWeight: '700', letterSpacing: 0.6,
                  color: colors?.textSecondary || '#6b7280',
                  textTransform: 'uppercase',
                }}>
                  {t?.('profile.links') || 'Links'}
                </Text>
              </View>
              {(links || []).map((lk, idx) => (
                <View key={`lk-${idx}`} style={{
                  paddingHorizontal: 16, paddingVertical: 10,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors?.border || 'rgba(0,0,0,0.08)',
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                }}>
                  <IconLink size={16} color={colors?.textSecondary || '#6b7280'} />
                  <View style={{ flex: 1 }}>
                    <TextInput
                      value={lk.label || ''}
                      onChangeText={(v) => handleUpdateLink(idx, 'label', v)}
                      placeholder={t?.('profile.linkLabelPh') || 'Rótulo (opcional)'}
                      placeholderTextColor={colors?.textTertiary || '#9ca3af'}
                      maxLength={30}
                      style={{ fontSize: 14, fontWeight: '600', color: colors?.text, paddingVertical: 2 }}
                    />
                    <TextInput
                      value={lk.url || ''}
                      onChangeText={(v) => handleUpdateLink(idx, 'url', v)}
                      placeholder="https://..."
                      placeholderTextColor={colors?.textTertiary || '#9ca3af'}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      maxLength={200}
                      style={{ fontSize: 13, color: colors?.textSecondary || '#6b7280', paddingVertical: 2 }}
                    />
                  </View>
                  <TouchableOpacity
                    onPress={() => handleRemoveLink(idx)}
                    style={{ padding: 6 }}
                    accessibilityRole="button"
                    accessibilityLabel={t?.('common.remove') || 'Remover'}
                  >
                    <IconTrash size={18} color={colors?.textTertiary || '#9ca3af'} />
                  </TouchableOpacity>
                </View>
              ))}
              {(links || []).length < 5 ? (
                <TouchableOpacity
                  onPress={handleAddLink}
                  activeOpacity={0.7}
                  style={{
                    paddingHorizontal: 16, paddingVertical: 14,
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors?.border || 'rgba(0,0,0,0.08)',
                  }}
                  accessibilityRole="button"
                >
                  <IconPlus size={16} color="#7C3AED" />
                  <Text style={{ fontSize: 14, color: '#7C3AED', fontWeight: '600' }}>
                    {t?.('profile.addLink') || 'Adicionar link'}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {/* Account type — radio list. Replaces the prior "show
                  professional" toggle since the type now drives the
                  business-info section visibility AND gates monetization
                  features (creator dashboard, business analytics). */}
              <View style={{ marginTop: 16, marginBottom: 4, paddingHorizontal: 16 }}>
                <Text style={{
                  fontSize: 12, fontWeight: '700', letterSpacing: 0.6,
                  color: colors?.textSecondary || '#6b7280',
                  textTransform: 'uppercase',
                }}>
                  {t?.('profile.accountType') || 'Tipo de conta'}
                </Text>
              </View>
              {[
                { key: 'personal',  label: t?.('profile.accountTypePersonal') || 'Pessoal',
                  hint: t?.('profile.accountTypePersonalHint') || 'Perfil padrão, sem recursos comerciais.' },
                { key: 'creator',   label: t?.('profile.accountTypeCreator')  || 'Criador',
                  hint: t?.('profile.accountTypeCreatorHint')  || 'Analytics, ferramentas de monetização e insights.' },
                { key: 'business',  label: t?.('profile.accountTypeBusiness') || 'Negócio',
                  hint: t?.('profile.accountTypeBusinessHint') || 'Categoria + contato + métricas comerciais.' },
              ].map((opt) => {
                const selected = accountType === opt.key;
                const accent = opt.key === 'creator' ? '#9333EA' : opt.key === 'business' ? '#2563EB' : '#7C3AED';
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setAccountType(opt.key)}
                    activeOpacity={0.75}
                    style={{
                      paddingHorizontal: 16, paddingVertical: 12,
                      flexDirection: 'row', alignItems: 'center', gap: 12,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors?.border || 'rgba(0,0,0,0.08)',
                      backgroundColor: selected ? (isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.04)') : 'transparent',
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                  >
                    <View style={{
                      width: 20, height: 20, borderRadius: 10,
                      borderWidth: 2, borderColor: selected ? accent : (colors?.border || '#d1d5db'),
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {selected ? (
                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: accent }} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: colors?.text }}>
                        {opt.label}
                      </Text>
                      <Text style={{ fontSize: 12, color: colors?.textSecondary || '#6b7280', marginTop: 2 }}>
                        {opt.hint}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              {/* Business / creator sub-fields — category + contact, only
                  visible when the user picks a non-personal type. Carries
                  forward the legacy proCategory/proContact fields. */}
              {(accountType === 'business' || accountType === 'creator') ? (
                <View>
                  <Row
                    label={t?.('profile.proCategory') || 'Categoria'}
                    value={proCategory}
                    onChangeText={setProCategory}
                    placeholder={t?.('profile.proCategoryPh') || 'Ex: Designer, Loja, Artista'}
                    maxLength={50}
                    colors={colors}
                  />
                  <Row
                    label={t?.('profile.proContact') || 'Contato'}
                    value={proContact}
                    onChangeText={setProContact}
                    placeholder={t?.('profile.proContactPh') || 'Email ou telefone comercial'}
                    maxLength={120}
                    colors={colors}
                  />
                </View>
              ) : null}

              {!!err && (
                <Text style={{ color: '#ef4444', fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 }}>
                  {err}
                </Text>
              )}

              <View style={{ height: Platform.OS === 'ios' ? 40 : 20 }} />
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>

        {/* Avatar preview modal — shown after the user picks an image and
            BEFORE we upload. The big square frame with a circular crop
            overlay shows exactly what the rest of the app will render
            (AvatarCircle is a 1:1 cropped circle). User confirms or
            cancels; only confirm fires the upload. */}
        <Modal visible={!!pendingAvatar} transparent animationType="fade" onRequestClose={cancelPendingAvatar}>
          <Pressable
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onPress={cancelPendingAvatar}
          >
            <Pressable
              onPress={(e) => e.stopPropagation?.()}
              style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 20 }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                {t?.('profile.previewTitle') || 'Confirmar foto'}
              </Text>
              {/* Square frame with circular crop overlay — the user sees
                  exactly what AvatarCircle will render. */}
              <View style={{ width: 280, height: 280, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000', position: 'relative' }}>
                {pendingAvatar?.uri ? (
                  <ExpoImage
                    source={{ uri: pendingAvatar.uri }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                  />
                ) : null}
                {/* Circular crop indicator — translucent ring shows the
                    visible portion. Pure visual; the actual avatar is
                    the full image (server crops to a square). */}
                <View pointerEvents="none" style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <View style={{
                    width: 260, height: 260, borderRadius: 130,
                    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
                    ...(Platform.OS === 'web' ? { boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' } : {}),
                  }} />
                </View>
              </View>
              <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, textAlign: 'center' }}>
                {t?.('profile.previewHint') || 'A área dentro do círculo será exibida como sua foto.'}
              </Text>
              <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                <TouchableOpacity
                  onPress={cancelPendingAvatar}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 14,
                    backgroundColor: 'rgba(255,255,255,0.12)',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('common.cancel') || 'Cancelar'}
                >
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                    {t?.('common.cancel') || 'Cancelar'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={confirmAvatarUpload}
                  style={{
                    flex: 1, paddingVertical: 14, borderRadius: 14,
                    backgroundColor: '#7C3AED',
                    alignItems: 'center', justifyContent: 'center',
                    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(124,58,237,0.45)' } : {}),
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('common.confirm') || 'Confirmar'}
                >
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>
                    {t?.('common.confirm') || 'Confirmar'}
                  </Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </Pressable>
    </Modal>
  );
}
