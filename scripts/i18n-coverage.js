#!/usr/bin/env node
/**
 * i18n-coverage.js — [2026-10-09 i18n-complete]
 *
 * Mede a cobertura de tradução de cada i18n/<code>.js contra a fonte pt-BR.
 *
 *   node scripts/i18n-coverage.js              # tabela de todos os idiomas
 *   node scripts/i18n-coverage.js fr de ja     # só esses
 *   node scripts/i18n-coverage.js --missing fr # lista as chaves que faltam em fr
 *   node scripts/i18n-coverage.js --min 98     # exit 1 se algum idioma listado ficar < 98%
 *
 * Colunas:
 *   cobertura   = chaves da fonte presentes no idioma (string não vazia, ou vazia
 *                 quando a fonte também é vazia / o en é vazio de propósito)
 *   faltam      = chaves da fonte ausentes
 *   placeholder = chaves com {placeholders} quebrados vs a fonte (token extra ou
 *                 faltando; {s} de plural pode ser omitido)
 *   =pt-BR      = valores idênticos ao pt-BR (pode ser legítimo: "Email", "OK"…)
 *
 * O seletor de idioma (app/settings.js) só oferece idiomas com cobertura ≥ 98%.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'i18n');
const SOURCE = 'pt-BR';

let babel;
try { babel = require('@babel/core'); } catch (e) {
  console.error('ERRO: @babel/core não encontrado — rode a partir de /root/webmail-app.');
  process.exit(2);
}

function load(code) {
  const file = path.join(I18N_DIR, code + '.js');
  const src = fs.readFileSync(file, 'utf8');
  const { code: out } = babel.transformSync(src, {
    babelrc: false, configFile: false, compact: true, comments: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'], filename: file,
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', out)(mod, mod.exports);
  return mod.exports.default || mod.exports;
}

const phList = (s) => (typeof s === 'string' ? (s.match(/\{\{?[^{}]*\}\}?/g) || []) : []);
// Placeholder quebrado = token na tradução que não existe na fonte (renderiza
// literal, ex.: "{daté}") ou token da fonte que sumiu. Exceção: sufixo de
// plural {s}, que idiomas sem plural por sufixo (ar, ja, de…) podem omitir.
const OPTIONAL_PH = new Set(['{s}']);
function phBroken(src, tr) {
  const a = new Set(phList(src)); const b = new Set(phList(tr));
  for (const x of b) if (!a.has(x)) return true;
  for (const x of a) if (!b.has(x) && !OPTIONAL_PH.has(x)) return true;
  return false;
}

const args = process.argv.slice(2);
const minIdx = args.indexOf('--min');
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : null;
const showMissing = args.includes('--missing');
const wanted = args.filter((a, i) => !a.startsWith('--') && !(minIdx >= 0 && i === minIdx + 1));

// Idiomas do seletor (i18n/index.js → SELECTABLE_LOCALES): marcados com * e
// conferidos contra o mínimo de 98% (exit 1 se algum cair abaixo).
const SELECTOR_MIN = 98;
const SELECTABLE = (() => {
  try {
    const idx = fs.readFileSync(path.join(I18N_DIR, 'index.js'), 'utf8');
    const m = idx.match(/SELECTABLE_LOCALES\s*=\s*\[([^\]]*)\]/);
    return m ? (m[1].match(/'([^']+)'/g) || []).map((x) => x.slice(1, -1)) : [];
  } catch { return []; }
})();

const src = load(SOURCE);
const en = load('en');
const keys = Object.keys(src).filter((k) => !k.startsWith('_'));

const codes = (wanted.length ? wanted : fs.readdirSync(I18N_DIR)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .map((f) => f.replace(/\.js$/, '')))
  .filter((c) => c !== SOURCE);

const rows = [];
for (const code of codes) {
  let d;
  try { d = load(code); } catch (e) { rows.push({ code, err: e.message }); continue; }
  let have = 0; let same = 0; const missing = []; const badPh = [];
  for (const k of keys) {
    const s = src[k]; const v = d[k];
    const emptyOk = v === '' && (s === '' || en[k] === '');
    if (v == null || (v === '' && !emptyOk)) { missing.push(k); continue; }
    have++;
    if (v === s) same++;
    if (typeof s === 'string' && phBroken(s, v)) badPh.push(k);
  }
  rows.push({ code, pct: (have / keys.length) * 100, have, missing, badPh, same });
}

rows.sort((a, b) => (b.pct || 0) - (a.pct || 0) || a.code.localeCompare(b.code));
console.log(`fonte ${SOURCE}: ${keys.length} chaves\n`);
console.log('idioma   cobertura   faltam  placeholder  =pt-BR');
for (const r of rows) {
  if (r.err) { console.log(`${r.code.padEnd(8)} ERRO ${r.err}`); continue; }
  const mark = SELECTABLE.includes(r.code) ? '*' : ' ';
  console.log(`${mark}${r.code.padEnd(7)} ${r.pct.toFixed(1).padStart(7)}%  ${String(r.missing.length).padStart(7)}  ${String(r.badPh.length).padStart(11)}  ${String(r.same).padStart(6)}`);
  if (showMissing) {
    if (r.missing.length) console.log('   faltam: ' + r.missing.join(', '));
    if (r.badPh.length) console.log('   placeholder: ' + r.badPh.join(', '));
  }
}

if (SELECTABLE.length) {
  console.log(`\n* = no seletor de idioma (SELECTABLE_LOCALES: ${SELECTABLE.length}; mínimo ${SELECTOR_MIN}%)`);
  const lowSel = rows.filter((r) => SELECTABLE.includes(r.code) && (r.err || r.pct < SELECTOR_MIN || r.badPh.length));
  if (lowSel.length) {
    console.error(`ATENÇÃO: no seletor mas incompleto/placeholder quebrado: ${lowSel.map((r) => r.code).join(', ')}`);
    process.exitCode = 1;
  }
}

if (MIN != null) {
  const low = rows.filter((r) => r.err || r.pct < MIN);
  if (low.length) {
    console.error(`\n${low.length} idioma(s) abaixo de ${MIN}%: ${low.map((r) => r.code).join(', ')}`);
    process.exit(1);
  }
}
