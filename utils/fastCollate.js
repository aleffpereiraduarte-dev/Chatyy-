// [2026-10-19 perf-android] Ordenação/normalização de nomes SEM Intl por par.
//
// No Hermes Android, String#localeCompare (com ou sem locale) cria um Collator
// via JNI A CADA chamada e String#normalize também atravessa o JNI. Ordenar
// 250 países (~2 000 comparações) ou a agenda (milhares) travava a thread JS por
// segundos no 1º boot (ART ainda sem JIT): /login 14 js_stall/24 h, p50 3,7 s;
// /chat-new quadro máx. 2 s. Aqui:
//   • foldText(s)       — minúsculas + sem acento (tabela própria, sem normalize);
//   • sortByText(arr,f) — decora 1× (chave por item), ordena por chave; no Android
//                         compara as chaves dobradas em JS puro; no iOS/web usa UM
//                         Intl.Collator em cache por locale (ordem idêntica à de antes).
// Kill switch (OTA/console): globalThis.__chatyy_fast_collate = false → localeCompare.

const _SRC = 'ÀÁÂÃÄÅĀĂĄàáâãäåāăąÇĆĈĊČçćĉċčĎĐďđÈÉÊËĒĔĖĘĚèéêëēĕėęěĜĞĠĢĝğġģĤĦĥħÌÍÎÏĨĪĬĮİìíîïĩīĭįıĴĵĶķĹĻĽĿŁĺļľŀłÑŃŅŇñńņňŉÒÓÔÕÖØŌŎŐòóôõöøōŏőŔŖŘŕŗřŚŜŞŠśŝşšŢŤŦţťŧÙÚÛÜŨŪŬŮŰŲùúûüũūŭůűųŴŵÝŸŶýÿŷŹŻŽźżž';
const _DST = 'AAAAAAAAAaaaaaaaaaCCCCCcccccDDddEEEEEEEEEeeeeeeeeeGGGGggggHHhhIIIIIIIIIiiiiiiiiiJjKkLLLLLlllllNNNNnnnnnOOOOOOOOOoooooooooRRRrrrSSSSssssTTTtttUUUUUUUUUUuuuuuuuuuuWwYYYyyyZZZzzz';
const _MAP = {};
for (let i = 0; i < _SRC.length && i < _DST.length; i++) _MAP[_SRC[i]] = _DST[i];
const _RE = /[À-ſ]/g;
const _LIG = { ß: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', þ: 'th', Þ: 'th', ð: 'd', Ð: 'd' };

function _on() {
  try { return globalThis.__chatyy_fast_collate !== false; } catch { return true; }
}
let _isAndroid = null;
function _android() {
  if (_isAndroid !== null) return _isAndroid;
  try { _isAndroid = require('react-native').Platform.OS === 'android'; } catch { _isAndroid = false; } // eslint-disable-line global-require
  return _isAndroid;
}

/** minúsculas + sem diacríticos latinos (pt/es/fr/de/pl/tr…); resto intacto. */
export function foldText(s) {
  const str = String(s == null ? '' : s);
  if (!str) return '';
  return str.replace(_RE, (c) => _MAP[c] || _LIG[c] || c).toLowerCase();
}

const _coll = {};
function _collator(locale) {
  const k = String(locale || '');
  if (_coll[k] !== undefined) return _coll[k];
  let c = null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Collator === 'function') {
      c = new Intl.Collator(k ? [k] : undefined, { sensitivity: 'base', numeric: true });
    }
  } catch { c = null; }
  _coll[k] = c;
  return c;
}

function _plain(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Comparador de strings barato (mesmo critério do sortByText). */
export function compareText(a, b, locale) {
  if (!_on()) { try { return String(a || '').localeCompare(String(b || '')); } catch { return _plain(String(a || ''), String(b || '')); } }
  if (_android()) return _plain(foldText(a), foldText(b));
  const c = _collator(locale);
  if (c) { try { return c.compare(String(a || ''), String(b || '')); } catch {} }
  return _plain(foldText(a), foldText(b));
}

/**
 * Ordena (cópia) por texto. textOf(item) → string. Itens com `pre(item)`
 * verdadeiro vêm antes (ex.: conversas recentes), mantendo a ordem por texto.
 */
export function sortByText(arr, textOf, locale, pre) {
  const list = Array.isArray(arr) ? arr : [];
  const n = list.length;
  if (n < 2) return list.slice();
  const fast = _on() && _android();
  const c = (!fast && _on()) ? _collator(locale) : null;
  const dec = new Array(n);
  for (let i = 0; i < n; i++) {
    const it = list[i];
    const raw = String(textOf(it) || '');
    dec[i] = { it, k: fast ? foldText(raw) : raw, p: pre ? (pre(it) ? 0 : 1) : 0, i };
  }
  dec.sort((x, y) => {
    if (x.p !== y.p) return x.p - y.p;
    let r = 0;
    if (fast) r = _plain(x.k, y.k);
    else if (c) { try { r = c.compare(x.k, y.k); } catch { r = _plain(x.k, y.k); } }
    else { try { r = x.k.localeCompare(y.k); } catch { r = _plain(x.k, y.k); } }
    return r || (x.i - y.i);
  });
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = dec[i].it;
  return out;
}
