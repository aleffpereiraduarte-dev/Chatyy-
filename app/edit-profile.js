// [2026-10-11 settings-unify] /edit-profile — a ÚNICA tela "Editar perfil".
//
// Todas as entradas de edição (cartão do topo das Configurações, botão
// "Editar perfil" do perfil público /u/me, /profile?edit=1) caem no MESMO
// componente: <ProfileEditSheet> (foto, capa, nome, @usuário, bio, recado,
// links, tipo de conta; e-mail/telefone só leitura). Aqui ele é hospedado
// como rota: carrega a identidade via profile_get e volta ao fechar.
import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX } from '../components/Icons';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import ProfileEditSheet from '../components/ProfileEditSheet';
import { useLocalSearchParams } from 'expo-router';
import { isNativeProfileEditEnabled } from '../components/profile/nativeProfileEdit';

export default function EditProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user, loading } = useAuth();
  const [identity, setIdentity] = useState(null);
  // [2026-10-18 profile-edit-native] Com o editor NATIVO disponível esta tela
  // JS só serve como "Links extras e tipo de conta" (?legacy=1); qualquer
  // outra entrada (busca das Configurações, /profile?edit=1, deep link) vai
  // para o perfil próprio já em modo edição.
  const params = useLocalSearchParams();
  const legacy = String(Array.isArray(params?.legacy) ? params.legacy[0] : (params?.legacy || '')) === '1';
  const redirectedRef = React.useRef(false);
  useEffect(() => {
    if (legacy || loading || redirectedRef.current || !user?.email) return;
    if (!isNativeProfileEditEnabled()) return;
    redirectedRef.current = true;
    try { router.replace(`/u/${encodeURIComponent(user.email)}?edit=1`); } catch {}
  }, [legacy, loading, user?.email, router]);

  useEffect(() => {
    if (loading) return;
    if (!user?.email) { try { router.replace('/login'); } catch {} return; }
    let alive = true;
    (async () => {
      try {
        const r = await api.profileGet(user.email);
        if (alive) setIdentity((r?.success && r.data?.identity) ? r.data.identity : { email: user.email, name: user.name || '' });
      } catch {
        if (alive) setIdentity({ email: user.email, name: user.name || '' });
      }
    })();
    return () => { alive = false; };
  }, [user?.email, loading]);

  // [2026-10-15 edit-profile-x] Fecha DIRETO com router.back() → a rota (modal
  // nativo no Stack) desce com a animação do sistema. Antes: setVisible(false)
  // baixava um <Modal> RN por cima desta rota vazia (fundo liso) e só depois
  // fazia back = "página branca e depois fecha". O "Descartar alterações?"
  // continua no ProfileEditSheet (requestClose) antes de chamar este close.
  const closingRef = React.useRef(false);
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/settings'); } catch {}
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors?.background }} testID="edit-profile-screen">
      {(!identity || (!legacy && !!user?.email && isNativeProfileEditEnabled())) ? (
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <TouchableOpacity
            onPress={close}
            style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}
            accessibilityRole="button"
            accessibilityLabel={t?.('common.cancel') || 'Cancelar'}
          >
            <IconX size={22} color={colors?.text || '#111'} />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors?.text} />
          </View>
        </View>
      ) : (
        <ProfileEditSheet
          asScreen
          visible
          onClose={close}
          initial={identity}
          currentEmail={identity?.email || user?.email}
          onSaved={(next) => {
            setIdentity(prev => ({ ...(prev || {}), ...next }));
            // Bust the shared profile cache so /u/me + the settings header
            // card show the new name/photo/bio immediately.
            try { require('../components/Profile').invalidateProfileCache(user?.email); } catch {}
            try { if (identity?.username) require('../components/Profile').invalidateProfileCache(identity.username); } catch {}
          }}
          colors={colors}
          isDark={isDark}
          t={t}
        />
      )}
    </View>
  );
}
