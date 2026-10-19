// [2026-10-18 profile-sheets] Folhas do perfil /u/* extraídas do Profile.js.
//
// Antes: 4 <Modal> RN dentro da função de 3,5 mil linhas do Profile — abrir
// qualquer um (setState no Profile) re-renderizava o perfil INTEIRO (header,
// grade, destaques…). Agora cada folha é um componente memo com estado LOCAL
// (visível + payload), aberto por ref (open/close): abrir/fechar/digitar só
// re-renderiza a própria folha.
//
// Apresentação:
//   • nativo (iOS/Android) → sheet do sistema (NativeSheet fitToContents, mesmo
//     padrão do ChatLockSheet) / NativeSheetDialog no apelido;
//   • web, kill switch globalThis.__chatyy_profile_native_sheets === false, ou
//     perfil em modo "peek" (que vive dentro de um <Modal> RN — NUNCA apresentar
//     sheet do sistema por cima de Modal RN) → o <Modal> JS de antes.
// Ações que abrem OUTRA apresentação (câmera, editor, lightbox, Alert, Share,
// denúncia) esperam o sheet nativo descer (runAfterNativeSheet).
import React, { forwardRef, memo, useCallback, useImperativeHandle, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad, runAfterNativeSheet } from '../NativeSheet';
import NativeSheetDialog from '../NativeSheetDialog';
import NativeSwitch from '../NativeSwitch';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from '../ui/useDragToDismiss';
import { androidBottomInset } from '../../utils/systemInsets';
import {
  IconShare, IconAlertTriangle, IconLock, IconEdit, IconTrash, IconPlus, IconGrid, IconEyeOff, IconCamera, IconImage,
} from '../Icons';
import { ppT } from '../../services/profilePhotos'; // [perfil-fotos 2026-10-19]

/** Sheets do sistema no perfil? (lido no render do dono). */
export function profileNativeSheetsOn(mode) {
  if (!USE_NATIVE_SHEETS) return false;
  if (mode === 'peek') return false; // peek = dentro de <Modal> RN
  try { if (globalThis.__chatyy_profile_native_sheets === false) return false; } catch {}
  return true;
}

const ROW = { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 };

// Casca comum: sheet do sistema (fitToContents) ou o Modal JS arrastável de antes.
function SheetShell({ native, visible, onClose, bg, isDark, drag, grabberColor, panelExtra, children }) {
  const insets = useSafeAreaInsets();
  if (native) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents="fitToContents" backgroundColor={bg}>
        <View style={{ paddingTop: 18, paddingBottom: nativeSheetBottomPad(insets, 10), backgroundColor: bg }}>
          {children}
        </View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <DragSheetRoot>
        <Pressable style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'transparent' }} onPress={onClose}>
          <DragBackdrop drag={drag} color="rgba(0,0,0,0.45)" />
          <DragPanel
            drag={drag}
            onStartShouldSetResponder={() => true}
            style={[{
              backgroundColor: bg,
              borderTopLeftRadius: 18, borderTopRightRadius: 18,
              paddingBottom: Platform.OS === 'ios' ? 30 : androidBottomInset(14),
            }, panelExtra]}
          >
            <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: grabberColor || (isDark ? '#333' : '#ddd') }} />
            </View>
            {children}
          </DragPanel>
        </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

// Fecha e roda a ação depois que o sheet nativo saiu (no Modal JS: na hora).
function useCloseThen(native, close) {
  return useCallback((fn) => {
    close();
    if (typeof fn !== 'function') return;
    if (native) runAfterNativeSheet(fn);
    else fn();
  }, [native, close]);
}

// ── Destaque (pressionar e segurar): Editar / Compartilhar / Apagar ─────────
export const ProfileHighlightMenuSheet = memo(forwardRef(function ProfileHighlightMenuSheet(
  { native, colors, isDark, t, onEdit, onShare, onDelete }, ref,
) {
  const [h, setH] = useState(null);
  const close = useCallback(() => setH(null), []);
  useImperativeHandle(ref, () => ({ open: (highlight) => setH(highlight || null), close }), [close]);
  const drag = useDragToDismiss({ onDismiss: close });
  const then = useCloseThen(native, close);
  const bg = colors?.background || (isDark ? '#1a1a1a' : '#fff');
  const confirmDelete = (hl) => {
    Alert.alert(
      t?.('profile.deleteHighlightTitle') || 'Apagar destaque?',
      t?.('profile.deleteHighlightHint') || 'Os status originais não são afetados.',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('common.delete') || 'Apagar', style: 'destructive', onPress: () => onDelete?.(hl) },
      ],
    );
  };
  return (
    <SheetShell native={native} visible={!!h} onClose={close} bg={bg} isDark={isDark} drag={drag}
      grabberColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'}>
      <Text style={{ textAlign: 'center', color: colors?.textSecondary, fontSize: 13, fontWeight: '600', paddingVertical: 8 }} numberOfLines={1}>
        {h?.title || ''}
      </Text>
      {h?.isSelf ? (
        <TouchableOpacity onPress={() => { const x = h; then(() => onEdit?.(x)); }} style={ROW}>
          <IconEdit size={20} color={colors?.text} />
          <Text style={{ color: colors?.text, fontSize: 16, fontWeight: '500' }}>{t?.('profile.editHighlight') || 'Editar destaque'}</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={() => { const x = h; then(() => onShare?.(x)); }} style={ROW}>
        <IconShare size={20} color={colors?.text} />
        <Text style={{ color: colors?.text, fontSize: 16, fontWeight: '500' }}>{t?.('profile.shareHighlight') || 'Compartilhar destaque'}</Text>
      </TouchableOpacity>
      {h?.isSelf ? (
        <TouchableOpacity onPress={() => { const x = h; then(() => confirmDelete(x)); }} style={ROW}>
          <IconTrash size={20} color="#dc2626" />
          <Text style={{ color: '#dc2626', fontSize: 16, fontWeight: '500' }}>{t?.('common.delete') || 'Apagar'}</Text>
        </TouchableOpacity>
      ) : null}
    </SheetShell>
  );
}));

