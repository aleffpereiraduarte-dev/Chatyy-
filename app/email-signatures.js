/**
 * /email-signatures — Manage multiple email signatures.
 *
 * Lists all signatures for the current user (work, personal, billing, etc.)
 * with create / edit / delete / set-default. Each signature can optionally
 * be tied to a from_alias so when the user sends from that alias the right
 * signature auto-attaches server-side. The default fires when nothing else
 * matches.
 *
 * Backend: signatures_list / signatures_create / signatures_update /
 * signatures_delete / signatures_set_default. Server inserts the chosen
 * signature into outgoing mail in `case 'send'` automatically.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Switch, FlatList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius } from '../constants/theme';
import { IconPlus, IconTrash, IconEdit, IconCheck } from '../components/Icons';
import { apiCall } from '../services/api';
import BrandFab from '../components/BrandFab';
import ModalHeader from '../components/ModalHeader';

export default function EmailSignaturesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | sig object
  const [name, setName] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [aliasEmail, setAliasEmail] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall('signatures_list');
      if (r.success && Array.isArray(r.data)) setItems(r.data);
    } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const reset = () => {
    setEditing(null); setName(''); setBodyHtml(''); setAliasEmail(''); setIsDefault(false);
  };
  const startEdit = (s) => {
    setEditing(s);
    setName(s.name || '');
    setBodyHtml(s.body_html || '');
    setAliasEmail(s.alias_email || '');
    setIsDefault(!!s.is_default);
  };

  const handleSave = async () => {
    const n = name.trim();
    const b = bodyHtml.trim();
    if (!n || !b) {
      Alert.alert(t('settings.signatures') || 'Assinaturas', t('signatures.required') || 'Nome e corpo obrigatórios');
      return;
    }
    if (editing && editing !== 'new') {
      const r = await apiCall('signatures_update', {
        id: editing.id, name: n, body_html: b, alias_email: aliasEmail.trim().toLowerCase(), is_default: isDefault,
      }, 'POST');
      if (!r.success) { Alert.alert('', r.message || 'Failed'); return; }
    } else {
      const r = await apiCall('signatures_create', {
        name: n, body_html: b, alias_email: aliasEmail.trim().toLowerCase(), is_default: isDefault,
      }, 'POST');
      if (!r.success) { Alert.alert('', r.message || 'Failed'); return; }
    }
    reset();
    load();
  };

  const handleDelete = (s) => {
    Alert.alert(
      t('signatures.confirmDeleteTitle') || 'Remover assinatura',
      t('signatures.confirmDelete') || 'Tem certeza?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('common.delete') || 'Remover', style: 'destructive',
          onPress: async () => {
            const r = await apiCall('signatures_delete', { id: s.id }, 'POST');
            if (r.success) load();
          },
        },
      ],
    );
  };

  const setDefault = async (s) => {
    const r = await apiCall('signatures_set_default', { id: s.id }, 'POST');
    if (r.success) load();
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <ModalHeader
        title={editing ? (editing === 'new' ? (t('signatures.newSignature') || 'Nova assinatura') : (t('signatures.editSignature') || 'Editar assinatura'))
          : (t('settings.signatures') || 'Assinaturas')}
        onClose={() => editing ? reset() : router.back()}
      />

      {editing ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <Text style={[s.label, { color: colors.textSecondary }]}>
            {t('signatures.nameLabel') || 'Nome'}
          </Text>
          <TextInput
            style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
            value={name} onChangeText={setName}
            placeholder={t('signatures.namePlaceholder') || 'Ex: Trabalho'}
            placeholderTextColor={colors.textTertiary}
          />

          <Text style={[s.label, { color: colors.textSecondary }]}>
            {t('signatures.bodyLabel') || 'Corpo (HTML aceito)'}
          </Text>
          <TextInput
            style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant, height: 160, textAlignVertical: 'top' }]}
            value={bodyHtml} onChangeText={setBodyHtml}
            multiline
            placeholder={'-- \nNome\nCargo\nempresa.com'}
            placeholderTextColor={colors.textTertiary}
          />

          <Text style={[s.label, { color: colors.textSecondary }]}>
            {t('signatures.aliasLabel') || 'Atribuir a alias (opcional)'}
          </Text>
          <TextInput
            style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceVariant }]}
            value={aliasEmail} onChangeText={setAliasEmail}
            autoCapitalize="none" keyboardType="email-address"
            placeholder="alias@chatyy.com.br"
            placeholderTextColor={colors.textTertiary}
          />

          <View style={s.switchRow}>
            <Text style={[s.switchLabel, { color: colors.text }]}>
              {t('signatures.makeDefault') || 'Tornar padrão'}
            </Text>
            <Switch value={isDefault} onValueChange={setIsDefault} trackColor={{ true: colors.primary, false: colors.border }} />
          </View>

          <TouchableOpacity onPress={handleSave} style={[s.cta, { backgroundColor: '#7C3AED' }]}>
            <IconCheck size={18} color="#fff" />
            <Text style={s.ctaText}>{t('common.save') || 'Salvar'}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              data={items}
              keyExtractor={(it) => String(it.id)}
              ListEmptyComponent={
                <View style={{ paddingVertical: 40, paddingHorizontal: 24, alignItems: 'center' }}>
                  <View style={{
                    width: 64, height: 64, borderRadius: 32,
                    backgroundColor: colors.primary + '15',
                    alignItems: 'center', justifyContent: 'center',
                    marginBottom: 16,
                  }}>
                    <IconEdit size={28} color={colors.primary} />
                  </View>
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 6 }}>
                    {t('signatures.emptyTitle') || 'Sem assinaturas ainda'}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 18, lineHeight: 18 }}>
                    {t('signatures.emptySubtitle') || 'Crie uma assinatura pra aparecer no fim dos seus emails'}
                  </Text>
                  <TouchableOpacity
                    onPress={() => { setEditing('new'); setName(''); setBodyHtml(''); setAliasEmail(''); setIsDefault(items.length === 0); }}
                    style={{
                      backgroundColor: colors.primary,
                      paddingHorizontal: 18, paddingVertical: 11,
                      borderRadius: BorderRadius.md,
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('signatures.createFirst') || 'Criar primeira assinatura'}
                  >
                    <IconPlus size={16} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
                      {t('signatures.createFirst') || 'Criar primeira assinatura'}
                    </Text>
                  </TouchableOpacity>
                </View>
              }
              renderItem={({ item }) => (
                <View style={[s.row, { borderBottomColor: colors.borderLight }]}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => startEdit(item)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={[s.rowName, { color: colors.text }]}>{item.name}</Text>
                      {item.is_default ? (
                        <View style={[s.badge, { backgroundColor: '#7C3AED' }]}>
                          <Text style={s.badgeText}>{t('signatures.defaultBadge') || 'Padrão'}</Text>
                        </View>
                      ) : null}
                    </View>
                    {item.alias_email ? (
                      <Text style={[s.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                        {item.alias_email}
                      </Text>
                    ) : null}
                    <Text style={[s.rowMeta, { color: colors.textTertiary }]} numberOfLines={2}>
                      {(item.body_html || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 100)}
                    </Text>
                  </TouchableOpacity>
                  {!item.is_default ? (
                    <TouchableOpacity onPress={() => setDefault(item)} style={s.rowBtn}>
                      <Text style={[s.rowBtnText, { color: colors.primary }]}>
                        {t('signatures.makeDefault') || 'Tornar padrão'}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity onPress={() => handleDelete(item)} style={s.rowBtnIcon}>
                    <IconTrash size={16} color={colors.error || '#dc2626'} />
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
          <BrandFab
            style={{ position: 'absolute', right: 20, bottom: 24 }}
            size={52}
            color="#7C3AED"
            onPress={() => { setEditing('new'); setName(''); setBodyHtml(''); setAliasEmail(''); setIsDefault(items.length === 0); }}
            accessibilityLabel="New signature"
          >
            <IconPlus size={22} color="#fff" />
          </BrandFab>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  label: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 12, marginBottom: 4, letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  switchLabel: { fontSize: 15, fontWeight: '500' },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: BorderRadius.lg, marginTop: 24 },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 12, marginTop: 2 },
  rowBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  rowBtnText: { fontSize: 12, fontWeight: '700' },
  rowBtnIcon: { padding: 8 },
  badge: { marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  fab: { position: 'absolute', right: 20, bottom: 24, width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
});
