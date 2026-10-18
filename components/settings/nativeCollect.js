// components/settings/nativeCollect.js — [2026-10-18 settings-sub-native]
//
// Sub-páginas das Configurações (/settings-section → SettingsCategoryScreen)
// desenhadas pela MESMA lista nativa da raiz (ChatyySettingsList, api ≥ 2),
// sem reescrever as categorias: a categoria JS continua montada (estado,
// efeitos, folhas, handlers) numa árvore INVISÍVEL e, nesse modo "coleta",
// SettingsGroup / SettingsRow / SettingsSwitchRow / SettingsPickerRow NÃO
// desenham — registram DESCRITORES aqui. O coletor ordena os grupos pela
// posição real na árvore (cada grupo deixa um marcador de 1 px; medimos y),
// monta as linhas planas (cabeçalho/rodapé por seção, valor à direita, check,
// spinner, interruptor, destrutiva, desabilitada) e a tela entrega à lista
// nativa. Toque/interruptor nativo → o MESMO onPress / onValueChange do JS.
//
// Segurança (volta sozinho p/ a tela JS, mesmo visual):
//   • conteúdo que não é linha do kit (cartões, campos, medidores…) ocupa
//     altura na árvore invisível → altura > nº de marcadores → falha;
//   • linha fora de grupo, título não-texto, `right` desconhecido, `children`;
//   • erro de render/nativo (Boundary do NativeSettingsList).
// Grupo com `nativeHeader` (ex.: cabeçalho da Bia) vai como cartão RN no topo
// da lista (slot do header nativo), não como linhas.
//
// Kill switches (OTA): globalThis.__chatyy_native_settings_sub = false (todas)
// ou globalThis.__chatyy_native_settings_cats = ['privacy', …] (lista própria).
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { View, ActivityIndicator, Platform, findNodeHandle } from 'react-native';
import NativeSwitch from '../NativeSwitch';
import { settingsListApiVersion, isSettingsListAvailable } from '../../modules/expo-chat-conversation-list';

export const SettingsCollectContext = createContext(null);
const SlotContext = createContext(null);

// Categorias que são só linhas do kit (as demais têm cartões/campos próprios
// e ficam na tela JS). Conferido à mão + checagem de altura em tempo real.
const DEFAULT_NATIVE_CATS = ['privacy', 'notifications', 'accessibility', 'help', 'invite', 'bia'];
const _failedCats = new Set();

export function nativeSettingsCategoryOn(cat) {
  if (Platform.OS === 'web' || !cat) return false;
  try {
    if (globalThis.__chatyy_native_settings === false) return false;
    if (globalThis.__chatyy_native_settings_sub === false) return false;
    if (globalThis.__chatyy_native_settings_failed) return false;
  } catch {}
  if (_failedCats.has(cat)) return false;
  let allow = DEFAULT_NATIVE_CATS;
  try { if (Array.isArray(globalThis.__chatyy_native_settings_cats)) allow = globalThis.__chatyy_native_settings_cats; } catch {}
  if (!allow.includes(cat)) return false;
  try { return settingsListApiVersion() >= 2 && isSettingsListAvailable(); } catch { return false; }
}

export function markNativeCategoryFailed(cat, why) {
  if (!cat) return;
  _failedCats.add(cat);
  try { console.warn('[native-settings-sub] fallback JS:', cat, why); } catch {}
  try { require('../../services/crashReporter').reportNativeFallback?.('native_settings_sub', `${cat}: ${String(why || '')}`); } catch {}
}

// [2026-10-18 bia-orb-icon] Ícone da Bia = ORB (não a estrelinha). A lista
// nativa desenha o orb com a chave 'biaOrb' a partir da apiVersion 3; binário
// antigo não conhece a chave → manda 'status' (círculo neutro; sem ícone se
// nem isso existir), nunca mais 'sparkles'.
export function nativeIconKey(name) {
  if (name !== 'biaOrb') return name || '';
  try { return settingsListApiVersion() >= 3 ? 'biaOrb' : 'status'; } catch { return 'status'; }
}

