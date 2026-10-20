// [mural 2026-10-20] Textos do perfil novo (Telegram + Mural): pt-BR, pt-PT, en, es.
// Tabela local (mesmo padrão do ProfilePostProgress) — outros idiomas caem no en.
import { useCallback } from 'react';
import { useLanguage } from '../../../context/LanguageContext';

const S = {
  audio: { pt: 'Áudio', pp: 'Áudio', en: 'Audio', es: 'Audio' },
  video: { pt: 'Vídeo', pp: 'Vídeo', en: 'Video', es: 'Video' },
  profile: { pt: 'Perfil', pp: 'Perfil', en: 'Profile', es: 'Perfil' },
  search: { pt: 'Pesquisar', pp: 'Pesquisar', en: 'Search', es: 'Buscar' },
  message: { pt: 'Mensagem', pp: 'Mensagem', en: 'Message', es: 'Mensaje' },
  publish: { pt: 'Publicar', pp: 'Publicar', en: 'Post', es: 'Publicar' },
  edit: { pt: 'Editar', pp: 'Editar', en: 'Edit', es: 'Editar' },
  share: { pt: 'Compartilhar', pp: 'Partilhar', en: 'Share', es: 'Compartir' },
  back: { pt: 'Voltar', pp: 'Voltar', en: 'Back', es: 'Volver' },
  more: { pt: 'Mais opções', pp: 'Mais opções', en: 'More options', es: 'Más opciones' },
  bio: { pt: 'Bio', pp: 'Biografia', en: 'Bio', es: 'Biografía' },
  username: { pt: 'Nome de usuário', pp: 'Nome de utilizador', en: 'Username', es: 'Nombre de usuario' },
  phone: { pt: 'Celular', pp: 'Telemóvel', en: 'Mobile', es: 'Celular' },
  notifications: { pt: 'Notificações', pp: 'Notificações', en: 'Notifications', es: 'Notificaciones' },
  notifOn: { pt: 'Ativadas · toque para silenciar', pp: 'Ativadas · toque para silenciar', en: 'On · tap to mute', es: 'Activadas · toca para silenciar' },
  notifOff: { pt: 'Silenciadas · toque para ativar', pp: 'Silenciadas · toque para ativar', en: 'Muted · tap to unmute', es: 'Silenciadas · toca para activar' },
  mute8h: { pt: 'Silenciar por 8 horas', pp: 'Silenciar por 8 horas', en: 'Mute for 8 hours', es: 'Silenciar 8 horas' },
  mute1w: { pt: 'Silenciar por 1 semana', pp: 'Silenciar por 1 semana', en: 'Mute for 1 week', es: 'Silenciar 1 semana' },
  muteAlways: { pt: 'Silenciar sempre', pp: 'Silenciar sempre', en: 'Mute always', es: 'Silenciar siempre' },
  cancel: { pt: 'Cancelar', pp: 'Cancelar', en: 'Cancel', es: 'Cancelar' },
  favorites: { pt: 'Mensagens favoritas', pp: 'Mensagens com estrela', en: 'Starred messages', es: 'Mensajes destacados' },
  tabPosts: { pt: 'Publicações', pp: 'Publicações', en: 'Posts', es: 'Publicaciones' },
  tabMedia: { pt: 'Mídia', pp: 'Multimédia', en: 'Media', es: 'Multimedia' },
  tabLinks: { pt: 'Links', pp: 'Ligações', en: 'Links', es: 'Enlaces' },
  tabDocs: { pt: 'Docs', pp: 'Docs', en: 'Docs', es: 'Docs' },
  tabVoice: { pt: 'Voz', pp: 'Voz', en: 'Voice', es: 'Voz' },
  tabGroups: { pt: 'Grupos em comum', pp: 'Grupos em comum', en: 'Groups in common', es: 'Grupos en común' },
  grid: { pt: 'Grade', pp: 'Grelha', en: 'Grid', es: 'Cuadrícula' },
  list: { pt: 'Lista', pp: 'Lista', en: 'List', es: 'Lista' },
  postsSummary: { pt: '{n} publicações · {p} com foto · {t} de texto', pp: '{n} publicações · {p} com foto · {t} de texto', en: '{n} posts · {p} with photos · {t} text', es: '{n} publicaciones · {p} con foto · {t} de texto' },
  postsCount: { pt: '{n} publicações', pp: '{n} publicações', en: '{n} posts', es: '{n} publicaciones' },
  noPosts: { pt: 'Nenhuma publicação ainda', pp: 'Ainda sem publicações', en: 'No posts yet', es: 'Aún no hay publicaciones' },
  noPostsSelf: { pt: 'Escreva algo ou adicione uma foto para começar o seu mural.', pp: 'Escreva algo ou adicione uma fotografia para começar o seu mural.', en: 'Write something or add a photo to start your wall.', es: 'Escribe algo o añade una foto para empezar tu muro.' },
  whatsOnMind: { pt: 'No que você está pensando?', pp: 'Em que está a pensar?', en: "What's on your mind?", es: '¿Qué estás pensando?' },
  whoSees: { pt: 'Quem vê minhas publicações', pp: 'Quem vê as minhas publicações', en: 'Who sees my posts', es: 'Quién ve mis publicaciones' },
  whoSeesSub: { pt: 'Padrão para posts novos', pp: 'Predefinição para novas publicações', en: 'Default for new posts', es: 'Predeterminado para nuevas publicaciones' },
  audEveryone: { pt: 'Todos', pp: 'Todos', en: 'Everyone', es: 'Todos' },
  audContacts: { pt: 'Contatos', pp: 'Contactos', en: 'Contacts', es: 'Contactos' },
  audMe: { pt: 'Só eu', pp: 'Só eu', en: 'Only me', es: 'Solo yo' },
  conversation: { pt: 'Conversa', pp: 'Conversa', en: 'Chat', es: 'Chat' },
  privacy: { pt: 'Privacidade', pp: 'Privacidade', en: 'Privacy', es: 'Privacidad' },
  moreSection: { pt: 'Mais', pp: 'Mais', en: 'More', es: 'Más' },
  customNotif: { pt: 'Notificações personalizadas', pp: 'Notificações personalizadas', en: 'Custom notifications', es: 'Notificaciones personalizadas' },
  wallpaper: { pt: 'Papel de parede e som', pp: 'Imagem de fundo e som', en: 'Wallpaper and sound', es: 'Fondo de pantalla y sonido' },
  disappearing: { pt: 'Mensagens temporárias', pp: 'Mensagens temporárias', en: 'Disappearing messages', es: 'Mensajes temporales' },
  chatLock: { pt: 'Bloqueio da conversa', pp: 'Bloqueio da conversa', en: 'Chat lock', es: 'Bloqueo del chat' },
  off: { pt: 'Desativado', pp: 'Desativado', en: 'Off', es: 'Desactivado' },
  block: { pt: 'Bloquear {name}', pp: 'Bloquear {name}', en: 'Block {name}', es: 'Bloquear a {name}' },
  unblock: { pt: 'Desbloquear {name}', pp: 'Desbloquear {name}', en: 'Unblock {name}', es: 'Desbloquear a {name}' },
  report: { pt: 'Denunciar', pp: 'Denunciar', en: 'Report', es: 'Denunciar' },
  blockConfirm: { pt: 'Bloquear {name}? Essa pessoa não poderá mais ligar nem mandar mensagens.', pp: 'Bloquear {name}? Esta pessoa deixará de poder ligar ou enviar mensagens.', en: 'Block {name}? They will no longer be able to call or message you.', es: '¿Bloquear a {name}? Ya no podrá llamarte ni enviarte mensajes.' },
  reportConfirm: { pt: 'Denunciar {name}? As últimas mensagens serão enviadas para análise.', pp: 'Denunciar {name}? As últimas mensagens serão enviadas para análise.', en: 'Report {name}? Recent messages will be sent for review.', es: '¿Denunciar a {name}? Los últimos mensajes se enviarán para revisión.' },
  done: { pt: 'Pronto', pp: 'Feito', en: 'Done', es: 'Listo' },
  online: { pt: 'online', pp: 'online', en: 'online', es: 'en línea' },
  seenToday: { pt: 'visto por último hoje às {h}', pp: 'visto pela última vez hoje às {h}', en: 'last seen today at {h}', es: 'últ. vez hoy a las {h}' },
  seenYesterday: { pt: 'visto por último ontem às {h}', pp: 'visto pela última vez ontem às {h}', en: 'last seen yesterday at {h}', es: 'últ. vez ayer a las {h}' },
  seenDate: { pt: 'visto por último em {d}', pp: 'visto pela última vez a {d}', en: 'last seen {d}', es: 'últ. vez el {d}' },
  seenRecently: { pt: 'visto recentemente', pp: 'visto recentemente', en: 'last seen recently', es: 'visto recientemente' },
  addNote: { pt: 'Adicionar nota', pp: 'Adicionar nota', en: 'Add note', es: 'Añadir nota' },
  members: { pt: '{n} membros', pp: '{n} membros', en: '{n} members', es: '{n} miembros' },
  group: { pt: 'Grupo', pp: 'Grupo', en: 'Group', es: 'Grupo' },
  noMedia: { pt: 'Nenhuma mídia ainda', pp: 'Ainda sem multimédia', en: 'No media yet', es: 'Aún no hay multimedia' },
  noLinks: { pt: 'Nenhum link ainda', pp: 'Ainda sem ligações', en: 'No links yet', es: 'Aún no hay enlaces' },
  noDocs: { pt: 'Nenhum documento ainda', pp: 'Ainda sem documentos', en: 'No documents yet', es: 'Aún no hay documentos' },
  noVoice: { pt: 'Nenhuma mensagem de voz ainda', pp: 'Ainda sem mensagens de voz', en: 'No voice messages yet', es: 'Aún no hay mensajes de voz' },
  noGroups: { pt: 'Nenhum grupo em comum', pp: 'Sem grupos em comum', en: 'No groups in common', es: 'No hay grupos en común' },
  noConvMedia: { pt: 'Abra uma conversa com esta pessoa para ver o que vocês compartilharam.', pp: 'Abra uma conversa com esta pessoa para ver o que partilharam.', en: 'Start a chat with this person to see what you shared.', es: 'Abre un chat con esta persona para ver lo que compartieron.' },
  myMediaHint: { pt: 'As fotos e vídeos das suas publicações aparecem aqui.', pp: 'As fotografias e vídeos das suas publicações aparecem aqui.', en: 'Photos and videos from your posts show up here.', es: 'Las fotos y videos de tus publicaciones aparecen aquí.' },
  now: { pt: 'agora', pp: 'agora', en: 'now', es: 'ahora' },
  minutes: { pt: '{n} min', pp: '{n} min', en: '{n}m', es: '{n} min' },
  hours: { pt: '{n} h', pp: '{n} h', en: '{n}h', es: '{n} h' },
  yesterday: { pt: 'ontem', pp: 'ontem', en: 'yesterday', es: 'ayer' },
  days: { pt: '{n} d', pp: '{n} d', en: '{n}d', es: '{n} d' },
  weeks: { pt: '{n} sem', pp: '{n} sem', en: '{n}w', es: '{n} sem' },
  deletePost: { pt: 'Apagar publicação', pp: 'Eliminar publicação', en: 'Delete post', es: 'Eliminar publicación' },
  editCaption: { pt: 'Editar texto', pp: 'Editar texto', en: 'Edit text', es: 'Editar texto' },
  copyLink: { pt: 'Copiar link', pp: 'Copiar ligação', en: 'Copy link', es: 'Copiar enlace' },
  reportPost: { pt: 'Denunciar publicação', pp: 'Denunciar publicação', en: 'Report post', es: 'Denunciar publicación' },
  openChat: { pt: 'Abrir conversa', pp: 'Abrir conversa', en: 'Open chat', es: 'Abrir chat' },
  loadFailed: { pt: 'Não foi possível carregar. Toque para tentar de novo.', pp: 'Não foi possível carregar. Toque para tentar novamente.', en: "Couldn't load. Tap to try again.", es: 'No se pudo cargar. Toca para reintentar.' },
  notFound: { pt: 'Perfil não encontrado', pp: 'Perfil não encontrado', en: 'Profile not found', es: 'Perfil no encontrado' },
  pending: { pt: 'Publicando…', pp: 'A publicar…', en: 'Posting…', es: 'Publicando…' },
  failed: { pt: 'Falhou · toque', pp: 'Falhou · toque', en: 'Failed · tap', es: 'Falló · toca' },
  reasonSpam: { pt: 'Spam', pp: 'Spam', en: 'Spam', es: 'Spam' },
  reasonAbuse: { pt: 'Conteúdo impróprio', pp: 'Conteúdo impróprio', en: 'Inappropriate content', es: 'Contenido inapropiado' },
  reasonHarass: { pt: 'Assédio ou ameaça', pp: 'Assédio ou ameaça', en: 'Harassment or threat', es: 'Acoso o amenaza' },
  reported: { pt: 'Denúncia enviada. Obrigado.', pp: 'Denúncia enviada. Obrigado.', en: 'Report sent. Thank you.', es: 'Denuncia enviada. Gracias.' },
};

