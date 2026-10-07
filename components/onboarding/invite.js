// [2026-10-07 welcome] "Convidar" — shares the download link
// (https://chatyy.com.br/baixar). Native: system share sheet. Web: Web Share
// API when available, otherwise copy to clipboard + a short confirmation.
import { Platform, Share } from 'react-native';
import { INVITE_URL } from './copy';

export async function shareInvite(c) {
  const message = c('empty.inviteMsg', { url: INVITE_URL });
  if (Platform.OS === 'web') {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title: 'Chatyy', text: message, url: INVITE_URL });
        return true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
    try {
      await navigator.clipboard.writeText(message);
      try { require('../../services/alerts').safeAlert('Chatyy', c('empty.inviteCopied')); } catch {}
      return true;
    } catch {
      try { require('../../services/alerts').safeAlert('Chatyy', message); } catch {}
      return false;
    }
  }
  try {
    await Share.share({ message, title: 'Chatyy' });
    return true;
  } catch { return false; }
}
