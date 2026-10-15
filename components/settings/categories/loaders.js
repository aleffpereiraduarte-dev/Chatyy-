// [2026-10-15 settings-split] Web: import() → um chunk por categoria no
// export (fora do bundle principal da raiz).
export const LOADERS = {
  account: () => import('./AccountCategory'),
  privacy: () => import('./PrivacyCategory'),
  chat: () => import('./ChatsCategory'),
  notifications: () => import('./NotificationsCategory'),
  storage_data: () => import('./StorageCategory'),
  accessibility: () => import('./AccessibilityCategory'),
  language: () => import('./LanguageCategory'),
  email: () => import('./EmailCategory'),
  bia: () => import('./BiaCategory'),
  help: () => import('./HelpCategory'),
  invite: () => import('./InviteCategory'),
};
export const ASYNC = true;