// Componente de ícone (components/Icons) → nome lógico do nativo.
let _iconNames = null;
function iconName(Icon) {
  if (!Icon) return '';
  if (!_iconNames) {
    _iconNames = new Map();
    try {
      const I = require('../Icons');
      const pairs = {
        IconCreditCard: 'wallet', IconDownload: 'download', IconDraft: 'edit', IconMessageSquare: 'message',
        IconPenTool: 'edit', IconPlus: 'plus', IconSparkles: 'sparkles', IconTrash: 'trash', IconZap: 'sparkles',
        IconMail: 'mail', IconBell: 'bell', IconPhone: 'phone', IconUser: 'user', IconShield: 'shield',
        IconGlobe: 'globe', IconStar: 'star', IconMonitor: 'device', IconUsers: 'users', IconLock: 'lock',
        IconImage: 'image', IconShare: 'share', IconCopy: 'link', IconLink: 'link', IconCalendar: 'calendar',
        IconClock: 'clock', IconArchive: 'archive', IconCamera: 'camera', IconVideo: 'video', IconHelpCircle: 'help',
        IconInfo: 'info', IconEdit: 'edit', IconDatabase: 'database', IconType: 'type', IconUserPlus: 'userPlus',
        IconSearch: 'search', IconLogOut: 'logout', IconFlag: 'flag', IconEye: 'eye', IconCloud: 'database', IconKey: 'lock',
      };
      for (const k of Object.keys(pairs)) if (I[k]) _iconNames.set(I[k], pairs[k]);
    } catch {}
    try { _iconNames.set(require('../bia/BiaIcon').default, 'biaOrb'); } catch {}
  }
  return nativeIconKey(_iconNames.get(Icon) || '');
}

function _isText(v) { return typeof v === 'string' || typeof v === 'number'; }
function _hasChildren(c) {
  let n = 0;
  React.Children.forEach(c, (x) => { if (x !== null && x !== undefined && x !== false && x !== '') n += 1; });
  return n > 0;
}

// props da SettingsRow → descritor da linha nativa (ou { bad }).
function describeRow(p) {
  const {
    title, subtitle, value, icon, onPress, onLongPress, chevron, right, destructive, disabled, checked,
    numberOfLines = 1, subtitleLines = 2, center, children, native,
  } = p || {};
  if (_hasChildren(children)) return { bad: 'row children' };
  if (p && p.left) return { bad: 'row left' };
  if (!_isText(title)) return { bad: 'row title' };
  if (subtitle && !_isText(subtitle)) return { bad: 'row subtitle' };
  const d = {
    title: String(title),
    sub: subtitle ? String(subtitle) : '',
    icon: iconName(icon),
    val: (value !== undefined && value !== null && value !== '') ? String(value) : '',
    dest: !!destructive,
    center: !!center,
    dis: !!disabled,
    tl: Math.max(0, Number(numberOfLines) || 0),
    sl: Math.max(0, Number(subtitleLines) || 0),
  };
  let toggle = null;
  let spin = false;
  if (native && typeof native === 'object') {
    // Override explícito do lado direito (ex.: código do convite como valor).
    if (native.val !== undefined) d.val = String(native.val || '');
    if (native.acc) d.acc = String(native.acc);
  } else if (right) {
    const ty = right.type;
    if (ty === NativeSwitch) toggle = right.props || {};
    else if (ty && ty.__nativeValueText) {
      const c = right.props?.children;
      if (!_isText(c)) return { bad: 'value text' };
      d.val = String(c);
    } else if (ty === ActivityIndicator) spin = true;
    else return { bad: 'row right' };
  }
  if (toggle) {
    d.k = 't';
    d.on = !!toggle.value;
    d.dis = !!(disabled || toggle.disabled);
    d.acc = '';
    return { d, toggle };
  }
  const pressable = !!(onPress || onLongPress) && !disabled;
  d.k = pressable ? 'a' : 'i';
  if (!d.acc) {
    if (spin) d.acc = 's';
    else if (checked === true) d.acc = 'k';
    else if (checked === false) d.acc = 'u';
    else {
      const showChevron = chevron ?? (!!onPress && !destructive && checked === undefined && !right);
      d.acc = showChevron ? 'c' : 'n';
    }
  }
  return { d };
}

/**
 * Coletor de uma tela. onChange({ rows, headers, failed }) após cada passada.
 */
