# OneMundo Mail — Project Instructions

## App Info
- **Name**: OneMundo Mail
- **Package**: `com.onemundo.mail`
- **Slug**: `webmail-app`
- **Expo SDK**: 55
- **Source**: `/root/webmail-app`

## Credentials & Accounts
- **Expo Account**: `aleffduarte` (already logged in on this server)
- **Expo Project ID**: `7175af93-5113-4bd7-85d7-1ae78e5762b4`
- **Apple ID**: `jsfkjcb@gmail.com`
- **Apple Team ID**: `XN9XN27QCE`
- **ASC App ID**: `6759975575`
- **ASC API Key ID**: `QSYM3KX73P`
- **ASC API Key Issuer**: `494360d0-0420-4f1f-a1db-6be19eeb2d89`
- **ASC API Key File**: `./asc_key.p8` (already exists in this directory)
- **Google Play SA Key**: `./gcloud-sa-key.json`
- **Firebase Project**: `onemundo-52ca6` (project number: 782929446226)
- **Firebase SA Key**: `/etc/onemundo-firebase-sa.json` (on production server 69.62.103.131)
- **Firebase Android Config**: `./google-services.json`
- **Firebase iOS Config**: `./GoogleService-Info.plist`

## OTA Update (EAS Update)

OTA = Over-The-Air update. Atualiza o app no celular do usuario SEM precisar publicar na App Store/Play Store. So funciona pra mudancas em JavaScript/assets (nao muda codigo nativo).

### Como publicar um OTA update:
```bash
cd /root/webmail-app
npx eas-cli update --branch production --environment production --message "descricao do que mudou" --non-interactive
```

Esse comando:
1. Faz bundle do JS (iOS + Android + Web)
2. Faz upload dos bundles pro Expo
3. Publica o update na branch `production`
4. Proximo vez que o usuario abrir o app, ele baixa o update automaticamente

### Como verificar se o OTA foi publicado:
```bash
# Listar os ultimos updates publicados
npx eas-cli update:list --branch production --non-interactive

# Ver detalhes de um update especifico
npx eas-cli update:view <update-group-id> --non-interactive
```

Tambem pode ver no dashboard web: https://expo.dev/accounts/aleffduarte/projects/webmail-app/updates

### Como reverter um OTA (rollback):
Se publicou um update com bug, pode reverter republishing a versao anterior:
```bash
# Republica o update - faz as mudancas no codigo e publica de novo
npx eas-cli update --branch production --environment production --message "rollback: revertendo bug X" --non-interactive
```

### Como deletar um update:
```bash
npx eas-cli update:delete <update-group-id> --non-interactive
```

### Notas importantes sobre OTA:
- SDK 55 EXIGE `--environment production` (sem isso da erro)
- Runtime version vem do `app.json` -> `version` (atualmente 1.3.0)
- Se mudar a versao no app.json, o OTA so chega em apps com aquela mesma runtime version
- OTA NAO funciona se mudar codigo nativo (nova dependencia nativa, novo plugin, etc.) -- precisa build novo
- O update e baixado em background. O usuario ve na PROXIMA abertura do app (nao na atual)
- O app mostra um splash/loading extra brevemente quando aplica o update

## Build Nativo (quando OTA nao basta)

Precisa build novo quando: adiciona/remove pacote nativo, muda plugin no app.json, muda permissoes, muda versao nativa, muda google-services.json / GoogleService-Info.plist.

### Build:
```bash
cd /root/webmail-app

# iOS (gera .ipa pra App Store / TestFlight)
npx eas-cli build --platform ios --profile production --non-interactive

# Android (gera .aab pra Play Store)
npx eas-cli build --platform android --profile production --non-interactive

# Ambos ao mesmo tempo
npx eas-cli build --platform all --profile production --non-interactive
```

### Ver status dos builds:
```bash
# Listar builds recentes
npx eas-cli build:list --non-interactive

# Ver build especifico
npx eas-cli build:view <build-id> --non-interactive
```

Dashboard de builds: https://expo.dev/accounts/aleffduarte/projects/webmail-app/builds

