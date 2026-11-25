import { test } from '@japa/runner'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MicrosoftDriver } from '../../src/microsoft.js'
import type { MicrosoftDriverConfig } from '../../src/types/main.js'
import type { HttpContext } from '@adonisjs/core/http'

// ---------------------------------------------------------------------------
// Test RSA key — generated once, written to a temp file, cleaned up on exit
// ---------------------------------------------------------------------------
const { privateKey: privKeyObj, publicKey: pubKeyObj } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const TEST_PRIV_PEM = privKeyObj.export({ type: 'pkcs8', format: 'pem' }) as string
const TEST_THUMBPRINT = createHash('sha1')
  .update(pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer)
  .digest('hex')
  .toUpperCase()
const TEST_KEY_PATH = join(tmpdir(), `ms-driver-test-${Date.now()}.pem`)
writeFileSync(TEST_KEY_PATH, TEST_PRIV_PEM)
process.on('exit', () => {
  try {
    unlinkSync(TEST_KEY_PATH)
  } catch {}
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createCtx(queryParams: Record<string, string> = {}): HttpContext {
  return {
    request: {
      input: (name: string) => queryParams[name] ?? null,
      encryptedCookie: () => null,
    },
    response: { clearCookie: () => {} },
  } as any
}

function createCallbackCtx(
  queryParams: Record<string, string>,
  cookies: Record<string, string>,
  setCookies: Record<string, string> = {}
): HttpContext {
  return {
    request: {
      input: (name: string, fallback?: unknown) => queryParams[name] ?? fallback,
      // Mirrors AdonisJS: a missing encrypted cookie reads as undefined
      encryptedCookie: (name: string) => cookies[name],
    },
    response: {
      clearCookie: () => {},
      encryptedCookie: (name: string, value: string) => {
        setCookies[name] = value
      },
    },
  } as any
}

function fakeIdToken(claims: Record<string, unknown>) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.sig`
}

const BASE_CONFIG = {
  clientId: 'test-client-id',
  callbackUrl: 'http://localhost/callback',
} satisfies Partial<MicrosoftDriverConfig>

const SECRET_CONFIG: MicrosoftDriverConfig = { ...BASE_CONFIG, clientSecret: 'test-secret' }
const CERT_CONFIG: MicrosoftDriverConfig = {
  ...BASE_CONFIG,
  certificate: { privateKey: TEST_KEY_PATH, thumbprint: TEST_THUMBPRINT },
}

// ---------------------------------------------------------------------------
// TestDriver — exposes protected methods, generic get/post body
// ---------------------------------------------------------------------------
class TestDriver extends MicrosoftDriver {
  private _mockBody: Record<string, unknown> = {}

  setMockBody(body: Record<string, unknown>) {
    this._mockBody = body
  }

  protected override httpClient(_url: string): any {
    const self = this
    const req: any = {
      header: () => req,
      parseAs: () => req,
      field: () => req,
      get: async () => self._mockBody,
      post: async () => self._mockBody,
    }
    return req
  }

  testBuildClientAssertion() {
    return this.buildClientAssertion()
  }

  async testGetUserInfo(token: string) {
    return this.getUserInfo(token)
  }

  async testGetUserPhoto(token: string) {
    return this.getUserPhotoAsBase64(token)
  }
}

// ---------------------------------------------------------------------------
// SpyDriver — records field() calls, supports separate get/post bodies
// ---------------------------------------------------------------------------
class SpyDriver extends MicrosoftDriver {
  private _getBody: Record<string, unknown> = {}
  private _postBody: Record<string, unknown> = {}
  readonly fields: Map<string, string> = new Map()

  setGetBody(body: Record<string, unknown>) {
    this._getBody = body
  }
  setPostBody(body: Record<string, unknown>) {
    this._postBody = body
  }

  protected override httpClient(_url: string): any {
    const self = this
    const req: any = {
      header: () => req,
      parseAs: () => req,
      field: (k: string, v: string) => {
        self.fields.set(k, v)
        return req
      },
      getResponseType: () => 'json',
      get: async () => self._getBody,
      post: async () => self._postBody,
    }
    return req
  }

  testConfigureAccessTokenRequest() {
    const self = this
    // seed client_secret like the base getAccessToken does, so clearField is observable
    self.fields.set('client_secret', '')
    const req: any = {
      header: () => req,
      field: (k: string, v: string) => {
        self.fields.set(k, v)
        return req
      },
      clearField: (k: string) => {
        self.fields.delete(k)
        return req
      },
    }
    this.configureAccessTokenRequest(req)
  }

  testConfigureRedirectRequest(spy: any) {
    this.configureRedirectRequest(spy)
  }

  async testRefreshAccessToken(token: string) {
    return this.refreshAccessToken(token)
  }
}

// ---------------------------------------------------------------------------
// RedirectSpy — records param() and scopes() calls
// ---------------------------------------------------------------------------
class RedirectSpy {
  readonly params: Record<string, string> = {}
  readonly scopesList: string[][] = []

  scopes(s: string[]) {
    this.scopesList.push(s)
    return this
  }

  param(k: string, v: string) {
    this.params[k] = v
    return this
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.group('Constructor validation', () => {
  test('throws when no clientSecret and no certificate', ({ assert }) => {
    assert.throws(
      () => new MicrosoftDriver(createCtx(), BASE_CONFIG as any),
      /clientSecret.*required/
    )
  })

  test('accepts clientSecret config', ({ assert }) => {
    assert.doesNotThrows(() => new MicrosoftDriver(createCtx(), SECRET_CONFIG))
  })

  test('accepts certificate config', ({ assert }) => {
    assert.doesNotThrows(() => new MicrosoftDriver(createCtx(), CERT_CONFIG))
  })

  test('throws on an unsupported photoSize', ({ assert }) => {
    assert.throws(
      () => new MicrosoftDriver(createCtx(), { ...SECRET_CONFIG, photoSize: '100x100' as any }),
      /invalid "photoSize"/
    )
  })
})

test.group('buildClientAssertion', () => {
  test('returns a three-part JWT string', ({ assert }) => {
    const driver = new TestDriver(createCtx(), CERT_CONFIG)
    const jwt = driver.testBuildClientAssertion()
    const parts = jwt.split('.')
    assert.lengthOf(parts, 3)
  })

  test('header has alg RS256, typ JWT, and x5t', ({ assert }) => {
    const driver = new TestDriver(createCtx(), CERT_CONFIG)
    const jwt = driver.testBuildClientAssertion()
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())
    assert.equal(header.alg, 'RS256')
    assert.equal(header.typ, 'JWT')
    assert.isString(header.x5t)
    assert.isNotEmpty(header.x5t)
  })

  test('payload has required MS claims', ({ assert }) => {
    const driver = new TestDriver(createCtx(), CERT_CONFIG)
    const jwt = driver.testBuildClientAssertion()
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    assert.isString(payload.aud)
    assert.equal(payload.iss, 'test-client-id')
    assert.equal(payload.sub, 'test-client-id')
    assert.isString(payload.jti)
    assert.isNumber(payload.nbf)
    assert.isNumber(payload.exp)
  })

  test('exp is 600 seconds after nbf', ({ assert }) => {
    const driver = new TestDriver(createCtx(), CERT_CONFIG)
    const jwt = driver.testBuildClientAssertion()
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    assert.equal(payload.exp - payload.nbf, 600)
  })

  test('x5t matches thumbprint base64url encoding', ({ assert }) => {
    const driver = new TestDriver(createCtx(), CERT_CONFIG)
    const jwt = driver.testBuildClientAssertion()
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())
    const expected = Buffer.from(TEST_THUMBPRINT, 'hex').toString('base64url')
    assert.equal(header.x5t, expected)
  })

  test('colon-separated thumbprint normalizes correctly', ({ assert }) => {
    const colonThumbprint = TEST_THUMBPRINT.match(/.{2}/g)!.join(':')
    const driver = new TestDriver(createCtx(), {
      ...CERT_CONFIG,
      certificate: { privateKey: TEST_KEY_PATH, thumbprint: colonThumbprint },
    })
    const jwt = driver.testBuildClientAssertion()
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())
    const expected = Buffer.from(TEST_THUMBPRINT, 'hex').toString('base64url')
    assert.equal(header.x5t, expected)
  })

  test('throws at construction when the private key file does not exist', ({ assert }) => {
    assert.throws(
      () =>
        new TestDriver(createCtx(), {
          ...CERT_CONFIG,
          certificate: {
            privateKey: '/nonexistent/path/private.key',
            thumbprint: TEST_THUMBPRINT,
          },
        }),
      /could not read the certificate private key/
    )
  })

  test('throws at construction on an invalid thumbprint', ({ assert }) => {
    assert.throws(
      () =>
        new TestDriver(createCtx(), {
          ...CERT_CONFIG,
          certificate: { privateKey: TEST_KEY_PATH, thumbprint: 'not-hex' },
        }),
      /invalid certificate "thumbprint"/
    )
  })
})

test.group('configureAccessTokenRequest', () => {
  test('secret flow sets client_secret and no client_assertion', ({ assert }) => {
    const driver = new SpyDriver(createCtx({ code: 'auth-code' }), SECRET_CONFIG)
    driver.testConfigureAccessTokenRequest()
    assert.equal(driver.fields.get('client_secret'), 'test-secret')
    assert.isFalse(driver.fields.has('client_assertion'))
    assert.isFalse(driver.fields.has('client_assertion_type'))
  })

  test('cert flow sets client_assertion and no client_secret', ({ assert }) => {
    const driver = new SpyDriver(createCtx({ code: 'auth-code' }), CERT_CONFIG)
    driver.testConfigureAccessTokenRequest()
    assert.isTrue(driver.fields.has('client_assertion'))
    assert.equal(
      driver.fields.get('client_assertion_type'),
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    )
    assert.isFalse(driver.fields.has('client_secret'))
  })

  test('both flows set grant_type authorization_code', ({ assert }) => {
    const driver = new SpyDriver(createCtx({ code: 'auth-code' }), SECRET_CONFIG)
    driver.testConfigureAccessTokenRequest()
    assert.equal(driver.fields.get('grant_type'), 'authorization_code')
  })
})

test.group('configureRedirectRequest', () => {
  test('adds prompt param when configured', ({ assert }) => {
    const driver = new SpyDriver(createCtx(), {
      ...SECRET_CONFIG,
      prompt: 'select_account',
    })
    const spy = new RedirectSpy()
    driver.testConfigureRedirectRequest(spy)
    assert.equal(spy.params['prompt'], 'select_account')
  })

  test('adds login_hint param when configured', ({ assert }) => {
    const driver = new SpyDriver(createCtx(), {
      ...SECRET_CONFIG,
      loginHint: 'user@contoso.com',
    })
    const spy = new RedirectSpy()
    driver.testConfigureRedirectRequest(spy)
    assert.equal(spy.params['login_hint'], 'user@contoso.com')
  })

  test('adds domain_hint param when configured', ({ assert }) => {
    const driver = new SpyDriver(createCtx(), {
      ...SECRET_CONFIG,
      domainHint: 'contoso.com',
    })
    const spy = new RedirectSpy()
    driver.testConfigureRedirectRequest(spy)
    assert.equal(spy.params['domain_hint'], 'contoso.com')
  })

  test('does not add optional params when not configured', ({ assert }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    const spy = new RedirectSpy()
    driver.testConfigureRedirectRequest(spy)
    assert.isFalse('prompt' in spy.params)
    assert.isFalse('login_hint' in spy.params)
    assert.isFalse('domain_hint' in spy.params)
  })
})

test.group('refreshAccessToken', () => {
  test('returns MicrosoftToken with correct shape', async ({ assert }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    driver.setPostBody({
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
      scope: 'openid profile email',
    })
    const token = await driver.testRefreshAccessToken('old-refresh-token')
    assert.equal(token.token, 'new-access-token')
    assert.equal(token.type, 'bearer')
    assert.equal(token.refreshToken, 'new-refresh-token')
    assert.equal(token.expiresIn, 3600)
    assert.instanceOf(token.expiresAt, Date)
    assert.deepEqual(token.scope, ['openid', 'profile', 'email'])
  })

  test('falls back to input refresh token when MS does not return a new one', async ({
    assert,
  }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    driver.setPostBody({
      access_token: 'new-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid',
    })
    const token = await driver.testRefreshAccessToken('original-refresh-token')
    assert.equal(token.refreshToken, 'original-refresh-token')
  })

  test('secret flow sends client_secret in refresh request', async ({ assert }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    driver.setPostBody({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: '' })
    await driver.testRefreshAccessToken('rt')
    assert.equal(driver.fields.get('grant_type'), 'refresh_token')
    assert.equal(driver.fields.get('client_secret'), 'test-secret')
    assert.isFalse(driver.fields.has('client_assertion'))
  })

  test('cert flow sends client_assertion in refresh request', async ({ assert }) => {
    const driver = new SpyDriver(createCtx(), CERT_CONFIG)
    driver.setPostBody({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: '' })
    await driver.testRefreshAccessToken('rt')
    assert.equal(driver.fields.get('grant_type'), 'refresh_token')
    assert.isTrue(driver.fields.has('client_assertion'))
    assert.isFalse(driver.fields.has('client_secret'))
  })

  test('expiresAt is approximately now + expiresIn seconds', async ({ assert }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    const expiresIn = 7200
    driver.setPostBody({
      access_token: 'tok',
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: '',
    })
    const before = Date.now()
    const token = await driver.testRefreshAccessToken('rt')
    const after = Date.now()
    const expectedMin = before + expiresIn * 1000
    const expectedMax = after + expiresIn * 1000
    assert.isAtLeast(token.expiresAt.getTime(), expectedMin)
    assert.isAtMost(token.expiresAt.getTime(), expectedMax)
  })
})

test.group('accessDenied', () => {
  test('returns true when error is access_denied', ({ assert }) => {
    const driver = new MicrosoftDriver(createCtx({ error: 'access_denied' }), SECRET_CONFIG)
    assert.isTrue(driver.accessDenied())
  })

  test('returns false when error is absent', ({ assert }) => {
    const driver = new MicrosoftDriver(createCtx(), SECRET_CONFIG)
    assert.isFalse(driver.accessDenied())
  })

  test('returns false when error is a different value', ({ assert }) => {
    const driver = new MicrosoftDriver(createCtx({ error: 'server_error' }), SECRET_CONFIG)
    assert.isFalse(driver.accessDenied())
  })
})

test.group('getUserInfo mapping', () => {
  test('maps MS Graph response to Ally user format', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    driver.setMockBody({
      id: 'user-123',
      displayName: 'John Doe',
      mail: 'john@example.com',
      userPrincipalName: 'john@example.onmicrosoft.com',
    })
    const user = await driver.testGetUserInfo('fake-token')
    assert.equal(user.id, 'user-123')
    assert.equal(user.name, 'John Doe')
    assert.equal(user.nickName, 'John Doe')
    assert.equal(user.email, 'john@example.com')
    assert.equal(user.emailVerificationState, 'unsupported')
    assert.isNull(user.avatarUrl)
  })

  test('falls back to userPrincipalName when mail is null', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    driver.setMockBody({
      id: 'user-456',
      displayName: null,
      mail: null,
      userPrincipalName: 'user@tenant.onmicrosoft.com',
    })
    const user = await driver.testGetUserInfo('fake-token')
    assert.equal(user.email, 'user@tenant.onmicrosoft.com')
    assert.equal(user.name, 'user@tenant.onmicrosoft.com')
  })

  test('original field contains the raw MS Graph body', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    const raw = { id: 'x', displayName: 'X', mail: 'x@x.com', userPrincipalName: 'x@x.com' }
    driver.setMockBody(raw)
    const user = await driver.testGetUserInfo('fake-token')
    assert.deepEqual(user.original, raw)
  })
})

test.group('getUserPhotoAsBase64', (group) => {
  const originalFetch = globalThis.fetch

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
  })

  test('returns null when response is not ok', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    globalThis.fetch = async () => ({ ok: false }) as any
    const result = await driver.testGetUserPhoto('fake-token')
    assert.isNull(result)
  })

  test('returns null when content-type is not an allowed image type', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    globalThis.fetch = async () =>
      ({
        ok: true,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as any
    const result = await driver.testGetUserPhoto('fake-token')
    assert.isNull(result)
  })

  test('returns base64 data URI for valid jpeg photo', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    const fakeBytes = Buffer.from('fake-image-data')
    globalThis.fetch = async () =>
      ({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => fakeBytes.buffer,
      }) as any
    const result = await driver.testGetUserPhoto('fake-token')
    assert.isString(result)
    assert.isTrue(result!.startsWith('data:image/jpeg;base64,'))
  })

  test('fetches the original photo when photoSize is not set', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    let url = ''
    globalThis.fetch = async (u: any) => ((url = String(u)), { ok: false }) as any
    await driver.testGetUserPhoto('fake-token')
    assert.equal(url, 'https://graph.microsoft.com/v1.0/me/photo/$value')
  })

  test('fetches the sized photo when photoSize is set', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), { ...SECRET_CONFIG, photoSize: '96x96' })
    let url = ''
    globalThis.fetch = async (u: any) => ((url = String(u)), { ok: false }) as any
    await driver.testGetUserPhoto('fake-token')
    assert.equal(url, 'https://graph.microsoft.com/v1.0/me/photos/96x96/$value')
  })

  test('returns null when fetch throws', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    globalThis.fetch = async () => {
      throw new Error('network error')
    }
    const result = await driver.testGetUserPhoto('fake-token')
    assert.isNull(result)
  })
})

test.group('Callback state and PKCE binding', () => {
  const STATE_COOKIE = 'microsoft_oauth_state'
  const VERIFIER_COOKIE = 'microsoft_oauth_code_verifier'

  test('stateMisMatch is true when both state cookie and state param are absent', ({ assert }) => {
    const driver = new MicrosoftDriver(createCallbackCtx({ code: 'c' }, {}), SECRET_CONFIG)
    assert.isTrue(driver.stateMisMatch())
  })

  test('stateMisMatch is true when the state param differs from the cookie', ({ assert }) => {
    const ctx = createCallbackCtx(
      { code: 'c', state: 'other' },
      { [STATE_COOKIE]: 'abc', [VERIFIER_COOKIE]: 'v' }
    )
    assert.isTrue(new MicrosoftDriver(ctx, SECRET_CONFIG).stateMisMatch())
  })

  test('stateMisMatch is true when the PKCE verifier cookie is missing', ({ assert }) => {
    const ctx = createCallbackCtx({ code: 'c', state: 'abc' }, { [STATE_COOKIE]: 'abc' })
    assert.isTrue(new MicrosoftDriver(ctx, SECRET_CONFIG).stateMisMatch())
  })

  test('stateMisMatch is false when state and verifier cookies match', ({ assert }) => {
    const ctx = createCallbackCtx(
      { code: 'c', state: 'abc' },
      { [STATE_COOKIE]: 'abc', [VERIFIER_COOKIE]: 'v' }
    )
    assert.isFalse(new MicrosoftDriver(ctx, SECRET_CONFIG).stateMisMatch())
  })

  test('stateMisMatch stays false in stateless mode', ({ assert }) => {
    const driver = new MicrosoftDriver(createCallbackCtx({ code: 'c' }, {}), SECRET_CONFIG)
    assert.isFalse(driver.stateless().stateMisMatch())
  })

  test('user() rejects a callback carrying only a code', async ({ assert }) => {
    const driver = new SpyDriver(createCallbackCtx({ code: 'attacker-code' }, {}), SECRET_CONFIG)
    driver.setPostBody({ access_token: 't' })
    driver.setGetBody({ id: 'attacker-oid' })
    await assert.rejects(() => driver.user(), /state/i)
  })

  test('redirectUrl sends an S256 code_challenge and stores the verifier', async ({ assert }) => {
    const set: Record<string, string> = {}
    const driver = new MicrosoftDriver(createCallbackCtx({}, {}, set), SECRET_CONFIG)
    const url = new URL(await driver.redirectUrl())
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.isString(url.searchParams.get('code_challenge'))
    assert.isString(set[VERIFIER_COOKIE])
  })

  test('user() sends code_verifier and returns tenantId from the id_token', async ({ assert }) => {
    const ctx = createCallbackCtx(
      { code: 'c', state: 'abc' },
      { [STATE_COOKIE]: 'abc', [VERIFIER_COOKIE]: 'verifier-1' }
    )
    const driver = new SpyDriver(ctx, SECRET_CONFIG)
    driver.setPostBody({ access_token: 't', id_token: fakeIdToken({ tid: 'tenant-1' }) })
    driver.setGetBody({ id: 'oid-1', mail: 'a@example.test' })
    const user = await driver.user()
    assert.equal(driver.fields.get('code_verifier'), 'verifier-1')
    assert.equal(user.tenantId, 'tenant-1')
    assert.equal(user.id, 'oid-1')
  })

  test('tenantId is null without an id_token and from userFromToken', async ({ assert }) => {
    const ctx = createCallbackCtx(
      { code: 'c', state: 'abc' },
      { [STATE_COOKIE]: 'abc', [VERIFIER_COOKIE]: 'v' }
    )
    const driver = new SpyDriver(ctx, SECRET_CONFIG)
    driver.setPostBody({ access_token: 't', id_token: 'not-a-jwt' })
    driver.setGetBody({ id: 'oid-1' })
    const fromCallback = await driver.user()
    const fromToken = await driver.userFromToken('t')
    assert.isNull(fromCallback.tenantId)
    assert.isNull(fromToken.tenantId)
  })
})

test.group('2.0 hardening', () => {
  const STATE_COOKIE = 'microsoft_oauth_state'
  const VERIFIER_COOKIE = 'microsoft_oauth_code_verifier'
  const originalFetch = globalThis.fetch

  function boundCtx() {
    return createCallbackCtx(
      { code: 'c', state: 'abc' },
      { [STATE_COOKIE]: 'abc', [VERIFIER_COOKIE]: 'v' }
    )
  }

  test('refreshAccessToken throws when the token endpoint omits access_token', async ({
    assert,
  }) => {
    const driver = new SpyDriver(createCtx(), SECRET_CONFIG)
    driver.setPostBody({ error: 'invalid_grant' })
    await assert.rejects(() => driver.testRefreshAccessToken('rt'), /access_token/)
  })

  test('refreshAccessToken requests JSON parsing', async ({ assert }) => {
    let parsedAs = ''
    class ParseSpy extends MicrosoftDriver {
      protected override httpClient(_url: string): any {
        const req: any = {
          header: () => req,
          field: () => req,
          parseAs: (t: string) => ((parsedAs = t), req),
          post: async () => ({ access_token: 't', expires_in: 60, scope: '' }),
        }
        return req
      }
      run() {
        return this.refreshAccessToken('rt')
      }
    }
    await new ParseSpy(createCtx(), SECRET_CONFIG).run()
    assert.equal(parsedAs, 'json')
  })

  test('getUserPhotoAsBase64 returns null when the body exceeds the size cap', async ({
    assert,
  }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    globalThis.fetch = async () =>
      ({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new ArrayBuffer(2_000_001),
      }) as any
    try {
      assert.isNull(await driver.testGetUserPhoto('fake-token'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('getUserPhotoAsBase64 passes an abort signal', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    let hadSignal = false
    globalThis.fetch = async (_u: any, init: any) => (
      (hadSignal = init?.signal instanceof AbortSignal),
      { ok: false } as any
    )
    try {
      await driver.testGetUserPhoto('fake-token')
      assert.isTrue(hadSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('user() marks the email verified from the xms_edov claim', async ({ assert }) => {
    const driver = new SpyDriver(boundCtx(), SECRET_CONFIG)
    driver.setPostBody({ access_token: 't', id_token: fakeIdToken({ tid: 't1', xms_edov: true }) })
    driver.setGetBody({ id: 'oid', mail: 'person@contoso.com' })
    const user = await driver.user()
    assert.equal(user.emailVerificationState, 'verified')
    assert.equal(user.tenantId, 't1')
  })

  test('user() marks the email unverified when xms_edov is false', async ({ assert }) => {
    const driver = new SpyDriver(boundCtx(), SECRET_CONFIG)
    driver.setPostBody({ access_token: 't', id_token: fakeIdToken({ tid: 't1', xms_edov: false }) })
    driver.setGetBody({ id: 'oid', mail: 'person@contoso.com' })
    const user = await driver.user()
    assert.equal(user.emailVerificationState, 'unverified')
  })

  test('user() keeps emailVerificationState unsupported without the claim', async ({ assert }) => {
    const driver = new SpyDriver(boundCtx(), SECRET_CONFIG)
    driver.setPostBody({ access_token: 't', id_token: fakeIdToken({ tid: 't1' }) })
    driver.setGetBody({ id: 'oid', mail: 'person@contoso.com' })
    const user = await driver.user()
    assert.equal(user.emailVerificationState, 'unsupported')
  })
})
