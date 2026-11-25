import { createSign, createPrivateKey, randomUUID, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type ApiRequest, Oauth2Driver } from '@adonisjs/ally'
import type { HttpContext } from '@adonisjs/core/http'
import {
  MICROSOFT_PHOTO_SIZES,
  type CertificateConfig,
  type MicrosoftDriverConfig,
  type MicrosoftDriverConfigResolved,
  type MicrosoftScopes,
  type MicrosoftToken,
} from './types/main.js'
import type { ApiRequestContract, RedirectRequestContract } from '@adonisjs/ally/types'

const ALLOWED_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// The photo becomes a base64 data URI that usually lands in the session. Cap it so a large
// response cannot bloat the session, and give the fetch a deadline so it cannot hang a login.
// Both are overridable per driver via `maxPhotoBytes` / `photoTimeoutMs` in the config.
const DEFAULT_MAX_PHOTO_BYTES = 2_000_000
const DEFAULT_PHOTO_TIMEOUT_MS = 5_000

export class MicrosoftDriver extends Oauth2Driver<MicrosoftToken, MicrosoftScopes> {
  protected authorizeUrl: string
  protected accessTokenUrl: string

  protected userInfoUrl = 'https://graph.microsoft.com/v1.0/me'
  protected userPhotoUrl = 'https://graph.microsoft.com/v1.0/me/photo/$value'

  protected codeParamName = 'code'
  protected errorParamName = 'error'
  protected stateCookieName = 'microsoft_oauth_state'
  protected stateParamName = 'state'
  // Enables Ally's built-in PKCE: binds the authorization code to the browser that started the flow
  protected codeVerifierCookieName = 'microsoft_oauth_code_verifier'
  protected scopeParamName = 'scope'
  protected scopesSeparator = ' '

  public config: MicrosoftDriverConfigResolved

  // Certificate material, validated and parsed once at construction (not on every token request)
  #privateKey?: KeyObject
  #x5t?: string