### Baixar o build (pra instalar manual ou submeter):
```bash
npx eas-cli build:download --id <build-id> --non-interactive
```

## Submit to Stores

Depois de fazer o build, submete pra loja:

### App Store / TestFlight (iOS):
```bash
# Submeter o build iOS mais recente pro TestFlight
npx eas-cli submit --platform ios --profile production --non-interactive
# Usa o asc_key.p8 pra autenticar automaticamente
# O build vai aparecer no TestFlight em ~10-30min apos processar
# Depois vai no App Store Connect (appstoreconnect.apple.com) pra submeter pra review (se quiser ir pra loja)
```

### Fluxo completo Build + TestFlight (copiar e colar):
```bash
cd /root/webmail-app

# 1. Build iOS
npx eas-cli build --platform ios --profile production --non-interactive

# 2. Pegar o Build ID do build que acabou de terminar
npx eas-cli build:list --platform ios --non-interactive
# Copiar o ID do build mais recente (ex: f8685540-9347-42de-bbce-fb4d31789082)

# 3. Submeter pro TestFlight (PRECISA do --id)
npx eas-cli submit --platform ios --profile production --id <BUILD_ID> --non-interactive

# Pronto! O build vai aparecer no TestFlight em ~5-10min.
# Usuarios com TestFlight instalado vao receber a atualizacao.
```

### Google Play (Android):
```bash
npx eas-cli submit --platform android --profile production --non-interactive
# Usa o gcloud-sa-key.json pra autenticar
# Vai pra track "production" no Play Console
```

## Web Deploy

O app tambem roda como web (SPA):

```bash
cd /root/webmail-app

# 1. Build web
NODE_ENV=production npx expo export --platform web
# Gera a pasta dist/

# 2. Deploy pra producao (servidor 69.62.103.131)
rsync -avz --delete --exclude='api/' --exclude='meet/' --exclude='data/' --exclude='docs/' --exclude='suporte/' /root/webmail-app/dist/ root@69.62.103.131:/var/www/mail/

# 3. Se mudou backend PHP tambem:
scp /var/www/mail/api/email.php root@69.62.103.131:/var/www/mail/api/email.php
scp /var/www/mail/api/meet.php root@69.62.103.131:/var/www/mail/api/meet.php
scp /var/www/mail/api/chat.php root@69.62.103.131:/var/www/mail/api/chat.php
scp /var/www/mail/api/calendar.php root@69.62.103.131:/var/www/mail/api/calendar.php
scp /var/www/mail/api/files.php root@69.62.103.131:/var/www/mail/api/files.php
```

### CUIDADOS com web deploy:
- Production server: `69.62.103.131` (servidor dedicado, SO pra OneMundo Mail)
- Production nginx root: `/var/www/mail/` (NAO e `/var/www/html/webmail/` -- isso e staging)
- **NUNCA deletar `data/`** -- tem SQLite DBs dos outros serviços (meetings.db, calendar.db, files.db) e arquivos dos usuarios. Chat já migrou pra PG — chat.db está arquivado como chat.db.archived-YYYYMMDD (não usar, não restaurar sem motivo).
- **NUNCA deletar `api/`** -- backend PHP
- **NUNCA deletar `meet/`** -- sala de videoconferencia WebRTC
- **NUNCA deletar `docs/`** -- sistema de documentos/planilhas (editor CKEditor + jspreadsheet)
- **NUNCA deletar `suporte/`** -- dashboard de suporte
- O rsync ja exclui essas pastas com --exclude

## Push Notifications (Firebase)

O app usa Firebase Cloud Messaging (FCM) pra push notifications.

### Como funciona:
- **Email**: Dovecot chama `/var/www/mail/api/push-notify.php` via Sieve pipe quando chega email novo
  - Usa Claude Haiku AI pra gerar resumo de 60 chars em portugues
  - Envia push via FCM com titulo (remetente) e body (resumo AI)
- **Chat**: `/var/www/mail/api/chat.php` envia push automaticamente quando recebe mensagem
  - Agrupa mensagens rapidas em 1 push so
  - Tambem usa Claude AI pra resumo quando tem multiplas mensagens
- **Reunioes**: Push de lembrete 5min antes de reunioes agendadas

