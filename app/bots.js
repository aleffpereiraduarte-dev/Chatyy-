// Bots — Telegram-style bot management (create, list, webhook)
import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, Platform,
  StyleSheet, ScrollView, Pressable, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconPlus, IconTrash, IconRefresh, IconCopy } from '../components/Icons';
import EmptyStateCard from '../components/EmptyStateCard';
import { ListSkeleton } from '../components/SkeletonLoader';

// Tiny SVG-free bot illustration: stacked rounded squares mimicking the
// Bots tile in the app drawer. Uses purely View+gradient for parity with
// the rest of the app's "no SVG illustration libs" rule.
function BotsEmptyIllustration({ tint }) {
  return (
    <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{
        width: 64, height: 64, borderRadius: 16, backgroundColor: tint + '22',
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: tint + '44',
      }}>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
        </View>
        <View style={{ width: 22, height: 4, borderRadius: 2, backgroundColor: tint }} />
      </View>
      {/* Antenna nub */}
      <View style={{ position: 'absolute', top: 8, width: 4, height: 8, borderRadius: 2, backgroundColor: tint }} />
    </View>
  );
}

// Cross-platform alert. Accepts buttons[] like Alert.alert, falling back to
// window.confirm on web so destructive flows (regenerate token, delete bot)
// can still get a yes/no answer instead of being silently dismissed.
const safeAlert = (title, msg, buttons) => {
  if (Platform.OS === 'web') {
    if (Array.isArray(buttons) && buttons.length > 1) {
      // Find the destructive / confirm button (anything not 'cancel').
      const confirmBtn = buttons.find(b => b && b.style !== 'cancel' && typeof b.onPress === 'function');
      const cancelBtn = buttons.find(b => b && b.style === 'cancel');
      const ok = window.confirm(`${title}\n${msg || ''}`);
      if (ok && confirmBtn) confirmBtn.onPress?.();
      else if (!ok && cancelBtn) cancelBtn.onPress?.();
      return;
    }
    window.alert(`${title}\n${msg || ''}`);
    return;
  }
  Alert.alert(title, msg, buttons);
};

