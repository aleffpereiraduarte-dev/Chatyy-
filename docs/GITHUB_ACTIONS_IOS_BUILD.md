# Tutorial — iOS Build + TestFlight 100% automático via GitHub Actions

> **Pra quem é**: Devs do SuperBora, BoraUm, GSP (e qualquer outro app Expo/iOS) que querem replicar o pipeline que tá funcionando no Chatyy.
>
> **O que ele faz**: Você dá `git push`, e em ~12 minutos o build aparece no TestFlight do iPhone. Sem Mac local, sem MacStadium, sem clicar em nada.
>
> **Custo**: ~$0.30 por build no GitHub Actions (macOS runner $0.16/min × ~12 min). Se fizer 30 builds/mês, dá ~$10. MacStadium cobra $60-100/mês fixo. **Cancela o Mac.**

---

## Como o pipeline funciona

```
git push  ─►  GitHub Actions (macOS runner)
                │
                ├─ Restaura cert + profiles dos GitHub Secrets
                ├─ Cria keychain temporário, importa .p12
                ├─ npx expo prebuild (gera ios/)
                ├─ Patch ShareExtension signing (se tiver)
                ├─ pod install
                ├─ xcodebuild archive  →  Chatyy.xcarchive
                ├─ xcodebuild -exportArchive  →  build.ipa
                ├─ eas-cli submit  →  TestFlight
                └─ git commit buildNumber++  →  push de volta no repo
```

