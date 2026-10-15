// [2026-10-15 native-onboarding] Quais pedidos de permissão ainda fazem
// sentido neste aparelho (só pergunta o que está "não decidido").
// Câmera/microfone NÃO entram: são pedidos só no uso (ligação, foto, áudio).
import { Platform } from 'react-native';

async function _contactsNeeded() {
  try {
    const cs = require('../../services/contactSync');
    const consent = await cs.getContactsConsentState?.();
    const has = await cs.hasContactsPermissionNoPrompt?.();
    if (consent === 'granted' && has) return false;
  } catch {}
  try {
    const Contacts = require('expo-contacts');
    const r = await Contacts.getPermissionsAsync();
    if (r?.status === 'granted') {
      const cs = require('../../services/contactSync');
      return (await cs.getContactsConsentState?.()) !== 'granted';
    }
    if (r?.status === 'denied' && r?.canAskAgain === false) return false;
  } catch {}
  return true;
}

async function _pushNeeded() {
  try {
    const { isPushPrimerNeeded } = require('../../services/pushPrimer');
    if (isPushPrimerNeeded()) return true;
  } catch {}
  try {
    const N = require('expo-notifications');
    const p = await N.getPermissionsAsync();
    const prov = Platform.OS === 'ios' && p?.ios?.status === 3; // provisória (silenciosa)
    return p?.status === 'undetermined' || (prov && p?.canAskAgain !== false);
  } catch { return false; }
}

/** → ['contacts'?, 'notifications'?] (vazio na web). Nunca lança. */
export async function computePermissionSteps() {
  if (Platform.OS === 'web') return [];
  const out = [];
  try { if (await _contactsNeeded()) out.push('contacts'); } catch {}
  try { if (await _pushNeeded()) out.push('notifications'); } catch {}
  return out;
}
