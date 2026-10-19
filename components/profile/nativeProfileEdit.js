// components/profile/nativeProfileEdit.js — [2026-10-18 profile-edit-native]
//
// "Editar perfil" NATIVO estilo Telegram: tocar "Editar" no perfil próprio
// troca a MESMA view nativa (ChatyyChatInfo, apiVersion ≥ 4) para o modo
// edição (CIEditPanel.swift / CIEditPanel.kt). Aqui fica só o estado e os
// handlers JS — os mesmos endpoints da folha JS (components/ProfileEditSheet):
//   update_profile (nome, @, bio, site, pronomes, recado, capa),
//   username_check (disponibilidade ao vivo, debounce 400 ms),
//   upload_avatar / upload_cover (expo-image-picker com recorte nativo).
// Os campos de texto pertencem ao nativo durante a edição: mandamos `values`
// uma vez (quando `seq` muda) e recebemos cada mudança por onEdit.
//
// Entrada externa (tela "Você" / Configurações / deep link):
//   openNativeProfileEdit(router, email) → /u/<email>?edit=1 quando o nativo
//   está disponível; senão a tela JS /edit-profile.
// Kill switch: globalThis.__chatyy_native_profile_edit = false.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as api from '../../services/api';
import { normalizeCoverUrl, prepareCoverFile } from '../../services/profileCover';
import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';
import { avatarRefForEmail } from '../chat/NativeProfileBridge';
import { isNativeProfileEditEnabled } from '../chat/NativeChatInfo';

export { isNativeProfileEditEnabled };

const LIMITS = { first: 40, last: 40, bio: 150, username: 30, pronouns: 40, link: 120, about: 139 };

/** Rota da edição: nativa (perfil próprio em modo edição) ou a tela JS. */
export function profileEditHref(email) {
  if (email && isNativeProfileEditEnabled()) return `/u/${encodeURIComponent(String(email))}?edit=1`;
  return '/edit-profile';
}

/** Abre a edição do perfil próprio (nativa quando disponível). */
export function openNativeProfileEdit(router, email) {
  const href = profileEditHref(email);
  try { router?.push?.(href); } catch {}
  return href;
}

function splitName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) return { first: '', last: '' };
  const i = n.indexOf(' ');
  if (i < 0) return { first: n, last: '' };
  return { first: n.slice(0, i), last: n.slice(i + 1) };
}

function cleanUsername(v) {
  return String(v || '').replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 30);
}

async function pickImage(t, aspect) {
  if (Platform.OS === 'web') return null;
  let ensure = null;
  try { ensure = require('../ProfileEditSheet').ensurePhotoPermission; } catch {}
  if (typeof ensure === 'function' && !(await ensure(t))) return null;
  const ImagePicker = require('expo-image-picker');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect,
    quality: 0.85,
  });
  if (result?.canceled || !result?.assets?.[0]) return null;
  return result.assets[0];
}

/**
 * ctx = { t, identity, enabled, abs(url), onSaved(next), onRow(id), onClosed() }
 * → { active, start(), edit (descritor p/ prop `edit`), onEdit(ev), back() }
 */