### Firebase config files (ja no projeto):
- `google-services.json` -- Android (Firebase project onemundo-52ca6)
- `GoogleService-Info.plist` -- iOS (Firebase project onemundo-52ca6)
- Referenciados no `app.json` via `googleServicesFile`
- **IMPORTANTE**: Mudar esses arquivos e mudanca NATIVA -- precisa `eas build` novo, OTA nao basta

### Service Account (no servidor de producao 69.62.103.131):
- `/etc/onemundo-firebase-sa.json` -- chave do service account
- Permissoes: `chmod 640, chown root:www-data`
- Usado por `firebase_push.php` pra autenticar com FCM API v1

## Verificar Login do Expo
```bash
npx eas-cli whoami
# Deve retornar: aleffduarte
# Se nao estiver logado:
npx eas-cli login
# User: aleffduarte
# Senha: pedir pro Aleff
```

## Comandos Uteis
```bash
# Ver info do projeto
npx eas-cli project:info --non-interactive

# Ver credenciais configuradas
npx eas-cli credentials --non-interactive

# Limpar cache do Metro (se build/update der erro estranho)
npx expo start --clear

# Ver versao do EAS CLI
npx eas-cli --version
```

## Architecture
- Expo Router (file-based routing)
- Backend: PHP + IMAP at `/var/www/mail/api/` (production: 69.62.103.131)
- Backend APIs: email.php, meet.php, chat.php, calendar.php, files.php, push-notify.php, firebase_push.php
- SQLite DBs: meetings.db, calendar.db, files.db in `/var/www/mail/data/` (chat already migrated to PG — chat.db archived)
- Chat DB: PostgreSQL only — `chat_*` tables (chat_conversations, chat_messages, chat_conversation_members, chat_message_reactions, chat_starred_messages, chat_pinned_messages, chat_broadcast_lists, chat_live_locations, chat_user_privacy, chat_user_conv_settings, chat_user_privacy_contacts, chat_user_auto_reply, chat_user_defaults, chat_folders). Connection via `getPGDB()` in `/var/www/mail/api/db.php`.
- WebRTC signaling: port 8443 on production server (69.62.103.131)
- Staging server: 10.0.0.5 (this machine), nginx root `/var/www/html/webmail/`
- Firebase project: `onemundo-52ca6` (shared with BoraUm)

## Codebase Structure (IMPORTANT — read this before making changes)

O codigo fonte ESTA neste servidor em `/root/webmail-app`. NAO diga que nao tem acesso.

### Frontend Screens (`/root/webmail-app/app/`)
Cada arquivo .js na pasta `app/` e uma tela (Expo Router file-based routing):

| File | Screen | Description |
|------|--------|-------------|
| `index.js` | `/` | Splash/redirect (login or inbox) |
| `login.js` | `/login` | Login page (multi-account) |
| `signup/` | `/signup` | Registration flow |
| `forgot.js` | `/forgot` | Password recovery |
| `inbox.js` | `/inbox` | **Main screen** — email list + sidebar |
| `read.js` | `/read` | Read email (modal) |
| `compose.js` | `/compose` | Compose/reply/forward email |
| `settings.js` | `/settings` | App settings |
| `profile.js` | `/profile` | User profile |
| `contacts.js` | `/contacts` | Address book |
| `meetings.js` | `/meetings` | Meeting list |
| `meeting-create.js` | `/meeting-create` | Create meeting |
| `meeting-detail.js` | `/meeting-detail` | Meeting details |
| `meeting-recap.js` | `/meeting-recap` | AI meeting recap |
| `meet/[id].js` | `/meet/:id` | WebRTC video call room |
| `chat.js` | `/chat` | Chat conversations list |
| `chat-conversation.js` | `/chat-conversation` | Chat messages |
| `chat-new.js` | `/chat-new` | New chat conversation |
| `calendar.js` | `/calendar` | Calendar + events |
| `event-detail.js` | `/event-detail` | Event detail/edit |
| `files.js` | `/files` | File manager (drive) |
| `documentos.js` | `/documentos` | Docs WebView (`mail.onemundo.com.br/docs/`) |

