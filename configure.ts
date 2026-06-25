import { existsSync } from 'node:fs'
import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

/**
 * Configures the package
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  const authMethod = await command.prompt.choice('Authentication method for Microsoft OAuth?', [
    'Client Secret',
    'Certificate (RS256 JWT)',
  ])

  const useCert = authMethod === 'Certificate (RS256 JWT)'

  const selectedScopes = await command.prompt.multiple(
    'Scopes? (space to select, enter to confirm)',
    ['openid', 'profile', 'email', 'User.Read', 'User.ReadBasic.All', 'offline_access'],
    { default: ['openid', 'profile', 'email', 'User.Read'] }
  )

  const scopesLine = `scopes: [${selectedScopes.map((s: string) => `'${s}'`).join(', ')}],`

  /**
   * Env variables — only inject what the chosen auth method needs
   */
  await codemods.defineEnvVariables({
    MICROSOFT_CLIENT_ID: '',
    MICROSOFT_CALLBACK_URL: '',
    MICROSOFT_TENANT_ID: '',
    ...(useCert
      ? {
          MICROSOFT_CERT_THUMBPRINT: '',
          MICROSOFT_CERT_PRIVATE_KEY: '/etc/certs/private.key',
        }
      : {
          MICROSOFT_CLIENT_SECRET: '',
        }),
  })

  /**
   * Env validations — cert vars required when using certificate auth
   */
  await codemods.defineEnvValidations({
    variables: {
      MICROSOFT_CLIENT_ID: 'Env.schema.string()',
      MICROSOFT_CALLBACK_URL: 'Env.schema.string()',
      MICROSOFT_TENANT_ID: 'Env.schema.string.optional()',
      ...(useCert
        ? {
            MICROSOFT_CERT_THUMBPRINT: 'Env.schema.string()',
            MICROSOFT_CERT_PRIVATE_KEY: 'Env.schema.string()',
          }
        : {
            MICROSOFT_CLIENT_SECRET: 'Env.schema.string()',
          }),
    },
    leadingComment: 'Variables for @williamanjo/ally-6-microsoft',
  })

  /**
   * Config file — create from stub or show existing content
   */
  const allyConfigPath = command.app.makePath('config/ally.ts')

  if (!existsSync(allyConfigPath)) {
    await codemods.makeUsingStub(stubsRoot, 'config/ally.stub', {
      useCert,
      scopesLine,
    })
    command.logger.action('create config/ally.ts')
  } else {
    const snippet = useCert
      ? `  microsoft: microsoft({
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
    ${scopesLine}
    certificate: {
      privateKey: env.get('MICROSOFT_CERT_PRIVATE_KEY'),
      thumbprint: env.get('MICROSOFT_CERT_THUMBPRINT'),
    },
  }),`
      : `  microsoft: microsoft({
    clientId: env.get('MICROSOFT_CLIENT_ID'),
    clientSecret: env.get('MICROSOFT_CLIENT_SECRET'),
    callbackUrl: env.get('MICROSOFT_CALLBACK_URL'),
    tenantId: env.get('MICROSOFT_TENANT_ID'),
    ${scopesLine}
  }),`

    command.logger.warning('config/ally.ts already exists. Add this block inside defineConfig({}):\n')
    command.logger.log(snippet)
  }
}
