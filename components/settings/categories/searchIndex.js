// [2026-10-15 settings-split] Índice de busca das Configurações (estilo
// Ajustes do iOS): a raiz NÃO monta as categorias para buscar — procura neste
// catálogo leve (título traduzido + palavras-chave) e cada resultado abre a
// categoria certa (rolando até a âncora). Usado pela lista JS e enviado à
// lista nativa (que filtra do lado nativo).
import { Platform } from 'react-native';

// [cat, chave i18n do título, fallback, âncora?, palavras extras, plataforma?]
const ENTRIES = [
  ['account', 'settings.editProfile', 'Editar perfil', 'account', 'perfil profile foto photo nome name'],
  ['account', 'account.switch', 'Trocar conta', 'account', 'contas accounts'],
  ['account', null, 'Chatyy One', 'account', 'plano plan assinatura premium'],
  ['account', 'linkedPhones.title', 'Números', 'account', 'telefone phone'],
  ['account', 'settings.linkedDevices', 'Dispositivos conectados', 'account', 'aparelhos devices'],
  ['account', 'settings.exportData', 'Exportar dados', 'account', 'lgpd export'],
  ['account', 'profile.creatorDashboard', 'Painel do criador', 'account', 'creator'],
  ['account', 'settings.biometricLock', 'Bloqueio biométrico', 'security', 'face id touch id biometric digital', 'native'],
  ['account', 'settings.autoLockInterval', 'Bloqueio automático', 'security', 'auto lock', 'native'],
  ['account', 'settings.changePassword', 'Alterar senha', 'security', 'senha password'],
  ['account', 'settings.twoFactor', 'Verificação em duas etapas', 'security', '2fa pin', 'native'],
  ['account', 'settings.registrationLock', 'PIN de segurança', 'security', 'sim swap pin', 'native'],
  ['account', 'settings.changePhone', 'Alterar número de telefone', 'security', 'phone telefone', 'native'],
  ['account', 'settings.loginAlerts.history', 'Histórico de logins', 'security', 'login', 'native'],
  ['account', 'settings.activityLog', 'Histórico de atividades', 'security', 'activity atividade', 'native'],
  ['account', 'mod.myReports', 'Minhas denúncias', 'security', 'denúncia denuncia report moderação moderation'],
  ['account', 'settings.e2eBackup', 'Backup com criptografia', 'security', 'backup e2e chave key', 'native'],
  ['account', 'settings.backupKey.rotate', 'Redefinir senha do backup', 'security', 'backup', 'native'],
  ['account', 'settings.advancedKey', 'Chave avançada (BYOK)', 'security', 'byok', 'native'],
  ['account', 'settings.advancedPrivacy', 'Privacidade avançada', 'security', 'proxy tor vpn captura screenshot', 'native'],
  ['account', 'settings.rd2.family', 'Família', 'security', 'family', 'native'],
  ['account', 'settings.rd2.parental', 'Controle parental', 'security', 'parental filhos kids', 'native'],
  ['account', 'settings.emptyTrash', 'Esvaziar lixeira', null, 'trash lixeira'],
  ['account', 'settings.deleteAccount', 'Excluir conta', null, 'delete apagar conta'],
  ['privacy', 'settings.privacyLastSeen', 'Visto por último', 'privacy_granular', 'last seen online'],
  ['privacy', 'settings.privacyOnline', 'Online', 'privacy_granular', 'invisível invisible'],
  ['privacy', 'settings.privacyProfilePhoto', 'Foto do perfil', 'privacy_granular', 'photo'],
  ['privacy', 'settings.privacyAbout', 'Recado', 'privacy_granular', 'about'],
  ['privacy', 'privacy.phoneNumber', 'Número de telefone', 'privacy_granular', 'phone'],
  ['privacy', 'settings.privacyStatus', 'Status', 'privacy_granular', 'story stories'],
  ['privacy', 'settings.privacyGroups', 'Grupos', 'privacy_granular', 'groups'],
  ['privacy', 'settings.privacyReadReceipts', 'Confirmação de leitura', 'privacy_granular', 'read receipts visto azul'],
  ['privacy', 'settings.privacyCloseFriends', 'Melhores amigos', 'privacy_granular', 'close friends'],
  ['privacy', 'settings.privacyStatusExcept', 'Ocultar status de', 'privacy_granular', 'except'],
  ['privacy', 'settings.privacyKeepArchived', 'Manter conversas arquivadas', 'privacy_granular', 'archived arquivadas'],
  ['privacy', 'settings.blockUnknown', 'Bloquear desconhecidos', 'privacy_granular', 'unknown spam'],
  ['privacy', 'settings.blockedContacts', 'Contatos bloqueados', 'privacy_granular', 'blocked bloqueados'],
  ['privacy', 'settings.personalizationOffers', 'Personalização e ofertas', null, 'lgpd reels anúncios ads'],
  ['privacy', 'settings.defaultDisappearing', 'Mensagens temporárias', 'defaultDisappearing', 'disappearing temporárias'],
  ['chat', 'settings.theme.label', 'Tema', null, 'tema claro escuro sistema dark light theme aparência appearance'],
  ['chat', 'settings.accentColor', 'Cor de destaque', null, 'cor color accent'],
  ['chat', 'config.wallpaper', 'Papel de parede', null, 'wallpaper fundo'],
  ['chat', 'sidebar.backup', 'Backup', null, 'backup conversas'],
  ['chat', 'settings.enterSends.title', 'Enter envia mensagem', null, 'enter teclado'],
  ['chat', 'settings.autocorrect.title', 'Auto-correção', null, 'autocorrect'],
  ['chat', 'settings.doubleTapReact.title', 'Toque duplo para curtir', null, 'double tap coração'],
  ['chat', 'settings.voiceSpeed.title', 'Velocidade dos áudios', null, 'voice speed áudio'],
  ['chat', 'settings.bubble.title', 'Estilo dos balões', null, 'bubble balão'],
  ['chat', 'waImport.settingsRow', 'Importar do WhatsApp', null, 'whatsapp importar import'],
  ['chat', 'settings.mutedWords', 'Palavras silenciadas', 'mutedWords', 'muted mute silenciar feed'],
  ['chat', 'settings.dataSaver.title', 'Modo economia de dados', null, 'data saver economia'],
  ['chat', 'settings.beta.title', 'Recursos beta', null, 'beta'],
  ['notifications', 'settings.notificationsTitle', 'Notificações', null, 'push alertas todas urgentes silencioso'],
  ['notifications', 'settings.privacyHideReactions', 'Ocultar reações', null, 'reactions reações'],
  ['notifications', 'settings.rd2.muteCalls', 'Modo silencioso para ligações', null, 'toque ringtone ligação call'],
  ['notifications', 'settings.contactJoinedPush', 'Contatos que entraram', null, 'contatos joined'],
  ['notifications', 'settings.rd.advancedNotifs', 'Notificações avançadas', null, 'menções palavras-chave soneca'],
  ['notifications', 'settings.desktopNotifs', 'Notificações no navegador', 'notifications', 'desktop browser', 'web'],
  ['storage_data', 'storage.title', 'Armazenamento', 'mediaAutoDownload', 'storage nuvem cloud'],
  ['storage_data', 'settings.mediaAutoDownload', 'Download automático', 'mediaAutoDownload', 'auto-download fotos áudio vídeos documentos', 'native'],
  ['storage_data', 'settings.roaming.title', 'Permitir em roaming', 'mediaAutoDownload', 'roaming', 'native'],
  ['storage_data', 'settings.autoSaveGallery', 'Salvar na galeria', 'mediaAutoDownload', 'galeria gallery fotos', 'native'],
  ['storage_data', 'settings.mediaUploadQuality.title', 'Qualidade de envio de mídia', 'mediaAutoDownload', 'hd qualidade quality'],
  ['storage_data', 'settings.lowDataCalls.title', 'Usar menos dados em chamadas', 'mediaAutoDownload', 'chamadas calls dados'],
  ['storage_data', 'settings.storage.title', 'Uso do armazenamento', 'storage', 'cache armazenamento mídia', 'native'],
  ['storage_data', 'settings.storage.clearCache', 'Limpar cache', 'storage', 'cache limpar', 'native'],
  ['accessibility', 'settings.fontSize', 'Tamanho da fonte', 'reading', 'fonte font texto'],
  ['accessibility', 'quickSettings.density', 'Densidade', 'reading', 'density compacto'],
  ['language', 'settings.languageLabel', 'Idioma', 'language', 'language idioma'],
  ['language', 'settings.language.autoDetect', 'Seguir idioma do sistema', 'language', 'auto'],
  ['language', 'settings.currencyLabel', 'Moeda', 'language', 'currency moeda'],
  ['email', 'settings.undoSend', 'Desfazer envio', null, 'undo'],
  ['email', 'settings.perPage', 'E-mails por página', null, 'caixa de entrada inbox'],
  ['email', 'settings.notifications', 'Notificações de email', 'notifications', 'som vibração não perturbe dnd'],
  ['email', 'settings.dndTitle', 'Não perturbe', 'notifications', 'dnd horário silenciar'],
  ['email', 'settings.signatures', 'Assinaturas', null, 'assinatura signature'],
  ['email', 'settings.importFromOthers', 'Importar de outras contas', null, 'gmail outlook importar'],
  ['email', 'settings.pgpKeys', 'Chave PGP', null, 'pgp criptografia'],
  ['email', 'settings.tasks', 'Tarefas', null, 'tasks'],
  ['email', 'settings.autoReply', 'Resposta automática', 'vacation', 'férias vacation'],
  ['email', 'settings.filters', 'Filtros', 'vacation', 'filtros regras rules'],
  ['email', 'settings.ai', 'Recursos de IA', 'vacation', 'ia ai resposta inteligente resumo'],
  ['email', 'settings.smartCompose', 'Escrita inteligente', 'vacation', 'smart compose'],
  ['email', 'settings.emailReadReceipts', 'Confirmação de leitura de email', 'forwarding', 'leitura reading'],
  ['email', 'settings.forwarding', 'Encaminhamento', 'forwarding', 'forward encaminhar'],
  ['bia', 'settings.oneEnabled', 'Ativar Bia', null, 'bia assistente assistant one ai'],
  ['bia', 'settings.oneNotifPrefs', 'Avisos da Bia', null, 'bia avisos'],
  ['bia', 'settings.rd2.biaVoice', 'Tom, assinatura e estilo', null, 'bia tom estilo'],
  ['help', 'settings.help.contactSupport', 'Falar com o suporte', 'help', 'ajuda help suporte support'],
  ['help', 'settings.rd2.aboutApp', 'Sobre o Chatyy', 'help', 'sobre about versão version'],
  ['help', 'settings.update.title', 'Atualizar app', 'help', 'atualização update atualiza'],
  ['help', 'settings.privacyPolicy', 'Política de privacidade', 'help', 'legal privacy'],
  ['help', 'settings.termsOfService', 'Termos de uso', 'help', 'legal terms'],
  ['invite', 'referral.inviteFriends', 'Convidar amigos', null, 'convite invite referral indicação gb grátis'],
  ['invite', 'referral.yourCode', 'Seu código', null, 'código code'],
];

/** Normaliza p/ comparar: minúsculas, sem acentos. */
export function normalizeQuery(s) {
  let x = String(s || '').toLowerCase().trim();
  try { x = x.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch {}
  return x;
}

/** Índice traduzido: [{ id, cat, title, anchor, kw }]. */
export function buildSearchIndex(t) {
  const plat = Platform.OS === 'web' ? 'web' : 'native';
  const out = [];
  const seen = new Set();
  for (const [cat, key, fb, anchor, kw, only] of ENTRIES) {
    if (only && only !== plat) continue;
    let title = key ? t(key) : fb;
    if (!title || title === key) title = fb;
    const id = 'q:' + cat + ':' + (key || fb);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, cat, title: String(title), anchor: anchor || null, kw: kw || '' });
  }
  return out;
}

/** Filtro (lista JS): título, palavras-chave e o título da categoria. */
export function filterSearchIndex(index, query, catTitleOf) {
  const q = normalizeQuery(query);
  if (!q) return [];
  return index.filter((e) => {
    const hay = normalizeQuery(`${e.title} ${e.kw} ${catTitleOf ? catTitleOf(e.cat) : ''}`);
    return hay.includes(q);
  });
}
