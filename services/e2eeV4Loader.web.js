// [2026-10-09 e2ee v4] Web: carrega núcleo + vodozemac (wasm) sob demanda
// (import() vira chunk separado — quem não usa E2EE não baixa).
export async function loadE2EEv4() {
  const [core, vz, wasmB64] = await Promise.all([
    import('./e2eeV4Core'),
    import('../vendor/chatyy-e2ee/vodozemac'),
    import('../vendor/chatyy-e2ee/vodozemac_wasm_b64'),
  ]);
  const b64 = wasmB64.default || wasmB64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await vz.default({ module_or_path: bytes });
  return { Core: core, V: vz };
}