export function createCollector({ onChange }) {
  let gseq = 0;
  let rseq = 0;
  const groups = new Map(); // gid -> { header, footer, el, node, seq }
  const rows = new Map(); // rid -> { gid, slot, seq, d, toggle, props, nonce }
  let container = null;
  let containerH = 0;
  let failed = null;
  let scheduled = false;
  let alive = true;
  let lastKey = '';
  let lastHeaders = [];
  let pass = 0;

  const fail = (why) => {
    if (failed || !alive) return;
    failed = String(why || 'unsupported');
    try { onChange({ rows: [], headers: [], failed }); } catch {}
  };

  const schedule = () => {
    if (scheduled || !alive || failed) return;
    scheduled = true;
    const run = () => { scheduled = false; flush(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
  };

  const measure = (node) => new Promise((resolve) => {
    if (!node || !container || typeof node.measureLayout !== 'function') { resolve(null); return; }
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const viaHandle = () => {
      // Arquitetura antiga: measureLayout pede o nó numérico.
      try {
        const h = findNodeHandle(container);
        if (h == null) { fin(null); return; }
        node.measureLayout(h, (_x, y) => fin(y), () => fin(null));
      } catch { fin(null); }
    };
    try { node.measureLayout(container, (_x, y) => fin(y), viaHandle); } catch { viaHandle(); }
    setTimeout(() => fin(null), 400);
  });

  async function flush() {
    if (!alive || failed) return;
    const my = ++pass;
    // Conteúdo fora do kit ocupa altura (marcadores = 1 px cada).
    if (containerH > groups.size + 1.5) { fail(`custom content (${Math.round(containerH)}px / ${groups.size} groups)`); return; }
    const list = Array.from(groups.entries());
    const ys = await Promise.all(list.map(([, g]) => measure(g.node)));
    if (!alive || failed || my !== pass) return;
    const ordered = list
      .map(([gid, g], i) => ({ gid, g, y: ys[i] == null ? Number.MAX_SAFE_INTEGER : ys[i] }))
      .sort((a, b) => (a.y - b.y) || (a.g.seq - b.g.seq));
    const byGroup = new Map();
    for (const [rid, r] of rows) {
      if (!byGroup.has(r.gid)) byGroup.set(r.gid, []);
      byGroup.get(r.gid).push([rid, r]);
    }
    const out = [];
    const headers = [];
    for (const { gid, g } of ordered) {
      if (g.el) { headers.push(g.el); continue; }
      const rs = (byGroup.get(gid) || []).sort((a, b) => (a[1].slot - b[1].slot) || (a[1].seq - b[1].seq));
      if (!rs.length) continue;
      for (const [rid, r] of rs) {
        out.push({ ...r.d, id: rid, sid: 'g' + gid, hd: g.header, ft: g.footer, n: r.nonce || 0 });
      }
    }
    const key = JSON.stringify(out);
    const headersSame = headers.length === lastHeaders.length && headers.every((h, i) => h === lastHeaders[i]);
    if (key === lastKey && headersSame) return;
    lastKey = key;
    lastHeaders = headers;
    try { onChange({ rows: out, headers, failed: null }); } catch {}
  }

  return {
    get failed() { return failed; },
    fail,
    schedule,
    setContainer(node) { container = node; schedule(); },
    setContainerHeight(h) { containerH = Number(h) || 0; schedule(); },
    newGid() { gseq += 1; return gseq; },
    newRid() { rseq += 1; return 'r' + rseq; },
    setGroup(gid, info) {
      const prev = groups.get(gid);
      groups.set(gid, { ...(prev || {}), ...info, seq: prev?.seq || gid });
      schedule();
    },
    setGroupNode(gid, node) {
      const prev = groups.get(gid) || { seq: gid };
      groups.set(gid, { ...prev, node });
      schedule();
    },
    removeGroup(gid) { groups.delete(gid); schedule(); },
    setRow(rid, slot, props) {
      if (!slot) { fail('row outside group'); return; }
      const r = describeRow(props);
      if (r.bad) { fail(r.bad); return; }
      const prev = rows.get(rid);
      rows.set(rid, { gid: slot.gid, slot: slot.index, seq: prev?.seq || Number(String(rid).slice(1)) || 0, d: r.d, toggle: r.toggle || null, props, nonce: prev?.nonce || 0 });
      schedule();
    },
    removeRow(rid) { rows.delete(rid); schedule(); },
    press(rid) {
      const r = rows.get(rid);
      if (!r || !r.props) return;
      try { r.props.onPress?.(); } catch (e) { try { console.warn('[native-settings-sub] onPress', e?.message || e); } catch {} }
    },
    toggle(rid, value) {
      const r = rows.get(rid);
      if (!r || !r.toggle) return;
      try { r.toggle.onValueChange?.(!!value); } catch (e) { try { console.warn('[native-settings-sub] onToggle', e?.message || e); } catch {} }
      // O nativo já virou o interruptor; se o JS recusar (valor não muda), o
      // patch não traria nada → reenvia a linha com o valor real.
      setTimeout(() => {
        const cur = rows.get(rid);
        if (!cur || !alive) return;
        cur.nonce = (cur.nonce || 0) + 1;
        schedule();
      }, 650);
    },
    /** id da 1ª linha do 1º grupo na/abaixo da âncora (View do registerAnchor). */
    async resolveAnchor(node) {
      const ay = await measure(node);
      if (ay == null) return null;
      const list = Array.from(groups.entries()).filter(([, g]) => !g.el);
      const ys = await Promise.all(list.map(([, g]) => measure(g.node)));
      let best = null;
      list.forEach(([gid], i) => {
        const y = ys[i];
        if (y == null || y < ay - 0.5) return;
        if (!best || y < best.y) best = { gid, y };
      });
      if (!best) return null;
      // Âncora já no 1º grupo (topo da tela) → não rola.
      const minY = Math.min(...ys.filter((y) => y != null));
      if (best.y <= minY + 0.5) return null;
      let first = null;
      for (const [rid, r] of rows) {
        if (r.gid !== best.gid) continue;
        if (!first || r.slot < first.slot || (r.slot === first.slot && r.seq < first.seq)) first = { rid, slot: r.slot, seq: r.seq };
      }
      return first ? first.rid : null;
    },
    dispose() { alive = false; },
  };
}

// ── Versões "coleta" dos primitivos (usadas pelo SettingsKit) ─────────────
export function useSettingsCollector() {
  return useContext(SettingsCollectContext);
}

export function CollectGroup({ col, header, footer, children, nativeHeader }) {
  const gidRef = useRef(0);
  if (!gidRef.current) gidRef.current = col.newGid();
  const gid = gidRef.current;
  useLayoutEffect(() => {
    col.setGroup(gid, {
      header: header ? String(header) : '',
      footer: footer && (typeof footer === 'string' || typeof footer === 'number') ? String(footer) : '',
      el: nativeHeader ? (children || null) : null,
    });
    if (footer && typeof footer !== 'string' && typeof footer !== 'number') col.fail('group footer');
  });
  useEffect(() => () => col.removeGroup(gid), [col, gid]);
  const marker = (
    <View
      collapsable={false}
      style={MARKER}
      ref={(n) => { if (n) col.setGroupNode(gid, n); }}
    />
  );
  if (nativeHeader) return marker;
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <>
      {marker}
      {items.map((child, i) => (
        <SlotContext.Provider key={child.key ?? i} value={slotValue(gid, i)}>
          {child}
        </SlotContext.Provider>
      ))}
    </>
  );
}

// Valores de slot estáveis (sem re-render em cascata por objeto novo).
const _slotCache = new Map();
function slotValue(gid, index) {
  const k = gid + ':' + index;
  let v = _slotCache.get(k);
  if (!v) { v = { gid, index }; _slotCache.set(k, v); if (_slotCache.size > 4000) _slotCache.clear(); }
  return v;
}

export function CollectRow({ col, rowProps }) {
  const slot = useContext(SlotContext);
  const ridRef = useRef('');
  if (!ridRef.current) ridRef.current = col.newRid();
  const rid = ridRef.current;
  useLayoutEffect(() => { col.setRow(rid, slot, rowProps); });
  useEffect(() => () => col.removeRow(rid), [col, rid]);
  return null;
}

const MARKER = { height: 1, alignSelf: 'stretch' };
