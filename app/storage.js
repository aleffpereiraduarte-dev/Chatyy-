// /storage — [2026-10-17 one-merge] "Armazenamento" e "Chatyy One" eram 2 telas
// com o mesmo conteúdo (plano, cota, uso, mudar plano, assinatura). Agora UMA
// tela só: app/settings-one.js (components/settings/SettingsPanels.js →
// ChatyyOnePanel: plano + barra de uso + Arquivos/Email/Chat/Feed + Mudar de
// plano + Liberar espaço + Assinatura + Pagamento). Esta rota continua válida
// (Drive "Comprar armazenamento", CTAs de cota cheia, links antigos) e abre a
// MESMA tela. Versão anterior: git show 135d017a:app/storage.js
export { default } from './settings-one';
