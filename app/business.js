// Business Profile — WhatsApp Business features for Chatyy
// Business profile, product catalog, cart, auto-replies, labels

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView,
  FlatList, Modal, Platform, Alert, Image, ActivityIndicator,
  KeyboardAvoidingView, Pressable, Animated, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import * as api from '../services/api';
import {
  IconArrowLeft, IconPlus, IconEdit, IconTrash, IconX, IconCheck,
  IconSearch, IconChevronRight, IconCamera, IconShoppingCart,
  IconStar, IconTag, IconBell, IconSettings, IconUser,
} from '../components/Icons';
import Svg, { Path, Rect, Circle, Line, Polyline } from 'react-native-svg';

// ─── Brand accent ───
const ACCENT = '#25D366'; // WhatsApp green
const ACCENT_DARK = '#128C7E';
const VERIFIED_COLOR = '#1DA1F2';

// ─── Helper: safe Alert ───
const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// ─── Business Category icons ───
const CATEGORIES = [
  'Varejo', 'Alimentação', 'Serviços', 'Saúde & Beleza', 'Educação',
  'Tecnologia', 'Moda', 'Imóveis', 'Finanças', 'Viagens', 'Outros',
];

// ─── Label colors (WhatsApp Business style) ───
const LABEL_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
];

const LABEL_DEFAULTS = [
  { name: 'Novo cliente', color: '#22c55e' },
  { name: 'Aguardando', color: '#eab308' },
  { name: 'Concluído', color: '#3b82f6' },
  { name: 'Pagamento pendente', color: '#f97316' },
  { name: 'Cancelado', color: '#ef4444' },
];

// ─── Custom Icons ───
function IconStore({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <Polyline points="9 22 9 12 15 12 15 22" />
    </Svg>
  );
}

function IconPackage({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <Path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <Polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <Line x1="12" y1="22.08" x2="12" y2="12" />
    </Svg>
  );
}

function IconReply({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="9 17 4 12 9 7" />
      <Path d="M20 18v-2a4 4 0 00-4-4H4" />
    </Svg>
  );
}

function IconVerified({ size = 20, color = VERIFIED_COLOR }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </Svg>
  );
}

function IconLabel({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
      <Line x1="7" y1="7" x2="7.01" y2="7" />
    </Svg>
  );
}

// ─── Tab icons ───
const TABS = [
  { key: 'profile', label: 'Perfil', icon: IconStore },
  { key: 'catalog', label: 'Catálogo', icon: IconPackage },
  { key: 'cart', label: 'Carrinho', icon: IconShoppingCart },
  { key: 'autoreplies', label: 'Respostas', icon: IconReply },
  { key: 'labels', label: 'Labels', icon: IconLabel },
];

