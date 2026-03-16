# Chatyy Widgets

## iOS Widget (WidgetKit)
Para implementar, precisa criar um Widget Extension no Xcode:
1. Target > New Target > Widget Extension
2. Widget mostra: emails não lidos, próximo evento, mensagens novas
3. Usa App Groups para compartilhar dados com o app principal
4. Atualiza via TimelineProvider a cada 15 min

## Android Widget (Jetpack Glance)
1. Criar AppWidgetProvider
2. Widget mostra mesmas infos
3. Atualiza via WorkManager

## Como ativar:
Adicionar no app.json:
```json
"plugins": [
  ["expo-widgets", { "ios": { "src": "./widgets/ios" }, "android": { "src": "./widgets/android" } }]
]
```

Nota: expo-widgets está em beta (SDK 55). Precisa de build nativo.
