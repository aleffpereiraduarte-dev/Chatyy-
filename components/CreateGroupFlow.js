import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, ActivityIndicator, Alert, Platform, ScrollView, Modal, Animated,
} from 'react-native';
import KeyboardSafeView from './ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconArrowLeft, IconSearch, IconX, IconUsers, IconCheck, IconPlus } from './Icons';
import SelectionCheck from './ui/SelectionCheck'; // [2026-10-18 elegance]
import AvatarCircle from './AvatarCircle';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import { safeAlert as _sharedSafeAlert } from '../services/alerts';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
import { useGroupedColors } from './settings/SettingsKit'; // [2026-10-17 wa-polish] tokens P&B do tema

const isWeb = Platform.OS === 'web';

function IconCamera({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <SvgCircle cx="12" cy="13" r="4" />
    </Svg>
  );
}

// [2026-10-12 overlays] cópia local → services/alerts (web = diálogo estilizado do app).
function safeAlert(title, message, buttons) { _sharedSafeAlert(title, message, buttons); }

export default function CreateGroupFlow({ visible, onClose, onCreated, mode = 'group' }) {
  const { colors, isDark } = useTheme();
  const g = useGroupedColors();
  const { user } = useAuth();
  const { t } = useLanguage();
  // Safe-area top — modal header had `paddingTop: 12` on Android which
  // tucked the back arrow under the status bar on Pixel/Galaxy edge-to-edge.
  const insets = useSafeAreaInsets();
  const headerPadTop = Math.max(insets.top, Platform.OS === 'android' ? 12 : 44) + 8;

  const [step, setStep] = useState(1);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Step 2 fields
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  // Group photo — picked file ({ uri, name, type }) + local preview URI.
  // The group doesn't exist yet at pick time, so we stage the file here and
  // upload it right AFTER chat_create returns the conversation id (same
  // chat_upload → chat_update avatar_url pipeline the group-info screen uses).
  const [groupPhoto, setGroupPhoto] = useState(null);
  const [groupPhotoPreview, setGroupPhotoPreview] = useState(null);

  const searchTimer = useRef(null);
  const isChannel = mode === 'channel';

  useEffect(() => {
    if (!visible) {
      setStep(1);
      setSelectedMembers([]);
      setSearchText('');
      setGroupName('');
      setGroupDescription('');
      setIsPublic(true);
      setGroupPhoto(null);
      setGroupPhotoPreview(null);
      setSearchResults([]);
      return;
    }
    // If channel mode, skip step 1 (no member selection needed)
    if (isChannel) setStep(2);

    setLoading(true);
    api.chatyyUsers('', 200).then(r => {
      if (r.success) {
        const users = (r.data?.users || []).filter(u => u.email !== user?.email);
        setAllUsers(users);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [visible, user?.email, isChannel]);

  const handleSearch = useCallback((text) => {
    setSearchText(text);
    if (!text.trim()) {
      setSearchResults([]);
      return;
    }
    const q = text.toLowerCase();
    const results = allUsers.filter(u => {
      const name = (u.name || '').toLowerCase();
      const email = (u.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
    setSearchResults(results);
  }, [allUsers]);

  const toggleMember = useCallback((contact) => {
    setSelectedMembers(prev => {
      const exists = prev.find(m => m.email === contact.email);
      if (exists) return prev.filter(m => m.email !== contact.email);
      return [...prev, { email: contact.email, name: contact.name || contact.email }];
    });
  }, []);

  const isSelected = useCallback((email) => {
    return selectedMembers.some(m => m.email === email);
  }, [selectedMembers]);

  // Pick (and 1:1-crop) the group photo. Mirrors the profile-avatar picker:
  // native uses expo-image-picker with allowsEditing+aspect[1,1]; web uses a
  // hidden <input type=file>. We only stage the file + a local preview here —
  // the actual upload happens in handleCreate once we have a conversation id.
  const handlePickGroupPhoto = async () => {
    try {
      let file = null;
      let previewUri = null;
      if (Platform.OS === 'web') {
        await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.onchange = (e) => { const f = e.target.files?.[0]; if (f) file = f; resolve(); };
          input.click();
        });
        if (!file) return;
        previewUri = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : null;
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          safeAlert(t('chatConv.permission') || 'Permissão', t('chatConv.galleryPermission') || t('channel.mediaPermission') || 'Permita o acesso à galeria nas configurações.');
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
        // Force JPEG — same HEIC-mislabel guard the profile avatar uses.
        file = { uri: a.uri, name: a.fileName || 'group.jpg', type: 'image/jpeg' };
        previewUri = a.uri;
      }
      if (!file) return;
      setGroupPhoto(file);
      setGroupPhotoPreview(previewUri);
    } catch {
      safeAlert(t('common.error') || 'Erro', t('common.networkError') || 'Erro de rede');
    }
  };

  const handleNext = () => {
    if (step === 1) {
      if (selectedMembers.length === 0) {
        safeAlert('', t('group.minMembers'));
        return;
      }
      setStep(2);
    }
  };

  const handleBack = () => {
    if (step === 2 && !isChannel) {
      setStep(1);
    } else {
      onClose();
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    const name = groupName.trim();
    if (!name) {
      safeAlert('', isChannel ? t('channel.name') : t('group.name'));
      return;
    }

    setCreating(true);
    try {
      let result;
      if (isChannel) {
        result = await api.chatCreateChannel(name, groupDescription.trim(), isPublic);
      } else {
        const members = selectedMembers.map(m => m.email);
        result = await api.chatCreate(members, name, 'group');
      }
      if (result.success) {
        const convId = result.data?.conversation_id || result.data?.id;
        const convName = result.data?.name || name;
        // [2026-10-20 wa2] descrição do grupo era digitada e descartada (chatCreate não leva).
        if (!isChannel && convId && groupDescription.trim()) {
          try { await api.chatUpdateGroup(convId, { description: groupDescription.trim() }); } catch {}
        }
        // If a photo was picked, upload it now that we have a conversation id.
        // Reuses the proven chat_upload → chat_update avatar_url pipeline (same
        // one the group-info "change photo" flow uses). Best-effort: a failed
        // upload never blocks group creation — the group is created regardless.
        let avatarUrl = null;
        if (convId && groupPhoto) {
          try {
            const up = await api.chatUploadFile(convId, groupPhoto, '', false, null, 'image', null, true);
            const fileUrl = up?.data?.file_url || up?.data?.url || up?.data?.message?.file_url;
            if (fileUrl) {
              const ur = await api.chatUpdate(convId, { avatar_url: fileUrl });
              if (ur?.success) avatarUrl = fileUrl;
            }
          } catch {}
        }
        onCreated?.({
          id: convId,
          name: convName,
          type: isChannel ? 'channel' : 'group',
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        });
      } else {
        safeAlert(t('common.error'), result?.message || 'Error');
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const displayList = searchText.trim() ? searchResults : allUsers;

  // [2026-10-17 wa-polish] Tinta do tema (era ACCENT #111111 fixo → no escuro
  // checkbox/chips/indicador/toggle ficavam preto-no-preto, invisíveis).
  const ink = g.ink;
  const onInk = g.onInk;
  const pageBg = step === 2 ? g.pageBg : colors.background;

  const renderContactItem = ({ item }) => {
    const selected = isSelected(item.email);
    return (
      <TouchableOpacity
        style={sty.contactRow}
        onPress={() => toggleMember(item)}
        activeOpacity={0.6}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={item.name || item.email}
      >
        {/* WhatsApp iOS: círculo de seleção à esquerda, separador começa no texto. */}
        {/* [2026-10-18 elegance] círculo anima (preenche do centro + check com mola) */}
        <SelectionCheck on={selected} size={22} borderWidth={1.5} onColor={ink} offColor={g.tertiary} checkColor={onInk} checkSize={14} />
        <AvatarCircle email={item.email} name={item.name || item.email} size={40} />
        <View style={[sty.contactInfo, { borderBottomColor: g.separator }]}>
          <Text style={[sty.contactName, { color: colors.text }]} numberOfLines={1}>
            {item.name || item.email?.split('@')[0]}
          </Text>
          <Text style={[sty.contactEmail, { color: g.secondary }]} numberOfLines={1}>
            {item.email}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (!visible) return null;

  const canNext = selectedMembers.length > 0;
  const canCreate = !!groupName.trim() && !creating;
  const showCancel = step === 1 || isChannel;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleBack} transparent={false}>
      <KeyboardSafeView
        style={[sty.container, { backgroundColor: pageBg }]}
      >
        {/* Header — [2026-10-17 wa-polish] barra do sistema estilo WhatsApp:
            fundo da página, título centralizado + contagem, ações em texto
            (era placa preta com botões translúcidos + barra de passos). */}
        <View style={[sty.header, { backgroundColor: pageBg, paddingTop: headerPadTop, borderBottomColor: g.separator }]}>
          <TouchableOpacity
            onPress={handleBack}
            style={sty.headerSide}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={showCancel ? (t('common.cancel') || 'Cancelar') : (t('common.back') || 'Voltar')}
          >
            {showCancel ? (
              <Text style={[sty.headerActionText, { color: ink, fontWeight: '400' }]} numberOfLines={1}>
                {t('common.cancel') || 'Cancelar'}
              </Text>
            ) : (
              <IconArrowLeft size={22} color={ink} />
            )}
          </TouchableOpacity>
          <View style={sty.headerCenter}>
            <Text style={[sty.headerTitle, { color: colors.text }]} numberOfLines={1}>
              {isChannel ? t('channel.create') : t('group.create')}
            </Text>
            {step === 1 && (
              <Text style={[sty.headerSubtitle, { color: g.secondary }]} numberOfLines={1}>
                {t('group.membersSelected').replace('{count}', String(selectedMembers.length))}
              </Text>
            )}
          </View>
          <View style={[sty.headerSide, sty.headerSideRight]}>
            {step === 1 && (
              <TouchableOpacity
                onPress={handleNext}
                disabled={!canNext}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canNext }}
              >
                <Text style={[sty.headerActionText, { color: ink, opacity: canNext ? 1 : 0.35 }]}>{t('group.next')}</Text>
              </TouchableOpacity>
            )}
            {step === 2 && (
              <TouchableOpacity
                onPress={handleCreate}
                disabled={!canCreate}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canCreate }}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={ink} />
                ) : (
                  <Text style={[sty.headerActionText, { color: ink, opacity: groupName.trim() ? 1 : 0.35 }]}>{t('group.done')}</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* STEP 1: Member selection */}
        {step === 1 && (
          <View style={{ flex: 1 }}>
            {/* Selecionados — faixa de avatares com "x" (WhatsApp), era pílulas. */}
            {selectedMembers.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[sty.chipsRow, { borderBottomColor: g.separator }]}
                contentContainerStyle={sty.chipsContent}
              >
                {selectedMembers.map(m => (
                  <TouchableOpacity
                    key={m.email}
                    style={sty.chip}
                    onPress={() => toggleMember(m)}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('common.remove') || 'Remover'} ${m.name || m.email}`}
                  >
                    <View>
                      <AvatarCircle email={m.email} name={m.name} size={52} />
                      <View style={[sty.chipX, { backgroundColor: g.secondary, borderColor: pageBg }]}>
                        <IconX size={10} color="#FFFFFF" />
                      </View>
                    </View>
                    <Text style={[sty.chipText, { color: g.secondary }]} numberOfLines={1}>
                      {(m.name || m.email).split('@')[0].split(' ')[0]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {/* Search */}
            <View style={[sty.searchWrap, { backgroundColor: g.fill }]}>
              <IconSearch size={17} color={g.secondary} />
              <TextInput
                style={[sty.searchInput, { color: colors.text }]}
                placeholder={t('group.searchMembers')}
                placeholderTextColor={g.secondary}
                value={searchText}
                onChangeText={handleSearch}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {searchText ? (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.clear', 'Limpar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => { setSearchText(''); setSearchResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <IconX size={16} color={g.secondary} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Contacts list */}
            {loading ? (
              <View style={sty.loader}>
                <ActivityIndicator size="small" color={g.secondary} />
              </View>
            ) : (
              <FlatList
                data={displayList}
                extraData={selectedMembers}
                keyExtractor={(item) => item.email}
                renderItem={renderContactItem}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{ paddingBottom: 20 }}
                ListEmptyComponent={
                  <View style={sty.empty}>
                    <Text style={[sty.emptyText, { color: g.secondary }]}>
                      {searchText ? t('chat.noContactsFound') : ''}
                    </Text>
                  </View>
                }
              />
            )}
          </View>
        )}

        {/* STEP 2: Group/Channel details — cartões agrupados (inset grouped). */}
        {step === 2 && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={sty.step2Content} keyboardShouldPersistTaps="handled">
            {/* Photo circle — tap to pick + crop a 1:1 image. Shows a preview
                once picked; a small camera badge keeps the "edit" affordance. */}
            <TouchableOpacity
              style={[sty.photoCircle, { backgroundColor: g.fill }]}
              onPress={handlePickGroupPhoto}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('group.photo') || 'Foto do grupo'}
            >
              {groupPhotoPreview ? (
                <ExpoImage
                  source={{ uri: groupPhotoPreview }}
                  style={{ width: 104, height: 104, borderRadius: 52 }}
                  contentFit="cover"
                />
              ) : (
                <IconCamera size={30} color={g.secondary} />
              )}
              <View style={[sty.photoBadge, { backgroundColor: ink, borderColor: pageBg }]} pointerEvents="none">
                <IconCamera size={13} color={onInk} />
              </View>
            </TouchableOpacity>

            {/* Nome + descrição num cartão só (WhatsApp/Ajustes do iOS). */}
            <View style={[sty.card, { backgroundColor: g.cardBg }]}>
              <View style={sty.nameRow}>
                <TextInput
                  style={[sty.nameInput, { color: colors.text }]}
                  placeholder={isChannel ? t('channel.name') : t('group.namePlaceholder')}
                  placeholderTextColor={g.secondary}
                  value={groupName}
                  onChangeText={setGroupName}
                  maxLength={60} /* [2026-10-20 wa2] servidor corta em 60 */
                  autoFocus
                  returnKeyType="next"
                  accessibilityLabel={isChannel ? t('channel.name') : t('group.name')}
                />
                <Text style={[sty.counter, { color: groupName.length >= 60 ? g.destructive : g.secondary }]}>
                  {60 - groupName.length}
                </Text>
              </View>
              <View style={[sty.cardSep, { backgroundColor: g.separator }]} />
              <TextInput
                style={[sty.descInput, { color: colors.text }]}
                placeholder={t('group.descriptionPlaceholder')}
                placeholderTextColor={g.secondary}
                value={groupDescription}
                onChangeText={setGroupDescription}
                multiline
                maxLength={500} /* [2026-10-20 wa2] servidor corta em 500 */
                accessibilityLabel={isChannel ? t('channel.description') : t('group.description')}
              />
            </View>

            {/* Channel: Public/Private — linhas de rádio num cartão. */}
            {isChannel && (
              <>
                <Text style={[sty.sectionHd, { color: g.header }]}>
                  {t('channel.public')} / {t('channel.private')}
                </Text>
                <View style={[sty.card, { backgroundColor: g.cardBg }]}>
                  {[true, false].map((pub, i) => {
                    const on = isPublic === pub;
                    return (
                      <React.Fragment key={pub ? 'pub' : 'priv'}>
                        {i > 0 ? <View style={[sty.cardSep, { backgroundColor: g.separator }]} /> : null}
                        <TouchableOpacity
                          style={sty.radioRow}
                          onPress={() => setIsPublic(pub)}
                          activeOpacity={0.6}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: on }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[sty.radioTitle, { color: colors.text }]}>
                              {pub ? t('channel.public') : t('channel.private')}
                            </Text>
                            <Text style={[sty.radioDesc, { color: g.secondary }]} numberOfLines={2}>
                              {pub ? t('channel.publicDesc') : t('channel.privateDesc')}
                            </Text>
                          </View>
                          <View style={[sty.radio, { borderColor: on ? ink : g.tertiary }]}>
                            {on ? <View style={[sty.radioDot, { backgroundColor: ink }]} /> : null}
                          </View>
                        </TouchableOpacity>
                      </React.Fragment>
                    );
                  })}
                </View>
              </>
            )}

            {/* Selected members summary (group only) */}
            {!isChannel && selectedMembers.length > 0 && (
              <>
                <Text style={[sty.sectionHd, { color: g.header }]}>
                  {t('group.addMembers')} ({selectedMembers.length})
                </Text>
                <View style={[sty.card, { backgroundColor: g.cardBg }]}>
                  {selectedMembers.map((m, i) => (
                    <View key={m.email} style={sty.memberRow}>
                      <AvatarCircle email={m.email} name={m.name} size={36} />
                      <View style={[sty.memberBody, i < selectedMembers.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: g.separator }]}>
                        <Text style={[sty.memberName, { color: colors.text }]} numberOfLines={1}>
                          {m.name || m.email.split('@')[0]}
                        </Text>
                        <TouchableOpacity
                          onPress={() => toggleMember(m)}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          accessibilityRole="button"
                          accessibilityLabel={`${t('common.remove') || 'Remover'} ${m.name || m.email}`}
                        >
                          <IconX size={16} color={g.secondary} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}
          </ScrollView>
        )}
      </KeyboardSafeView>
    </Modal>
  );
}

const sty = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: Platform.OS === 'ios' ? 54 : androidTopInset(12),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { minWidth: 76, justifyContent: 'center', alignItems: 'flex-start' },
  headerSideRight: { alignItems: 'flex-end' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  headerSubtitle: { fontSize: 12, marginTop: 1, fontVariant: ['tabular-nums'] },
  headerActionText: { fontSize: 17, fontWeight: '600' },
  chipsRow: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chipsContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 14,
    flexDirection: 'row',
  },
  chip: { alignItems: 'center', width: 60 },
  chipX: {
    position: 'absolute', right: -2, top: -2,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  chipText: { fontSize: 12, marginTop: 5, maxWidth: 60, textAlign: 'center' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 36,
    gap: 6,
  },
  searchInput: {
    flex: 1, fontSize: 16, padding: 0,
    ...(isWeb ? { outlineStyle: 'none' } : {}),
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    minHeight: 62,
    gap: 12,
  },
  contactInfo: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactName: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  contactEmail: { fontSize: 13, marginTop: 2 },
  checkbox: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
  },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 15 },
  step2Content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 40 },
  photoCircle: {
    width: 104, height: 104, borderRadius: 52,
    alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  photoBadge: {
    position: 'absolute', right: 0, bottom: 2,
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2.5,
    zIndex: 2, elevation: 4,
  },
  card: { borderRadius: 14, overflow: 'hidden' },
  cardSep: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  nameRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 52 },
  nameInput: {
    flex: 1, fontSize: 17, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    ...(isWeb ? { outlineStyle: 'none' } : {}),
  },
  counter: { fontSize: 13, marginLeft: 8, fontVariant: ['tabular-nums'] },
  descInput: {
    fontSize: 16, minHeight: 52, maxHeight: 140,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14,
    textAlignVertical: 'top',
    ...(isWeb ? { outlineStyle: 'none' } : {}),
  },
  sectionHd: {
    fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.3,
    marginTop: 28, marginBottom: 7, marginLeft: 16,
  },
  radioRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  radioTitle: { fontSize: 16, fontWeight: '500' },
  radioDesc: { fontSize: 13, marginTop: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, gap: 12 },
  memberBody: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingRight: 16, gap: 10 },
  memberName: { flex: 1, fontSize: 16 },
});
