// Tela de configuração da Bia (assistente de IA) — memória/personalização.
// Chama a ação `ai_memory` do backend (get / set / learn_style). (2026-09-24)
//
// [2026-10-19 bia-personaliza] Página completa, P&B premium:
//   • cabeçalho com o orb + descrição;
//   • prévia ao vivo (como a Bia cumprimentaria, com o nome + tom escolhidos);
//   • Como a Bia me chama  → ai_memory display_name (bia-user-context: "chame de");
//   • Tom de voz           → ai_memory tone (texto livre no prompt: "Tom que prefere");
//   • Respostas curtas/detalhadas → [bia-convite 2026-10-19] chave própria
//     ai_memory reply_length (short|detailed). Servidor sem o kit recusa a chave
//     ("chave invalida") → volta ao jeito antigo: vai junto no MESMO valor de
//     `tone` ("Amigável e acolhedor, respostas curtas"). Valor livre antigo = "Personalizado".
//   • Idioma das respostas → ai_memory language (pt/en/es/fr/de/it) ou 'auto'
//     ("Automático": o servidor com o kit apaga a chave → idioma do pedido/app).
//   • Voz da Bia → [bia-convite 2026-10-19] ai_memory voice (vozes da conversa ao
//     vivo). Prévia = one_tts com a voz salva. Sem o kit (sub_action delete /
//     chave voice recusados) a seção some.
//   • Privacidade: bia_personalize / bia_data_access + "Ver o que a Bia lembra".
//   • Dados: "Apagar memória" (one_memory_delete all=1, com confirmação).
//   • Escrita de e-mails: assinatura + aprender estilo (como antes).
// Salva sozinho (toque/blur), sem botão "Salvar" global.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { aiMemoryGet, aiMemorySet, aiMemoryLearnStyle, apiCall } from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import { HapticsCompat as Haptics } from '../services/haptics';
import { safeAlert } from '../services/alerts';
import { IconTrash, IconSmile, IconBriefcase, IconZap, IconMessageCircle, IconGlobe, IconEye, IconPlay, IconPause } from '../components/Icons';
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, useGroupedColors, useSettingsInputStyle,
} from '../components/settings/SettingsKit';
import BiaOrb, { BiaOrbLite } from '../components/bia/BiaOrb';
import BiaIcon from '../components/bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