// ── "Mais" (perfil de outra pessoa): Compartilhar / Apelido / Ocultar status / Bloquear / Denunciar ──
export const ProfileMoreMenuSheet = memo(forwardRef(function ProfileMoreMenuSheet(
  {
    native, colors, isDark, t, showContactRows, nicknameValue, hideStatusFromContact, hideStatusSaving,
    onShare, onNickname, onToggleHideStatus, onBlock, onReport,
  }, ref,
) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true), close }), [close]);
  const drag = useDragToDismiss({ onDismiss: close });
  const then = useCloseThen(native, close);
  const bg = colors?.background || '#fff';
  return (
    <SheetShell native={native} visible={open} onClose={close} bg={bg} isDark={isDark} drag={drag}>
      <TouchableOpacity onPress={() => then(onShare)} style={ROW}>
        <IconShare size={20} color={colors?.text} />
        <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>{t?.('profile.share') || 'Compartilhar perfil'}</Text>
      </TouchableOpacity>
      {showContactRows && (
        <TouchableOpacity onPress={() => then(onNickname)} style={ROW}>
          <IconEdit size={20} color={colors?.text} />
          <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
            {nicknameValue
              ? `${t?.('profile.nicknameEdit') || 'Editar apelido'}: ${nicknameValue}`
              : (t?.('profile.nicknameAdd') || 'Adicionar apelido')}
          </Text>
        </TouchableOpacity>
      )}
      {showContactRows && (
        // Privacidade por contato estilo WhatsApp (não fecha a folha; UI otimista).
        <TouchableOpacity
          onPress={() => onToggleHideStatus?.()}
          activeOpacity={0.7}
          style={[ROW, { justifyContent: 'space-between' }]}
          accessibilityRole="switch"
          accessibilityState={{ checked: !!hideStatusFromContact }}
          accessibilityLabel={t?.('profile.hideStatusFromContact') || 'Ocultar status deste contato'}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 }}>
            <IconEyeOff size={20} color={colors?.text} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>
                {t?.('profile.hideStatusFromContact') || 'Ocultar status deste contato'}
              </Text>
              <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 2 }}>
                {t?.('profile.hideStatusFromContactDesc') || 'Este contato não verá seus status'}
              </Text>
            </View>
          </View>
          <NativeSwitch
            value={!!hideStatusFromContact}
            onValueChange={onToggleHideStatus}
            disabled={!!hideStatusSaving}
            trackColor={{ false: '#767577', true: colors?.primary || '#111111' }}
            thumbColor={Platform.OS === 'android' ? (hideStatusFromContact ? '#fff' : '#f4f3f4') : undefined}
          />
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => then(onBlock)} style={ROW}>
        <IconLock size={20} color={colors?.text} />
        <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>{t?.('profile.block') || 'Bloquear'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => then(onReport)} style={ROW}>
        <IconAlertTriangle size={20} color={colors?.error || '#ef4444'} />
        <Text style={{ fontSize: 15, color: '#ef4444', fontWeight: '500' }}>{t?.('profile.report') || 'Denunciar'}</Text>
      </TouchableOpacity>
      {!native && (
        // Sheet do sistema fecha por gesto/fundo — "Cancelar" só no Modal JS.
        <TouchableOpacity onPress={close} style={{ alignItems: 'center', paddingVertical: 14, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors?.border }}>
          <Text style={{ fontSize: 15, color: colors?.textSecondary }}>{t?.('common.cancel') || 'Cancelar'}</Text>
        </TouchableOpacity>
      )}
    </SheetShell>
  );
}));

