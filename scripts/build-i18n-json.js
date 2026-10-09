#!/usr/bin/env node
/**
 * build-i18n-json.js — [2026-10-06 i18n-remote]
 *
 * Gera os idiomas NÃO-core como JSON estático servido pelo nginx em
 * https://chatyy.com.br/i18n/<code>.json (+ manifest.json), e grava uma cópia
 * do manifest em i18n/manifest.json (vai no bundle → o app sabe o hash de cada
 * idioma pra nomear o cache em disco e furar o cache da CDN com ?v=<hash>).
 *
 * Por quê: o Hermes NÃO faz code-split de import() → os 55 idiomas "lazy"
 * (16.5MB de JS) iam em TODO OTA/APK apesar de <1% dos usuários usarem.
 * Agora só pt-BR/en vão no bundle (es/pt-PT remotos desde 2026-10-09); o resto é baixado sob demanda
 * (ver i18n/index.js → ensureLocaleLoaded).
 *
 * Fonte da verdade continua sendo i18n/<code>.js (ES module `export default {}`).
 *
 * Uso:
 *   node scripts/build-i18n-json.js                 # grava em /var/www/mail/i18n
 *   node scripts/build-i18n-json.js --out /tmp/x    # outro diretório
 *   node scripts/build-i18n-json.js --check         # só valida (manifest do repo em dia?) → exit 1 se stale
 *   npm run i18n:json
 *
 * ⚠️ DEPLOY WEB: o rsync --delete de dist/ → /var/www/mail PRECISA de
 *    --exclude='i18n/' senão apaga os JSONs no servidor.
 * ⚠️ Rodar este script SEMPRE que um i18n/<code>.js mudar (antes do OTA/web).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'i18n');
const REPO_MANIFEST = path.join(I18N_DIR, 'manifest.json');

// Mantém em sincronia com CORE_LOCALES em i18n/index.js
const CORE_LOCALES = ['pt-BR', 'en']; // [2026-10-09 lighter-app] es/pt-PT viraram remotos

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const OUT_DIR = path.resolve(argVal('--out', process.env.I18N_OUT || '/var/www/mail/i18n'));
const CHECK_ONLY = args.includes('--check');
const QUIET = args.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

let babel;
try { babel = require('@babel/core'); } catch (e) {
  console.error('ERRO: @babel/core não encontrado — rode a partir de /root/webmail-app (node_modules).');
  process.exit(2);
}

// Carrega i18n/<code>.js (ESM) → objeto plano. Sem @babel/register: transforma
// só módulos (ESM→CJS) e avalia em sandbox; arquivos são literais puros.
function loadLocaleModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { code } = babel.transformSync(src, {
    babelrc: false, configFile: false, compact: true, comments: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
    filename: file,
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => { throw new Error('require não suportado em locale: ' + file); });
  const obj = mod.exports && mod.exports.default ? mod.exports.default : mod.exports;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('export default não é objeto: ' + file);
  return obj;
}

// Só string | string[] são válidos (o t() só lida com isso) → JSON seguro.
function validate(code, obj) {
  const bad = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) continue;
    bad.push(k);
  }
  if (bad.length) throw new Error(`${code}: valores não-string em ${bad.length} chave(s): ${bad.slice(0, 5).join(', ')}`);
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

function main() {
  const files = fs.readdirSync(I18N_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => f.replace(/\.js$/, ''))
    .filter((code) => !CORE_LOCALES.includes(code))
    .sort();

  const locales = {};
  const outputs = [];
  let totalBytes = 0;
  for (const code of files) {
    const obj = loadLocaleModule(path.join(I18N_DIR, code + '.js'));
    validate(code, obj);
    const json = JSON.stringify(obj);
    const bytes = Buffer.byteLength(json);
    totalBytes += bytes;
    locales[code] = { hash: sha1(json), bytes, keys: Object.keys(obj).length };
    outputs.push({ code, json });
  }

  const manifest = {
    v: 1,
    generatedAt: new Date().toISOString(),
    core: CORE_LOCALES,
    locales,
  };
  // Cópia do repo: sem generatedAt pra não gerar diff a cada build sem mudança real.
  const repoManifest = JSON.stringify({ v: 1, core: CORE_LOCALES, locales }, null, 1) + '\n';

  if (CHECK_ONLY) {
    let cur = null;
    try { cur = fs.readFileSync(REPO_MANIFEST, 'utf8'); } catch {}
    if (cur !== repoManifest) {
      console.error('STALE: i18n/manifest.json não bate com i18n/*.js — rode `npm run i18n:json`.');
      process.exit(1);
    }
    log(`OK: manifest em dia (${files.length} idiomas, ${(totalBytes / 1048576).toFixed(2)} MB JSON).`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Escrita atômica (tmp + rename) → nginx nunca serve JSON pela metade.
  const writeAtomic = (file, data) => {
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o644 });
    fs.renameSync(tmp, file);
  };
  for (const { code, json } of outputs) writeAtomic(path.join(OUT_DIR, code + '.json'), json);
  writeAtomic(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

  const prevRepo = fs.existsSync(REPO_MANIFEST) ? fs.readFileSync(REPO_MANIFEST, 'utf8') : null;
  if (prevRepo !== repoManifest) {
    fs.writeFileSync(REPO_MANIFEST, repoManifest);
    log(`i18n/manifest.json atualizado (bundle) — precisa de OTA/web p/ o app conhecer novos hashes.`);
  }

  // Limpa JSONs órfãos (idioma removido) no OUT_DIR — só *.json do nosso padrão.
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = /^([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/.exec(f);
    if (m && m[1] !== 'manifest' && !locales[m[1]] && !CORE_LOCALES.includes(m[1])) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      log(`removido órfão: ${f}`);
    }
  }

  log(`OK: ${files.length} idiomas → ${OUT_DIR} (${(totalBytes / 1048576).toFixed(2)} MB JSON, manifest ${Object.keys(locales).length} entradas).`);
  const top = Object.entries(locales).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5)
    .map(([c, m]) => `${c}=${(m.bytes / 1024).toFixed(0)}KB`).join(' ');
  log(`maiores: ${top}`);
}

try { main(); } catch (e) { console.error('ERRO build-i18n-json:', e.message); process.exit(1); }