export default function BotsScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();

  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newWebhook, setNewWebhook] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenReveal, setTokenReveal] = useState(null); // { username, token }

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.botList();
      if (r?.success) {
        setBots(r.data?.bots || []);
      } else {
        setLoadError(r?.message || (t?.('common.errorLoading') || 'Não foi possível carregar.'));
      }
    } catch (e) {
      setLoadError(String(e?.message || e) || (t?.('common.errorLoading') || 'Não foi possível carregar.'));
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim() || !newUsername.trim()) {
      safeAlert(t?.('common.error') || 'Erro', t?.('bots.nameAndUsernameRequired') || 'Nome e username obrigatórios');
      return;
    }
    if (!/bot$/i.test(newUsername.trim())) {
      safeAlert(t?.('common.error') || 'Erro', t?.('bots.usernameMustEndBot') || 'Username deve terminar com "bot"');
      return;
    }
    setBusy(true);
    try {
      const r = await api.botCreate(newName.trim(), newUsername.trim().toLowerCase(), newWebhook.trim(), newDesc.trim());
      if (r?.success) {
        setTokenReveal({ username: r.data.username, token: r.data.token });
        setCreateOpen(false);
        setNewName(''); setNewUsername(''); setNewWebhook(''); setNewDesc('');
        load();
      } else {
        safeAlert(t?.('common.error') || 'Erro', r?.message || 'Falha ao criar bot');
      }
    } catch (e) {
      safeAlert(t?.('common.error') || 'Erro', String(e));
    }
    setBusy(false);
  };

  const handleRegenerate = async (bot) => {
    safeAlert(
      t?.('bots.regenerateToken') || 'Regenerar token',
      t?.('bots.regenerateConfirm') || 'O token atual deixará de funcionar. Continuar?',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('common.confirm') || 'Confirmar', onPress: async () => {
          try {
            const r = await api.botRegenerateToken(bot.id);
            if (r?.success) setTokenReveal({ username: bot.username, token: r.data.token });
          } catch {}
        } },
      ]
    );
  };

  const handleDelete = async (bot) => {
    safeAlert(
      t?.('bots.delete') || 'Excluir bot',
      (t?.('bots.deleteConfirm') || 'Excluir @{u}?').replace('{u}', bot.username),
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t?.('common.delete') || 'Excluir', style: 'destructive', onPress: async () => {
          try {
            await api.botDelete(bot.id);
            setBots(prev => prev.filter(b => b.id !== bot.id));
          } catch {}
        } },
      ]
    );
  };

  const copyToken = async (token) => {
    try {
      if (Platform.OS === 'web' && navigator?.clipboard) await navigator.clipboard.writeText(token);
      else { const Clipboard = require('expo-clipboard'); await Clipboard.setStringAsync(token); }
      safeAlert(t?.('common.copied') || 'Copiado', '');
    } catch {}
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: '700', color: colors.text, marginLeft: 4 }}>
          {t?.('bots.title') || 'Bots'}
        </Text>
        <TouchableOpacity onPress={() => setCreateOpen(true)} style={{ padding: 8 }}>
          <IconPlus size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Loading skeleton (first paint only — pull-to-refresh keeps the list). */}
      {loading && bots.length === 0 ? (
        <ListSkeleton count={4} showIcon={true} />
      ) : loadError && bots.length === 0 ? (
        <EmptyStateCard
          illustration={<BotsEmptyIllustration tint="#dc2626" />}
          title={t?.('common.error') || 'Erro'}
          subtitle={loadError}
          ctaLabel={t?.('common.retry') || 'Tentar de novo'}
          onPress={load}
          tone="warning"
        />
      ) : (
      <FlatList
        data={bots}
        keyExtractor={(b) => String(b.id)}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={{ padding: 12, flexGrow: 1 }}
        ListEmptyComponent={
          !loading ? (
            <EmptyStateCard
              illustration={<BotsEmptyIllustration tint="#7C3AED" />}
              title={t?.('bots.emptyTitle') || 'Nenhum bot ainda'}
              subtitle={t?.('bots.empty') || 'Crie um bot para automatizar mensagens, executar slash-commands e integrar serviços.'}
              ctaLabel={t?.('bots.create') || 'Criar bot'}
              onPress={() => setCreateOpen(true)}
            />
          ) : null
        }
        renderItem={({ item }) => {
          // Commands can be returned as an array of strings, an array of
          // {name, ...} objects, or a comma-separated list. Normalize once
          // so the chip row below is dumb. Falls back to common defaults
          // (start/help) so the UI isn't empty for fresh bots.
          const cmds = (() => {
            const c = item?.commands;
            if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : (x?.name || '')).filter(Boolean);
            if (typeof c === 'string') return c.split(',').map(s => s.trim()).filter(Boolean);
            return [];
          })();
          return (
          <View style={{ backgroundColor: colors.surface, padding: 14, borderRadius: 14, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 20 }}>🤖</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{item.name}</Text>
                <Text style={{ fontSize: 13, color: colors.textSecondary }}>@{item.username}</Text>
              </View>
              <TouchableOpacity onPress={() => handleRegenerate(item)} style={{ padding: 8 }}>
                <IconRefresh size={18} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDelete(item)} style={{ padding: 8 }}>
                <IconTrash size={18} color="#dc2626" />
              </TouchableOpacity>
            </View>
            {!!item.description && (
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 8 }}>{item.description}</Text>
            )}
            {/* Command chips — surfaces /start, /help, etc. so the creator
                can scan their bot's surface area at a glance. */}
            {cmds.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {cmds.slice(0, 8).map((cmd, idx) => (
                  <View key={idx} style={{
                    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                    backgroundColor: '#7C3AED22',
                  }}>
                    <Text style={{ fontSize: 11, color: '#7C3AED', fontWeight: '700' }}>
                      /{String(cmd).replace(/^\//, '')}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {!!item.webhook_url && (
              <Text style={{ fontSize: 11, color: colors.textTertiary || colors.textSecondary, marginTop: 6 }} numberOfLines={1}>
                🔗 {item.webhook_url}
              </Text>
            )}
            {/* Testar bot — opens a fake DM with the bot for webhook
                debugging. chat-new turns ?bot=<username> into a 1:1 with
                the bot account so the dev can poke it without leaving the app. */}
            <TouchableOpacity
              onPress={() => {
                try {
                  router.push(`/chat-new?bot=${encodeURIComponent(item.username)}&debug=1`);
                } catch {}
              }}
              style={{
                marginTop: 10, alignSelf: 'flex-start',
                paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
                backgroundColor: colors.primary,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                {t?.('bots.test') || 'Testar bot'}
              </Text>
            </TouchableOpacity>
          </View>
          );
        }}
      />
      )}

      {/* Create modal */}
      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setCreateOpen(false)}>
          <Pressable style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' }} onPress={e => e.stopPropagation()}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 14 }}>
              {t?.('bots.create') || 'Criar bot'}
            </Text>
            <ScrollView>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 6 }}>{t?.('bots.name') || 'Nome'}</Text>
              <TextInput value={newName} onChangeText={setNewName} placeholder="My Cool Bot" placeholderTextColor={colors.textSecondary}
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, color: colors.text, marginBottom: 12 }} />

              <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 6 }}>
                {t?.('bots.username') || 'Username'} ({t?.('bots.mustEndBot') || 'deve terminar com "bot"'})
              </Text>
              <TextInput value={newUsername} onChangeText={setNewUsername} placeholder="mycoolbot" placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, color: colors.text, marginBottom: 12 }} />

              <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 6 }}>
                {t?.('bots.webhook') || 'Webhook URL (HTTPS)'}
              </Text>
              <TextInput value={newWebhook} onChangeText={setNewWebhook} placeholder="https://meu-bot.com/webhook" placeholderTextColor={colors.textSecondary}
                autoCapitalize="none" keyboardType="url"
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, color: colors.text, marginBottom: 12 }} />

              <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 6 }}>
                {t?.('bots.description') || 'Descrição'}
              </Text>
              <TextInput value={newDesc} onChangeText={setNewDesc} placeholder="..." placeholderTextColor={colors.textSecondary} multiline
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, color: colors.text, marginBottom: 16, minHeight: 70 }} />

              <TouchableOpacity
                disabled={busy}
                onPress={handleCreate}
                style={{ backgroundColor: colors.primary, padding: 14, borderRadius: 12, alignItems: 'center', opacity: busy ? 0.6 : 1 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>
                  {busy ? (t?.('common.loading') || 'Carregando...') : (t?.('bots.create') || 'Criar bot')}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Token reveal modal */}
      <Modal visible={!!tokenReveal} transparent animationType="fade" onRequestClose={() => setTokenReveal(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 }} onPress={() => setTokenReveal(null)}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 22 }} onPress={e => e.stopPropagation()}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
              {t?.('bots.tokenReady') || '🎉 Bot criado!'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 12 }}>
              {t?.('bots.saveToken') || 'Guarde seu token. Ele não será mostrado novamente.'}
            </Text>
            {tokenReveal && (
              <>
                <Text style={{ fontSize: 14, color: colors.text, marginBottom: 4 }}>@{tokenReveal.username}</Text>
                <View style={{ backgroundColor: isDark ? '#0a0a0a' : '#f1f5f9', padding: 10, borderRadius: 10, marginBottom: 8 }}>
                  <Text selectable style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, color: colors.text }}>
                    {tokenReveal.token}
                  </Text>
                </View>
                {/* HMAC hint — make it explicit that this same token doubles
                    as the secret for signing webhook payloads, so devs don't
                    go hunting for a separate "public key" field that doesn't
                    exist in our backend. */}
                <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 12 }}>
                  {t?.('bots.hmacHint') || 'Use este token como segredo HMAC para validar webhooks (header X-Chatyy-Signature).'}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => copyToken(tokenReveal.token)}
                    style={{ flex: 1, backgroundColor: colors.primary, padding: 12, borderRadius: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 }}
                  >
                    <IconCopy size={16} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.copy') || 'Copiar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setTokenReveal(null)}
                    style={{ flex: 1, borderWidth: 1, borderColor: colors.border, padding: 12, borderRadius: 10, alignItems: 'center' }}
                  >
                    <Text style={{ color: colors.text, fontWeight: '700' }}>{t?.('common.done') || 'Pronto'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