// ── Apelido (rascunho LOCAL: digitar não re-renderiza o perfil) ─────────────
export const ProfileNicknameDialog = memo(forwardRef(function ProfileNicknameDialog(
  { native, colors, t, placeholder, onSave }, ref,
) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const close = useCallback(() => setOpen(false), []);
  useImperativeHandle(ref, () => ({
    open: (initial) => { setDraft(String(initial || '')); setOpen(true); },
    close,
  }), [close]);
  const panelStyle = {
    width: '100%', maxWidth: 360,
    backgroundColor: colors?.surface || '#fff',
    borderRadius: 18, padding: 20,
    borderWidth: native ? 0 : 1, borderColor: colors?.border || 'rgba(0,0,0,0.08)',
  };
  return (
    <NativeSheetDialog
      visible={open}
      onClose={close}
      disableNative={!native}
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 }}
      panelStyle={panelStyle}
    >
      <NativeSheetKeyboardView enabled={!!native} style={{ flex: 0 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors?.text, marginBottom: 6 }}>
          {t?.('profile.nickname') || 'Apelido'}
        </Text>
        <Text style={{ fontSize: 13, color: colors?.textSecondary, marginBottom: 14 }}>
          {t?.('profile.nicknameHint') || 'Só você vê este nome. Pode trocar quando quiser.'}
        </Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder || ''}
          placeholderTextColor={colors?.textTertiary}
          autoFocus
          maxLength={60}
          style={{
            fontSize: 16, color: colors?.text,
            borderWidth: 1, borderColor: colors?.border || 'rgba(0,0,0,0.12)',
            borderRadius: 12, paddingHorizontal: 14,
            backgroundColor: colors?.background, height: 42, paddingTop: 0, paddingBottom: 0,
          }}
        />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <TouchableOpacity
            onPress={close}
            style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors?.background, borderWidth: 1, borderColor: colors?.border || 'rgba(0,0,0,0.08)' }}
          >
            <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '500' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { const val = draft.trim(); close(); onSave?.(val); }}
            style={{ flex: 1, paddingVertical: 12, minHeight: 44, justifyContent: 'center', borderRadius: 12, alignItems: 'center', backgroundColor: colors?.primary || '#111111' }}
          >
            <Text style={{ fontSize: 15, color: colors?.onPrimary || '#fff', fontWeight: '600' }}>{t?.('common.save') || 'Salvar'}</Text>
          </TouchableOpacity>
        </View>
      </NativeSheetKeyboardView>
    </NativeSheetDialog>
  );
}));

// ── Avatar (meu perfil): Adicionar ao status / Mudar foto / Ver foto ────────
export const ProfileAvatarActionsSheet = memo(forwardRef(function ProfileAvatarActionsSheet(
  { native, colors, isDark, t, onAddStatus, onEditPhoto, onViewPhoto, onAddPhoto, onPublishPost }, ref,
) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true), close }), [close]);
  const drag = useDragToDismiss({ onDismiss: close });
  const then = useCloseThen(native, close);
  const bg = colors?.background || '#fff';
  const rows = [
    {
      key: 'addStatus',
      label: t?.('profile.avatarAddStatus') || 'Adicionar ao status',
      hint: t?.('profile.avatarAddStatusHint') || 'Câmera + filtros, stickers e texto',
      Icon: IconPlus,
      fn: onAddStatus,
    },
    {
      key: 'editPhoto',
      label: t?.('profile.avatarEditPhoto') || 'Mudar foto de perfil',
      hint: t?.('profile.avatarEditPhotoHint') || 'Atualizar foto, nome, bio',
      Icon: IconEdit,
      fn: onEditPhoto,
    },
    {
      key: 'viewPhoto',
      label: t?.('profile.avatarView') || 'Ver foto',
      hint: t?.('profile.avatarViewHint') || 'Em tela cheia',
      Icon: IconGrid,
      fn: onViewPhoto,
    },
  ];
  // [perfil-fotos 2026-10-19] galeria de fotos (Telegram) + publicar no perfil.
  if (typeof onAddPhoto === 'function') rows.splice(1, 0, { key: 'addPhoto', label: ppT(t, 'addPhoto'), hint: ppT(t, 'addPhotoHint'), Icon: IconCamera, fn: onAddPhoto });
  if (typeof onPublishPost === 'function') rows.push({ key: 'publishPost', label: ppT(t, 'publish'), hint: ppT(t, 'publishHint'), Icon: IconImage, fn: onPublishPost });
  return (
    <SheetShell native={native} visible={open} onClose={close} bg={bg} isDark={isDark} drag={drag} panelExtra={{ paddingTop: 4 }}>
      {rows.map((row) => (
        <TouchableOpacity
          key={row.key}
          onPress={() => then(row.fn)}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
        >
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
            <row.Icon size={20} color={colors?.text} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '600' }}>{row.label}</Text>
            {!!row.hint && <Text style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 2 }}>{row.hint}</Text>}
          </View>
        </TouchableOpacity>
      ))}
      {!native && (
        <TouchableOpacity
          onPress={close}
          activeOpacity={0.7}
          style={{ marginTop: 6, paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}
        >
          <Text style={{ fontSize: 15, color: colors?.text, fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
        </TouchableOpacity>
      )}
    </SheetShell>
  );
}));
