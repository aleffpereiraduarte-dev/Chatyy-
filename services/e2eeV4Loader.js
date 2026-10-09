// [2026-10-09 e2ee v4] Nativo (iOS/Android): ainda sem E2EE v4 — o vodozemac
// entra como módulo nativo Rust/UniFFI numa build futura. Este arquivo existe
// para o bundle nativo NÃO carregar o wasm (~600 KB) à toa.
export async function loadE2EEv4() {
  const e = new Error('e2ee_unsupported');
  e.code = 'e2ee_unsupported';
  throw e;
}