function _code(language) {
  const l = String(language || '').toLowerCase();
  if (l === 'pt-pt') return 'pp';
  if (l.startsWith('pt')) return 'pt';
  if (l.startsWith('es')) return 'es';
  if (!l) return 'pt';
  return 'en';
}

export function tgT(language, key, vars) {
  const row = S[key];
  let s = row ? (row[_code(language)] || row.pt) : key;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

/** const tr = useTgT(); tr('audio') */
export function useTgT() {
  const { language } = useLanguage() || {};
  return useCallback((key, vars) => tgT(language, key, vars), [language]);
}

export function useTgLang() {
  const { language } = useLanguage() || {};
  return language || 'pt-BR';
}

/** "2 h", "ontem", "3 d", "1 sem" (mockup) ou data curta. */
export function relTime(language, iso) {
  if (!iso) return '';
  let ms = NaN;
  try {
    const api = require('../../../services/api');
    const d = api.parseServerDate ? api.parseServerDate(iso) : new Date(iso);
    ms = d && d.getTime ? d.getTime() : NaN;
  } catch { ms = new Date(iso).getTime(); }
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms) / 1000;
  if (diff < 60) return tgT(language, 'now');
  if (diff < 3600) return tgT(language, 'minutes', { n: Math.floor(diff / 60) });
  if (diff < 86400) return tgT(language, 'hours', { n: Math.floor(diff / 3600) });
  if (diff < 2 * 86400) return tgT(language, 'yesterday');
  if (diff < 7 * 86400) return tgT(language, 'days', { n: Math.floor(diff / 86400) });
  if (diff < 5 * 7 * 86400) return tgT(language, 'weeks', { n: Math.floor(diff / (7 * 86400)) });
  try { return new Date(ms).toLocaleDateString(language || undefined, { day: 'numeric', month: 'short' }); } catch { return ''; }
}

/** presence {online, last_seen(unix s|iso)} → "online" / "visto por último hoje às 09:12". */
export function presenceLine(language, presence) {
  if (!presence) return '';
  if (presence.online) return tgT(language, 'online');
  const ls = presence.last_seen;
  if (ls == null || ls === '') return '';
  let d = null;
  if (typeof ls === 'number' || /^\d+$/.test(String(ls))) { const n = Number(ls); d = new Date(n < 1e12 ? n * 1000 : n); }
  else { try { d = new Date(ls); } catch { d = null; } }
  if (!d || !Number.isFinite(d.getTime())) return tgT(language, 'seenRecently');
  const loc = language || undefined;
  const hh = (() => { try { return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })();
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return tgT(language, 'seenToday', { h: hh });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return tgT(language, 'seenYesterday', { h: hh });
  let ds = '';
  try { ds = d.toLocaleDateString(loc, { day: 'numeric', month: 'short' }); } catch {}
  return tgT(language, 'seenDate', { d: ds });
}
