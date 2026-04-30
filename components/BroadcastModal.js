import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import { IconX, IconCheck } from './Icons';
import AvatarCircle from './AvatarCircle';
import * as api from '../services/api';

export default function BroadcastModal({ visible, onClose, onCreated, colors, t, editBroadcast }) {
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
    if (selected.length === 0) return;
    setSaving(true);
    try {
      let r;
      if (editBroadcast) {
        r = await api.chatBroadcastUpdate(editBroadcast.id, name || 'Transmissao', selected);
      } else {
        r = await api.chatBroadcastCreate(name || 'Transmissao', selected);
      }
      if (r.success) {
        onCreated?.();
        onClose();
      }
    } catch {}
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
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable style={{
          marginTop: 'auto', maxHeight: '80%', backgroundColor: colors.surface,
          borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden',
        }} onPress={() => {}}>
          {/* Header */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', padding: 16,
            borderBottomWidth: 1, borderBottomColor: colors.border,
          }}>
            <TouchableOpacity onPress={onClose} style={{ marginRight: 12 }}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text, flex: 1 }}>
              {editBroadcast
                ? (t?.('chat.editBroadcast') || 'Editar transmissao')
                : (t?.('chat.newBroadcast') || 'New broadcast list')}
            </Text>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving || selected.length === 0}
              style={{
                backgroundColor: selected.length > 0 ? colors.primary : colors.border,
                paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
              }}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>
                  {t?.('common.save') || 'Salvar'}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Name */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t?.('chat.broadcastName') || 'List name'}
              placeholderTextColor={colors.textTertiary}
              style={{
                backgroundColor: colors.background, borderRadius: 10, paddingHorizontal: 16,
                paddingVertical: 10, color: colors.text, fontSize: 15,
              }}
            />
          </View>

          {/* Selected count */}
          {selected.length > 0 && (
            <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: colors.primary, fontSize: 13, fontWeight: '600' }}>
              {selected.length} {t?.('chat.broadcastMembers') || 'members'}
            </Text>
          )}

          {/* Search */}
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t?.('chat.searchContacts') || 'Search contacts...'}
              placeholderTextColor={colors.textTertiary}
              style={{
                backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 16,
                paddingVertical: 8, color: colors.text, fontSize: 14,
              }}
            />
          </View>

          {/* Contact list */}
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ padding: 20 }} />
          ) : (
            <FlatList
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
                      {isSelected && <IconCheck size={14} color="#fff" />}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
