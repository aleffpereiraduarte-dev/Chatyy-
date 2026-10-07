// [2026-10-07 welcome] Host for the per-account first-run flow. Mounted once
// on the chat home (app/chat.js). Waits for the list to settle, asks
// services/firstRun.js whether this account still needs the flow, and
// resumes at the persisted step. Renders nothing otherwise.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import FirstRunFlow, { computeFirstRunSteps } from './FirstRunFlow';
import { evaluateFirstRun, completeFirstRun } from '../../services/firstRun';

const SETTLE_MS = 900;

export default function FirstRunGate() {
  const { user } = useAuth();
  const router = useRouter();
  const [state, setState] = useState(null); // { steps, step }
  const evaluatedFor = useRef('');
  const email = String(user?.email || '').toLowerCase();

  useEffect(() => {
    if (!email || evaluatedFor.current === email) return undefined;
    evaluatedFor.current = email;
    setState(null);
    let cancelled = false;
    const tm = setTimeout(async () => {
      try {
        const r = await evaluateFirstRun(user);
        if (cancelled || !r?.show) return;
        const steps = await computeFirstRunSteps();
        if (cancelled) return;
        setState({ steps, step: r.step && steps.includes(r.step) ? r.step : steps[0] });
      } catch {}
    }, SETTLE_MS);
    return () => { cancelled = true; clearTimeout(tm); };
  }, [email]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDone = useCallback((reason) => {
    completeFirstRun(email, reason);
    setState(null);
  }, [email]);

  const onOpenBackup = useCallback(() => {
    completeFirstRun(email, 'backup');
    setState(null);
    setTimeout(() => { try { router.push('/chat-backup'); } catch {} }, 350);
  }, [email, router]);

  if (!state) return null;
  return (
    <FirstRunFlow
      key={email}
      visible
      steps={state.steps}
      initialStep={state.step}
      onDone={onDone}
      onOpenBackup={onOpenBackup}
    />
  );
}
