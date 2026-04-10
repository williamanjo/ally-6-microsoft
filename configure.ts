import type Configure from '@adonisjs/core/commands/configure'

/**
 * Configures the package
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  /**
   * 1. Add env variables to .env and .env.example
   */
  await codemods.defineEnvVariables({
    MICROSOFT_CLIENT_ID: '',
    MICROSOFT_CLIENT_SECRET: '',
    MICROSOFT_CALLBACK_URL: '',
    MICROSOFT_TENANT_ID: '',
  })

  /**
   * 2. Add env validations to start/env.ts
   */
  await codemods.defineEnvValidations({
    variables: {
      MICROSOFT_CLIENT_ID: 'Env.schema.string()',
      MICROSOFT_CLIENT_SECRET: 'Env.schema.string()',
      MICROSOFT_CALLBACK_URL: 'Env.schema.string()',
      MICROSOFT_TENANT_ID: 'Env.schema.string.optional()',
    },
    leadingComment: 'Variables for @williamanjo/ally-6-microsoft',
  })

  /**
   * 3. Add the microsoft driver block to config/ally.ts.
   *
   * codemods.makeUsingStub copies the stub file from stubs/ into the
   * app — here we use it only when config/ally.ts does not exist yet.
   * When ally is already configured the user is instructed to add the
   * driver manually; a warning is printed instead of overwriting their file.
   */
  const allyConfigPath = command.app.makePath('config/ally.ts')
  const { existsSync } = await import('node:fs')

  if (!existsSync(allyConfigPath)) {
    await codemods.makeUsingStub(stubsRoot, 'config/ally.stub', {})
    command.logger.action('create config/ally.ts')
  } else {
    command.logger.warning(
      [
        'config/ally.ts already exists.',
        "Add the microsoft driver manually following the README instructions.",
      ].join(' ')
    )
  }
}

import { stubsRoot } from './stubs/main.js'
