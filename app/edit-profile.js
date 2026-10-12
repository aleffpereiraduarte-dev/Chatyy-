// [2026-10-11 settings-unify] /edit-profile — a ÚNICA tela "Editar perfil".
//
// Todas as entradas de edição (cartão do topo das Configurações, botão
// "Editar perfil" do perfil público /u/me, /profile?edit=1) caem no MESMO
// componente: <ProfileEditSheet> (foto, capa, nome, @usuário, bio, recado,
// links, tipo de conta; e-mail/telefone só leitura). Aqui ele é hospedado
// como rota: carrega a identidade via profile_get e volta ao fechar.
import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import ProfileEditSheet from '../components/ProfileEditSheet';

export default function EditProfileScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user, loading } = useAuth();
  const [identity, setIdentity] = useState(null);
  const [visible, setVisible] = useState(true);

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

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
      try { router.replace('/settings'); } catch {}
    }, 0);
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors?.background }} testID="edit-profile-screen">
      {!identity ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors?.text} />
        </View>
      ) : (
        <ProfileEditSheet
          visible={visible}
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
