// [WP-04] Runner no edge: copia PRIVADA do app (/opt/chatyy-qa/app-wp04) + rota QA temporária,
// expo export ali (sem mexer no /opt/chatyy-qa/app compartilhado), serve o dist e roda o teste.
const { execSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const OUT = process.env.QA_OUT || '.';
const SRC = '/opt/chatyy-qa/app', DST = '/opt/chatyy-qa/app-wp04';
const sh = (c, t = 1500) => execSync(c, { stdio: 'inherit', shell: '/bin/bash', timeout: t * 1000 });
const t0 = Date.now();
sh(`mkdir -p ${DST} && rsync -a --delete --exclude=/node_modules --exclude=/dist --exclude=/.expo ${SRC}/ ${DST}/`);
if (!fs.existsSync(DST + '/node_modules')) sh(`cp -al ${SRC}/node_modules ${DST}/node_modules`);
fs.copyFileSync(path.join(__dirname, 'e2ee5-qa.route.js'), DST + '/app/e2ee5-qa.js');
// overlay com a versão ATUAL do WP-04 (a árvore compartilhada pode estar atrás)
for (const [f, d] of [['index.web.js', 'services/crypto'], ['client.web.js', 'services/crypto/worker'], ['workerBundle.generated.js', 'services/crypto/worker'], ['chatyy_crypto_bg.wasm', 'vendor/chatyy-crypto-wasm']]) {
  fs.mkdirSync(path.join(DST, d), { recursive: true });
  fs.copyFileSync(path.join(__dirname, f), path.join(DST, d, f));
}
// confere que a árvore tem os arquivos do WP-04 iguais aos do US
const exp = fs.readFileSync(path.join(__dirname, 'expected.md5'), 'utf8');
try { execSync('md5sum -c -', { cwd: DST, input: exp, stdio: ['pipe', 'inherit', 'inherit'] }); } catch (e) { console.log('MD5 DIFERENTE: árvore do edge não tem a versão atual do WP-04'); process.exit(3); }
sh(`cd ${DST} && rm -rf dist && NODE_ENV=production npx expo export --platform web --clear 2>&1 | tail -6`);
const exportMs = Date.now() - t0;
// análise estática do dist
const dist = DST + '/dist';
const js = execSync(`find ${dist}/_expo -name '*.js'`).toString().trim().split('\n');
const hits = js.filter((f) => fs.readFileSync(f, 'utf8').includes('chatyy-e2ee5-meta')).map((f) => path.basename(f));
const idx = fs.readFileSync(dist + '/index.html', 'utf8');
const entry = (idx.match(/_expo\/static\/js\/web\/[^"']+\.js/g) || []).map((s) => path.basename(s));
const wasm = execSync(`find ${dist} -name '*chatyy_crypto_bg*.wasm'`).toString().trim();
const st = { exportMs, workerChunks: hits, entryScripts: entry, workerInEntry: hits.some((h) => entry.includes(h)), wasm: wasm.replace(dist, ''), wasmBytes: wasm ? fs.statSync(wasm).size : 0 };
fs.writeFileSync(path.join(OUT, 'dist-analysis.json'), JSON.stringify(st, null, 2));
console.log('DIST', JSON.stringify(st));
// serve + teste
const srv = spawn(process.execPath, ['/opt/chatyy-qa/bin/serve-dist.js', dist, '0']);
srv.stdout.once('data', (d) => {
  process.env.QA_BASE_URL = 'http://127.0.0.1:' + String(d).trim();
  const child = spawn(process.execPath, [path.join(__dirname, 'e2ee5-web-host.pw.js')], { stdio: 'inherit', env: process.env });
  child.on('exit', (c) => { srv.kill(); sh(`rm -f ${DST}/app/e2ee5-qa.js`); process.exit(c); });
});