// Valores gravados no servidor (o LLM lê em pt; independem do idioma do app).
const TONES = [
  { id: 'friendly', phrase: 'Amigável e acolhedor', match: ['amigável', 'amigavel'], Icon: IconSmile },
  { id: 'professional', phrase: 'Profissional e cordial', match: ['profissional'], Icon: IconBriefcase },
  { id: 'fun', phrase: 'Divertido e descontraído', match: ['divertido'], Icon: IconZap },
  { id: 'direct', phrase: 'Direto e objetivo', match: ['direto'], Icon: IconMessageCircle },
];
const LENGTHS = [
  { id: 'short', phrase: 'respostas curtas', match: ['respostas curtas'] },
  { id: 'detailed', phrase: 'respostas detalhadas', match: ['respostas detalhadas'] },
];
const LANGS = ['pt', 'en', 'es', 'fr', 'de', 'it'];
const LANG_FB = { auto: 'Automático', pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano' };

// [bia-convite 2026-10-19] Vozes da Bia (ai_memory voice). Padrão do servidor = shimmer.
const DEFAULT_VOICE = 'shimmer';
const VOICES = [
  { id: 'shimmer', name: 'Shimmer', desc: 'Leve e luminosa' },
  { id: 'coral', name: 'Coral', desc: 'Calorosa e animada' },
  { id: 'sage', name: 'Sage', desc: 'Serena e acolhedora' },
  { id: 'marin', name: 'Marin', desc: 'Natural e próxima' },
  { id: 'ballad', name: 'Ballad', desc: 'Suave e expressiva' },
  { id: 'alloy', name: 'Alloy', desc: 'Neutra e equilibrada' },
  { id: 'verse', name: 'Verse', desc: 'Versátil e animada' },
  { id: 'echo', name: 'Echo', desc: 'Clara e firme' },
  { id: 'ash', name: 'Ash', desc: 'Grave e calma' },
  { id: 'cedar', name: 'Cedar', desc: 'Profunda e tranquila' },
];
const VOICE_IDS = VOICES.map(v => v.id);

// Sessão: o servidor tem o kit (reply_length / voice)? null = ainda não sabemos.
let _kitKnown = null;
function _rejectedKey(r) {
  const st = Number(r && r.__httpStatus) || 0;
  const msg = String((r && (r.message || r.error)) || '').toLowerCase();
  return !(r && r.success) && (/chave invalida|chave inválida|sub_action invalido|sub_action inválido/.test(msg) || st === 400);
}

let _ExpoAudio = null;
try { _ExpoAudio = require('expo-audio'); } catch {}

function parseTone(raw) {
  const s = String(raw || '').trim();
  const low = s.toLowerCase();
  const tone = TONES.find(x => x.match.some(m => low.startsWith(m)));
  const len = LENGTHS.find(x => x.match.some(m => low.includes(m)));
  // Texto livre (tela antiga) que não é um dos nossos → "Personalizado".
  const custom = s && !tone ? s : '';
  return { tone: tone ? tone.id : '', length: len ? len.id : '', custom };
}

function composeTone(toneId, lengthId) {
  const tn = TONES.find(x => x.id === toneId);
  const ln = LENGTHS.find(x => x.id === lengthId);
  if (tn && ln) return `${tn.phrase}, ${ln.phrase}`;
  if (tn) return tn.phrase;
  if (ln) return ln.phrase.charAt(0).toUpperCase() + ln.phrase.slice(1);
  return '';
}

function firstName(user) {
  const n = String(user?.name || user?.display_name || user?.displayName || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// Prévia: bolha da Bia com o cumprimento no tom escolhido.
function GreetingPreview({ name, tone, length, t, g }) {
  const nm = name || t('bia.previewYou', 'você');
  const key = tone || 'friendly';
  const base = t(`bia.greet.${key}`, {
    friendly: 'Oi, {name}! Que bom te ver por aqui. Em que posso ajudar hoje?',
    professional: 'Olá, {name}. Estou à disposição. Como posso ajudar?',
    fun: 'E aí, {name}! Bora resolver umas coisas juntos?',
    direct: '{name}, o que você precisa?',
  }[key]).split('{name}').join(nm);
  const extra = length === 'detailed'
    ? ' ' + t('bia.greetDetailed', 'Posso resumir seus e-mails, organizar sua agenda ou escrever uma resposta com você, com todos os detalhes.')
    : '';
  return (
    <View style={s.previewWrap} accessible accessibilityLabel={`${t('bia.preview', 'Prévia')}: ${base}${extra}`}>
      <View style={s.previewRow}>
        <BiaOrbLite size={30} isDark={g.isDark} animated={false} />
        <View style={[s.bubble, { backgroundColor: g.fill }]}>
          <Text style={[s.bubbleName, { color: g.text }]}>Bia</Text>
          <Text style={[s.bubbleText, { color: g.text }]}>{base}{extra}</Text>
        </View>
      </View>
    </View>
  );
}

// Segmentado P&B (Curtas | Detalhadas).
function Segmented({ options, value, onChange, g }) {
  return (
    <View style={[s.seg, { backgroundColor: g.fill }]} accessibilityRole="radiogroup">
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => { if (!on) { try { Haptics.selectionAsync?.(); } catch {} onChange(o.value); } }}
            style={[s.segItem, on && { backgroundColor: g.ink }]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
          >
            <Text style={[s.segText, { color: on ? g.onInk : g.text }]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function BiaSettings() {
  const { t } = useLanguage();
  const router = useRouter();
  let user = null;
  try { user = useAuth()?.user || null; } catch {}
  const g = useGroupedColors();
  const inputStyle = useSettingsInputStyle();

  // [2026-10-13 settings-instant] memória da Bia salva no aparelho → abre na hora.
  const [loading, setLoading] = useState(() => settingsCache.peek('bia_memory') == null);
  const [learning, setLearning] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [displayName, setDisplayName] = useState('');
  const savedName = useRef('');
  const [toneId, setToneId] = useState('');
  const [lengthId, setLengthId] = useState('');
  const [customTone, setCustomTone] = useState('');
  const [lang, setLang] = useState('');
  // [bia-convite 2026-10-19] kit no servidor (reply_length/voice): null = sondando
  const [kit, setKit] = useState(_kitKnown);
  const [voice, setVoice] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const playerRef = useRef(null);
  const toneRawRef = useRef('');
  const [signature, setSignature] = useState('');
  const savedSig = useRef('');
  const [learnedStyle, setLearnedStyle] = useState('');
  // [bia-contexto 2026-10-18] "A Bia aprende comigo" (ai_memory bia_personalize; padrão ligado)
  const [learnOn, setLearnOn] = useState(true);
  // [bia-ferramentas-voz 2026-10-18] "Bia pode acessar meus e-mails e conversas" (ai_memory bia_data_access; padrão ligado)
  const [dataOn, setDataOn] = useState(true);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const hydrate = useCallback((mem) => {
    if (!mem || typeof mem !== 'object') return;
    if (mem.display_name != null) { setDisplayName(String(mem.display_name)); savedName.current = String(mem.display_name); }
    if (mem.tone != null) {
      toneRawRef.current = String(mem.tone);
      const p = parseTone(mem.tone);
      setToneId(p.tone); setCustomTone(p.custom);
      if (!mem.reply_length) setLengthId(p.length);
    }
    // [bia-convite 2026-10-19] chave própria vence o tamanho embutido no tom
    if (mem.reply_length === 'short' || mem.reply_length === 'detailed') setLengthId(mem.reply_length);
    if (mem.voice && VOICE_IDS.includes(String(mem.voice).toLowerCase())) setVoice(String(mem.voice).toLowerCase());
    if (mem.reply_length || mem.voice) { _kitKnown = true; setKit(true); }
    if (mem.language) {
      const lv = String(mem.language).toLowerCase();
      setLang(lv === 'auto' ? 'auto' : lv.slice(0, 2));
    }
    if (mem.signature != null) { setSignature(String(mem.signature)); savedSig.current = String(mem.signature); }
    if (mem.writing_style) setLearnedStyle(mem.writing_style);
    if (mem.bia_personalize != null) setLearnOn(String(mem.bia_personalize) !== '0');
    if (mem.bia_data_access != null) setDataOn(String(mem.bia_data_access) !== '0');
  }, []);

  useEffect(() => {
    hydrate(settingsCache.peek('bia_memory'));
    (async () => {
      try {
        const r = await aiMemoryGet();
        if (r?.success) {
          hydrate(r.data?.memory);
          if (r.data?.memory && typeof r.data.memory === 'object') settingsCache.put('bia_memory', r.data.memory);
          // [bia-convite 2026-10-19] sonda o kit sem mudar nada: "delete voice" quando
          // não há voz salva (servidor antigo responde "sub_action invalido").
          const m = r.data?.memory || {};
          if (_kitKnown == null && !m.voice && !m.reply_length) {
            try {
              const pr = await apiCall('ai_memory', { sub_action: 'delete', key: 'voice' }, 'POST');
              if (pr?.success) { _kitKnown = true; setKit(true); }
              else if (_rejectedKey(pr)) { _kitKnown = false; setKit(false); }
            } catch {}
          }
        }
      } catch {}
      setLoading(false);
    })();
  }, [hydrate]);

  useEffect(() => () => { try { playerRef.current?.stop?.(); } catch {} }, []);

  // Grava uma chave; devolve true/false. O servidor recusa valor vazio.
  const saveKey = useCallback(async (key, value) => {
    try {
      const r = await aiMemorySet(key, value);
      if (!r?.success) throw new Error('fail');
      try { settingsCache.patch('bia_memory', { [key]: value }); } catch {}
      return true;
    } catch {
      showToast(t('bia.toggleError', 'Não consegui salvar agora'));
      return false;
    }
  }, [showToast, t]);

  // [bia-convite 2026-10-19] grava sem toast; diz se o servidor recusou a CHAVE (sem o kit).
  const trySet = useCallback(async (key, value) => {
    try {
      const r = await aiMemorySet(key, value);
      if (r?.success) {
        try { settingsCache.patch('bia_memory', { [key]: value }); } catch {}
        return { ok: true, rejected: false };
      }
      return { ok: false, rejected: _rejectedKey(r) };
    } catch { return { ok: false, rejected: false }; }
  }, []);

  const handleLearnToggle = useCallback(async (v) => {
    setLearnOn(v);
    if (!(await saveKey('bia_personalize', v ? '1' : '0'))) setLearnOn(!v);
  }, [saveKey]);

  const handleDataToggle = useCallback(async (v) => {
    setDataOn(v);
    if (!(await saveKey('bia_data_access', v ? '1' : '0'))) setDataOn(!v);
  }, [saveKey]);

  const commitName = useCallback(async () => {
    const v = displayName.trim().slice(0, 40);
    if (!v || v === savedName.current) { if (!v) setDisplayName(savedName.current); return; }
    if (await saveKey('display_name', v)) { savedName.current = v; showToast(t('bia.saved', 'Preferências salvas')); }
  }, [displayName, saveKey, showToast, t]);

  const commitSignature = useCallback(async () => {
    const v = signature.trim();
    if (!v || v === savedSig.current) { if (!v) setSignature(savedSig.current); return; }
    if (await saveKey('signature', v)) { savedSig.current = v; showToast(t('bia.saved', 'Preferências salvas')); }
  }, [signature, saveKey, showToast, t]);

  const pickTone = useCallback(async (id) => {
    const prev = { toneId, customTone };
    setToneId(id); setCustomTone('');
    try { Haptics.selectionAsync?.(); } catch {}
    // [bia-convite 2026-10-19] com reply_length próprio o tom vai sem o tamanho
    const v = composeTone(id, kit === true ? '' : lengthId);
    if (!(await saveKey('tone', v))) { setToneId(prev.toneId); setCustomTone(prev.customTone); }
    else toneRawRef.current = v;
  }, [toneId, customTone, lengthId, kit, saveKey]);

  // Jeito antigo (servidor sem o kit): tamanho embutido no `tone`.
  const legacyLengthTone = useCallback((id) => (toneId ? composeTone(toneId, id)
    : customTone ? `${customTone.replace(/,?\s*respostas (curtas|detalhadas)/i, '')}, ${LENGTHS.find(x => x.id === id).phrase}`
    : composeTone('', id)), [toneId, customTone]);

  const pickLength = useCallback(async (id) => {
    const prev = lengthId;
    setLengthId(id);
    if (kit !== false) {
      // [bia-convite 2026-10-19] chave própria reply_length
      const r = await trySet('reply_length', id);
      if (r.ok) {
        if (!_kitKnown) { _kitKnown = true; setKit(true); }
        // limpa o tamanho antigo embutido no tom (sem toast; falha = fica como estava)
        const raw = toneRawRef.current;
        if (raw && /respostas (curtas|detalhadas)/i.test(raw)) {
          const clean = toneId ? composeTone(toneId, '') : raw.replace(/,?\s*respostas (curtas|detalhadas)/i, '').trim();
          if (clean && (await trySet('tone', clean)).ok) toneRawRef.current = clean;
        }
        return;
      }
      if (!r.rejected) { setLengthId(prev); showToast(t('bia.toggleError', 'Não consegui salvar agora')); return; }
      _kitKnown = false; setKit(false); // servidor sem o kit → jeito antigo
    }
    const value = legacyLengthTone(id);
    if (!(await saveKey('tone', value))) setLengthId(prev);
    else toneRawRef.current = value;
  }, [lengthId, kit, toneId, trySet, legacyLengthTone, saveKey, showToast, t]);

  // [bia-convite 2026-10-19] Voz da Bia
  const pickVoice = useCallback(async (id) => {
    if (id === (voice || DEFAULT_VOICE)) return;
    const prev = voice;
    setVoice(id);
    try { Haptics.selectionAsync?.(); } catch {}
    const r = await trySet('voice', id);
    if (r.ok) { if (!_kitKnown) { _kitKnown = true; setKit(true); } return; }
    setVoice(prev);
    if (r.rejected) { _kitKnown = false; setKit(false); return; } // some a seção
    showToast(t('bia.toggleError', 'Não consegui salvar agora'));
  }, [voice, trySet, showToast, t]);

  const stopPreview = useCallback(() => {
    const p = playerRef.current;
    playerRef.current = null;
    try { p?.stop?.(); } catch {}
    setPreviewing(false);
  }, []);

  const playPreview = useCallback(async () => {
    if (previewing) { stopPreview(); return; }
    const nm = displayName.trim() || firstName(user);
    const text = (nm
      ? t('bia.voice.sampleName', 'Oi, {name}! Eu sou a Bia. É assim que eu falo com você.').split('{name}').join(nm)
      : t('bia.voice.sample', 'Oi! Eu sou a Bia. É assim que eu falo com você.'));
    setPreviewing(true);
    try {
      if (Platform.OS === 'web') {
        const url = await api.oneTTS(text);
        if (!url) throw new Error('tts');
        const audio = new window.Audio(url);
        const end = () => { try { URL.revokeObjectURL(url); } catch {} if (playerRef.current?.audio === audio) { playerRef.current = null; setPreviewing(false); } };
        audio.onended = end; audio.onerror = end;
        playerRef.current = { audio, stop: () => { try { audio.pause(); } catch {} end(); } };
        await audio.play();
        return;
      }
      if (!_ExpoAudio?.createAudioPlayer) throw new Error('no_audio');
      try { await _ExpoAudio.setAudioModeAsync?.({ playsInSilentMode: true }); } catch {}
      const player = _ExpoAudio.createAudioPlayer({ uri: api.oneTTSUrl(text) });
      let iv = null;
      const cleanup = () => {
        if (iv) { clearInterval(iv); iv = null; }
        try { player.remove(); } catch {}
        if (playerRef.current?.player === player) { playerRef.current = null; setPreviewing(false); }
      };
      playerRef.current = { player, stop: () => { try { player.pause(); } catch {} cleanup(); } };
      let started = 0;
      const startAt = Date.now();
      iv = setInterval(() => {
        try {
          if (player.playing) started = started || Date.now();
          if ((!player.playing && player.currentTime > 0) || (!started && Date.now() - startAt > 15000)) cleanup();
        } catch { cleanup(); }
      }, 300);
      player.play();
    } catch {
      stopPreview();
      showToast(t('bia.voice.previewError', 'Não consegui tocar a prévia agora'));
    }
  }, [previewing, stopPreview, displayName, user, showToast, t]);

  const pickLang = useCallback(async (code) => {
    const prev = lang;
    setLang(code);
    if (!(await saveKey('language', code))) setLang(prev);
  }, [lang, saveKey]);

  const handleLearn = useCallback(async () => {
    setLearning(true);
    try {
      const r = await aiMemoryLearnStyle();
      if (r?.success) {
        hydrate(r.data?.memory);
        showToast(t('bia.learned', 'Aprendi o seu estilo'));
      } else {
        showToast(t('bia.learnEmpty', 'Sem emails enviados pra aprender ainda'));
      }
    } catch {
      showToast(t('bia.learnError', 'Não consegui aprender agora'));
    }
    setLearning(false);
  }, [hydrate, showToast, t]);

  const handleWipe = useCallback(() => {
    safeAlert(
      t('bia.wipeTitle', 'Apagar a memória da Bia?'),
      t('bia.wipeMsg', 'A Bia vai esquecer tudo o que aprendeu sobre você nas conversas. Suas preferências desta tela continuam. Isso não pode ser desfeito.'),
      [
        { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
        { text: t('bia.wipeConfirm', 'Apagar memória'), style: 'destructive', onPress: async () => {
          setWiping(true);
          try {
            const r = await apiCall('one_memory_delete', { all: 1 }, 'POST');
            if (r?.success === false) throw new Error('fail');
            try { Haptics.notificationAsync?.('success'); } catch {}
            showToast(t('bia.wipeDone', 'Memória apagada'));
          } catch {
            showToast(t('bia.wipeError', 'Não consegui apagar agora. Tente de novo.'));
          }
          setWiping(false);
        } },
      ],
    );
  }, [showToast, t]);

  const langOptions = useMemo(() => ['auto', ...LANGS].map(code => ({ value: code, label: t(`bia.lang.${code}`, LANG_FB[code]) })), [t]);
  // [bia-convite 2026-10-19] sem idioma salvo = Automático (o servidor segue o idioma do pedido/app)
  const langValue = lang && (lang === 'auto' || LANGS.includes(lang)) ? lang : 'auto';
  const langFooter = kit === false
    ? t('bia.langFooter', 'Na conversa por voz a Bia fala neste idioma. No chat por texto ela acompanha o idioma do app.')
    : (langValue === 'auto'
      ? t('bia.langFooterAuto', 'Automático: a Bia responde no idioma do app ou da sua mensagem.')
      : t('bia.langFooterFixed', 'A Bia responde sempre neste idioma, no texto e na voz.'));
  const voiceValue = voice || DEFAULT_VOICE;
  const previewName = displayName.trim() || firstName(user);

  const toneLabel = (id) => t(`bia.tone.${id}`, { friendly: 'Amigável', professional: 'Profissional', fun: 'Divertido', direct: 'Direto' }[id]);
  const toneDesc = (id) => t(`bia.toneDesc.${id}`, {
    friendly: 'Calorosa e próxima, como uma amiga',
    professional: 'Educada e precisa, boa para o trabalho',
    fun: 'Leve, com bom humor',
    direct: 'Vai direto ao ponto, sem rodeios',
  }[id]);

  return (
    <SettingsScreen
      title={t('bia.title', 'Bia — Assistente')}
      overlay={toast ? (
        <View style={[s.toast, { backgroundColor: g.ink }]} pointerEvents="none" accessibilityLiveRegion="polite">
          <Text style={[s.toastText, { color: g.onInk }]}>{toast}</Text>
        </View>
      ) : null}
    >
      {loading ? (
        <ActivityIndicator color={g.text} style={{ marginTop: 48 }} />
      ) : (
        <View>
          {/* Cabeçalho */}
          <View style={s.hero}>
            <BiaOrb size={84} isDark={g.isDark} /* [2026-10-15 bia-design] mesma identidade da tela da Bia */ />
            <Text style={[s.heroTitle, { color: g.text }]} accessibilityRole="header">{t('bia.heroTitle', 'Do seu jeito')}</Text>
            <Text style={[s.heroText, { color: g.secondary }]}>
              {t('bia.heroDesc', 'Escolha como a Bia te chama, o tom e o tamanho das respostas. Ela usa isso no chat, na voz e nos e-mails.')}
            </Text>
          </View>

          {/* Prévia ao vivo */}
          <SettingsGroup header={t('bia.preview', 'Prévia')}>
            <GreetingPreview name={previewName} tone={toneId} length={lengthId} t={t} g={g} />
          </SettingsGroup>

          {/* Como a Bia me chama */}
          <SettingsGroup header={t('bia.nameHeader', 'Como a Bia me chama')} footer={t('bia.nameFooter', 'Seu nome ou apelido. A Bia usa nas conversas e na voz.')}>
            <View style={s.inputWrap}>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                onBlur={commitName}
                onSubmitEditing={commitName}
                returnKeyType="done"
                maxLength={40}
                autoCapitalize="words"
                autoCorrect={false}
                placeholder={firstName(user) || t('bia.namePlaceholder', 'Ex: Ana, Dr. Paulo, Juju')}
                placeholderTextColor={g.secondary}
                style={inputStyle}
                accessibilityLabel={t('bia.nameHeader', 'Como a Bia me chama')}
              />
            </View>
          </SettingsGroup>

          {/* Tom de voz */}
          <SettingsGroup header={t('bia.toneHeader', 'Tom de voz')}>
            {TONES.map(o => (
              <SettingsRow
                key={o.id}
                icon={o.Icon}
                iconTile={false}
                title={toneLabel(o.id)}
                subtitle={toneDesc(o.id)}
                checked={toneId === o.id}
                accessibilityRole="radio"
                onPress={() => pickTone(o.id)}
              />
            ))}
            {!!customTone && (
              <SettingsRow
                title={t('bia.toneCustom', 'Personalizado')}
                subtitle={customTone}
                subtitleLines={3}
                checked
                accessibilityRole="radio"
              />
            )}
          </SettingsGroup>

          {/* Respostas */}
          <SettingsGroup header={t('bia.lengthHeader', 'Respostas')} footer={lengthId === 'detailed'
            ? t('bia.lengthDetailedDesc', 'A Bia explica com mais contexto e exemplos.')
            : t('bia.lengthShortDesc', 'A Bia responde em poucas frases, sem enrolar.')}>
            <View style={s.inputWrap}>
              <Segmented
                g={g}
                value={lengthId || 'short'}
                onChange={pickLength}
                options={[
                  { value: 'short', label: t('bia.lengthShort', 'Curtas') },
                  { value: 'detailed', label: t('bia.lengthDetailed', 'Detalhadas') },
                ]}
              />
            </View>
          </SettingsGroup>

          {/* [bia-convite 2026-10-19] Voz da Bia — some se o servidor não aceita a chave voice */}
          {kit === true && (
            <SettingsGroup header={t('bia.voice.header', 'Voz da Bia')} footer={t('bia.voice.footer', 'A voz da conversa por voz e das respostas faladas. A prévia é uma amostra e pode soar um pouco diferente na conversa ao vivo.')}>
              {VOICES.map(v => (
                <SettingsRow
                  key={v.id}
                  title={v.name}
                  subtitle={v.id === DEFAULT_VOICE
                    ? `${t(`bia.voice.desc.${v.id}`, v.desc)} · ${t('bia.voice.default', 'Padrão')}`
                    : t(`bia.voice.desc.${v.id}`, v.desc)}
                  checked={voiceValue === v.id}
                  accessibilityRole="radio"
                  onPress={() => pickVoice(v.id)}
                />
              ))}
              <SettingsRow
                icon={previewing ? IconPause : IconPlay}
                iconTile={false}
                title={previewing ? t('bia.voice.stop', 'Parar prévia') : t('bia.voice.preview', 'Ouvir a voz escolhida')}
                titleStyle={{ fontWeight: '600', color: g.ink }}
                chevron={false}
                onPress={playPreview}
              />
            </SettingsGroup>
          )}

          {/* Idioma */}
          <SettingsGroup footer={langFooter}>
            <SettingsPickerRow
              icon={IconGlobe}
              title={t('bia.langTitle', 'Idioma das respostas')}
              options={langOptions}
              value={langValue}
              onChange={pickLang}
              cancelLabel={t('common.cancel', 'Cancelar')}
            />
          </SettingsGroup>

          {/* Privacidade */}
          <SettingsGroup header={t('bia.privacyHeader', 'Privacidade')} footer={t('bia.learnMeDesc', 'A Bia lembra seu nome, preferências e o que você conta pra ela, no texto e na voz. Desligado, ela não usa nem guarda memórias.')}>
            <SettingsSwitchRow title={t('bia.learnMe', 'A Bia aprende comigo')} value={learnOn} onValueChange={handleLearnToggle} />
            <SettingsRow
              icon={IconEye}
              title={t('bia.seeMemory', 'Ver o que a Bia lembra')}
              onPress={() => router.push('/one-memory')}
            />
          </SettingsGroup>

          <SettingsGroup footer={t('bia.dataAccessDesc', 'Ligado, a Bia pode ler e resumir seus e-mails e conversas quando você pede, no texto e na voz. Enviar, apagar ou marcar compromissos sempre pede a sua confirmação.')}>
            <SettingsSwitchRow title={t('bia.dataAccess', 'Bia pode acessar meus e-mails e conversas')} value={dataOn} onValueChange={handleDataToggle} />
          </SettingsGroup>

          {/* Escrita de e-mails */}
          <SettingsGroup header={t('bia.signature', 'Assinatura')} footer={t('bia.signatureFooter', 'A Bia coloca no fim dos e-mails que escreve para você.')}>
            <View style={s.inputWrap}>
              <TextInput
                value={signature}
                onChangeText={setSignature}
                onBlur={commitSignature}
                placeholder={t('bia.signaturePlaceholder', 'Ex: Abraço, Aleff')}
                placeholderTextColor={g.secondary}
                multiline
                style={[inputStyle, { minHeight: 72, textAlignVertical: 'top' }]}
                accessibilityLabel={t('bia.signature', 'Assinatura')}
              />
            </View>
          </SettingsGroup>

          <SettingsGroup header={t('bia.learnTitle', 'Aprender meu estilo')} footer={t('bia.learnDesc', 'A Bia lê alguns dos seus emails enviados e aprende como você escreve. Nada sai do seu servidor.')}>
            {learnedStyle ? (
              <SettingsRow
                title={t('bia.currentStyle', 'Estilo que aprendi:')}
                titleStyle={{ fontSize: 13, color: g.secondary }}
              >
                <Text style={[s.styleText, { color: g.text }]}>{learnedStyle}</Text>
              </SettingsRow>
            ) : null}
            <SettingsRow
              title={learnedStyle ? t('bia.relearn', 'Aprender de novo') : t('bia.learnNow', 'Aprender agora')}
              titleStyle={{ fontWeight: '600', color: g.ink }}
              chevron={false}
              disabled={learning}
              right={learning ? <ActivityIndicator size="small" color={g.text} /> : <BiaIcon size={18} color={g.text} />}
              onPress={handleLearn}
            />
          </SettingsGroup>

          {/* Dados */}
          <SettingsGroup header={t('bia.dataHeader', 'Dados')} footer={t('bia.wipeFooter', 'Apaga tudo o que a Bia guardou das suas conversas. Não apaga seus e-mails nem mensagens.')}>
            <SettingsRow
              icon={IconTrash}
              iconTile={false}
              title={t('bia.wipeConfirm', 'Apagar memória')}
              destructive
              chevron={false}
              disabled={wiping}
              right={wiping ? <ActivityIndicator size="small" color={g.text} /> : undefined}
              onPress={handleWipe}
            />
          </SettingsGroup>
        </View>
      )}
    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 26 },
  heroTitle: { fontSize: 22, fontWeight: '600', letterSpacing: -0.4, marginTop: 14 },
  heroText: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6, maxWidth: 330 },
  previewWrap: { paddingHorizontal: 14, paddingVertical: 14 },
  previewRow: { flexDirection: 'row', alignItems: 'flex-end' },
  bubble: { flex: 1, marginLeft: 10, borderRadius: 18, borderBottomLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleName: { fontSize: 12, fontWeight: '600', letterSpacing: 0.2, marginBottom: 2, opacity: 0.7 },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  inputWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 8 },
  segText: { fontSize: 14, fontWeight: '600' },
  styleText: { fontSize: 15, lineHeight: 20, marginTop: 4 },
  toast: { position: 'absolute', bottom: 40, left: 24, right: 24, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  toastText: { fontSize: 14, fontWeight: '600' },
});