**Por que não usar `eas build --local`?** Porque tem um bug com keychain temporário que faz o import do .p12 falhar silenciosamente. Documentado [aqui](https://github.com/expo/eas-cli/issues/1331). Bypass: `xcodebuild` direto.

---

## Pré-requisitos (você precisa ter ANTES de começar)

1. **Repositório no GitHub** (privado pode, recomendado)
2. **Apple Developer account ativa** ($99/ano)
3. **App já criado no App Store Connect** com Bundle ID registrado
4. **ASC API Key (.p8)** com role "Developer" ou maior — gera em [App Store Connect → Users and Access → Keys](https://appstoreconnect.apple.com/access/api)
5. **Cert "Apple Distribution"** + **Provisioning Profile(s)** já criados no [Apple Developer Portal](https://developer.apple.com/account/resources/certificates/list)
6. **Expo account + projeto Expo** (se for app Expo)

---

## PASSO 1 — Exportar o cert "Apple Distribution" como .p12

> **Onde**: precisa rodar num Mac com o cert + private key instalados no keychain. Pode ser o seu Mac local ou o Mac de build do time.

### 1.1 — Encontrar o cert válido

```bash
security find-identity -v -p codesigning
```

Você quer o que tem `"Apple Distribution: <Seu Nome> (<TEAM_ID>)"`. **NÃO use** "iPhone Distribution" (legacy, foi descontinuado pela Apple em 2026).

Anota o nome completo do cert.

### 1.2 — Exportar como .p12 (formato moderno primeiro)

```bash
# Substitua "Apple Distribution: XYZ" pelo nome exato que apareceu acima
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 \
  -P "senhaqualquer123" \
  -o /tmp/dist-modern.p12
```

> Se der `0 items exported`, é porque o cert não tem private key associada. Você não exportou o cert original — provavelmente importou só o `.cer`. Refaz o CSR e baixa um novo cert.

### 1.3 — Reencriptar em formato legacy (CRÍTICO)

O `security` do macOS no GitHub runner **não aceita** `.p12` com encryption moderno (AES-256). Precisa converter pra PBE-SHA1-3DES:

```bash
# Extrair cert + key em PEM
openssl pkcs12 -in /tmp/dist-modern.p12 -passin pass:senhaqualquer123 -nodes -out /tmp/extracted.pem

# Baixar Apple WWDR cert (intermediate)
curl -fsSL -o /tmp/wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
openssl x509 -inform DER -in /tmp/wwdr.cer -out /tmp/wwdr.pem

# Concatenar (cert + key + WWDR) — embedando o WWDR já evita um problema futuro
cat /tmp/extracted.pem /tmp/wwdr.pem > /tmp/combined.pem

# Reencriptar em legacy mode
openssl pkcs12 -export \
  -in /tmp/combined.pem \
  -out /tmp/dist-legacy.p12 \
  -passout pass:senhaqualquer123 \
  -name "Apple Distribution: <SEU NOME EXATO>" \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -macalg SHA1 \
  -legacy

# Limpar temporários
rm /tmp/extracted.pem /tmp/combined.pem /tmp/dist-modern.p12 /tmp/wwdr.cer /tmp/wwdr.pem
```

Verifica se ficou certo:

```bash
openssl pkcs12 -in /tmp/dist-legacy.p12 -info -passin pass:senhaqualquer123 -nokeys -legacy 2>&1 | head -5
# Deve mostrar:
# MAC: sha1, Iteration 2048
# PKCS7 Encrypted data: pbeWithSHA1And3-KeyTripleDES-CBC
```

Se mostrar `AES-256-CBC`, repete o passo. **Tem que ser PBE-SHA1-3DES.**

---

## PASSO 2 — Baixar os Provisioning Profiles

No [Apple Developer Portal → Profiles](https://developer.apple.com/account/resources/profiles/list), você vai ter:
- 1 profile pra **app principal** (bundle ID `com.suaempresa.app`)
- 1 profile pra **cada extension/widget** se houver (ex: `com.suaempresa.app.share-extension`)

Baixa cada `.mobileprovision` e abre num editor pra confirmar:

```bash
# Pra cada profile baixado:
security cms -D -i ~/Downloads/SeuProfile.mobileprovision | grep -A1 -E "Name|UUID|application-identifier|ExpirationDate"
```

**Anote o UUID de cada profile** — vai usar mais tarde.

---

## PASSO 3 — Encodar tudo em base64

GitHub Secrets só aceitam texto. Vamos converter os arquivos binários:

```bash
base64 -w0 /tmp/dist-legacy.p12 > /tmp/IOS_DIST_CERT_P12_BASE64.txt
base64 -w0 ~/Downloads/SeuProfileMain.mobileprovision > /tmp/IOS_PROFILE_MAIN_BASE64.txt
base64 -w0 ~/Downloads/SeuProfileShareExt.mobileprovision > /tmp/IOS_PROFILE_SHAREEXT_BASE64.txt
base64 -w0 /caminho/pro/asc_key.p8 > /tmp/ASC_KEY_P8_BASE64.txt

# Verificar tamanhos (todos devem ter algumas KB, não vazio)
wc -c /tmp/IOS_*.txt /tmp/ASC_KEY_P8_BASE64.txt
```

> **No Mac**: `base64 -w0` não funciona — usa `base64` simples que já vem em uma linha só.

---

## PASSO 4 — Adicionar 5 GitHub Secrets

Vai em `https://github.com/<owner>/<repo>/settings/secrets/actions/new` e adiciona:

| Nome do Secret | Valor |
|---|---|
| `EXPO_TOKEN` | Token do Expo. Gera em https://expo.dev/settings/access-tokens |
| `IOS_DIST_CERT_P12_BASE64` | Cole o conteúdo de `/tmp/IOS_DIST_CERT_P12_BASE64.txt` |
| `IOS_DIST_CERT_PASSWORD` | A senha que você definiu no passo 1.3 (`senhaqualquer123` no exemplo) |
| `IOS_PROFILE_MAIN_BASE64` | Cole `/tmp/IOS_PROFILE_MAIN_BASE64.txt` |
| `IOS_PROFILE_SHAREEXT_BASE64` | Cole `/tmp/IOS_PROFILE_SHAREEXT_BASE64.txt` (ou pula se não tiver share extension) |
| `ASC_KEY_P8_BASE64` | Cole `/tmp/ASC_KEY_P8_BASE64.txt` |

Quando terminar, **apaga os arquivos**:

```bash
rm /tmp/IOS_*.txt /tmp/ASC_KEY_P8_BASE64.txt /tmp/dist-legacy.p12
```

---

## PASSO 5 — Adicionar o plugin de manual signing

Se você usa Expo, o config plugin que força manual signing fica em `plugins/withManualIosSigning.js`:

```js
// plugins/withManualIosSigning.js
const { withXcodeProject } = require('@expo/config-plugins');

const SIGNING = {
  // SUBSTITUA pelos UUIDs dos seus profiles (passo 2)
  'com.suaempresa.app': {
    profile: 'UUID-DO-PROFILE-MAIN-AQUI',
  },
  'com.suaempresa.app.share-extension': {
    profile: 'UUID-DO-PROFILE-SHAREEXT-AQUI',
  },
};

const TEAM_ID = 'XYZ1234567'; // Seu Apple Team ID
const SIGN_IDENTITY = 'Apple Distribution';

module.exports = function withManualIosSigning(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const configs = proj.pbxXCBuildConfigurationSection();

    for (const key in configs) {
      const bc = configs[key];
      if (!bc || !bc.buildSettings) continue;
      const settings = bc.buildSettings;
      const bundleId = (settings.PRODUCT_BUNDLE_IDENTIFIER || '').replace(/"/g, '');
      const hit = SIGNING[bundleId];
      if (!hit) continue;
      settings.CODE_SIGN_STYLE = 'Manual';
      settings.DEVELOPMENT_TEAM = TEAM_ID;
      settings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = `"${SIGN_IDENTITY}"`;
      settings.CODE_SIGN_IDENTITY = `"${SIGN_IDENTITY}"`;
      settings.PROVISIONING_PROFILE_SPECIFIER = `"${hit.profile}"`;
      settings.PROVISIONING_PROFILE = `"${hit.profile}"`;
    }
    return cfg;
  });
};
```

E adiciona no `app.json`:

```json
{
  "expo": {
    "plugins": [
      "...",
      "./plugins/withManualIosSigning.js"
    ]
  }
}
```

---

## PASSO 6 — Adicionar o workflow

Cria `.github/workflows/ios-build.yml` (copia o do Chatyy e ajusta as variáveis no topo):

```yaml
name: iOS Build (auto-TestFlight)

on:
  workflow_dispatch:
    inputs:
      submit:
        description: 'Submit to TestFlight after build?'
        required: true
        default: 'true'
        type: choice
        options: ['true', 'false']
  push:
    paths:
      - '.github/triggers/ios-build.txt'
      # Pode adicionar outros paths aqui se quiser builds automáticos:
      # - 'app/**'
      # - 'components/**'

permissions:
  contents: write

jobs:
  build:
    runs-on: macos-latest
    timeout-minutes: 90
    env:
      # ⚙️ AJUSTE ESTAS VARIÁVEIS PRO SEU APP
      KEYCHAIN_NAME: meuapp-build.keychain-db
      KEYCHAIN_PASS: ci-build-pass
      MAIN_PROFILE_UUID: COLE-O-UUID-DO-MAIN-AQUI
      SHAREEXT_PROFILE_UUID: COLE-O-UUID-DO-SHAREEXT-AQUI
      TEAM_ID: SEU_TEAM_ID
      MAIN_BUNDLE_ID: com.suaempresa.app
      SHAREEXT_BUNDLE_ID: com.suaempresa.app.share-extension
      APP_NAME: NomeDoApp  # nome que vira o .xcworkspace após prebuild
      # ⚙️ FIM DA CUSTOMIZAÇÃO

    steps:
      - name: Sanity check secrets
        run: |
          missing=()
          [ -z "${{ secrets.EXPO_TOKEN }}" ] && missing+=("EXPO_TOKEN")
          [ -z "${{ secrets.IOS_DIST_CERT_P12_BASE64 }}" ] && missing+=("IOS_DIST_CERT_P12_BASE64")
          [ -z "${{ secrets.IOS_DIST_CERT_PASSWORD }}" ] && missing+=("IOS_DIST_CERT_PASSWORD")
          [ -z "${{ secrets.IOS_PROFILE_MAIN_BASE64 }}" ] && missing+=("IOS_PROFILE_MAIN_BASE64")
          [ -z "${{ secrets.ASC_KEY_P8_BASE64 }}" ] && missing+=("ASC_KEY_P8_BASE64")
          if [ ${#missing[@]} -gt 0 ]; then
            echo "::error::Missing GitHub Secrets: ${missing[*]}"
            exit 1
          fi

      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: maxim-lobanov/setup-xcode@v1
        with: { xcode-version: latest-stable }

      - run: npm ci --no-audit --no-fund

      - name: Install Apple WWDR + root certs
        run: |
          curl -fsSL -o /tmp/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
          curl -fsSL -o /tmp/AppleIncRootCertificate.cer https://www.apple.com/appleca/AppleIncRootCertificate.cer
          security import /tmp/AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -T /usr/bin/security || true
          security import /tmp/AppleIncRootCertificate.cer -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -T /usr/bin/security || true

      - name: Create keychain + import distribution cert
        env:
          P12_B64: ${{ secrets.IOS_DIST_CERT_P12_BASE64 }}
          P12_PASS: ${{ secrets.IOS_DIST_CERT_PASSWORD }}
        run: |
          KP="$HOME/Library/Keychains/$KEYCHAIN_NAME"
          security delete-keychain "$KP" 2>/dev/null || true
          security create-keychain -p "$KEYCHAIN_PASS" "$KP"
          security set-keychain-settings -lut 21600 "$KP"
          security unlock-keychain -p "$KEYCHAIN_PASS" "$KP"
          security list-keychains -d user -s "$KP" ~/Library/Keychains/login.keychain-db
          echo "$P12_B64" | base64 -d > /tmp/dist.p12
          security import /tmp/dist.p12 -k "$KP" -P "$P12_PASS" -T /usr/bin/codesign -T /usr/bin/security -A
          rm /tmp/dist.p12
          security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASS" "$KP"
          security find-identity -v -p codesigning "$KP"

      - name: Install provisioning profiles
        env:
          MAIN_B64: ${{ secrets.IOS_PROFILE_MAIN_BASE64 }}
          SHAREEXT_B64: ${{ secrets.IOS_PROFILE_SHAREEXT_BASE64 }}
        run: |
          mkdir -p ~/Library/MobileDevice/Provisioning\ Profiles
          echo "$MAIN_B64" | base64 -d > ~/Library/MobileDevice/Provisioning\ Profiles/$MAIN_PROFILE_UUID.mobileprovision
          # Remove o bloco abaixo se seu app não tiver share extension
          if [ -n "$SHAREEXT_B64" ]; then
            echo "$SHAREEXT_B64" | base64 -d > ~/Library/MobileDevice/Provisioning\ Profiles/$SHAREEXT_PROFILE_UUID.mobileprovision
          fi

      - name: Bump build number
        id: bump
        run: |
          CURRENT=$(node -e "console.log(require('./app.json').expo.ios.buildNumber)")
          NEW=$((CURRENT + 1))
          node -e "
            const fs=require('fs');
            const p=require('./app.json');
            p.expo.ios.buildNumber=String($NEW);
            fs.writeFileSync('./app.json', JSON.stringify(p, null, 2) + '\n');
          "
          echo "build=$NEW" >> $GITHUB_OUTPUT

      - name: Expo prebuild
        run: npx expo prebuild --platform ios --no-install --clean

      # OPCIONAL: só se você tem ShareExtension. Se não tem, pula esse step.
      - name: Patch ShareExtension manual signing in pbxproj
        run: |
          node <<'EOF'
          const fs = require('fs');
          const path = `ios/${process.env.APP_NAME}.xcodeproj/project.pbxproj`;
          let txt = fs.readFileSync(path, 'utf8');
          const SHAREEXT_PROFILE = process.env.SHAREEXT_PROFILE_UUID;
          const TEAM = process.env.TEAM_ID;
          const SHAREEXT_BUNDLE = process.env.SHAREEXT_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          txt = txt.replace(
            new RegExp(`(buildSettings = \\{[^}]*?${SHAREEXT_BUNDLE}[^}]*?\\};)`, 'g'),
            (block) => {
              let cleaned = block
                .replace(/\s+CODE_SIGN_STYLE = [^;]+;/g, '')
                .replace(/\s+PROVISIONING_PROFILE = [^;]+;/g, '')
                .replace(/\s+PROVISIONING_PROFILE_SPECIFIER = [^;]+;/g, '')
                .replace(/\s+"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = [^;]+;/g, '')
                .replace(/\s+CODE_SIGN_IDENTITY = [^;]+;/g, '')
                .replace(/\s+DEVELOPMENT_TEAM = [^;]+;/g, '');
              const inject =
                `\n\t\t\t\tCODE_SIGN_STYLE = Manual;` +
                `\n\t\t\t\tDEVELOPMENT_TEAM = ${TEAM};` +
                `\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";` +
                `\n\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";` +
                `\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${SHAREEXT_PROFILE}";` +
                `\n\t\t\t\tPROVISIONING_PROFILE = "${SHAREEXT_PROFILE}";`;
              return cleaned.replace(/\s*\};$/, inject + '\n\t\t\t};');
            }
          );
          fs.writeFileSync(path, txt);
          EOF

      - name: Pod install
        run: cd ios && pod install --repo-update

      - name: Archive
        run: |
          KP="$HOME/Library/Keychains/$KEYCHAIN_NAME"
          security unlock-keychain -p "$KEYCHAIN_PASS" "$KP"
          cd ios
          xcodebuild -workspace "$APP_NAME.xcworkspace" \
            -scheme "$APP_NAME" \
            -configuration Release \
            -destination "generic/platform=iOS" \
            -archivePath "$RUNNER_TEMP/$APP_NAME.xcarchive" \
            CODE_SIGN_STYLE=Manual \
            DEVELOPMENT_TEAM="$TEAM_ID" \
            "OTHER_CODE_SIGN_FLAGS=--keychain=$KP" \
            archive

      - name: Export IPA
        run: |
          cat > /tmp/ExportOptions.plist <<EOF
          <?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
          <plist version="1.0">
          <dict>
            <key>method</key><string>app-store</string>
            <key>teamID</key><string>$TEAM_ID</string>
            <key>signingStyle</key><string>manual</string>
            <key>signingCertificate</key><string>Apple Distribution</string>
            <key>provisioningProfiles</key>
            <dict>
              <key>$MAIN_BUNDLE_ID</key><string>$MAIN_PROFILE_UUID</string>
              <key>$SHAREEXT_BUNDLE_ID</key><string>$SHAREEXT_PROFILE_UUID</string>
            </dict>
            <key>uploadBitcode</key><false/>
            <key>uploadSymbols</key><true/>
            <key>compileBitcode</key><false/>
          </dict>
          </plist>
          EOF
          KP="$HOME/Library/Keychains/$KEYCHAIN_NAME"
          security unlock-keychain -p "$KEYCHAIN_PASS" "$KP"
          xcodebuild -exportArchive \
            -archivePath "$RUNNER_TEMP/$APP_NAME.xcarchive" \
            -exportOptionsPlist /tmp/ExportOptions.plist \
            -exportPath "$RUNNER_TEMP/export" \
            "OTHER_CODE_SIGN_FLAGS=--keychain=$KP"
          cp "$RUNNER_TEMP/export"/*.ipa ./build.ipa

      - name: Submit to TestFlight
        if: ${{ github.event_name == 'push' || inputs.submit == 'true' }}
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
          ASC_KEY_B64: ${{ secrets.ASC_KEY_P8_BASE64 }}
        run: |
          echo "$ASC_KEY_B64" | base64 -d > ./asc_key.p8
          npx eas-cli submit --platform ios --profile production --path ./build.ipa --non-interactive
          rm ./asc_key.p8

      - uses: actions/upload-artifact@v4
        with:
          name: ios-build-${{ steps.bump.outputs.build }}
          path: ./build.ipa
          retention-days: 7

      - name: Commit bumped buildNumber
        if: ${{ success() && (github.event_name == 'push' || inputs.submit == 'true') }}
        run: |
          git config user.email "actions@github.com"
          git config user.name "github-actions[bot]"
          git add app.json
          if ! git diff --cached --quiet; then
            git commit -m "chore(ios): bump buildNumber to ${{ steps.bump.outputs.build }} [skip ci]"
            git pull --rebase origin ${GITHUB_REF_NAME} || true
            git push origin HEAD:${GITHUB_REF_NAME}
          fi

      - name: Cleanup
        if: always()
        run: |
          security delete-keychain "$HOME/Library/Keychains/$KEYCHAIN_NAME" 2>/dev/null || true
```

---

## PASSO 7 — Configurar `eas.json` (submit profile)

Adiciona no `eas.json`:

```json
{
  "submit": {
    "production": {
      "ios": {
        "appleId": "seu@email.com",
        "ascAppId": "1234567890",
        "appleTeamId": "XYZ1234567",
        "ascApiKeyId": "ABCDE12345",
        "ascApiKeyIssuerId": "xxxx-xxxx-xxxx-xxxx-xxxx",
        "ascApiKeyPath": "./asc_key.p8"
      }
    }
  }
}
```

Onde encontrar cada um:
- `ascAppId`: App Store Connect → seu app → App Information → Apple ID
- `appleTeamId`: Apple Developer → Membership → Team ID
- `ascApiKeyId`: App Store Connect → Users and Access → Keys → Key ID
- `ascApiKeyIssuerId`: Mesma página, no topo "Issuer ID"

---

## PASSO 8 — Primeiro build de teste

```bash
# Cria o trigger file
mkdir -p .github/triggers
date > .github/triggers/ios-build.txt

git add .github/ plugins/ app.json eas.json
git commit -m "feat: setup iOS auto-build via GitHub Actions"
git push
```

Vai em `https://github.com/<owner>/<repo>/actions` e acompanha o build. Demora ~12 min na primeira vez (Pods cache vazio).

Se der erro, **lê o `## Troubleshooting` abaixo**.

---

## Como disparar builds depois

### Build automático em qualquer push
Adiciona no `paths:` do workflow:
```yaml
on:
  push:
    paths:
      - 'app/**'
      - 'components/**'
      - 'package.json'
      - '.github/triggers/ios-build.txt'
```

Aí qualquer push em código nativo aciona build novo.

### Build manual sob demanda
Toca no trigger file:
```bash
date > .github/triggers/ios-build.txt
git add .github/triggers/ios-build.txt
git commit -m "trigger: iOS build"
git push
```

Ou dispara via UI: GitHub → Actions → "iOS Build" → Run workflow.

### Build manual SEM mandar pro TestFlight
GitHub → Actions → "iOS Build" → Run workflow → escolhe `submit: false` → Run.
Aí o `.ipa` fica disponível como artifact pra download.

---

## Troubleshooting

### `Distribution certificate hasn't been imported successfully`
Você ignorou o passo 1.3. O `.p12` tá em formato moderno (AES-256). **Repete o passo 1.3** com `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg SHA1 -legacy`.

### `MAC verification failed during PKCS12 import (wrong password?)`
Mesmo problema acima. Não é senha errada — é o formato.

### `ShareExtension requires a provisioning profile with the App Groups feature`
Você pulou o "Patch ShareExtension manual signing in pbxproj". Adiciona o step.

### `xcodebuild: error: Unknown build action 'NO'`
Você botou `-allowProvisioningUpdates NO` em algum lugar. Esse flag é booleano (sem valor). Tira `NO`.

### `No accounts found. Add an account in Accounts settings`
Apple ID não tá logado no Xcode da máquina. **Por isso usamos manual signing.** Verifica se o `withManualIosSigning.js` plugin tá no `app.json`.

### `Build number already used`
Apple não aceita reupload do mesmo `buildNumber`. O workflow já bumpa automaticamente. Se tá dando esse erro, é porque o commit do bump não foi feito (workflow falhou antes do step "Commit bumped buildNumber"). Bumpa manual no `app.json` e tenta de novo.

### `Missing GitHub Secrets: XYZ`
Você esqueceu de adicionar um secret. Volta no passo 4.

### TestFlight não recebeu o build mesmo com workflow verde
- Apple processa em 5-30 min, espera.
- Se passou de 1h, vê em [App Store Connect → TestFlight → Builds](https://appstoreconnect.apple.com/) se aparece com status "Invalid" — geralmente é `ITSAppUsesNonExemptEncryption` faltando no `Info.plist`. Adiciona no `app.json`:
```json
"infoPlist": {
  "ITSAppUsesNonExemptEncryption": false
}
```

---

## Custo real

Medições reais do Chatyy (build cheio com prebuild + pods + archive + submit):
- ~12 min × $0.16/min = **$1.92 por build**
- 30 builds/mês = **~$60**

> **Espera, não era $0.30?** Era a estimativa otimista. O número real depende do tamanho do projeto. Chatyy tem 80+ Pods, é grande. Apps menores (BoraUm, GSP) podem ser bem mais rápidos.

Comparativo:
- MacStadium M2 mini = $99/mês
- Mac dedicado (Mac Mini): $600 upfront + eletricidade + manutenção
- GitHub Actions: variável, paga só pelo que usa

**Vale a pena cancelar o Mac quando você faz menos de ~50 builds/mês.**

---

## Migração de outro app (SuperBora, BoraUm, GSP)

Se você já tem o app rodando com EAS Build cloud ou Mac local, a migração é:

1. **Não desativa nada antes de testar.** Faz o setup do GitHub Actions em paralelo.
2. **Roda 3-4 builds completos** no GitHub Actions e confirma que tudo funciona (TestFlight chega, buildNumber bumpa, etc).
3. **Só depois cancela o Mac/EAS cloud.**

Se um app tem ShareExtension, Widget, ou múltiplas extensions, **adiciona uma entrada no `withManualIosSigning.js` SIGNING object pra cada uma** + um step de "Patch X signing in pbxproj" no workflow + um secret `IOS_PROFILE_X_BASE64`.

---

## Referências

- [EAS Build local credentials docs](https://docs.expo.dev/app-signing/local-credentials/)
- [Apple WWDR Intermediate Certificates](https://www.apple.com/certificateauthority/)
- [eas-cli #1331 — keychain import bug que motivou o bypass](https://github.com/expo/eas-cli/issues/1331)
- Workflow do Chatyy (referência canônica): `.github/workflows/ios-build-local.yml` neste repo

---

## Suporte

Bateu qualquer erro fora dessa lista? Manda print + log do GitHub Actions pro Aleff. Ou abre um issue no repo do app com label `ci`.
