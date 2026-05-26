# Ally Microsoft Driver for AdonisJS 7

[![npm version](https://img.shields.io/npm/v/@williamanjo/ally-6-microsoft.svg)](https://www.npmjs.com/package/@williamanjo/ally-6-microsoft)
[![npm downloads](https://img.shields.io/npm/dm/@williamanjo/ally-6-microsoft.svg)](https://www.npmjs.com/package/@williamanjo/ally-6-microsoft)
[![license](https://img.shields.io/npm/l/@williamanjo/ally-6-microsoft.svg)](./LICENSE)

Microsoft OAuth2 driver for AdonisJS 7 and Ally v6.
This package allows authentication using Microsoft / Azure AD / Entra ID accounts.

## Installation

Install the package using npm.

```bash
npm install @williamanjo/ally-6-microsoft
```

## Configure

Run the configure command to automatically add environment variables.

```bash
node ace configure @williamanjo/ally-6-microsoft
```

This command will add the following variables to your .env file.
```ts
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_CALLBACK_URL=
MICROSOFT_TENANT_ID=
```

## Environment configuration

Add the values from your Microsoft Azure App Registration.

```ts
MICROSOFT_CLIENT_ID=xxxxxxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxxxxx
MICROSOFT_CALLBACK_URL="http://localhost:3333/microsoft/callback"
MICROSOFT_TENANT_ID=common
```

## Register the driver

Update `config/ally.ts`.

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
  })
})

export default allyConfig
```

## Usage

Example controller.

```ts
import type { HttpContext } from '@adonisjs/core/http'

export default class AuthController {
  async redirect({ ally }: HttpContext) {
    return ally.use('microsoft').redirect()
  }

  async callback({ ally }: HttpContext) {
    const microsoft = ally.use('microsoft')

    if (microsoft.accessDenied()) {
      return 'Access denied'
    }

    if (microsoft.stateMisMatch()) {
      return 'Request expired'
    }

    if (microsoft.hasError()) {
      return microsoft.getError()
    }

    const user = await microsoft.user()

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatarUrl, // null by default — see fetchPhoto option below
    }
  }
}
```

## Routes example

```ts
import router from '@adonisjs/core/services/router'

router.get('/microsoft/redirect', '#controllers/auth_controller.redirect')
router.get('/microsoft/callback', '#controllers/auth_controller.callback')
```


## Profile photo (base64)

By default, `user.avatarUrl` returns `null` and no extra request is made to the Microsoft Graph API.

To enable photo fetching, set `fetchPhoto: true` in the driver config.
The photo is returned as a base64 data URI (`data:image/jpeg;base64,...`) ready to use directly in an `<img>` tag or to store in your database.

```ts
// config/ally.ts
microsoft: microsoft({
  clientId: env.get('MICROSOFT_CLIENT_ID'),
  clientSecret: env.get('MICROSOFT_CLIENT_SECRET'),
  callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
  tenantId: env.get('MICROSOFT_TENANT_ID'),
  fetchPhoto: true, // enables fetching the profile photo
})
```

```ts
const user = await microsoft.user()

// user.avatarUrl → "data:image/jpeg;base64,/9j/4AAQSkZJRgAB..." or null
return {
  id: user.id,
  name: user.name,
  email: user.email,
  avatar: user.avatarUrl,
}
```

> **Note:** Requires the `User.Read` scope (included by default).
> If the user has no profile photo, `avatarUrl` will be `null` even with `fetchPhoto: true`.

## Available scopes

The default scopes are `openid`, `profile`, `email`, and `User.Read`.
You can override them using the `scopes` option.

```ts
microsoft: microsoft({
  // ...
  scopes: ['openid', 'profile', 'email', 'User.Read', 'offline_access'],
})
```

| Scope | Description |
|---|---|
| `openid` | Required for OAuth2 login |
| `profile` | Access to display name and basic profile |
| `email` | Access to email address |
| `User.Read` | Read the signed-in user's full profile |
| `User.ReadBasic.All` | Read basic profiles of all users |
| `offline_access` | Receive a refresh token |

## Certificate authentication

Instead of a client secret, you can authenticate using a certificate (recommended for production).
`clientSecret` is not required when `certificate` is provided.

### 1. Generate the private key and self-signed certificate

```bash
# Generate RSA private key (2048-bit, no passphrase)
openssl genrsa -out private.key 2048

# Generate self-signed certificate valid for 1 year
openssl req -new -x509 -key private.key -out certificate.crt -days 365 \
  -subj "/CN=my-app-name"
```

**Windows (Git Bash):** Git Bash converts `/CN=...` as a Unix path — prefix with `MSYS_NO_PATHCONV=1`:
```bash
MSYS_NO_PATHCONV=1 openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "/CN=my-app-name"
```

**Windows (PowerShell):** use `//CN=` instead:
```powershell
openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "//CN=my-app-name"
```

> You only need `private.key` (stays on your server) and `certificate.crt` (uploaded to Azure).

---

### 2. Extract the thumbprint locally

The thumbprint is the SHA-1 fingerprint of the certificate. Extract it before uploading so you can verify it matches Azure.

```bash
openssl x509 -in certificate.crt -fingerprint -sha1 -noout
```

Output example:
```
SHA1 Fingerprint=A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2
```

The driver accepts both formats — with or without colons:
- `A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2` ✅
- `A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2` ✅

---

### 3. Upload the certificate to Azure Portal

1. Go to **Azure Portal** → **App Registrations** → your app
2. Open **Certificates & secrets** → **Certificates** tab
3. Click **Upload certificate** and select `certificate.crt`
4. Copy the **Thumbprint** shown after upload — confirm it matches the one extracted in step 2

---

### 4. Format the private key for `.env`

The private key is multiline. To store it in `.env`, replace newlines with `\n`:

**Linux / macOS:**
```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private.key
```

**Windows (PowerShell):**
```powershell
(Get-Content private.key) -join '\n'
```

Copy the output (single line starting with `-----BEGIN RSA PRIVATE KEY-----`) into your `.env`.

---

### 5. Configure environment variables

```env
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CALLBACK_URL="http://localhost:3333/microsoft/callback"
MICROSOFT_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CERT_THUMBPRINT=A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2
MICROSOFT_CERT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----"
```

---

### 6. Register the driver with certificate

```ts
import { defineConfig } from '@adonisjs/ally'
import env from '#start/env'
import { microsoft } from '@williamanjo/ally-6-microsoft'

const allyConfig = defineConfig({
  microsoft: microsoft({
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
    certificate: {
      privateKey: env.get('MICROSOFT_CERT_PRIVATE_KEY'),
      thumbprint: env.get('MICROSOFT_CERT_THUMBPRINT'),
    },
  })
})

export default allyConfig
```

> **Note:** `clientSecret` is **required** unless `certificate` is provided. Passing neither throws an error at startup:
> `MicrosoftDriver: "clientSecret" is required when not using certificate authentication.`
>
> When using certificate auth, omit `clientSecret` entirely — it is not needed.

## Azure configuration

Create an application in Azure Portal.

1. Go to Azure Portal
2. Open App Registrations
3. Create a new application
4. Add redirect URI: `http://localhost:3333/microsoft/callback`

Copy the following values:

- Application (client) ID
- Client secret **or** certificate thumbprint
- Tenant ID

## Supported features

- OAuth2 Authorization Code flow
- Microsoft Account login
- Azure AD / Entra ID login
- **Client secret authentication**
- **Certificate authentication** (JWT client_assertion via RS256)
- Profile photo as base64 data URI (opt-in via `fetchPhoto: true`)
- Correct field mapping (`id`, `name`, `email`, `avatarUrl`, `original`)
- Multi-tenant support via `tenantId`

## Requirements

- Node.js 18+
- AdonisJS 7+
- @adonisjs/ally v6

## Support

For bugs and feature requests, open an issue on GitHub.

## Contributing

Contributions are welcome. Feel free to open issues and pull requests.

## License

MIT
