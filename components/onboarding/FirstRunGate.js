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

/** Name (2+ chars, not just the address/phone) AND a photo already saved on the server. */
async function profileAlreadyComplete(user) {
  try {
    const api = require('../../services/api');
    const r = await Promise.race([
      api.getProfile(),
      new Promise((res) => setTimeout(() => res(null), 4000)),
    ]);
    if (!r?.success || !r.data) return false;
    const d = r.data;
    const email = String(user?.email || d.email || '').toLowerCase();
    const local = email.split('@')[0];
    const name = String(d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || '').trim();
    const nameOk = name.length >= 2 && name.toLowerCase() !== local && !/^[+\d\s()-]+$/.test(name);
    const photoOk = !!(d.avatar || d.avatar_url || d.avatar_updated);
    return nameOk && photoOk;
  } catch { return false; }
}

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
        let steps = await computeFirstRunSteps();
        if (cancelled) return;
        // [2026-10-11 funnel-qa] Steps the signup screen already covered
        // (phone signup = name + photo) are not asked again.
        const skip = Array.isArray(r.skip) ? [...r.skip] : [];
        // [2026-10-16 wave12-c] …nor when the account ALREADY has a name + photo
        // on the server (login on a new device, signup on another device, the
        // native onboarding's skip lost) — never ask for the same profile twice.
        if (steps.includes('profile') && !skip.includes('profile') && await profileAlreadyComplete(user)) skip.push('profile');
        if (cancelled) return;
        if (skip.length) {
          const left = steps.filter((s) => !skip.includes(s));
          // A lone theme picker right after signup is just one more tap
          // between the new user and the chat list (theme follows the system).
          if (!left.length || (left.length === 1 && left[0] === 'look')) { completeFirstRun(email, 'covered_by_signup'); return; }
          steps = left;
        }
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
