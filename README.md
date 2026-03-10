# Ally Microsoft Driver for AdonisJS 7

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

Example:
```ts
MICROSOFT_CLIENT_ID=xxxxxxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxxxxx
MICROSOFT_CALLBACK_URL="http://localhost:3333/microsoft/callback"
MICROSOFT_TENANT_ID=common
```
## Register the driver
```ts
Update config/ally.ts.

import { defineConfig } from '@adonisjs/ally'
import env from '#start/env'

const allyConfig = defineConfig({
  microsoft: {
    driver: 'microsoft',
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    clientSecret: env.get('MICROSOFT_CLIENT_SECRET'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
  }
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
      avatar: user.avatarUrl
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

## Azure configuration

Create an application in Azure Portal.

1. Go to Azure Portal
2. Open App Registrations
3. Create a new application
4. Add redirect URI:

http://localhost:3333/microsoft/callback

Copy the following values:

- Application (client) ID
- Client secret
- Tenant ID

## Supported features

- OAuth2 Authorization Code flow
- Microsoft Account login
- Azure AD login
- Entra ID support

## Requirements

- Node.js 18+
- AdonisJS 7+
- @adonisjs/ally v6

## License

MIT
