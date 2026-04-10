import type {
  AllyDriverContract,
  LiteralStringUnion,
  Oauth2DriverConfig,
} from '@adonisjs/ally/types'

export interface MicrosoftDriverContract
  extends AllyDriverContract<MicrosoftToken, MicrosoftScopes> {
  version: 'oauth2'
}

export type MicrosoftDriverConfig = Oauth2DriverConfig & {
  scopes?: LiteralStringUnion<MicrosoftScopes>[]
  tenantId?: string
  /**
   * Whether to fetch the user's profile photo and return it as a
   * base64 data URI in the `avatarUrl` field.
   * Defaults to false. Set to true to enable photo fetching.
   */
  fetchPhoto?: boolean
}

export type MicrosoftToken = {
  expiresAt: Date
  expiresIn: number
  refreshToken: string
  scope: string[]
  token: string
  type: 'bearer'
}

export type MicrosoftScopes =
  | 'openid'
  | 'profile'
  | 'email'
  | 'User.Read'
  | 'User.ReadBasic.All'
  | 'offline_access'