// ─── Main Screen ───
export default function BusinessScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState('profile');
  const [cart, setCart] = useState([]); // { product, qty }

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Voltar">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={[styles.brandDot, { backgroundColor: ACCENT }]} />
          <Text style={[styles.headerTitle, { color: colors.text }]}>Negócios</Text>
        </View>
        {activeTab === 'catalog' && cartCount > 0 && (
          <TouchableOpacity onPress={() => setActiveTab('cart')} style={styles.cartBtn}>
            <IconShoppingCart size={22} color={colors.text} />
            <View style={[styles.cartBadge, { backgroundColor: ACCENT }]}>
              <Text style={styles.cartBadgeText}>{cartCount}</Text>
            </View>
          </TouchableOpacity>
        )}
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8 }}>
          {TABS.map(tab => {
            const active = activeTab === tab.key;
            const Icon = tab.icon;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={[styles.tabItem, active && { borderBottomColor: ACCENT, borderBottomWidth: 2 }]}
              >
                <Icon size={18} color={active ? ACCENT : colors.textSecondary} />
                <Text style={[styles.tabLabel, { color: active ? ACCENT : colors.textSecondary }]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Content */}
      {activeTab === 'profile' && <ProfileTab colors={colors} isDark={isDark} user={user} />}
      {activeTab === 'catalog' && <CatalogTab colors={colors} isDark={isDark} cart={cart} setCart={setCart} />}
      {activeTab === 'cart' && <CartTab colors={colors} isDark={isDark} cart={cart} setCart={setCart} user={user} />}
      {activeTab === 'autoreplies' && <AutoRepliesTab colors={colors} isDark={isDark} />}
      {activeTab === 'labels' && <LabelsTab colors={colors} isDark={isDark} />}
    </View>
  );
}

// ══════════════════════════════════════════════════
// PROFILE TAB
// ══════════════════════════════════════════════════
function ProfileTab({ colors, isDark, user }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    company_name: '', description: '', address: '', website: '',
    category: '', hours: '', phone: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('business_get_profile');
      if (r?.success && r.data?.profile) {
        setProfile(r.data.profile);
        setForm({
          company_name: r.data.profile.company_name || '',
          description: r.data.profile.description || '',
          address: r.data.profile.address || '',
          website: r.data.profile.website || '',
          category: r.data.profile.category || '',
          hours: r.data.profile.hours || '',
          phone: r.data.profile.phone || '',
        });
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!form.company_name.trim()) {
      safeAlert('Erro', 'Nome da empresa é obrigatório');
      return;
    }
    setBusy(true);
    try {
      const r = await api.apiCall('business_save_profile', form, 'POST');
      if (r?.success) {
        setProfile({ ...profile, ...form });
        setEditing(false);
      } else {
        safeAlert('Erro', r?.message || 'Falha ao salvar');
      }
    } catch (e) {
      safeAlert('Erro', String(e));
    }
    setBusy(false);
  };

  if (loading) return <LoadingView colors={colors} />;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }} showsVerticalScrollIndicator={false}>
        {/* Business card */}
        <View style={[styles.card, { backgroundColor: colors.surface, shadowColor: colors.shadow }]}>
          <View style={styles.profileHeader}>
            <View style={[styles.businessAvatar, { backgroundColor: ACCENT + '22' }]}>
              <IconStore size={40} color={ACCENT} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[styles.companyName, { color: colors.text }]}>
                  {profile?.company_name || 'Minha Empresa'}
                </Text>
                {profile?.is_verified && <IconVerified size={18} />}
              </View>
              {profile?.category ? (
                <View style={[styles.categoryBadge, { backgroundColor: ACCENT + '18' }]}>
                  <Text style={[styles.categoryText, { color: ACCENT_DARK }]}>{profile.category}</Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => setEditing(true)}
              style={[styles.editBtn, { backgroundColor: colors.inputBg }]}
              accessibilityLabel="Editar perfil"
            >
              <IconEdit size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {profile?.description ? (
            <Text style={[styles.descText, { color: colors.textSecondary }]}>{profile.description}</Text>
          ) : null}

          <View style={styles.infoRows}>
            {profile?.address ? <InfoRow icon="location" label={profile.address} colors={colors} /> : null}
            {profile?.phone ? <InfoRow icon="phone" label={profile.phone} colors={colors} /> : null}
            {profile?.website ? <InfoRow icon="globe" label={profile.website} colors={colors} accent /> : null}
            {profile?.hours ? <InfoRow icon="clock" label={profile.hours} colors={colors} /> : null}
          </View>

          {!profile?.is_verified && (
            <View style={[styles.verifyBanner, { backgroundColor: isDark ? '#1e293b' : '#f0f9ff', borderColor: '#bae6fd' }]}>
              <IconVerified size={16} color={VERIFIED_COLOR} />
              <Text style={[styles.verifyText, { color: isDark ? '#7dd3fc' : '#0369a1' }]}>
                Verifique sua conta para obter o selo de negócio verificado
              </Text>
            </View>
          )}
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <StatCard label="Produtos" value={profile?.product_count ?? '—'} color="#8b5cf6" colors={colors} />
          <StatCard label="Pedidos" value={profile?.order_count ?? '—'} color={ACCENT} colors={colors} />
          <StatCard label="Avaliação" value={profile?.rating ? `${profile.rating}★` : '—'} color="#f59e0b" colors={colors} />
        </View>
      </ScrollView>

      {/* Edit modal */}
      <Modal visible={editing} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditing(false)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setEditing(false)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Editar Perfil</Text>
            <TouchableOpacity onPress={handleSave} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={22} color={ACCENT} />}
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
              <FormField label="Nome da empresa *" value={form.company_name} onChangeText={v => setForm(f => ({ ...f, company_name: v }))} placeholder="Ex: Loja da Maria" colors={colors} />
              <FormField label="Descrição" value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))} placeholder="Sobre o negócio" multiline colors={colors} />
              <FormField label="Telefone" value={form.phone} onChangeText={v => setForm(f => ({ ...f, phone: v }))} placeholder="+55 11 99999-9999" keyboardType="phone-pad" colors={colors} />
              <FormField label="Endereço" value={form.address} onChangeText={v => setForm(f => ({ ...f, address: v }))} placeholder="Rua, número, cidade" colors={colors} />
              <FormField label="Site" value={form.website} onChangeText={v => setForm(f => ({ ...f, website: v }))} placeholder="https://..." keyboardType="url" colors={colors} />
              <FormField label="Horário de funcionamento" value={form.hours} onChangeText={v => setForm(f => ({ ...f, hours: v }))} placeholder="Seg-Sex 9h-18h" colors={colors} />
              <View style={{ gap: 6 }}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Categoria</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {CATEGORIES.map(cat => (
                      <TouchableOpacity
                        key={cat}
                        onPress={() => setForm(f => ({ ...f, category: cat }))}
                        style={[styles.catChip, { backgroundColor: form.category === cat ? ACCENT : colors.inputBg, borderColor: form.category === cat ? ACCENT : colors.border }]}
                      >
                        <Text style={[styles.catChipText, { color: form.category === cat ? '#fff' : colors.text }]}>{cat}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ══════════════════════════════════════════════════
// CATALOG TAB
// ══════════════════════════════════════════════════
function CatalogTab({ colors, isDark, cart, setCart }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editModal, setEditModal] = useState(false);
  const [editProduct, setEditProduct] = useState(null); // null = new
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ name: '', description: '', price: '', photo_url: '', stock: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('business_list_products');
      if (r?.success) setProducts(r.data?.products || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setEditProduct(null);
    setForm({ name: '', description: '', price: '', photo_url: '', stock: '' });
    setEditModal(true);
  };

  const openEdit = (product) => {
    setEditProduct(product);
    setForm({
      name: product.name || '',
      description: product.description || '',
      price: String(product.price || ''),
      photo_url: product.photo_url || '',
      stock: String(product.stock ?? ''),
    });
    setEditModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.price.trim()) {
      safeAlert('Erro', 'Nome e preço são obrigatórios');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        ...form,
        price: parseFloat(form.price) || 0,
        stock: form.stock !== '' ? parseInt(form.stock) : null,
      };
      if (editProduct) payload.product_id = editProduct.id;
      const action = editProduct ? 'business_update_product' : 'business_add_product';
      const r = await api.apiCall(action, payload, 'POST');
      if (r?.success) {
        setEditModal(false);
        load();
      } else {
        safeAlert('Erro', r?.message || 'Falha ao salvar produto');
      }
    } catch (e) { safeAlert('Erro', String(e)); }
    setBusy(false);
  };

  const handleDelete = (product) => {
    safeAlert('Excluir produto', `Excluir "${product.name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: async () => {
        try {
          await api.apiCall('business_delete_product', { product_id: product.id }, 'POST');
          load();
        } catch {}
      }},
    ]);
  };

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id);
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { product, qty: 1 }];
    });
  };

  const getCartQty = (productId) => cart.find(i => i.product.id === productId)?.qty || 0;

  const filtered = products.filter(p =>
    !search || p.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Search + Add */}
      <View style={[styles.searchRow, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View style={[styles.searchBox, { backgroundColor: colors.inputBg }]}>
          <IconSearch size={16} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Buscar produto..."
            placeholderTextColor={colors.textSecondary}
            value={search}
            onChangeText={setSearch}
          />
        </View>
        <TouchableOpacity onPress={openNew} style={[styles.addBtn, { backgroundColor: ACCENT }]} accessibilityLabel="Adicionar produto">
          <IconPlus size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? <LoadingView colors={colors} /> : (
        filtered.length === 0 ? (
          <EmptyState icon={<IconPackage size={48} color={colors.textSecondary} />} label="Nenhum produto no catálogo" sub="Toque + para adicionar o primeiro produto" colors={colors} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={item => String(item.id)}
            numColumns={2}
            contentContainerStyle={{ padding: 12, gap: 12 }}
            columnWrapperStyle={{ gap: 12 }}
            renderItem={({ item }) => (
              <ProductCard
                product={item}
                colors={colors}
                isDark={isDark}
                onEdit={() => openEdit(item)}
                onDelete={() => handleDelete(item)}
                onAddToCart={() => addToCart(item)}
                cartQty={getCartQty(item.id)}
              />
            )}
          />
        )
      )}

      {/* Edit / Add Product Modal */}
      <Modal visible={editModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditModal(false)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setEditModal(false)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{editProduct ? 'Editar Produto' : 'Novo Produto'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={22} color={ACCENT} />}
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
              {/* Photo picker */}
              <ProductPhotoPicker photoUrl={form.photo_url} onChange={url => setForm(f => ({ ...f, photo_url: url }))} colors={colors} />
              <FormField label="Nome do produto *" value={form.name} onChangeText={v => setForm(f => ({ ...f, name: v }))} placeholder="Ex: Camiseta Polo" colors={colors} />
              <FormField label="Descrição" value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))} placeholder="Detalhes do produto" multiline colors={colors} />
              <FormField label="Preço (R$) *" value={form.price} onChangeText={v => setForm(f => ({ ...f, price: v }))} placeholder="0,00" keyboardType="decimal-pad" colors={colors} />
              <FormField label="Estoque" value={form.stock} onChangeText={v => setForm(f => ({ ...f, stock: v }))} placeholder="Deixe vazio para ilimitado" keyboardType="number-pad" colors={colors} />
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

// ── Product Card ──
function ProductCard({ product, colors, isDark, onEdit, onDelete, onAddToCart, cartQty }) {
  const price = parseFloat(product.price || 0);
  const inCart = cartQty > 0;

  return (
    <View style={[styles.productCard, { backgroundColor: colors.surface }]}>
      {product.photo_url ? (
        <Image source={{ uri: product.photo_url }} style={styles.productImage} resizeMode="cover" />
      ) : (
        <View style={[styles.productImagePlaceholder, { backgroundColor: colors.inputBg }]}>
          <IconPackage size={32} color={colors.textSecondary} />
        </View>
      )}
      <View style={{ padding: 10, flex: 1 }}>
        <Text style={[styles.productName, { color: colors.text }]} numberOfLines={2}>{product.name}</Text>
        {product.description ? (
          <Text style={[styles.productDesc, { color: colors.textSecondary }]} numberOfLines={2}>{product.description}</Text>
        ) : null}
        <Text style={[styles.productPrice, { color: ACCENT_DARK }]}>
          R$ {price.toFixed(2).replace('.', ',')}
        </Text>
        {product.stock != null && (
          <Text style={[styles.productStock, { color: product.stock > 0 ? colors.textSecondary : '#ef4444' }]}>
            {product.stock > 0 ? `${product.stock} em estoque` : 'Esgotado'}
          </Text>
        )}
        <View style={styles.productActions}>
          <TouchableOpacity onPress={onEdit} style={[styles.productActionBtn, { backgroundColor: colors.inputBg }]} accessibilityLabel="Editar produto">
            <IconEdit size={14} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} style={[styles.productActionBtn, { backgroundColor: '#fee2e222' }]} accessibilityLabel="Excluir produto">
            <IconTrash size={14} color="#ef4444" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onAddToCart}
            style={[styles.addCartBtn, { backgroundColor: inCart ? ACCENT : ACCENT + '18', flex: 1 }]}
            accessibilityLabel={inCart ? `${cartQty} no carrinho` : 'Adicionar ao carrinho'}
          >
            <Text style={[styles.addCartText, { color: inCart ? '#fff' : ACCENT_DARK }]}>
              {inCart ? `+1 (${cartQty})` : 'Carrinho'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ── Product Photo Picker ──
function ProductPhotoPicker({ photoUrl, onChange, colors }) {
  const [picking, setPicking] = useState(false);

  const pick = async () => {
    setPicking(true);
    try {
      let ImagePicker;
      try { ImagePicker = require('expo-image-picker'); } catch { setPicking(false); return; }
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { safeAlert('Permissão negada', 'Acesso à galeria necessário'); setPicking(false); return; }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        // Upload to server
        const formData = new FormData();
        formData.append('action', 'business_upload_product_photo');
        if (Platform.OS === 'web') {
          const blob = await fetch(asset.uri).then(r => r.blob());
          formData.append('photo', blob, 'product.jpg');
        } else {
          formData.append('photo', { uri: asset.uri, type: 'image/jpeg', name: 'product.jpg' });
        }
        const { getAuthHeaders, BASE_URL } = require('../services/api');
        const res = await fetch(`${BASE_URL}/api/email.php?action=business_upload_product_photo`, {
          method: 'POST', headers: getAuthHeaders(), body: formData, credentials: 'include',
        });
        const data = await res.json();
        if (data?.success && data.data?.url) onChange(data.data.url);
      }
    } catch (e) { safeAlert('Erro', String(e)); }
    setPicking(false);
  };

  return (
    <TouchableOpacity onPress={pick} style={[styles.photoPicker, { backgroundColor: colors.inputBg, borderColor: colors.border }]}>
      {photoUrl ? (
        <Image source={{ uri: photoUrl }} style={styles.photoPickerImage} resizeMode="cover" />
      ) : (
        <View style={{ alignItems: 'center', gap: 8 }}>
          <IconCamera size={28} color={colors.textSecondary} />
          <Text style={[styles.photoPickerLabel, { color: colors.textSecondary }]}>Toque para adicionar foto</Text>
        </View>
      )}
      {picking && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', borderRadius: 12 }]}>
          <ActivityIndicator color="#fff" />
        </View>
      )}
    </TouchableOpacity>
  );
}

// ══════════════════════════════════════════════════
// CART TAB
// ══════════════════════════════════════════════════
function CartTab({ colors, isDark, cart, setCart, user }) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const total = cart.reduce((s, i) => s + (parseFloat(i.product.price || 0) * i.qty), 0);

  const updateQty = (productId, qty) => {
    if (qty <= 0) setCart(prev => prev.filter(i => i.product.id !== productId));
    else setCart(prev => prev.map(i => i.product.id === productId ? { ...i, qty } : i));
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setSending(true);
    try {
      // Build order message in WhatsApp Business style
      let msg = '*Pedido via Chatyy*\n\n';
      cart.forEach(item => {
        const price = parseFloat(item.product.price || 0);
        msg += `• ${item.product.name} x${item.qty} — R$ ${(price * item.qty).toFixed(2).replace('.', ',')}\n`;
      });
      msg += `\n*Total: R$ ${total.toFixed(2).replace('.', ',')}*`;
      if (note.trim()) msg += `\n\n_Observação: ${note.trim()}_`;

      const r = await api.apiCall('business_place_order', {
        items: cart.map(i => ({ product_id: i.product.id, qty: i.qty, price: i.product.price })),
        total,
        note: note.trim(),
        message: msg,
      }, 'POST');

      if (r?.success) {
        setSent(true);
        setCart([]);
        setNote('');
      } else {
        safeAlert('Erro', r?.message || 'Falha ao enviar pedido');
      }
    } catch (e) { safeAlert('Erro', String(e)); }
    setSending(false);
  };

  if (sent) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
        <View style={[styles.sentIcon, { backgroundColor: ACCENT + '18' }]}>
          <IconCheck size={40} color={ACCENT} />
        </View>
        <Text style={[styles.sentTitle, { color: colors.text }]}>Pedido enviado!</Text>
        <Text style={[styles.sentSub, { color: colors.textSecondary }]}>O vendedor receberá seu pedido via Chatyy</Text>
        <TouchableOpacity onPress={() => setSent(false)} style={[styles.sentBtn, { backgroundColor: ACCENT }]}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Ver catálogo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (cart.length === 0) {
    return <EmptyState icon={<IconShoppingCart size={48} color={colors.textSecondary} />} label="Carrinho vazio" sub="Adicione produtos do catálogo" colors={colors} />;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <FlatList
        data={cart}
        keyExtractor={item => String(item.product.id)}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListFooterComponent={() => (
          <View style={{ gap: 16, marginTop: 8 }}>
            <View style={[styles.noteBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginBottom: 6 }]}>Observações</Text>
              <TextInput
                style={[styles.noteInput, { color: colors.text }]}
                placeholder="Ex: sem cebola, entrega no andar 3..."
                placeholderTextColor={colors.textSecondary}
                value={note}
                onChangeText={setNote}
                multiline
              />
            </View>
            <View style={[styles.totalRow, { backgroundColor: colors.surface }]}>
              <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total</Text>
              <Text style={[styles.totalValue, { color: ACCENT_DARK }]}>R$ {total.toFixed(2).replace('.', ',')}</Text>
            </View>
            <TouchableOpacity
              onPress={handleCheckout}
              disabled={sending}
              style={[styles.checkoutBtn, { backgroundColor: ACCENT, opacity: sending ? 0.7 : 1 }]}
              accessibilityLabel="Finalizar pedido"
            >
              {sending ? <ActivityIndicator color="#fff" /> : (
                <>
                  <IconShoppingCart size={20} color="#fff" />
                  <Text style={styles.checkoutText}>Enviar pedido via Chatyy</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
        renderItem={({ item }) => (
          <CartItem item={item} colors={colors} onUpdateQty={updateQty} />
        )}
      />
    </KeyboardAvoidingView>
  );
}

function CartItem({ item, colors, onUpdateQty }) {
  const price = parseFloat(item.product.price || 0);
  return (
    <View style={[styles.cartItemCard, { backgroundColor: colors.surface }]}>
      {item.product.photo_url ? (
        <Image source={{ uri: item.product.photo_url }} style={styles.cartItemImage} resizeMode="cover" />
      ) : (
        <View style={[styles.cartItemImagePlaceholder, { backgroundColor: colors.inputBg }]}>
          <IconPackage size={20} color={colors.textSecondary} />
        </View>
      )}
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[styles.cartItemName, { color: colors.text }]} numberOfLines={1}>{item.product.name}</Text>
        <Text style={[styles.cartItemPrice, { color: ACCENT_DARK }]}>R$ {(price * item.qty).toFixed(2).replace('.', ',')}</Text>
      </View>
      <View style={styles.qtyControl}>
        <TouchableOpacity onPress={() => onUpdateQty(item.product.id, item.qty - 1)} style={[styles.qtyBtn, { backgroundColor: colors.inputBg }]}>
          <Text style={[styles.qtyBtnText, { color: colors.text }]}>-</Text>
        </TouchableOpacity>
        <Text style={[styles.qtyValue, { color: colors.text }]}>{item.qty}</Text>
        <TouchableOpacity onPress={() => onUpdateQty(item.product.id, item.qty + 1)} style={[styles.qtyBtn, { backgroundColor: ACCENT }]}>
          <Text style={[styles.qtyBtnText, { color: '#fff' }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ══════════════════════════════════════════════════
// AUTO-REPLIES TAB
// ══════════════════════════════════════════════════
function AutoRepliesTab({ colors, isDark }) {
  const [settings, setSettings] = useState({
    greeting_enabled: false,
    greeting_message: '',
    away_enabled: false,
    away_message: '',
    away_schedule: 'always',
  });
  const [quickReplies, setQuickReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrModal, setQrModal] = useState(false);
  const [qrForm, setQrForm] = useState({ shortcut: '', message: '' });
  const [qrEditing, setQrEditing] = useState(null);
  const [qrBusy, setQrBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('business_get_autoreplies');
      if (r?.success) {
        if (r.data?.settings) setSettings(r.data.settings);
        if (r.data?.quick_replies) setQuickReplies(r.data.quick_replies);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const r = await api.apiCall('business_save_autoreplies', settings, 'POST');
      if (!r?.success) safeAlert('Erro', r?.message || 'Falha ao salvar');
    } catch (e) { safeAlert('Erro', String(e)); }
    setSaving(false);
  };

  const openNewQR = () => {
    setQrEditing(null);
    setQrForm({ shortcut: '', message: '' });
    setQrModal(true);
  };

  const openEditQR = (qr) => {
    setQrEditing(qr);
    setQrForm({ shortcut: qr.shortcut || '', message: qr.message || '' });
    setQrModal(true);
  };

  const handleSaveQR = async () => {
    if (!qrForm.shortcut.trim() || !qrForm.message.trim()) {
      safeAlert('Erro', 'Atalho e mensagem são obrigatórios');
      return;
    }
    setQrBusy(true);
    try {
      const payload = { ...qrForm };
      if (qrEditing) payload.id = qrEditing.id;
      const action = qrEditing ? 'business_update_quick_reply' : 'business_add_quick_reply';
      const r = await api.apiCall(action, payload, 'POST');
      if (r?.success) { setQrModal(false); load(); }
      else safeAlert('Erro', r?.message || 'Falha ao salvar');
    } catch (e) { safeAlert('Erro', String(e)); }
    setQrBusy(false);
  };

  const handleDeleteQR = (qr) => {
    safeAlert('Excluir resposta rápida', `Excluir "/${qr.shortcut}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: async () => {
        try { await api.apiCall('business_delete_quick_reply', { id: qr.id }, 'POST'); load(); } catch {}
      }},
    ]);
  };

  if (loading) return <LoadingView colors={colors} />;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 20 }} showsVerticalScrollIndicator={false}>
      {/* Greeting */}
      <SectionCard title="Mensagem de saudação" colors={colors}>
        <ToggleRow
          label="Enviar saudação para novos contatos"
          value={settings.greeting_enabled}
          onChange={v => setSettings(s => ({ ...s, greeting_enabled: v }))}
          colors={colors}
        />
        {settings.greeting_enabled && (
          <TextInput
            style={[styles.autoReplyInput, { color: colors.text, backgroundColor: colors.inputBg, borderColor: colors.border }]}
            placeholder="Olá! Seja bem-vindo(a). Como posso ajudar?"
            placeholderTextColor={colors.textSecondary}
            value={settings.greeting_message}
            onChangeText={v => setSettings(s => ({ ...s, greeting_message: v }))}
            multiline
          />
        )}
      </SectionCard>

      {/* Away */}
      <SectionCard title="Mensagem de ausência" colors={colors}>
        <ToggleRow
          label="Enviar mensagem quando estiver ausente"
          value={settings.away_enabled}
          onChange={v => setSettings(s => ({ ...s, away_enabled: v }))}
          colors={colors}
        />
        {settings.away_enabled && (
          <>
            <TextInput
              style={[styles.autoReplyInput, { color: colors.text, backgroundColor: colors.inputBg, borderColor: colors.border }]}
              placeholder="No momento estou ausente. Retornarei em breve!"
              placeholderTextColor={colors.textSecondary}
              value={settings.away_message}
              onChangeText={v => setSettings(s => ({ ...s, away_message: v }))}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {['always', 'outside_hours', 'custom'].map(opt => (
                <TouchableOpacity
                  key={opt}
                  onPress={() => setSettings(s => ({ ...s, away_schedule: opt }))}
                  style={[styles.scheduleChip, {
                    backgroundColor: settings.away_schedule === opt ? ACCENT : colors.inputBg,
                    borderColor: settings.away_schedule === opt ? ACCENT : colors.border,
                  }]}
                >
                  <Text style={{ fontSize: 12, color: settings.away_schedule === opt ? '#fff' : colors.textSecondary }}>
                    {opt === 'always' ? 'Sempre' : opt === 'outside_hours' ? 'Fora do horário' : 'Personalizado'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </SectionCard>

      <TouchableOpacity
        onPress={handleSaveSettings}
        disabled={saving}
        style={[styles.saveSettingsBtn, { backgroundColor: ACCENT, opacity: saving ? 0.7 : 1 }]}
      >
        {saving ? <ActivityIndicator color="#fff" size="small" /> : (
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>Salvar configurações</Text>
        )}
      </TouchableOpacity>

      {/* Quick replies */}
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Respostas rápidas</Text>
        <TouchableOpacity onPress={openNewQR} style={[styles.sectionAddBtn, { backgroundColor: ACCENT + '18' }]}>
          <IconPlus size={16} color={ACCENT} />
          <Text style={{ color: ACCENT, fontSize: 13, fontWeight: '600' }}>Nova</Text>
        </TouchableOpacity>
      </View>

      {quickReplies.length === 0 ? (
        <View style={[styles.emptyInline, { backgroundColor: colors.surface }]}>
          <Text style={[styles.emptyInlineText, { color: colors.textSecondary }]}>
            Nenhuma resposta rápida. Use "/" no chat para acessar atalhos.
          </Text>
        </View>
      ) : (
        quickReplies.map(qr => (
          <View key={qr.id} style={[styles.qrCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.qrShortcut, { color: ACCENT_DARK }]}>/{qr.shortcut}</Text>
              <Text style={[styles.qrMessage, { color: colors.textSecondary }]} numberOfLines={2}>{qr.message}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => openEditQR(qr)} accessibilityLabel="Editar resposta rápida">
                <IconEdit size={18} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDeleteQR(qr)} accessibilityLabel="Excluir resposta rápida">
                <IconTrash size={18} color="#ef4444" />
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      {/* QR modal */}
      <Modal visible={qrModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setQrModal(false)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setQrModal(false)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{qrEditing ? 'Editar Atalho' : 'Novo Atalho'}</Text>
            <TouchableOpacity onPress={handleSaveQR} disabled={qrBusy}>
              {qrBusy ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={22} color={ACCENT} />}
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
              <FormField
                label="Atalho (sem /)"
                value={qrForm.shortcut}
                onChangeText={v => setQrForm(f => ({ ...f, shortcut: v.replace(/[^a-zA-Z0-9_]/g, '') }))}
                placeholder="ex: oi, preco, horario"
                colors={colors}
              />
              <FormField
                label="Mensagem"
                value={qrForm.message}
                onChangeText={v => setQrForm(f => ({ ...f, message: v }))}
                placeholder="Texto que será enviado quando usar o atalho"
                multiline
                colors={colors}
              />
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════
// LABELS TAB
// ══════════════════════════════════════════════════
function LabelsTab({ colors, isDark }) {
  const [labels, setLabels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', color: LABEL_COLORS[0] });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('business_list_labels');
      if (r?.success) setLabels(r.data?.labels || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setEditing(null);
    setForm({ name: '', color: LABEL_COLORS[0] });
    setModal(true);
  };

  const openEdit = (label) => {
    setEditing(label);
    setForm({ name: label.name || '', color: label.color || LABEL_COLORS[0] });
    setModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { safeAlert('Erro', 'Nome é obrigatório'); return; }
    setBusy(true);
    try {
      const payload = { ...form };
      if (editing) payload.label_id = editing.id;
      const action = editing ? 'business_update_label' : 'business_add_label';
      const r = await api.apiCall(action, payload, 'POST');
      if (r?.success) { setModal(false); load(); }
      else safeAlert('Erro', r?.message || 'Falha ao salvar');
    } catch (e) { safeAlert('Erro', String(e)); }
    setBusy(false);
  };

  const handleDelete = (label) => {
    safeAlert('Excluir label', `Excluir "${label.name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: async () => {
        try { await api.apiCall('business_delete_label', { label_id: label.id }, 'POST'); load(); } catch {}
      }},
    ]);
  };

  const handleSeedDefaults = async () => {
    for (const def of LABEL_DEFAULTS) {
      try { await api.apiCall('business_add_label', def, 'POST'); } catch {}
    }
    load();
  };

  if (loading) return <LoadingView colors={colors} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.searchRow, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Text style={[styles.searchBox, { color: colors.textSecondary, flex: 1, fontSize: 13 }]}>
          Labels organizam conversas de clientes
        </Text>
        <TouchableOpacity onPress={openNew} style={[styles.addBtn, { backgroundColor: ACCENT }]} accessibilityLabel="Nova label">
          <IconPlus size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {labels.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
          <EmptyState icon={<IconLabel size={48} color={colors.textSecondary} />} label="Nenhuma label criada" sub="Labels ajudam a organizar chats de clientes" colors={colors} />
          <TouchableOpacity onPress={handleSeedDefaults} style={[styles.seedBtn, { backgroundColor: ACCENT + '18', borderColor: ACCENT + '44' }]}>
            <Text style={{ color: ACCENT, fontWeight: '600' }}>Criar labels padrão</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={labels}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          renderItem={({ item }) => (
            <View style={[styles.labelCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.labelDot, { backgroundColor: item.color || ACCENT }]} />
              <Text style={[styles.labelName, { color: colors.text }]}>{item.name}</Text>
              {item.chat_count != null && (
                <View style={[styles.labelCount, { backgroundColor: colors.inputBg }]}>
                  <Text style={[styles.labelCountText, { color: colors.textSecondary }]}>{item.chat_count}</Text>
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 12, marginLeft: 'auto' }}>
                <TouchableOpacity onPress={() => openEdit(item)} accessibilityLabel="Editar label">
                  <IconEdit size={18} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleDelete(item)} accessibilityLabel="Excluir label">
                  <IconTrash size={18} color="#ef4444" />
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {/* Label modal */}
      <Modal visible={modal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setModal(false)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setModal(false)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.text }]}>{editing ? 'Editar Label' : 'Nova Label'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color={ACCENT} /> : <IconCheck size={22} color={ACCENT} />}
            </TouchableOpacity>
          </View>
          <View style={{ padding: 20, gap: 20 }}>
            <FormField
              label="Nome da label"
              value={form.name}
              onChangeText={v => setForm(f => ({ ...f, name: v }))}
              placeholder="Ex: Novo cliente"
              colors={colors}
            />
            <View style={{ gap: 10 }}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Cor</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                {LABEL_COLORS.map(c => (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setForm(f => ({ ...f, color: c }))}
                    style={[styles.colorDot, { backgroundColor: c, borderWidth: form.color === c ? 3 : 0, borderColor: '#fff' }]}
                    accessibilityLabel={`Cor ${c}`}
                  />
                ))}
              </View>
            </View>
            {/* Preview */}
            <View style={[styles.labelPreview, { backgroundColor: colors.surface }]}>
              <View style={[styles.labelDot, { backgroundColor: form.color }]} />
              <Text style={[styles.labelName, { color: colors.text }]}>{form.name || 'Prévia'}</Text>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ══════════════════════════════════════════════════
// SHARED COMPONENTS
// ══════════════════════════════════════════════════

function LoadingView({ colors }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={ACCENT} />
    </View>
  );
}

function EmptyState({ icon, label, sub, colors }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }}>
      {icon}
      <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text, textAlign: 'center' }}>{label}</Text>
      {sub && <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>{sub}</Text>}
    </View>
  );
}

function FormField({ label, value, onChangeText, placeholder, multiline, keyboardType, colors }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        style={[styles.formInput, { color: colors.text, backgroundColor: colors.inputBg, borderColor: colors.border, ...(multiline ? { height: 90, textAlignVertical: 'top' } : {}) }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType === 'url' || keyboardType === 'email-address' ? 'none' : 'sentences'}
      />
    </View>
  );
}

function InfoRow({ icon, label, colors, accent }) {
  const icons = {
    location: <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2}><Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><Circle cx="12" cy="10" r="3"/></Svg>,
    phone: <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2}><Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></Svg>,
    globe: <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2}><Circle cx="12" cy="12" r="10"/><Line x1="2" y1="12" x2="22" y2="12"/><Path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></Svg>,
    clock: <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2}><Circle cx="12" cy="12" r="10"/><Polyline points="12 6 12 12 16 14"/></Svg>,
  };
  return (
    <View style={styles.infoRow}>
      {icons[icon]}
      <Text style={[styles.infoText, { color: accent ? ACCENT_DARK : colors.textSecondary }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function StatCard({ label, value, color, colors }) {
  return (
    <View style={[styles.statCard, { backgroundColor: colors.surface }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

function SectionCard({ title, children, colors }) {
  return (
    <View style={[styles.sectionCard, { backgroundColor: colors.surface }]}>
      <Text style={[styles.sectionCardTitle, { color: colors.text }]}>{title}</Text>
      <View style={{ gap: 12, marginTop: 12 }}>{children}</View>
    </View>
  );
}

function ToggleRow({ label, value, onChange, colors }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: value ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [value]);
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  const bg = anim.interpolate({ inputRange: [0, 1], outputRange: ['#d1d5db', ACCENT] });
  return (
    <TouchableOpacity onPress={() => onChange(!value)} style={styles.toggleRow} accessibilityRole="switch" accessibilityState={{ checked: value }}>
      <Text style={[styles.toggleLabel, { color: colors.text }]}>{label}</Text>
      <Animated.View style={[styles.toggleTrack, { backgroundColor: bg }]}>
        <Animated.View style={[styles.toggleThumb, { transform: [{ translateX }] }]} />
      </Animated.View>
    </TouchableOpacity>
  );
}

// ══════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4 },
  brandDot: { width: 10, height: 10, borderRadius: 5 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  cartBtn: { padding: 4, position: 'relative' },
  cartBadge: { position: 'absolute', top: -2, right: -2, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cartBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tabItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 12 },
  tabLabel: { fontSize: 13, fontWeight: '600' },

  // Profile
  card: { borderRadius: 16, padding: 18, marginBottom: 16, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
  profileHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginBottom: 14 },
  businessAvatar: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  companyName: { fontSize: 18, fontWeight: '700', flex: 1 },
  categoryBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, marginTop: 4 },
  categoryText: { fontSize: 11, fontWeight: '600' },
  editBtn: { padding: 8, borderRadius: 10 },
  descText: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  infoRows: { gap: 8 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  infoText: { fontSize: 13, flex: 1 },
  verifyBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, padding: 12, borderRadius: 10, borderWidth: 1 },
  verifyText: { fontSize: 12, flex: 1 },
  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center', gap: 4, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, elevation: 1 },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 11, fontWeight: '500' },

  // Catalog
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 14 },
  addBtn: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  productCard: { flex: 1, borderRadius: 14, overflow: 'hidden', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, elevation: 2 },
  productImage: { width: '100%', height: 140 },
  productImagePlaceholder: { width: '100%', height: 140, alignItems: 'center', justifyContent: 'center' },
  productName: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  productDesc: { fontSize: 11, marginBottom: 4, lineHeight: 16 },
  productPrice: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  productStock: { fontSize: 10, marginBottom: 8 },
  productActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  productActionBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  addCartBtn: { height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  addCartText: { fontSize: 11, fontWeight: '700' },

  // Photo picker
  photoPicker: { height: 160, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photoPickerImage: { width: '100%', height: '100%', borderRadius: 12 },
  photoPickerLabel: { fontSize: 13 },

  // Cart
  cartItemCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 12, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, elevation: 1 },
  cartItemImage: { width: 56, height: 56, borderRadius: 10 },
  cartItemImagePlaceholder: { width: 56, height: 56, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cartItemName: { fontSize: 14, fontWeight: '600' },
  cartItemPrice: { fontSize: 13, fontWeight: '700' },
  qtyControl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: 18, fontWeight: '700', lineHeight: 20 },
  qtyValue: { fontSize: 15, fontWeight: '600', minWidth: 20, textAlign: 'center' },
  noteBox: { borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth },
  noteInput: { fontSize: 14, minHeight: 60, textAlignVertical: 'top' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 12, padding: 16 },
  totalLabel: { fontSize: 15, fontWeight: '500' },
  totalValue: { fontSize: 22, fontWeight: '800' },
  checkoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 52, borderRadius: 14 },
  checkoutText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  sentIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  sentTitle: { fontSize: 22, fontWeight: '700' },
  sentSub: { fontSize: 14, textAlign: 'center' },
  sentBtn: { paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14, marginTop: 8 },

  // AutoReplies
  sectionCard: { borderRadius: 14, padding: 16, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, elevation: 2 },
  sectionCardTitle: { fontSize: 15, fontWeight: '700' },
  autoReplyInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 14, minHeight: 80, textAlignVertical: 'top', marginTop: 4 },
  scheduleChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  saveSettingsBtn: { height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  sectionAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  emptyInline: { borderRadius: 12, padding: 16, alignItems: 'center' },
  emptyInlineText: { fontSize: 13, textAlign: 'center' },
  qrCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  qrShortcut: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  qrMessage: { fontSize: 12 },

  // Labels
  labelCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth },
  labelDot: { width: 14, height: 14, borderRadius: 7 },
  labelName: { fontSize: 15, fontWeight: '600', flex: 1 },
  labelCount: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  labelCountText: { fontSize: 12, fontWeight: '600' },
  labelPreview: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, padding: 14 },
  colorDot: { width: 32, height: 32, borderRadius: 16 },
  seedBtn: { paddingHorizontal: 20, paddingVertical: 11, borderRadius: 12, borderWidth: 1 },

  // Toggle
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { fontSize: 14, flex: 1, marginRight: 12 },
  toggleTrack: { width: 46, height: 26, borderRadius: 13, justifyContent: 'center' },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, elevation: 2 },

  // Shared form
  fieldLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  formInput: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  catChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  catChipText: { fontSize: 13, fontWeight: '500' },

  // Modal
  modalRoot: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 17, fontWeight: '700' },
});
