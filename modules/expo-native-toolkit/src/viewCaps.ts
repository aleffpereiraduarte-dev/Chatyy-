// [2026-10-07 native-docs-mail] Feature-detect what the INSTALLED binary's
// native view supports, so one JS bundle (OTA) works on old and new binaries.
//
// `requireNativeView` never throws for an unregistered view (it returns a
// component that only fails when rendered), so it can't be used as a probe.
// Instead we read the Expo view config that the native registry exposes via
// `globalThis.expo.getViewConfig(module)` — a synchronous JSI call on the Expo
// core object (no TurboModule lookup, no module init). It returns null when
// the module/view isn't in this binary, otherwise its prop + event names.
//
// Always call lazily (inside render/effects), never at import time.

export type NativeViewCaps = { props: Set<string>; events: Set<string> };

const cache = new Map<string, NativeViewCaps | null>();

export function nativeViewCaps(moduleName: string, viewName?: string): NativeViewCaps | null {
  const key = moduleName + '/' + (viewName || '');
  if (cache.has(key)) return cache.get(key) || null;
  let caps: NativeViewCaps | null = null;
  try {
    const g: any = globalThis as any;
    const cfg = g?.expo?.getViewConfig ? g.expo.getViewConfig(moduleName, viewName) : null;
    if (cfg) {
      const props = new Set<string>(Object.keys(cfg.validAttributes || {}));
      const events = new Set<string>();
      const det = cfg.directEventTypes || {};
      for (const k of Object.keys(det)) {
        const reg = det[k]?.registrationName;
        if (reg) events.add(String(reg));
      }
      caps = { props, events };
    }
  } catch {
    caps = null;
  }
  cache.set(key, caps);
  return caps;
}

export function nativeViewHas(moduleName: string, opts: { props?: string[]; events?: string[] }): boolean {
  const caps = nativeViewCaps(moduleName);
  if (!caps) return false;
  for (const p of opts.props || []) if (!caps.props.has(p)) return false;
  for (const e of opts.events || []) if (!caps.events.has(e)) return false;
  return true;
}
