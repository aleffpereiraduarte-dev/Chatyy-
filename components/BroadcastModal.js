import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import { IconCheck } from './Icons';
import AvatarCircle from './AvatarCircle';
import ModalHeader from './ModalHeader';
import * as api from '../services/api';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragBackdrop } from './ui/useDragToDismiss';

export default function BroadcastModal({ visible, onClose, onCreated, colors, t, editBroadcast }) {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag73 = useDragToDismiss({ onDismiss: () => { const f = onClose; if (typeof f === 'function') f(); } });
  const [name, setName] = useState('');
  const [contacts, setContacts] = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      loadContacts();
      if (editBroadcast) {
        setName(editBroadcast.name || '');
        setSelected(editBroadcast.members || []);
      } else {
        setName('');
        setSelected([]);
      }
    }
  }, [visible]);

  const loadContacts = async () => {
    setLoading(true);
    try {
      const r = await api.chatContacts();
      if (r.success) setContacts(r.data?.contacts || []);
    } catch {}
    setLoading(false);
  };

  const toggle = (email) => {
    setSelected(prev =>
      prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]
    );
  };

  const handleSave = async () => {
    if (selected.length === 0 || saving) return;
    setSaving(true);
    // [grupos 2026-10-21] nome padrão sem acento ("Transmissao") e falha calada
    // (a folha ficava parada sem dizer nada). Agora: nome traduzido + alerta.
    const listName = name.trim() || (t?.('chat.broadcastList') || 'Lista de transmissão');
    const fail = (msg) => { try { require('../services/alerts').safeAlert(t?.('common.error') || 'Erro', msg); } catch {} };
    try {
      let r;
      if (editBroadcast) {
        r = await api.chatBroadcastUpdate(editBroadcast.id, listName, selected);
      } else {
        r = await api.chatBroadcastCreate(listName, selected);
      }
      if (r?.success) {
        onCreated?.();
        onClose();
      } else {
        fail(t?.('common.genericError') || 'Não foi possível completar a ação. Tente de novo em instantes.');
      }
    } catch {
      fail(t?.('common.networkError') || 'Erro de rede. Verifique sua conexão.');
    }
    setSaving(false);
  };

  const filtered = contacts.filter(c =>
    c.email && (
      !search ||
      c.email.toLowerCase().includes(search.toLowerCase()) ||
      c.name?.toLowerCase().includes(search.toLowerCase())
    )
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <DragSheetRoot>
      <Pressable style={[{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }, { backgroundColor: 'transparent' }]} onPress={onClose}>
        <DragBackdrop drag={_drag73} color="rgba(0,0,0,0.5)" />
        <DragPanel drag={_drag73} onStartShouldSetResponder={() => true} style={{
          marginTop: 'auto', maxHeight: '80%', backgroundColor: colors.surface,
          borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden',
        }} >
          {/* Header */}
          <ModalHeader
            title={editBroadcast
              ? (t?.('chat.editBroadcast') || 'Editar lista de transmissão')
              : (t?.('chat.newBroadcast') || 'Nova lista de transmissão')}
            onClose={onClose}
            rightActionLabel={t?.('common.save') || 'Salvar'}
            onRightAction={handleSave}
            rightActionDisabled={saving || selected.length === 0}
          />

          {/* Name */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t?.('chat.broadcastName') || 'Nome da lista'}
              placeholderTextColor={colors.textTertiary}
              style={{
                backgroundColor: colors.background, borderRadius: 10, paddingHorizontal: 16,
                paddingVertical: 10, color: colors.text, fontSize: 15, height: 39, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */,
              }}
            />
          </View>

          {/* Selected count */}
          {selected.length > 0 && (
            <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>
              {selected.length} {t?.('chat.broadcastMembers') || 'membros'}
            </Text>
          )}

          {/* Search */}
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t?.('chat.searchContacts') || 'Buscar contatos…'}
              placeholderTextColor={colors.textTertiary}
              style={{
                backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 16,
                paddingVertical: 8, color: colors.text, fontSize: 14, height: 34, paddingTop: 0, paddingBottom: 0 /* [2026-10-17 input-align] altura fixa: texto centrado no iOS */,
              }}
            />
          </View>

          {/* Contact list */}
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ padding: 20 }} />
          ) : (
            <DragScroll drag={_drag73}><FlatList
              data={filtered}
              extraData={selected}
              keyExtractor={item => item.email}
              keyboardShouldPersistTaps="handled"
              style={{ maxHeight: 300 }}
              renderItem={({ item }) => {
                const isSelected = selected.includes(item.email);
                return (
                  <TouchableOpacity
                    onPress={() => toggle(item.email)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                      paddingVertical: 10,
                    }}
                    activeOpacity={0.6}
                  >
                    <AvatarCircle email={item.email} name={item.name || item.email} size={40} colors={colors} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>
                        {item.name || item.email}
                      </Text>
                      <Text style={{ color: colors.textTertiary, fontSize: 13 }}>{item.email}</Text>
                    </View>
                    <View style={{
                      width: 24, height: 24, borderRadius: 12,
                      backgroundColor: isSelected ? colors.primary : 'transparent',
                      borderWidth: isSelected ? 0 : 2, borderColor: colors.border,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isSelected && <IconCheck size={14} color={colors.onPrimary || '#fff'} />}
                    </View>
                  </TouchableOpacity>
                );
              }}
            /></DragScroll>
          )}
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}
