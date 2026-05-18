# OAuth Import Setup (Gmail / Outlook / Microsoft Graph)

The `/email-import` screen lets users pull recent emails from Gmail or
Microsoft 365 into Chatyy via OAuth + IMAP-APPEND. To activate the
buttons in production you need to:

1. Register OAuth clients with each provider.
2. Drop the client IDs into `app.json` (or set EAS secrets).
3. Re-deploy web + run `eas build` (native rebuild required because we
   added `expo-auth-session`, `expo-print`, and `openpgp` deps).

## 1. Google Cloud — Gmail readonly scope

1. Open https://console.cloud.google.com/apis/credentials
2. Project: create/select `chatyy-mail-import` (or reuse `onemundo-52ca6`).
3. **OAuth consent screen** → External; add the test email
   `apitest@onemundo.com.br` while in testing.
4. Scopes to add:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - (later: `https://www.googleapis.com/auth/gmail.modify` if you want
     mark-as-read sync)
5. **Credentials → Create credentials → OAuth client ID** — create 3 of
   them (one per platform):
   - Web application → Authorized JS origins: `https://chatyy.com.br`
     → Authorized redirect URIs: `https://chatyy.com.br/email-import`
   - iOS → Bundle ID: `com.onemundo.mail`
   - Android → Package name: `com.onemundo.mail`; SHA-1 from EAS
     `eas credentials -p android` → keystore fingerprint.
6. Copy the resulting client IDs into `app.json` under `expo.extra`:
   ```json
   "oauthGoogleClientIdWeb": "1234567890-abc.apps.googleusercontent.com",
   "oauthGoogleClientIdIos": "1234567890-ios.apps.googleusercontent.com",
   "oauthGoogleClientIdAndroid": "1234567890-and.apps.googleusercontent.com"
   ```
7. Submit for Google review when ready for production (gmail.readonly
   counts as a Sensitive Scope; expect 4–6 weeks).

## 2. Microsoft Azure — Mail.Read scope

1. Open https://portal.azure.com → Azure Active Directory → App
   registrations → **New registration**.
2. Name: `Chatyy Email Import`. Supported account types:
   *Accounts in any organizational directory and personal Microsoft
   accounts* (so outlook.com/hotmail/live work too).
3. Redirect URIs (add three):
   - Web: `https://chatyy.com.br/email-import`
   - Mobile/desktop: `com.onemundo.mail://oauth-redirect`
4. **Application (client) ID** → copy into `app.json`:
   ```json
   "oauthMicrosoftClientId": "00000000-0000-0000-0000-000000000000"
   ```
5. **API permissions → Add a permission → Microsoft Graph → Delegated**:
   - `Mail.Read`
   - `offline_access` (for refresh tokens once we add cron sync)
   - `User.Read` (default)
6. **Authentication → Implicit grant** → check **Access tokens** so the
   `response_type=token` flow works without the client secret.
7. Submit for verification when going public (Mail.Read also counts as
   a privileged scope — verification can take 1–2 weeks).

## 3. Backend env (production server `217.216.67.99`)

The dispatcher (`api/email-gaps.php`) doesn't currently require any
server-side secrets — token comes from the client. But two existing
env vars cover dependencies:

```
# /etc/mail-api.env (already configured)
TELNYX_API_KEY=...           # for pgp_send_passphrase_sms fallback
TELNYX_VERIFY_PROFILE_ID=...
```

## 4. Frontend deploy

Native rebuild is required because we added these JS deps that ship
TurboModules / large binaries:

| Dep                | Why                                          |
|--------------------|----------------------------------------------|
| `expo-auth-session` | Cleaner OAuth flow than WebBrowser fallback. |
| `expo-print`        | Native print support (AirPrint / spooler).   |
| `openpgp`           | PGP encrypt/decrypt + keypair generation.    |

```bash
cd /root/webmail-app
yarn install     # or npm install
scripts/ship.sh both "round 6 — OAuth import, PGP, tasks, bundles, print"
```

If you only want to ship the JS half (e.g. to show the new UI without
the live OAuth dance), publish OTA only — the screens will load and
report "OAuth client_id ausente" until you fill the IDs in app.json.

```bash
scripts/ship.sh ota "round 6 OTA preview"
```
