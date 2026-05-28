import type {
  AllyDriverContract,
  LiteralStringUnion,
  Oauth2DriverConfig,
} from '@adonisjs/ally/types'

export interface MicrosoftDriverContract
  extends AllyDriverContract<MicrosoftToken, MicrosoftScopes> {
  version: 'oauth2'
}

export type CertificateConfig = {
  /**
   * Absolute path to the private key file (.key / .pem)
   * e.g. "/etc/certs/private.key" or "C:/certs/private.key"
   */
  privateKey: string
  /**
   * SHA-1 thumbprint from Azure Portal > App Registration > Certificates & secrets
   * Accepts plain hex (e.g. "A1B2C3...") or colon-separated (e.g. "A1:B2:C3...")
   */
  thumbprint: string
}

export type MicrosoftDriverConfig = Omit<Oauth2DriverConfig, 'clientSecret'> & {
  /**
   * Required when NOT using certificate authentication.
   * When using certificate auth, omit this field or pass an empty string.
   */
  clientSecret?: string
  /**
   * Certificate-based authentication (replaces clientSecret).
   * When provided, a signed JWT client_assertion is sent instead of clientSecret.
   * See: https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
   */
  certificate?: CertificateConfig
  scopes?: LiteralStringUnion<MicrosoftScopes>[]
  tenantId?: string
  /**
   * Whether to fetch the user's profile photo and return it as a
   * base64 data URI in the `avatarUrl` field.
   * Defaults to false. Set to true to enable photo fetching.
   */
  fetchPhoto?: boolean
}

/**
 * Internal resolved config — clientSecret is always a string (defaults to '')
 * so the base Oauth2Driver constraint is satisfied.
 * @internal
 */
export type MicrosoftDriverConfigResolved = Omit<MicrosoftDriverConfig, 'clientSecret'> & {
  clientSecret: string
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
