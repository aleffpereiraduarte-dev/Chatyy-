// screenData — pares { key, fetch } das telas offline-first que também são
// AQUECIDAS em 2º plano (services/screenPrefetch). A tela usa exatamente o
// mesmo par → uma fonte só, sem chave divergente.
//
// fetch(email) → valor a salvar, ou undefined quando falhou (não grava).
// [2026-10-14 offline-first]
import * as api from './api';

const _ok = (r) => !!(r && r.success !== false && !r._offline);

// Perfil (próprio e de outros): components/Profile.js lê/grava esta chave
// (id = e-mail ou @handle em minúsculas).
export function profileCacheKey(id) { return ['profile', String(id || '').toLowerCase()]; }
export const OWN_PROFILE_SCREEN = {
  key: (email) => profileCacheKey(email),
  fetch: async (email) => {
    const r = await api.profileGet(email);
    return r && r.success && r.data ? r.data : undefined;
  },
  ttl: 2 * 60 * 1000,
};

// Carteira: 1ª página do histórico (o saldo é salvo por services/diamonds).
export const WALLET_PAGE = 30;
export async function fetchWalletScreen() {
  const [h] = await Promise.allSettled([
    api.walletHistory({ limit: WALLET_PAGE, offset: 0 }),
    require('./diamonds').refreshWallet(),
  ]);
  const r = h.status === 'fulfilled' ? h.value : null;
  if (!(r && r.success && r.data)) return undefined;
  return { items: Array.isArray(r.data.items) ? r.data.items : [], has_more: !!r.data.has_more };
}
export const WALLET_SCREEN = { key: ['wallet', 'history'], fetch: () => fetchWalletScreen(), ttl: 5 * 60 * 1000 };

// Notificações (app/notifications.js — guarda a RESPOSTA inteira, formato do swr).
export const NOTIF_SCREEN = {
  key: ['notifications', 'list'],
  fetch: async () => {
    const r = await api.notificationsList(1, 60);
    return _ok(r) && Array.isArray(r.data?.notifications) ? r : undefined;
  },
  ttl: 60 * 1000,
};

// Contatos: já aquecidos pelo prewarm do _layout (chave 'contacts'), não entram aqui.
export const PREFETCH_SCREENS = [OWN_PROFILE_SCREEN, WALLET_SCREEN, NOTIF_SCREEN];
