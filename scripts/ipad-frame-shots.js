#!/usr/bin/env node
/**
 * iPad App Store screenshots — MARKETING FRAME pass.
 *
 * Takes the raw 2048×2732 iPad captures from scripts/ipad-prints.js and renders
 * them at iPhone-marketing quality: purple gradient background + two-tone bold
 * headline (white with a yellow accent word, matching the iPhone set) + subtitle
 * + floating iPad device frame (rounded bezel + drop shadow). Output stays at the
 * exact 2048×2732 the App Store requires for the 12.9"/13" iPad display class.
 *
 * No Pango delegate on this box, so the two-tone headline is composed from
 * per-segment `label:` images h-appended — full color control per word.
 *
 * In : /var/www/mail/data/qa-robot/ipad-prints/<NN>-<screen>.png   (raw)
 * Out: /var/www/mail/data/qa-robot/ipad-prints/framed/<NN>-<screen>.png
 * Run: node scripts/ipad-frame-shots.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = '/var/www/mail/data/qa-robot/ipad-prints';
const OUT = path.join(DIR, 'framed');
const TMP = path.join(OUT, '_tmp');
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_R = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const W = 2048, H = 2732;            // 12.9" portrait
const ACCENT = '#FCD34D';            // yellow accent (matches iPhone set)
const GRAD_TOP = '#9333EA', GRAD_BOT = '#5B21B6';
const DEV_W = 1488;                  // device width on canvas
const BEZEL = 22, RAD_IN = 40, RAD_OUT = 62;

// Marketing copy per screen. headline = array of lines; each line = array of
// { t, c } segments (c omitted = white). Keep the yellow accent on key words.
const COPY = {
  '1-messaging':    { head: [[{t:'Converse com'}], [{t:'quem '},{t:'importa',c:ACCENT}]],         sub: 'Mensagens, voz e vídeo num só app' },
  '2-conversation': { head: [[{t:'Tudo numa'}],    [{t:'conversa '},{t:'só',c:ACCENT}]],          sub: 'Fotos, áudios, figurinhas e enquetes' },
  '3-ai':           { head: [[{t:'Sua IA pessoal,'}],[{t:'Chatyy One',c:ACCENT}]],                sub: 'Pergunte, traduza e resuma na hora' },
  '4-profile':      { head: [[{t:'Seu perfil,'}],  [{t:'do seu '},{t:'jeito',c:ACCENT}]],         sub: 'Destaques, links e status' },
  '5-wallet':       { head: [[{t:'Carteira e'}],   [{t:'diamantes',c:ACCENT}]],                   sub: 'Envie e receba presentes' },
  '6-photos':       { head: [[{t:'Suas memórias,'}],[{t:'sempre ',c:'#ffffff'},{t:'seguras',c:ACCENT}]], sub: 'Backup automático na nuvem' },
};
const FALLBACK = { head: [[{t:'Chatyy'}]], sub: 'Tudo num só app' };

const HEAD_PT = 118, SUB_PT = 50, LINE_GAP = 14;

function mk(args) { execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }

function labelSeg(text, color, out) {
  mk(['-background', 'none', '-fill', color || '#ffffff', '-font', FONT_B,
      '-pointsize', String(HEAD_PT), '-kerning', '-1', `label:${text}`, out]);
}

function buildHeadline(head, out) {
  const lineFiles = [];
  head.forEach((segs, li) => {
    const segFiles = segs.map((s, si) => {
      const f = path.join(TMP, `seg_${li}_${si}.png`);
      labelSeg(s.t, s.c || '#ffffff', f);
      return f;
    });
    const lf = path.join(TMP, `line_${li}.png`);
    if (segFiles.length === 1) fs.copyFileSync(segFiles[0], lf);
    else mk([...segFiles, '+append', lf]);   // h-join segments → one line
    lineFiles.push(lf);
  });
  // v-stack lines, centered
  mk(['-background', 'none', '-gravity', 'center', ...lineFiles, '-append', out]);
}

function buildDevice(rawPng, out) {
  const sz = execFileSync('magick', ['identify', '-format', '%w %h', rawPng]).toString().trim().split(' ').map(Number);
  const sw = DEV_W, sh = Math.round(sz[1] * (DEV_W / sz[0]));
  const round = path.join(TMP, 'shot_round.png');
  // scale + round screenshot corners
  mk(['(', rawPng, '-resize', `${sw}x${sh}`, ')',
      '(', '-size', `${sw}x${sh}`, 'xc:none', '-draw', `roundrectangle 0,0,${sw-1},${sh-1},${RAD_IN},${RAD_IN}`, ')',
      '-alpha', 'set', '-compose', 'DstIn', '-composite', round]);
  // black bezel rounded rect, screenshot centered on it
  const bw = sw + BEZEL * 2, bh = sh + BEZEL * 2;
  const bezel = path.join(TMP, 'bezel.png');
  mk(['(', '-size', `${bw}x${bh}`, 'xc:none', '-draw', `roundrectangle 0,0,${bw-1},${bh-1},${RAD_OUT},${RAD_OUT}`,
      '-fill', '#0b0b0f', '-colorize', '100', ')',
      round, '-gravity', 'center', '-composite', bezel]);
  // drop shadow behind
  mk(['(', bezel, ')', '(', bezel, '-background', 'black', '-shadow', '55x34+0+26', ')',
      '+swap', '-background', 'none', '-layers', 'merge', '+repage', out]);
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const raws = fs.readdirSync(DIR).filter(f => /^\d+-.*\.png$/.test(f)).sort();
  if (!raws.length) { console.error('no raw shots in', DIR); process.exit(1); }
  console.log('framing', raws.length, 'shots');

  for (const f of raws) {
    const key = f.replace(/^\d+-/, '').replace(/\.png$/, '');     // e.g. "1-messaging" -> match by stem
    const stem = f.replace(/\.png$/, '');
    const copy = COPY[stem] || COPY[key] || FALLBACK;
    const raw = path.join(DIR, f);

    const head = path.join(TMP, 'head.png');
    const sub = path.join(TMP, 'sub.png');
    const dev = path.join(TMP, 'dev.png');
    buildHeadline(copy.head, head);
    mk(['-background', 'none', '-fill', 'rgba(255,255,255,0.85)', '-font', FONT_R,
        '-pointsize', String(SUB_PT), `label:${copy.sub}`, sub]);
    buildDevice(raw, dev);

    const out = path.join(OUT, f);
    // gradient bg → place caption (top) + subtitle + device (centered lower)
    mk(['(', '-size', `${W}x${H}`, `gradient:${GRAD_TOP}-${GRAD_BOT}`, ')',
        '(', head, ')', '-gravity', 'North', '-geometry', '+0+150', '-composite',
        '(', sub, ')', '-gravity', 'North', '-geometry', `+0+${150 + HEAD_PT * copy.head.length + 60}`, '-composite',
        '(', dev, ')', '-gravity', 'North', '-geometry', '+0+560', '-composite',
        '-resize', `${W}x${H}!`, out]);
    console.log('  ✓', f);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('done →', OUT);
})();
