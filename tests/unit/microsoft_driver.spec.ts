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
// TestDriver — exposes protected methods for direct testing
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

  test('returns null when fetch throws', async ({ assert }) => {
    const driver = new TestDriver(createCtx(), SECRET_CONFIG)
    globalThis.fetch = async () => {
      throw new Error('network error')
    }
    const result = await driver.testGetUserPhoto('fake-token')
    assert.isNull(result)
  })
})