### How to Add a New Screen
1. Create `app/nome-da-tela.js` with the screen component (export default)
2. Add `<Stack.Screen name="nome-da-tela" />` in `app/_layout.js`
3. If it should appear in sidebar: add entry to the Quick Access array in `components/Sidebar.js` (line ~133)
4. Add translation keys in `i18n/pt-BR.js`, `i18n/en.js`, `i18n/es.js`
5. Navigate to it: `router.push('/nome-da-tela')` (from `useRouter()`)

### Key Components (`/root/webmail-app/components/`)
- `Sidebar.js` — Left sidebar with folders, Quick Access (Meetings, Files, Chat, Calendar, Docs), labels
- `Icons.js` — SVG icon components (IconInbox, IconSend, IconFolder, IconGlobe, etc.)
- `ErrorBoundary.js` — Catches render errors
- `OfflineNotice.js` — Offline banner
- `NotificationToast.js` — Push notification toast
- `ContextMenu.js` — Right-click context menu for emails
- `LabelPicker.js` — Label color picker (LABEL_COLORS, LABEL_NAMES)

### Sidebar Quick Access Items
In `components/Sidebar.js`, the Quick Access section (~line 133) is an array:
```js
[
  { label: t('sidebar.meetings'), icon: IconFilm, route: '/meetings' },
  { label: t('sidebar.files'), icon: IconFolder, route: '/files' },
  { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat' },
  { label: t('sidebar.calendar'), icon: IconCalendar, route: '/calendar' },
  { label: t('sidebar.documents'), icon: IconGlobe, route: '/documentos', color: '#4285f4' },
]
```
To add a new sidebar item: add an entry here with `label`, `icon`, `route`, and optional `color`.

### Contexts (`/root/webmail-app/context/`)
- `AuthContext.js` — Login/logout, JWT token, multi-account switching
- `MailContext.js` — Email state (folders, selected emails, refresh)
- `ThemeContext.js` — Dark/light theme (`colors` object)
- `LanguageContext.js` — i18n (`t()` function, locale)
- `BiometricContext.js` — Biometric lock (auto-lock after 5s background)

### i18n (`/root/webmail-app/i18n/`)
- `pt-BR.js` — Portuguese (default)
- `en.js` — English
- `es.js` — Spanish
- Keys are flat strings like `'sidebar.documents': 'Documentos'`
- Used via `const { t } = useLanguage();` then `t('sidebar.documents')`
- **ALWAYS add keys to ALL 3 files** when adding new text

### Services (`/root/webmail-app/services/`)
- `api.js` — All API calls to backend (email, folders, etc.)
- `pushNotifications.js` — FCM push registration
- `meetingReminders.js` — Local notification scheduling

### Theme (`/root/webmail-app/constants/theme.js`)
- `Colors` (light), `DarkColors` (dark)
- `Spacing`, `FontSize`, `BorderRadius`, `Shadow`, `Transition`
- Access via `const { colors } = useTheme();`

### Dependencies Already Installed
- `react-native-webview` (13.16.0) — for WebView screens
- `expo-web-browser` — for opening external links
- `@anthropic-ai/sdk` — NOT installed (Claude AI is server-side only)
- Full list in `package.json`

## Fluxo Completo de Deploy (checklist)

### Mudanca so em JS/assets (mais comum):
1. Faz as mudancas no codigo
2. `NODE_ENV=production npx expo export --platform web` (build web)
3. `rsync -avz --delete --exclude='api/' --exclude='meet/' --exclude='data/' --exclude='docs/' --exclude='suporte/' dist/ root@69.62.103.131:/var/www/mail/` (deploy web)
4. `npx eas-cli update --branch production --environment production --message "descricao" --non-interactive` (OTA mobile)

### Mudanca nativa (novo pacote, plugin, permissao, firebase config):
1. Faz as mudancas
2. Deploy web (passos 2-3 acima)
3. `npx eas-cli build --platform all --profile production --non-interactive` (build nativo ~15-20min)
4. `npx eas-cli submit --platform ios --profile production --non-interactive` (TestFlight)
5. `npx eas-cli submit --platform android --profile production --non-interactive` (Play Store)
