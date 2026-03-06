# OneMundo Mail — Guia de Desenvolvimento

Leia este arquivo INTEIRO antes de fazer qualquer mudanca.

## Onde fica o codigo

O codigo fonte fica em `/root/webmail-app`. E um app Expo (React Native + Web).

## Estrutura de pastas

```
/root/webmail-app/
  app/                  # Telas (cada .js = uma tela)
    _layout.js          # Stack navigator (registra todas as telas)
    index.js            # Splash/redirect
    login.js            # Login
    inbox.js            # Tela principal (email + sidebar)
    compose.js          # Escrever email
    read.js             # Ler email
    settings.js         # Configuracoes
    profile.js          # Perfil do usuario
    contacts.js         # Contatos
    meetings.js         # Lista de reunioes
    meeting-create.js   # Criar reuniao
    meeting-detail.js   # Detalhes reuniao
    meeting-recap.js    # Resumo AI da reuniao
    meet/[id].js        # Sala de video (WebRTC)
    chat.js             # Lista de conversas
    chat-conversation.js # Mensagens do chat
    chat-new.js         # Novo chat
    calendar.js         # Calendario
    event-detail.js     # Detalhes do evento
    files.js            # Gerenciador de arquivos
    documentos.js       # WebView pro Google Docs
    forgot.js           # Recuperar senha
    signup/             # Cadastro

  components/           # Componentes reutilizaveis
    Sidebar.js          # Sidebar esquerda (pastas, Quick Access, labels)
    Icons.js            # Todos os icones SVG do app
    ErrorBoundary.js    # Tratamento de erros
    OfflineNotice.js    # Banner offline
    NotificationToast.js # Toast de notificacao
    ContextMenu.js      # Menu de contexto (right-click)
    LabelPicker.js      # Seletor de labels/cores

  context/              # Contextos React (estado global)
    AuthContext.js      # Login/logout, JWT, multi-conta
    MailContext.js      # Estado dos emails
    ThemeContext.js     # Tema claro/escuro (usa: const { colors } = useTheme())
    LanguageContext.js  # Traducoes (usa: const { t } = useLanguage())
    BiometricContext.js # Bloqueio biometrico

  i18n/                 # Traducoes (SEMPRE editar os 3)
    pt-BR.js            # Portugues
    en.js               # Ingles
    es.js               # Espanhol

  services/             # Servicos
    api.js              # Chamadas API pro backend
    pushNotifications.js # Push Firebase
    meetingReminders.js  # Lembretes locais

  constants/
    theme.js            # Colors, Spacing, FontSize, BorderRadius, Shadow
```

## Como CRIAR uma tela nova

### Passo 1: Criar o arquivo da tela
Cria `app/nome-da-tela.js`:
```jsx
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
import { IconArrowLeft } from '../components/Icons';

export default function NomeDaTelaScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('chave.traducao')}</Text>
        <View style={{ flex: 1 }} />
      </View>
      {/* Conteudo aqui */}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    height: 56, paddingHorizontal: Spacing.sm, borderBottomWidth: 1,
  },
  headerBtn: { padding: Spacing.sm },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600' },
});
```

### Passo 2: Registrar no _layout.js
Abra `app/_layout.js` e adicione dentro do `<Stack>`:
```jsx
<Stack.Screen name="nome-da-tela" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
```

### Passo 3: Adicionar no sidebar (se quiser)
Abra `components/Sidebar.js` e ache o array de Quick Access (~linha 133):
```js
[
  { label: t('sidebar.meetings'), icon: IconFilm, route: '/meetings' },
  { label: t('sidebar.files'), icon: IconFolder, route: '/files' },
  { label: t('sidebar.messages'), icon: IconMessageSquare, route: '/chat' },
  { label: t('sidebar.calendar'), icon: IconCalendar, route: '/calendar' },
  { label: t('sidebar.documents'), icon: IconGlobe, route: '/documentos', color: '#4285f4' },
]
```
Adicione um novo item com `label`, `icon`, `route`, e `color` (opcional).

Se precisar de um icone novo, importe de `./Icons` (tem: IconInbox, IconSend, IconFolder, IconGlobe, IconFileText, IconCalendar, IconFilm, IconMessageSquare, IconSearch, IconSettings, etc.)

### Passo 4: Traducoes (OBRIGATORIO nos 3 arquivos)
Adicione a mesma chave nos 3 arquivos:

`i18n/pt-BR.js`:
```js
'sidebar.novacoisa': 'Nova Coisa',
```
`i18n/en.js`:
```js
'sidebar.novacoisa': 'New Thing',
```
`i18n/es.js`:
```js
'sidebar.novacoisa': 'Nueva Cosa',
```

### Passo 5: Navegar pra tela
De qualquer lugar no app:
```js
import { useRouter } from 'expo-router';
const router = useRouter();
router.push('/nome-da-tela');
```

## Como criar tela com WebView

Se a tela e so pra abrir um site dentro do app, use WebView:
```jsx
import { WebView } from 'react-native-webview';

// Dentro do componente, depois do header:
<WebView
  source={{ uri: 'https://url-do-site.com' }}
  style={{ flex: 1 }}
  sharedCookiesEnabled={true}
  javaScriptEnabled={true}
  domStorageEnabled={true}
/>
```
`react-native-webview` ja esta instalado no projeto.

Para web (Platform.OS === 'web'), use `<iframe>` em vez de `<WebView>`.

## Deploy (DEPOIS de fazer as mudancas)

### Rodar TODOS estes comandos em sequencia:
```bash
cd /root/webmail-app

# 1. Build web
NODE_ENV=production npx expo export --platform web

# 2. Deploy web pra producao
rsync -avz --delete --exclude='api/' --exclude='meet/' --exclude='data/' --exclude='docs/' --exclude='suporte/' /root/webmail-app/dist/ root@69.62.103.131:/var/www/mail/

# 3. OTA pra mobile (iOS + Android)
npx eas-cli update --branch production --environment production --message "descricao do que mudou" --non-interactive
```

**NUNCA pule o passo 2** — sem ele o site web nao atualiza.
**NUNCA pule o passo 3** — sem ele o app mobile nao atualiza.
**NUNCA delete api/, meet/, data/, docs/, ou suporte/ no servidor** — sao dados de producao.

## Coisas que NAO precisa fazer
- NAO precisa rodar `npm install` (ja tem node_modules)
- NAO precisa configurar credenciais (ja estao configuradas)
- NAO precisa criar backend PHP pra telas WebView
- NAO precisa fazer build nativo (eas build) pra mudancas JS — OTA basta
