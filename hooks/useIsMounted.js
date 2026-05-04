// Tracks the component's mount state in a ref so async callbacks can
// short-circuit setState after unmount. Replaces 20+ inline patterns of
// `const isMountedRef = useRef(true); useEffect(() => () => { ... = false }, [])`.
//
// Usage:
//   const mounted = useIsMounted();
//   await api.foo();
//   if (!mounted.current) return;
//   setState(...)
import { useEffect, useRef } from 'react';

export default function useIsMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => { ref.current = false; };
  }, []);
  return ref;
}
