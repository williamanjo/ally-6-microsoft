import type {
  AllyDriverContract,
  LiteralStringUnion,
  Oauth2DriverConfig,
} from '@adonisjs/ally/types'

export interface MicrosoftDriverContract extends AllyDriverContract<
  MicrosoftToken,
  MicrosoftScopes
> {
  version: 'oauth2'
}

/**
 * Sizes Microsoft Graph serves for profile photos (`/me/photos/{size}/$value`).
 * See: https://learn.microsoft.com/en-us/graph/api/profilephoto-get
 */
export const MICROSOFT_PHOTO_SIZES = [
  '48x48',
  '64x64',
  '96x96',
  '120x120',
  '240x240',
  '360x360',
  '432x432',
  '504x504',
  '648x648',
] as const
export type MicrosoftPhotoSize = (typeof MICROSOFT_PHOTO_SIZES)[number]

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
  /**
   * Size of the profile photo fetched when `fetchPhoto` is true (e.g. `"96x96"`).
   * Smaller photos keep the data URI light enough to store in a session.
   * Defaults to the original photo Microsoft Graph has (`/me/photo/$value`).
   */
  photoSize?: MicrosoftPhotoSize
  /**
   * Controls the sign-in UI behavior. `none` attempts silent auth.
   * See: https://learn.microsoft.com/en-us/entra/identity-platform/authentication-national-cloud#authentication-endpoints
   */
  prompt?: 'none' | 'login' | 'consent' | 'select_account'
  /**
   * Pre-fills the sign-in email field. Useful for multi-tenant flows.
   */
  loginHint?: string
  /**
   * Speeds up federated sign-in by skipping the home-realm discovery step.
   * Pass the user's email domain (e.g. `"contoso.com"`).
   */
  domainHint?: string
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
  'openid' | 'profile' | 'email' | 'User.Read' | 'User.ReadBasic.All' | 'offline_access'
