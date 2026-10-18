// [2026-10-15 settings-split] Nativo: require() síncrono — o Metro só AVALIA o
// módulo da categoria no 1º uso (sem fallback do Suspense piscando).
export const LOADERS = {
  account: () => require('./AccountCategory'),
  privacy: () => require('./PrivacyCategory'),
  chat: () => require('./ChatsCategory'),
  appearance: () => require('./AppearanceCategory'), // [2026-10-18 me-merge]
  notifications: () => require('./NotificationsCategory'),
  storage_data: () => require('./StorageCategory'),
  accessibility: () => require('./AccessibilityCategory'),
  language: () => require('./LanguageCategory'),
  email: () => require('./EmailCategory'),
  bia: () => require('./BiaCategory'),
  help: () => require('./HelpCategory'),
  invite: () => require('./InviteCategory'),
};
export const ASYNC = false;
