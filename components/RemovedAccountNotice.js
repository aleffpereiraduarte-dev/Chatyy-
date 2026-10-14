// [incidente-sessao 2026-10-14] Aviso discreto, UMA vez: "A conta X foi removida
// deste aparelho" — quando uma conta guardada teve o bearer revogado no servidor
// (services/storedAccountRevocation.js). O aviso fica pendente no AsyncStorage
// até ser mostrado (sobrevive a fechar o app no meio).
import { useEffect } from 'react';
import { showToast } from './ui/Toast';
import { useLanguageOptional } from '../context/LanguageContext';

const FALLBACK = 'A conta {email} foi removida deste aparelho';

export default function RemovedAccountNotice() {
  const lang = useLanguageOptional();
  const t = lang && typeof lang.t === 'function' ? lang.t : null;
  useEffect(() => {
    let alive = true;
    let tm = null;
    const flush = async () => {
      try {
        const rv = require('../services/storedAccountRevocation');
        const list = await rv.takeRemovedAccountNotices();
        if (!alive || !list.length) return;
        const email = list.join(', ');
        let msg = t ? t('account.removedFromDevice', { email }) : '';
        if (!msg || msg === 'account.removedFromDevice') msg = FALLBACK.replace('{email}', email);
        showToast({ message: msg, kind: 'info', duration: 6000 });
      } catch {}
    };
    const later = (ms) => { if (tm) clearTimeout(tm); tm = setTimeout(flush, ms); };
    later(2500);
    let unsub = null;
    try { unsub = require('../services/storedAccountRevocation').onStoredAccountRemoved(() => later(800)); } catch {}
    return () => { alive = false; if (tm) clearTimeout(tm); try { unsub?.(); } catch {} };
  }, [t]);
  return null;
}
