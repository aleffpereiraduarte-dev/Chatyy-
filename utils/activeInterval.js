// [2026-10-10 perf-battery] setInterval that only ticks while the app is in
// the foreground (AppState 'active'). Native background (Android keeps the JS
// thread alive while the process lives; iOS with audio/VoIP/location modes)
// and hidden web tabs (RN-web maps document visibility to AppState) no longer
// wake the JS thread / radio for UI pollers nobody can see.
//
// Semantics kept as close to a plain setInterval as possible:
//   - starts immediately if the app is active (first tick after `ms`, like
//     setInterval — callers that tick on mount keep doing it themselves);
//   - on 'background' the timer is cleared (iOS 'inactive' is transitional —
//     control center, incoming-call banner — and keeps ticking);
//   - on return to 'active' it ticks ONCE right away if at least `ms` elapsed
//     since the last tick (so state is never staler than with the old timer,
//     and quick app switches don't trigger an extra fetch), then re-arms.
// Returns a stop() function (idempotent). Never throws.
import { AppState } from 'react-native';

export function setActiveInterval(fn, ms) {
  let timer = null;
  let lastRun = Date.now();
  let stopped = false;
  let sub = null;
  const run = () => {
    lastRun = Date.now();
    try { fn(); } catch {}
  };
  const arm = () => {
    if (timer || stopped) return;
    timer = setInterval(run, ms);
  };
  const disarm = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };
  let current = 'active';
  try { current = AppState.currentState || 'active'; } catch {}
  if (current !== 'background') arm();
  try {
    sub = AppState.addEventListener('change', (next) => {
      if (stopped) return;
      if (next === 'background') {
        disarm();
      } else if (next === 'active') {
        if (!timer) {
          if (Date.now() - lastRun >= ms) run();
          arm();
        }
      }
    });
  } catch {}
  return function stop() {
    stopped = true;
    disarm();
    try { sub && sub.remove && sub.remove(); } catch {}
    sub = null;
  };
}

export default setActiveInterval;