  constructor(ctx: HttpContext, inputConfig: MicrosoftDriverConfig) {
    const config: MicrosoftDriverConfigResolved = {
      clientSecret: '',
      ...inputConfig,
    }
    if (!config.certificate && !config.clientSecret) {
      throw new Error(
        'MicrosoftDriver: "clientSecret" is required when not using certificate authentication.'
      )
    }

    super(ctx, config as any)
    this.config = config

    if (this.config.certificate) {
      this.prepareCertificate(this.config.certificate)
    }

    const tenantId = this.config.tenantId || 'common'

    if (this.config.photoSize) {
      if (!MICROSOFT_PHOTO_SIZES.includes(this.config.photoSize)) {
        throw new Error(
          `MicrosoftDriver: invalid "photoSize" "${this.config.photoSize}". Use one of: ${MICROSOFT_PHOTO_SIZES.join(', ')}`
        )
      }
      this.userPhotoUrl = `https://graph.microsoft.com/v1.0/me/photos/${this.config.photoSize}/$value`
    }

    this.authorizeUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`
    this.accessTokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

    this.loadState()
  }

  protected configureRedirectRequest(request: RedirectRequestContract<MicrosoftScopes>) {
    request.scopes(this.config.scopes || ['openid', 'profile', 'email', 'User.Read'])
    request.param('response_type', 'code')
    if (this.config.prompt) request.param('prompt', this.config.prompt)
    if (this.config.loginHint) request.param('login_hint', this.config.loginHint)
    if (this.config.domainHint) request.param('domain_hint', this.config.domainHint)
  }

  /**
   * Validates the thumbprint and loads the private key once, at construction, so a bad
   * certificate fails fast at boot instead of on the first token request, and the key file
   * is read a single time rather than on every exchange and refresh.
   */
  protected prepareCertificate(certificate: CertificateConfig) {
    const hex = certificate.thumbprint.replace(/:/g, '')
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
      throw new Error(
        `MicrosoftDriver: invalid certificate "thumbprint". Expected a 40-character SHA-1 hex string (colons allowed), got "${certificate.thumbprint}".`
      )
    }
    this.#x5t = Buffer.from(hex, 'hex').toString('base64url')

    let keyBuffer: Buffer
    try {
      keyBuffer = readFileSync(certificate.privateKey)
    } catch (cause) {
      throw new Error(
        `MicrosoftDriver: could not read the certificate private key file at "${certificate.privateKey}".`,
        { cause }
      )
    }
    try {
      this.#privateKey = createPrivateKey({ key: keyBuffer, format: 'pem' })
    } catch (cause) {
      throw new Error(
        `MicrosoftDriver: the certificate private key at "${certificate.privateKey}" is not a valid PEM key.`,
        { cause }
      )
    }
  }

  /**
   * Builds a signed JWT client_assertion for certificate-based authentication.
   *
   * Microsoft requires:
   *  - Header: { alg: 'RS256', typ: 'JWT', x5t: '<sha1-thumbprint-base64url>' }
   *  - Payload: aud, iss, sub (= clientId), jti, nbf, exp
   *  - Signed with the private key using RS256
   *
   * See: https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
   */
  protected buildClientAssertion(): string {
    const tenantId = this.config.tenantId || 'common'
    const now = Math.floor(Date.now() / 1000)

    const header = { alg: 'RS256', typ: 'JWT', x5t: this.#x5t }
    const payload = {
      aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      iss: this.config.clientId,
      sub: this.config.clientId,
      jti: randomUUID(),
      nbf: now,
      exp: now + 600,
    }

    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const signingInput = `${encode(header)}.${encode(payload)}`

    const sign = createSign('RSA-SHA256')
    sign.update(signingInput)
    const signature = sign.sign(this.#privateKey!, 'base64url')

    return `${signingInput}.${signature}`
  }

  protected configureAccessTokenRequest(request: ApiRequest): void {
    request
      .header('Content-Type', 'application/x-www-form-urlencoded')
      .field('grant_type', 'authorization_code')
      .field('client_id', this.config.clientId)
      .field('redirect_uri', this.config.callbackUrl)
      .field('code', this.ctx.request.input(this.codeParamName))

    if (this.config.certificate) {
      // Certificate auth: signed JWT assertion replaces clientSecret. The base getAccessToken
      // always sets an (empty) client_secret field, so drop it to send a single client credential.
      request
        .clearField('client_secret')
        .field('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        .field('client_assertion', this.buildClientAssertion())
    } else {
      // Secret auth: plain clientSecret
      request.field('client_secret', this.config.clientSecret)
    }
  }

  /**
   * Exchanges a refresh token for a new access token.
   * Requires the `offline_access` scope to be included in the original authorization request.
   */
  async refreshAccessToken(refreshToken: string): Promise<MicrosoftToken> {
    const request = this.httpClient(this.accessTokenUrl)
    request
      .header('Content-Type', 'application/x-www-form-urlencoded')
      .field('grant_type', 'refresh_token')
      .field('client_id', this.config.clientId)
      .field('refresh_token', refreshToken)

    if (this.config.certificate) {
      request
        .field('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        .field('client_assertion', this.buildClientAssertion())
    } else {
      request.field('client_secret', this.config.clientSecret)
    }

    // The token endpoint answers JSON; without this the HTTP client defaults to text and every
    // field below reads as undefined, so a failed refresh would be reported as a success.
    request.parseAs('json')
    let body: Record<string, unknown>
    try {
      body = await request.post()
    } catch (error) {
      // Drop the request body (refresh_token, client credential) from the surfaced error
      throw this.sanitizeTokenError(error)
    }

    const accessToken = body.access_token as string | undefined
    if (!accessToken) {
      throw new Error('MicrosoftDriver: the token endpoint did not return an "access_token".')
    }
    const expiresIn = Number(body.expires_in ?? 0)
    return {
      token: accessToken,
      type: 'bearer',
      refreshToken: (body.refresh_token ?? refreshToken) as string,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scope: ((body.scope as string) ?? '').split(' ').filter(Boolean),
    }
  }

  /**
   * Find if the current error code is for access denied
   */
  accessDenied(): boolean {
    const error = this.getError()
    if (!error) {
      return false
    }
    return error === 'access_denied'
  }

  /**
   * The base check treats a missing state cookie and a missing state param
   * as a match (undefined === undefined). Require a stored state.
   */
  stateMisMatch(): boolean {
    if (this.isStateless) {
      return false
    }
    return !this.stateCookieValue || super.stateMisMatch()
  }

  /**
   * Exchanges the authorization code for a token, replacing any HTTP-layer error with one
   * that does not carry the request body. The underlying ky error keeps the POST options
   * (client_secret, client_assertion, refresh_token) on the thrown object, so a consumer
   * that serializes the whole error would leak the credential.
   */
  async accessToken(callback?: (request: ApiRequestContract) => void) {
    try {
      return await super.accessToken(callback)
    } catch (error) {
      throw this.sanitizeTokenError(error)
    }
  }

  /**
   * Returns a credential-free error for HTTP-layer token failures, and leaves every other
   * error (state mismatch, missing code, a missing-token error) untouched.
   */
  protected sanitizeTokenError(error: unknown): unknown {
    const isHttp =
      !!error && typeof error === 'object' && ('response' in error || 'request' in error)
    if (!isHttp) return error
    const status = (error as { response?: { status?: number } }).response?.status
    return new Error(
      `MicrosoftDriver: the token request to Microsoft failed${status ? ` (HTTP ${status})` : ''}.`
    )
  }

  /**
   * Returns details for the authorized user
   */
  async user(callback?: (request: ApiRequestContract) => void) {
    const accessToken = await this.accessToken(callback)
    const user = await this.getUserInfo(accessToken.token, callback)
    const claims = this.idTokenClaims((accessToken as Record<string, unknown>).id_token)
    const verified = this.verifiedEmail(claims, user.email)
    return {
      ...user,
      tenantId: typeof claims?.tid === 'string' ? (claims.tid as string) : null,
      email: verified.email,
      emailVerificationState: verified.state,
      token: accessToken,
    }
  }

  /**
   * Decodes the id_token payload returned by the token endpoint. The token came straight
   * from Microsoft over TLS in this same request, so no signature check is needed
   * (OIDC Core 3.1.3.7). Returns null when the `openid` scope was not requested.
   */
  protected idTokenClaims(idToken: unknown): Record<string, unknown> | null {
    if (typeof idToken !== 'string') return null
    try {
      const payload = Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()
      const claims = JSON.parse(payload)
      return claims && typeof claims === 'object' ? claims : null
    } catch {
      return null
    }
  }

  /**
   * Decides the email to return and its verification state.
   *
   * `xms_edov` ("email domain owner verified") attests the domain of the id_token's own
   * `email` claim, NOT the Graph `mail` attribute. Reporting `verified` for a different
   * address than the one that was vouched for would re-open the nOAuth / claim-mismatch
   * hole, so `verified` is returned only together with that claim's email. A tenant admin
   * can still set Graph `mail` freely, so without a positive `xms_edov` the Graph-derived
   * email is handed back as `unsupported` (or `unverified` when the claim says so).
   *
   * Requires the optional `email` and `xms_edov` claims on the app registration; without
   * them the state stays `unsupported`.
   */
  protected verifiedEmail(
    claims: Record<string, unknown> | null,
    graphEmail: string
  ): { email: string; state: 'verified' | 'unverified' | 'unsupported' } {
    const claimEmail = typeof claims?.email === 'string' ? (claims.email as string) : null
    if (claims?.xms_edov === true && claimEmail) {
      return { email: claimEmail, state: 'verified' }
    }
    if (claims?.xms_edov === false) {
      return { email: graphEmail, state: 'unverified' }
    }
    return { email: graphEmail, state: 'unsupported' }
  }

  /**
   * Finds the user by the access token
   */
  async userFromToken(token: string, callback?: (request: ApiRequestContract) => void) {
    const user = await this.getUserInfo(token, callback)
    return {
      ...user,
      // No id_token on this path, so the tenant is unknown
      tenantId: null,
      token: { token: token, type: 'bearer' as const },
    }
  }

  /**
   * Fetches the user photo from Microsoft Graph API and returns as a
   * base64 data URI (e.g. "data:image/jpeg;base64,...").
   * Returns null if the user has no photo or if the request fails.
   */
  protected async getUserPhotoAsBase64(accessToken: string): Promise<string | null> {
    const maxBytes = this.config.maxPhotoBytes ?? DEFAULT_MAX_PHOTO_BYTES
    const timeoutMs = this.config.photoTimeoutMs ?? DEFAULT_PHOTO_TIMEOUT_MS
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.userPhotoUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        return null
      }

      const rawContentType = response.headers.get('content-type') ?? 'image/jpeg'
      const contentType = rawContentType.split(';')[0].trim().toLowerCase()
      if (!ALLOWED_PHOTO_CONTENT_TYPES.includes(contentType)) return null

      // Early out on a declared size before downloading the body
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) return null

      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > maxBytes) return null
      const base64 = Buffer.from(buffer).toString('base64')

      return `data:${contentType};base64,${base64}`
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Fetches the user info from the Microsoft Graph API and maps
   * fields to the Ally standard user format.
   *
   * avatarUrl will be a base64 data URI when the user has a photo,
   * or null when they don't (or when fetchPhoto is set to false in config).
   */
  protected async getUserInfo(accessToken: string, callback?: (request: ApiRequest) => void) {
    const request = this.getAuthenticatedRequest(this.userInfoUrl, accessToken)

    if (typeof callback === 'function') {
      callback(request)
    }

    const body = await request.get()

    const avatarUrl =
      this.config.fetchPhoto === true ? await this.getUserPhotoAsBase64(accessToken) : null

    return {
      id: body.id as string,
      nickName: (body.displayName ?? body.userPrincipalName) as string,
      name: (body.displayName ?? body.userPrincipalName) as string,
      email: (body.mail ?? body.userPrincipalName) as string,
      avatarUrl,
      emailVerificationState: 'unsupported' as const,
      original: body,
    }
  }

  /**
   * Returns the HTTP request with the authorization header set
   */
  protected getAuthenticatedRequest(url: string, token: string) {
    const request = this.httpClient(url)
    request.header('Authorization', `Bearer ${token}`)
    request.parseAs('json')
    return request
  }
}
