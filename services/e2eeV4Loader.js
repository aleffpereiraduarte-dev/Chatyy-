// [2026-10-09 e2ee v4] Nativo (iOS/Android). Este arquivo existe para o bundle
// nativo NÃO carregar o wasm (~600 KB) à toa (o web usa e2eeV4Loader.web.js).
//
// [2026-10-10] Com o módulo nativo 'ChatyyE2EE' no binário (vodozemac via
// Rust/UniFFI, native/e2ee/), devolve { Core, V } com a MESMA forma do wasm.
// Sem o módulo (todo binário publicado até hoje) continua lançando
// e2ee_unsupported, exatamente como antes. Quem decide ligar é
// services/e2eeV4.js (isSupported() ainda é só web até existir o store nativo
// — ver /root/e2ee-nativo-plano.md, fase 2).
export async function loadE2EEv4() {
  const native = require('./e2eeV4Native');
  if (!native.nativeE2EEAvailable()) {
    const e = new Error('e2ee_unsupported');
    e.code = 'e2ee_unsupported';
    throw e;
  }
  const V = native.getNativeV();
  const Core = require('./e2eeV4Core');
  return { Core, V };
}
