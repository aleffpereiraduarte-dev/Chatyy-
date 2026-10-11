// [2026-10-11 boot-split] Mounts its (React.lazy) child the first time `when`
// is true and keeps it mounted afterwards, so a lazily-loaded modal keeps the
// exact same close animation / internal state behavior as an eager one.
// `fallback` is shown only while the chunk loads (web; on native the import()
// resolves from the bundle on the next tick).
import React, { Suspense, useRef } from 'react';

export default function LazyMount({ when, fallback = null, children }) {
  const seen = useRef(false);
  if (when) seen.current = true;
  if (!seen.current) return null;
  return <Suspense fallback={fallback}>{children}</Suspense>;
}
