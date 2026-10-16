// [2026-10-16 onb-phone-fit] Tamanho de fonte do campo de telefone que SEMPRE
// cabe na linha. `adjustsFontSizeToFit` não existe em TextInput, então a conta é
// feita aqui: largura disponível ÷ largura estimada (em "em") do texto mais longo
// possível (máscara do país OU o que foi digitado/colado). Estimativa
// conservadora p/ SF Pro / Roboto semibold com tabular-nums (dígito ≈ 0,62em).
const EM = { '(': 0.36, ')': 0.36, ' ': 0.28, '-': 0.42, '+': 0.62, '.': 0.3 };

export function textEm(s) {
  let w = 0;
  for (const ch of String(s || '')) w += EM[ch] != null ? EM[ch] : 0.62;
  return w;
}

/**
 * @param {number} avail   largura (pt) disponível para o texto do campo
 * @param {string[]} texts candidatos (máscara com 0, valor formatado…)
 * @param {{max?:number,min?:number}} [o]
 * @returns {number} fontSize inteiro entre min e max
 */
export function fitPhoneFontSize(avail, texts, o = {}) {
  const max = o.max || 28;
  const min = o.min || 17;
  if (!avail || avail <= 0) return Math.min(max, 24);
  let em = 0;
  for (const s of texts || []) em = Math.max(em, textEm(s));
  if (!em) return max;
  // 6% de folga (cursor, arredondamento de glifo, kerning).
  const fs = Math.floor((avail * 0.94) / em);
  return Math.max(min, Math.min(max, fs));
}
