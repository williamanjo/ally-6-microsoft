# Ally Microsoft Driver for AdonisJS 7

[![npm version](https://img.shields.io/npm/v/@williamanjo/ally-6-microsoft.svg)](https://www.npmjs.com/package/@williamanjo/ally-6-microsoft)
[![npm downloads](https://img.shields.io/npm/dm/@williamanjo/ally-6-microsoft.svg)](https://www.npmjs.com/package/@williamanjo/ally-6-microsoft)
[![license](https://img.shields.io/npm/l/@williamanjo/ally-6-microsoft.svg)](./LICENSE)
[![Certificate Auth](https://img.shields.io/badge/auth-client%20secret%20%7C%20certificate-blue.svg)](#authentication-methods)

Microsoft OAuth2 driver for AdonisJS 7 and Ally v6.
Supports authentication via **Microsoft Account**, **Azure AD**, and **Entra ID** — with two auth methods: **client secret** or **certificate (RS256 JWT)**.

> **Certificate authentication is the recommended method for production.** It avoids rotating secrets and is required by some enterprise Azure policies.

## Installation

```bash
npm install @williamanjo/ally-6-microsoft
```

## Configure

```bash
node ace configure @williamanjo/ally-6-microsoft
```

## Authentication methods

### Option A — Client secret (quick start)

Set these env vars:

```env
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxxxxx
MICROSOFT_CALLBACK_URL=http://localhost:3333/microsoft/callback
MICROSOFT_TENANT_ID=common
```

Register in `config/ally.ts`:

```ts
import { defineConfig } from '@adonisjs/ally'
import env from '#start/env'
import { microsoft } from '@williamanjo/ally-6-microsoft'

const allyConfig = defineConfig({
  microsoft: microsoft({
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    clientSecret: env.get('MICROSOFT_CLIENT_SECRET'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
    scopes: ['openid', 'profile', 'email', 'User.Read'],
  })
})

export default allyConfig
```

---

### Option B — Certificate authentication (recommended for production)

No rotating secrets. Uses a self-signed certificate uploaded to Azure — the driver signs each token request with an RS256 JWT (`client_assertion`).

#### 1. Generate certificate

```bash
# RSA private key
openssl genrsa -out private.key 2048

# Self-signed certificate (1 year)
openssl req -new -x509 -key private.key -out certificate.crt -days 365 \
  -subj "/CN=my-app-name"
```

**Windows (Git Bash):** prefix with `MSYS_NO_PATHCONV=1` to prevent path conversion of `/CN=`:
```bash
MSYS_NO_PATHCONV=1 openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "/CN=my-app-name"
```

**Windows (PowerShell):** use `//CN=` instead:
```powershell
openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "//CN=my-app-name"
```

#### 2. Extract the thumbprint

```bash
openssl x509 -in certificate.crt -fingerprint -sha1 -noout
# SHA1 Fingerprint=A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2
```

The driver accepts both formats — with or without colons.

#### 3. Upload to Azure Portal

1. **Azure Portal** → **App Registrations** → your app
2. **Certificates & secrets** → **Certificates** tab
3. Upload `certificate.crt` — confirm the thumbprint matches

#### 4. Set env vars

```env
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CALLBACK_URL=http://localhost:3333/microsoft/callback
MICROSOFT_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CERT_THUMBPRINT=A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2
MICROSOFT_CERT_PRIVATE_KEY=/etc/certs/private.key
```

> `MICROSOFT_CERT_PRIVATE_KEY` must be the **absolute path** to the key file on the server. Never put the key content directly in `.env`.

#### 5. Register the driver

```ts
import { defineConfig } from '@adonisjs/ally'
import env from '#start/env'
import { microsoft } from '@williamanjo/ally-6-microsoft'

const allyConfig = defineConfig({
  microsoft: microsoft({
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
    scopes: ['openid', 'profile', 'email', 'User.Read'],
    certificate: {
      privateKey: env.get('MICROSOFT_CERT_PRIVATE_KEY'),
      thumbprint: env.get('MICROSOFT_CERT_THUMBPRINT'),
    },
  })
})

export default allyConfig
```

> `clientSecret` is **required** unless `certificate` is provided. Passing neither throws at startup.

---

## Usage

```ts
import type { HttpContext } from '@adonisjs/core/http'

export default class AuthController {
  async redirect({ ally }: HttpContext) {
    return ally.use('microsoft').redirect()
  }

  async callback({ ally }: HttpContext) {
    const microsoft = ally.use('microsoft')

    if (microsoft.accessDenied()) return 'Access denied'
    if (microsoft.stateMisMatch()) return 'Request expired'
    if (microsoft.hasError()) return microsoft.getError()

    const user = await microsoft.user()

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatarUrl, // null by default — see fetchPhoto
    }
  }
}
```

## Routes

```ts
import router from '@adonisjs/core/services/router'

router.get('/microsoft/redirect', '#controllers/auth_controller.redirect')
router.get('/microsoft/callback', '#controllers/auth_controller.callback')
```

## Azure Portal setup

1. **App Registrations** → New registration
2. Add redirect URI: `http://localhost:3333/microsoft/callback`
3. Copy **Application (client) ID** and **Directory (tenant) ID**
4. Add either a **client secret** or upload a **certificate** under _Certificates & secrets_

## Options

### Profile photo (base64)

`user.avatarUrl` returns `null` by default. Enable with `fetchPhoto: true`:

```ts
microsoft({
  // ...
  fetchPhoto: true,
})
```

Returns a base64 data URI (`data:image/jpeg;base64,...`) or `null` if the user has no photo. Requires the `User.Read` scope (included by default).

The content-type returned by Microsoft Graph is validated against an allowlist (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) before the data URI is constructed. Any unexpected content-type returns `null`.

### Custom scopes

```ts
microsoft({
  // ...
  scopes: ['openid', 'profile', 'email', 'User.Read', 'offline_access'],
})
```

| Scope | Description |
|---|---|
| `openid` | Required for OAuth2 login |
| `profile` | Display name and basic profile |
| `email` | Email address |
| `User.Read` | Full profile of the signed-in user |
| `User.ReadBasic.All` | Basic profiles of all users |
| `offline_access` | Receive a refresh token |

## Supported features

- OAuth2 Authorization Code flow
- Microsoft Account, Azure AD, and Entra ID login
- **Client secret authentication**
- **Certificate authentication** (RS256 JWT `client_assertion`) — recommended for production
- Multi-tenant support via `tenantId`
- Profile photo as base64 data URI (opt-in)
- Standard Ally field mapping (`id`, `name`, `email`, `avatarUrl`, `original`)

## Requirements

- Node.js 18+
- AdonisJS 7+
- @adonisjs/ally v6

## License

MIT