export function useNativeProfileEdit(ctx) {
  const { t, identity, enabled } = ctx;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const tr = useCallback((k, fb) => { const v = t?.(k); return v && v !== k ? v : fb; }, [t]);

  const [session, setSession] = useState(null); // null = nunca abriu
  const [on, setOn] = useState(false);
  const [seq, setSeq] = useState(0);
  const [backSeq, setBackSeq] = useState(0);
  const [values, setValues] = useState({});
  const [cover, setCover] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [busyAvatar, setBusyAvatar] = useState(false);
  const [busyCover, setBusyCover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [uname, setUname] = useState({ q: '', state: '', text: '' });
  const draftRef = useRef({});
  const initialRef = useRef({ values: {}, cover: '' });
  const checkTimer = useRef(null);
  const checkReq = useRef(0);

  useEffect(() => () => { if (checkTimer.current) clearTimeout(checkTimer.current); }, []);

  const start = useCallback(() => {
    if (!enabled) return false;
    const id = ctxRef.current.identity || {};
    const { first, last } = splitName(id.name || '');
    const v = {
      first,
      last,
      bio: String(id.bio || ''),
      username: cleanUsername(id.username || ''),
      pronouns: String(id.pronouns || ''),
      link: String(id.website || id.link || ''),
      about: String(id.about || id.recado || ''),
    };
    const cv = normalizeCoverUrl(String(id.cover_url || id.coverUrl || '')); // [capa-2026-10-19]
    initialRef.current = { values: v, cover: cv };
    draftRef.current = { ...v };
    setValues(v);
    setCover(cv);
    setAvatarUri('');
    setErrors({});
    setUname({ q: '', state: '', text: '' });
    setSaving(false);
    setSeq((n) => n + 1);
    setSession((n) => (n || 0) + 1);
    setOn(true);
    return true;
  }, [enabled]);

  // silent = true → fecha sem avisar onClosed (quem chamou vai navegar).
  const close = useCallback((silent) => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setOn(false);
    setErrors({});
    if (silent !== true) { try { ctxRef.current.onClosed?.(); } catch {} }
  }, []);

  /** Botão voltar do Android: subtela do @ fecha antes; senão = Cancelar. */
  const back = useCallback(() => { setBackSeq((n) => n + 1); }, []);

  const checkUsername = useCallback((raw) => {
    const q = cleanUsername(raw);
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const init = initialRef.current.values.username || '';
    if (!q || q === init) { setUname({ q, state: '', text: '' }); return; }
    if (q.length < 3) { setUname({ q, state: 'bad', text: tr('profileEdit.usernameShort', 'Mínimo de 3 caracteres.') }); return; }
    setUname({ q, state: 'checking', text: tr('profileEdit.usernameChecking', 'Verificando…') });
    const my = ++checkReq.current;
    checkTimer.current = setTimeout(async () => {
      let r = null;
      try { r = await api.usernameCheck(q); } catch { r = null; }
      if (my !== checkReq.current) return;
      if (r?.success) {
        const ok = !!r.data?.available;
        const reason = r.data?.reason || '';
        const text = ok
          ? tr('profileEdit.usernameAvailable', '@{u} está disponível.').replace('{u}', q)
          : reason === 'taken' ? tr('profile.usernameTaken', 'Esse @ já está em uso')
            : reason === 'reserved' ? tr('profile.usernameReserved', 'Esse @ é reservado')
              : reason === 'too_short' ? tr('profileEdit.usernameShort', 'Mínimo de 3 caracteres.')
                : tr('profile.usernameInvalid', 'Indisponível');
        setUname({ q, state: ok ? 'ok' : 'bad', text });
      } else {
        setUname({ q, state: '', text: '' });
      }
    }, 400);
  }, [tr]);

  const pickAvatar = useCallback(async () => {
    if (busyAvatar) return;
    let a = null;
    try { a = await pickImage(t, [1, 1]); } catch (e) { setErrors((x) => ({ ...x, general: e?.message || tr('common.networkError', 'Erro de rede') })); return; }
    if (!a) return;
    const file = { uri: a.uri, name: 'avatar.jpg', type: 'image/jpeg' };
    setAvatarUri(a.uri);
    setBusyAvatar(true);
    setErrors((x) => ({ ...x, general: '' }));
    try {
      const r = await api.uploadAvatar(file);
      if (!r?.success) {
        setAvatarUri('');
        setErrors((x) => ({ ...x, general: r?.message || tr('profile.photoUploadFailed', 'Falha ao enviar foto') }));
      } else {
        try { ctxRef.current.onAvatarChanged?.(); } catch {}
      }
    } catch (e) {
      setAvatarUri('');
      setErrors((x) => ({ ...x, general: e?.message || tr('common.networkError', 'Erro de rede') }));
    } finally {
      setBusyAvatar(false);
    }
  }, [busyAvatar, t, tr]);

  const pickCover = useCallback(async () => {
    if (busyCover) return;
    let a = null;
    try { a = await pickImage(t, [3, 1]); } catch (e) { setErrors((x) => ({ ...x, general: e?.message || tr('common.networkError', 'Erro de rede') })); return; }
    if (!a) return;
    const prev = cover;
    // [capa-2026-10-19] prévia otimista + JPEG ≤1600 px (HEIC/PNG/12 MP → JPEG leve).
    setCover(a.uri);
    setBusyCover(true);
    setErrors((x) => ({ ...x, general: '' }));
    try {
      const file = (await prepareCoverFile(a)) || { uri: a.uri, name: 'cover.jpg', type: 'image/jpeg' };
      const r = await api.uploadCover(file);
      if (r?.success && r?.data?.cover_url) {
        const url = normalizeCoverUrl(String(r.data.cover_url));
        setCover(url);
        // O upload já grava a capa no perfil — atualiza o cabeçalho na hora,
        // mesmo se a pessoa fechar o editor sem tocar em Salvar.
        initialRef.current = { ...initialRef.current, cover: url };
        try { ctxRef.current.onSaved?.({ cover_url: url }); } catch {}
      } else {
        setCover(prev);
        setErrors((x) => ({ ...x, general: r?.message || tr('profile.coverUploadFailed', 'Falha ao enviar capa') }));
      }
    } catch (e) {
      setCover(prev);
      setErrors((x) => ({ ...x, general: e?.message || tr('common.networkError', 'Erro de rede') }));
    } finally {
      setBusyCover(false);
    }
  }, [busyCover, cover, t, tr]);

  const save = useCallback(async (vals) => {
    if (saving) return;
    const v = { ...draftRef.current, ...(vals || {}) };
    const name = `${String(v.first || '').trim()} ${String(v.last || '').trim()}`.trim();
    const username = cleanUsername(v.username);
    const init = initialRef.current;
    const errs = {};
    if (!name) errs.first = tr('profileEdit.errName', 'Informe seu nome.');
    if (username && username.length < 3) errs.username = tr('profileEdit.usernameShort', 'Mínimo de 3 caracteres.');
    else if (username && username !== init.values.username && uname.q === username && uname.state === 'bad') {
      errs.username = uname.text || tr('profile.usernameNotAvailable', 'Esse @ não está disponível');
    }
    const link = String(v.link || '').trim();
    if (link && (!/\./.test(link) || /\s/.test(link))) errs.link = tr('profileEdit.errLink', 'Link inválido.');
    if (Object.keys(errs).length) { setErrors(errs); return; }
    if (busyAvatar || busyCover) { setErrors({ general: tr('profileEdit.waitUpload', 'Aguarde o envio da foto terminar.') }); return; }
    const payload = {
      name,
      username,
      bio: String(v.bio || '').trim(),
      website: link,
      pronouns: String(v.pronouns || '').trim(),
      about: String(v.about || '').trim(),
    };
    if ((cover || '') !== (init.cover || '')) payload.cover_url = cover || '';
    setErrors({});
    setSaving(true);
    try {
      const r = await api.updateProfile(payload);
      if (r?.success) {
        const next = { ...payload };
        delete next.cover_url;
        if (payload.cover_url !== undefined) next.cover_url = payload.cover_url;
        try { ctxRef.current.onSaved?.(next); } catch {}
        setSaving(false);
        close();
        return;
      }
      const msg = String(r?.message || tr('profile.saveFailed', 'Não foi possível salvar'));
      setErrors(/@/.test(msg) ? { username: msg } : { general: msg });
    } catch (e) {
      setErrors({ general: e?.message || tr('common.networkError', 'Erro de rede') });
    }
    setSaving(false);
  }, [saving, uname, cover, busyAvatar, busyCover, tr, close]);

  const askDiscard = useCallback(() => {
    Alert.alert(
      tr('profile.discardTitle', 'Descartar alterações?'),
      tr('profile.discardMessage', 'Suas mudanças serão perdidas.'),
      [
        { text: tr('profile.keepEditing', 'Continuar editando'), style: 'cancel' },
        { text: tr('common.discard', 'Descartar'), style: 'destructive', onPress: () => close() },
      ],
    );
  }, [tr, close]);

  const onEdit = useCallback((ev) => {
    const type = String(ev?.type || '');
    switch (type) {
      case 'change': {
        const field = String(ev.field || '');
        if (!field) return;
        draftRef.current[field] = String(ev.value ?? '');
        if (field === 'username') checkUsername(ev.value);
        setErrors((x) => {
          if (!x[field] && !x.general) return x;
          const n = { ...x };
          delete n[field];
          delete n.general;
          return n;
        });
        return;
      }
      case 'done':
        save(ev.values || {});
        return;
      case 'cancel': {
        const dirty = !!ev.dirty || (cover || '') !== (initialRef.current.cover || '');
        if (saving) return;
        if (dirty) askDiscard(); else close();
        return;
      }
      case 'avatar':
        pickAvatar();
        return;
      case 'cover':
        pickCover();
        return;
      case 'coverRemove':
        setCover('');
        return;
      case 'row':
        try { ctxRef.current.onRow?.(String(ev.id || '')); } catch {}
        return;
      default:
    }
  }, [checkUsername, save, cover, saving, askDiscard, close, pickAvatar, pickCover]);

  const edit = useMemo(() => {
    if (!session) return null;
    const id = identity || {};
    const email = String(id.email || '');
    const nm = String(id.name || id.username || email.split('@')[0] || '');
    const pic = { i: initialsOf(nm, email), g: gradientIndex(nm || email || '') };
    if (avatarUri) {
      pic.u = avatarUri;
    } else {
      const ref = email ? avatarRefForEmail(email, nm, 'full') : null;
      if (ref && ref.uri) {
        pic.u = ref.uri;
        if (ref.headers && (ref.headers.Authorization || ref.headers.authorization)) pic.a = 1;
      }
    }
    const abs = typeof ctx.abs === 'function' ? ctx.abs : (u) => u;
    const cu = cover ? (/^(file|content|ph|assets-library):/i.test(cover) ? cover : abs(cover)) : '';
    const phone = String(id.phone || id.verified_phone || '').trim();
    const contactRows = [];
    if (email) contactRows.push({ id: 'email', title: tr('editProfile.email', 'E-mail'), val: email, nav: false });
    contactRows.push({ id: 'phone', title: tr('editProfile.phone', 'Telefone'), val: phone || tr('profileEdit.phoneAdd', 'Adicionar'), nav: true });
    const groups = [
      { header: tr('editProfile.contactInfo', 'Contato'), footer: tr('profileEdit.contactFooter', 'Para trocar o número, vá em Configurações › Conta.'), rows: contactRows },
      {
        header: tr('profileEdit.visibility', 'Visibilidade'),
        footer: tr('profileEdit.visibilityFooter', 'Escolha quem vê sua foto, recado, número e visto por último.'),
        rows: [{ id: 'privacy', title: tr('profileEdit.privacy', 'Privacidade'), val: '', nav: true }],
      },
      { header: '', footer: '', rows: [{ id: 'more', title: tr('profileEdit.moreOptions', 'Links extras e tipo de conta'), val: '', nav: true }] },
    ];
    // [perfil-fotos 2026-10-19] galeria de fotos (Telegram) + publicar no perfil → ctx.onRow.
    try {
      const PP = require('../../services/profilePhotos');
      const ppRows = [];
      if (PP.isProfileGalleryEnabled()) ppRows.push({ id: 'pp_add', title: PP.ppT(t, 'addPhoto'), val: '', nav: true });
      if (PP.isProfilePostsCiEnabled()) ppRows.push({ id: 'pp_publish', title: PP.ppT(t, 'publish'), val: '', nav: true });
      if (ppRows.length) groups.splice(0, 0, { header: PP.ppT(t, 'photos'), footer: PP.ppT(t, 'addPhotoHint'), rows: ppRows });
    } catch {}
    return {
      on,
      seq,
      backSeq,
      values,
      pic,
      cover: cu ? { u: cu, a: /\/api\//.test(cu) ? 1 : 0 } : null,
      busyAvatar,
      busyCover,
      saving,
      errors,
      uname,
      presets: [
        tr('profile.aboutPresetAvailable', 'Disponível'),
        tr('profile.aboutPresetBusy', 'Ocupado'),
        tr('profile.aboutPresetUrgent', 'Só urgências'),
        tr('profile.aboutPresetRush', 'Na correria'),
      ],
      groups,
      limits: LIMITS,
      labels: {
        cancel: tr('common.cancel', 'Cancelar'),
        done: tr('common.done', 'Concluído'),
        title: '',
        setPhoto: tr('profileEdit.setPhoto', 'Definir nova foto'),
        firstPh: tr('profileEdit.firstPh', 'Nome (obrigatório)'),
        lastPh: tr('profileEdit.lastPh', 'Sobrenome (opcional)'),
        nameFooter: tr('profileEdit.nameFooter', 'Insira seu nome e adicione uma foto de perfil.'),
        bioPh: tr('profileEdit.bioPh', 'Bio'),
        bioHint: tr('profileEdit.bioHint', 'Você pode adicionar algumas linhas sobre você. Quem abrir seu perfil verá este texto.'),
        username: tr('profileEdit.username', 'Usuário'),
        usernameEmpty: tr('profileEdit.usernameEmpty', 'Definir'),
        usernameTitle: tr('profileEdit.usernameTitle', 'Nome de usuário'),
        usernamePh: tr('profile.usernamePh', 'usuario'),
        usernameHint: tr('profileEdit.usernameHint', 'Você pode escolher um nome de usuário no Chatyy. Assim, as pessoas encontram você por @usuário sem precisar do seu número.\n\nUse a–z, 0–9, ponto e sublinhado. Mínimo de 3 caracteres.'),
        usernameShort: tr('profileEdit.usernameShort', 'Mínimo de 3 caracteres.'),
        usernameChecking: tr('profileEdit.usernameChecking', 'Verificando…'),
        back: tr('common.back', 'Voltar'),
        pronouns: tr('profile.pronouns', 'Pronomes'),
        pronounsPh: tr('profileEdit.pronounsPh', 'ela/dela'),
        link: tr('profileEdit.link', 'Link'),
        linkPh: tr('profileEdit.linkPh', 'seusite.com'),
        about: tr('profile.about', 'Recado'),
        aboutPh: tr('profile.aboutPh', 'Disponível'),
        aboutHint: tr('profileEdit.aboutHint', 'Uma frase curta que aparece junto do seu nome.'),
        cover: tr('profileEdit.cover', 'Foto de capa'),
        coverChange: tr('profileEdit.coverChange', 'Alterar'),
        coverAdd: tr('profileEdit.coverAdd', 'Adicionar'),
        coverRemove: tr('profileEdit.coverRemove', 'Remover foto de capa'),
        errName: tr('profileEdit.errName', 'Informe seu nome.'),
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, on, seq, backSeq, values, avatarUri, cover, busyAvatar, busyCover, saving, errors, uname, identity, tr]);

  return { active: on, start, edit, onEdit, back, close };
}
