import { ApiRequest, Oauth2Driver } from '@adonisjs/ally'
import type { HttpContext } from '@adonisjs/core/http'
import { MicrosoftDriverConfig, MicrosoftScopes, MicrosoftToken } from './types/main.js'
import type { ApiRequestContract, RedirectRequestContract } from '@adonisjs/ally/types'

export class MicrosoftDriver extends Oauth2Driver<MicrosoftToken, MicrosoftScopes> {
  protected authorizeUrl: string
  protected accessTokenUrl: string

  protected userInfoUrl = 'https://graph.microsoft.com/v1.0/me'
  protected userPhotoUrl = 'https://graph.microsoft.com/v1.0/me/photo/$value'

  protected codeParamName = 'code'
  protected errorParamName = 'error'
  protected stateCookieName = 'microsoft_oauth_state'
  protected stateParamName = 'state'
  protected scopeParamName = 'scope'
  protected scopesSeparator = ' '

  constructor(
    ctx: HttpContext,
    public config: MicrosoftDriverConfig
  ) {
    super(ctx, config)

    const tenantId = this.config.tenantId || 'common'

    this.authorizeUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`
    this.accessTokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

    this.loadState()
  }

  protected configureRedirectRequest(request: RedirectRequestContract<MicrosoftScopes>) {
    request.scopes(this.config.scopes || ['openid', 'profile', 'email', 'User.Read'])
    request.param('response_type', 'code')
  }

  protected configureAccessTokenRequest(request: ApiRequest): void {
    request
      .header('Content-Type', 'application/x-www-form-urlencoded')
      .field('grant_type', 'authorization_code')
      .field('client_id', this.config.clientId)
      .field('client_secret', this.config.clientSecret)
      .field('redirect_uri', this.config.callbackUrl)
      .field('code', this.ctx.request.input(this.codeParamName))
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
   * Returns details for the authorized user
   */
  async user(callback?: (request: ApiRequestContract) => void) {
    const accessToken = await this.accessToken(callback)
    const user = await this.getUserInfo(accessToken.token, callback)
    return {
      ...user,
      token: accessToken,
    }
  }

  /**
   * Finds the user by the access token
   */
  async userFromToken(token: string, callback?: (request: ApiRequestContract) => void) {
    const user = await this.getUserInfo(token, callback)
    return {
      ...user,
      token: { token: token, type: 'bearer' as const },
    }
  }

  /**
   * Fetches the user photo from Microsoft Graph API and returns as a
   * base64 data URI (e.g. "data:image/jpeg;base64,...").
   * Returns null if the user has no photo or if the request fails.
   */
  protected async getUserPhotoAsBase64(accessToken: string): Promise<string | null> {
    try {
      const response = await fetch(this.userPhotoUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      if (!response.ok) {
        return null
      }

      const contentType = response.headers.get('content-type') ?? 'image/jpeg'
      const buffer = await response.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')

      return `data:${contentType};base64,${base64}`
    } catch {
      return null
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
