// [2026-10-07 welcome] Copy for the welcome carousel, first-run flow and the
// smart chat-list empty state. Kept local (pt / en / es) instead of touching
// the 50+ i18n bundles — i18n is already ~53% of the JS bundle and those files
// are shared with other in-flight work. Unknown languages fall back to pt-BR.
import { useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';

export const INVITE_URL = 'https://chatyy.com.br/baixar';

const PT = {
  'welcome.value': 'Conversas, chamadas e e-mail.\nTudo num app só.',
  'welcome.start': 'Começar',
  'welcome.haveAccount': 'Já tenho conta',
  'welcome.terms': 'Ao continuar, você concorda com os Termos e a Política de Privacidade.',
  'welcome.s1.title': 'Mensagens na hora',
  'welcome.s1.sub': 'Texto, voz, fotos e vídeos — com aviso de entregue e lido.',
  'welcome.s2.title': 'Voz e vídeo',
  'welcome.s2.sub': 'Ligue para quem você quiser, no celular ou no computador.',
  'welcome.s3.title': 'E-mail e Drive',
  'welcome.s3.sub': 'Seu endereço @chatyy.com.br e seus arquivos, no mesmo lugar.',
  'welcome.swipeHint': 'Deslize para conhecer',

  'fr.skip': 'Pular',
  'fr.continue': 'Continuar',
  'fr.done': 'Concluir',
  'fr.notNow': 'Agora não',
  'fr.stepOf': 'Etapa {n} de {total}',
  'fr.profile.title': 'Seu perfil',
  'fr.profile.sub': 'É assim que seus amigos vão te ver no Chatyy.',
  'fr.profile.namePh': 'Seu nome',
  'fr.profile.addPhoto': 'Adicionar foto',
  'fr.profile.changePhoto': 'Trocar foto',
  'fr.profile.nameShort': 'Digite pelo menos 2 letras.',
  'fr.profile.saveFail': 'Não foi possível salvar agora. Você pode ajustar depois em Configurações.',
  'fr.friends.title': 'Encontre seus amigos',
  'fr.friends.sub': 'Veja quem da sua agenda já está no Chatyy.',
  'fr.friends.privacy': 'Seus contatos são enviados como código criptográfico (hash), usados só para encontrar quem já usa o Chatyy e não ficam guardados. Você pode desligar quando quiser em Configurações › Privacidade.',
  'fr.friends.cta': 'Encontrar amigos',
  'fr.friends.searching': 'Procurando…',
  'fr.friends.found': '{n} contatos já estão no Chatyy',
  'fr.friends.foundOne': '1 contato já está no Chatyy',
  'fr.friends.none': 'Ninguém da sua agenda está aqui ainda. Que tal convidar?',
  'fr.friends.denied': 'Sem acesso aos contatos. Você pode ativar depois em Nova conversa.',
  'fr.friends.invite': 'Convidar amigos',
  'fr.notif.title': 'Não perca nenhuma mensagem',
  'fr.notif.sub': 'Ative as notificações para receber mensagens e chamadas mesmo com o Chatyy fechado.',
  'fr.notif.cta': 'Ativar notificações',
  'fr.notif.on': 'Notificações ativadas',
  'fr.look.title': 'Do seu jeito',
  'fr.look.sub': 'Escolha a aparência. Dá para mudar em Configurações.',
  'fr.look.system': 'Automático',
  'fr.look.light': 'Claro',
  'fr.look.dark': 'Escuro',
  'fr.look.backup': 'Backup das conversas',
  'fr.look.backupSub': 'Guarde suas conversas no iCloud ou Google Drive.',

  'empty.title': 'Comece a conversar',
  'empty.sub': 'Suas conversas vão aparecer aqui.',
  'empty.onChatyy': 'Já estão no Chatyy',
  'empty.findFriends': 'Encontrar amigos da agenda',
  'empty.findFriendsSub': 'Veja quem você conhece que já usa o Chatyy',
  'empty.newChat': 'Nova conversa',
  'empty.invite': 'Convidar',
  'empty.inviteMsg': 'Vem conversar comigo no Chatyy! Baixe aqui: {url}',
  'empty.inviteCopied': 'Link copiado. É só colar e enviar.',
  'empty.savedTitle': 'Mensagens salvas',
  'empty.savedSub': 'Anote ideias, links e arquivos só para você.',
  'empty.message': 'Conversar',
};

const EN = {
  'welcome.value': 'Chats, calls and email.\nAll in one app.',
  'welcome.start': 'Get started',
  'welcome.haveAccount': 'I already have an account',
  'welcome.terms': 'By continuing you agree to the Terms and Privacy Policy.',
  'welcome.s1.title': 'Instant messages',
  'welcome.s1.sub': 'Text, voice, photos and videos — with delivered and read receipts.',
  'welcome.s2.title': 'Voice and video',
  'welcome.s2.sub': 'Call anyone, from your phone or your computer.',
  'welcome.s3.title': 'Email and Drive',
  'welcome.s3.sub': 'Your @chatyy.com.br address and your files, in one place.',
  'welcome.swipeHint': 'Swipe to explore',
  'fr.skip': 'Skip',
  'fr.continue': 'Continue',
  'fr.done': 'Done',
  'fr.notNow': 'Not now',
  'fr.stepOf': 'Step {n} of {total}',
  'fr.profile.title': 'Your profile',
  'fr.profile.sub': 'This is how your friends will see you on Chatyy.',
  'fr.profile.namePh': 'Your name',
  'fr.profile.addPhoto': 'Add photo',
  'fr.profile.changePhoto': 'Change photo',
  'fr.profile.nameShort': 'Type at least 2 letters.',
  'fr.profile.saveFail': "Couldn't save right now. You can change it later in Settings.",
  'fr.friends.title': 'Find your friends',
  'fr.friends.sub': 'See who from your contacts is already on Chatyy.',
  'fr.friends.privacy': 'Your contacts are sent as a cryptographic code (hash), used only to find who already uses Chatyy, and are not stored. You can turn this off anytime in Settings › Privacy.',
  'fr.friends.cta': 'Find friends',
  'fr.friends.searching': 'Searching…',
  'fr.friends.found': '{n} contacts are already on Chatyy',
  'fr.friends.foundOne': '1 contact is already on Chatyy',
  'fr.friends.none': 'None of your contacts are here yet. Invite them?',
  'fr.friends.denied': 'No access to contacts. You can enable it later in New chat.',
  'fr.friends.invite': 'Invite friends',
  'fr.notif.title': 'Never miss a message',
  'fr.notif.sub': 'Turn on notifications to get messages and calls even when Chatyy is closed.',
  'fr.notif.cta': 'Turn on notifications',
  'fr.notif.on': 'Notifications on',
  'fr.look.title': 'Make it yours',
  'fr.look.sub': 'Pick a look. You can change it in Settings.',
  'fr.look.system': 'Automatic',
  'fr.look.light': 'Light',
  'fr.look.dark': 'Dark',
  'fr.look.backup': 'Chat backup',
  'fr.look.backupSub': 'Keep your chats safe in iCloud or Google Drive.',
  'empty.title': 'Start chatting',
  'empty.sub': 'Your conversations will show up here.',
  'empty.onChatyy': 'Already on Chatyy',
  'empty.findFriends': 'Find friends from contacts',
  'empty.findFriendsSub': 'See who you know that already uses Chatyy',
  'empty.newChat': 'New chat',
  'empty.invite': 'Invite',
  'empty.inviteMsg': "Let's chat on Chatyy! Download it here: {url}",
  'empty.inviteCopied': 'Link copied. Just paste and send.',
  'empty.savedTitle': 'Saved messages',
  'empty.savedSub': 'Keep notes, links and files just for you.',
  'empty.message': 'Message',
};

const ES = {
  'welcome.value': 'Chats, llamadas y correo.\nTodo en una sola app.',
  'welcome.start': 'Empezar',
  'welcome.haveAccount': 'Ya tengo cuenta',
  'welcome.terms': 'Al continuar, aceptas los Términos y la Política de Privacidad.',
  'welcome.s1.title': 'Mensajes al instante',
  'welcome.s1.sub': 'Texto, voz, fotos y videos — con aviso de entregado y leído.',
  'welcome.s2.title': 'Voz y video',
  'welcome.s2.sub': 'Llama a quien quieras, desde el celular o la computadora.',
  'welcome.s3.title': 'Correo y Drive',
  'welcome.s3.sub': 'Tu dirección @chatyy.com.br y tus archivos, en un solo lugar.',
  'welcome.swipeHint': 'Desliza para conocer',
  'fr.skip': 'Omitir',
  'fr.continue': 'Continuar',
  'fr.done': 'Listo',
  'fr.notNow': 'Ahora no',
  'fr.stepOf': 'Paso {n} de {total}',
  'fr.profile.title': 'Tu perfil',
  'fr.profile.sub': 'Así te verán tus amigos en Chatyy.',
  'fr.profile.namePh': 'Tu nombre',
  'fr.profile.addPhoto': 'Agregar foto',
  'fr.profile.changePhoto': 'Cambiar foto',
  'fr.profile.nameShort': 'Escribe al menos 2 letras.',
  'fr.profile.saveFail': 'No se pudo guardar ahora. Puedes cambiarlo luego en Ajustes.',
  'fr.friends.title': 'Encuentra a tus amigos',
  'fr.friends.sub': 'Mira quién de tu agenda ya está en Chatyy.',
  'fr.friends.privacy': 'Tus contactos se envían como código criptográfico (hash), solo para encontrar quién ya usa Chatyy, y no se guardan. Puedes desactivarlo cuando quieras en Ajustes › Privacidad.',
  'fr.friends.cta': 'Encontrar amigos',
  'fr.friends.searching': 'Buscando…',
  'fr.friends.found': '{n} contactos ya están en Chatyy',
  'fr.friends.foundOne': '1 contacto ya está en Chatyy',
  'fr.friends.none': 'Nadie de tu agenda está aquí todavía. ¿Los invitas?',
  'fr.friends.denied': 'Sin acceso a contactos. Puedes activarlo luego en Nuevo chat.',
  'fr.friends.invite': 'Invitar amigos',
  'fr.notif.title': 'No te pierdas ningún mensaje',
  'fr.notif.sub': 'Activa las notificaciones para recibir mensajes y llamadas aunque Chatyy esté cerrado.',
  'fr.notif.cta': 'Activar notificaciones',
  'fr.notif.on': 'Notificaciones activadas',
  'fr.look.title': 'A tu manera',
  'fr.look.sub': 'Elige la apariencia. Puedes cambiarla en Ajustes.',
  'fr.look.system': 'Automático',
  'fr.look.light': 'Claro',
  'fr.look.dark': 'Oscuro',
  'fr.look.backup': 'Copia de seguridad',
  'fr.look.backupSub': 'Guarda tus chats en iCloud o Google Drive.',
  'empty.title': 'Empieza a chatear',
  'empty.sub': 'Tus conversaciones aparecerán aquí.',
  'empty.onChatyy': 'Ya están en Chatyy',
  'empty.findFriends': 'Encontrar amigos de la agenda',
  'empty.findFriendsSub': 'Mira quién conoces que ya usa Chatyy',
  'empty.newChat': 'Nuevo chat',
  'empty.invite': 'Invitar',
  'empty.inviteMsg': '¡Chateemos en Chatyy! Descárgalo aquí: {url}',
  'empty.inviteCopied': 'Enlace copiado. Solo pégalo y envíalo.',
  'empty.savedTitle': 'Mensajes guardados',
  'empty.savedSub': 'Guarda ideas, enlaces y archivos solo para ti.',
  'empty.message': 'Mensaje',
};

const DICTS = { pt: PT, en: EN, es: ES };

export function onbCopy(language, key, vars) {
  const lang = String(language || 'pt').slice(0, 2).toLowerCase();
  const d = DICTS[lang] || PT;
  let s = d[key] ?? PT[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

/** Hook: returns c(key, vars) bound to the current app language.
 *  Looks up `welcomeFlow.<key>` in the i18n bundles first (pt-BR/en/es carry
 *  the keys); falls back to the local dictionaries above for any language
 *  that lacks them (t() returns the key literal when missing). */
export function useOnbCopy() {
  let language = 'pt';
  let t = null;
  try { const l = useLanguage(); language = l?.language || 'pt'; t = l?.t || null; } catch {}
  return useCallback((key, vars) => {
    const full = 'welcomeFlow.' + key;
    let v = null;
    try { v = t ? t(full) : null; } catch { v = null; }
    if (typeof v === 'string' && v && v !== full) {
      if (vars) for (const k of Object.keys(vars)) v = v.split('{' + k + '}').join(String(vars[k]));
      return v;
    }
    return onbCopy(language, key, vars);
  }, [language, t]);
}

/** For tooling: the pt/en/es dictionaries (used to seed the i18n bundles). */
export const ONB_DICTS = DICTS;
