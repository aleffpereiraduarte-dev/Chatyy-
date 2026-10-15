// [phone-obrigatorio 2026-10-15] Gate do "Adicione seu número" (contas antigas sem telefone).
// Montado no _layout ao lado do TermsUpdateGate. Pergunta 1x por abertura/conta, depois do boot
// (o aviso de Termos abre em 6 s; este em 9 s), e só fora dos fluxos de entrada/chamada/câmera.
// Regras de quando perguntar + constante p/ tornar obrigatório: services/phoneLink.js.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'expo-router';
import { useAuth, isChildAccount } from '../../context/AuthContext';
import { shouldAskPhoneLink } from '../../services/phoneLink';

const SKIP_RE = /^\/(login|signup|forgot|verify|onboarding|call|group-call|meet|live|reels-recorder|reels-compose|video-studio|native-sheet|legal|change-phone)/;

export default function AddPhoneGate() {
  const auth = useAuth();
  const pathname = usePathname() || '';
  const [ask, setAsk] = useState(null); // { required }
  const probedForRef = useRef(null);
  const email = auth?.user?.email || '';

  useEffect(() => {
    if (!email) { probedForRef.current = null; setAsk(null); return undefined; }
    if (auth?.loading || probedForRef.current === email) return undefined;
    probedForRef.current = email;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        if (isChildAccount()) return;
        const r = await shouldAskPhoneLink(email);
        if (alive && r.show) setAsk({ required: !!r.required, snoozeDays: r.snoozeDays });
      } catch {}
    }, 9000);
    return () => { alive = false; clearTimeout(timer); };
  }, [email, auth?.loading]);

  if (!ask || !email || SKIP_RE.test(pathname)) return null;
  const AddPhoneSheet = require('./AddPhoneSheet').default;
  return <AddPhoneSheet email={email} required={ask.required} snoozeDays={ask.snoozeDays} onDone={() => setAsk(null)} />;
}
