/**
 * Host route tests: the registered config handler is wired into a real
 * `node:http` server (exact-route dispatch, mirroring the DSH webServer) and
 * exercised with real fetch calls — GET defaults, PUT roundtrip + disk
 * persistence, validation failures, the cross-origin write fence, corrupt
 * file self-healing, and concurrent PUT serialization.
 *
 * Pattern follows the main plugin's tests/host/routes.test.ts (real server +
 * tmpdir store; the store's own update() chain provides the serialization).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_CONFIG, type ThrowPhysicsPluginConfig } from '../../src/client/config'
import { PhysicsConfigStore, repairConfig, validateConfigPatch } from '../../src/host/config'
import { registerConfigRoutes, type ConfigRoutesDeps } from '../../src/host/routes'

let dir: string
let server: Server
let base: string
let disposeRoutes: () => void
let store: PhysicsConfigStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'motion-pet-physics-routes-'))
  store = new PhysicsConfigStore({ configPath: join(dir, 'config.json') })
  const deps: ConfigRoutesDeps = {
    loadConfig: () => store.load(),
    updateConfig: (patch) => store.update(patch),
  }
  const routes: WebRoute[] = []
  disposeRoutes = registerConfigRoutes(
    {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {
            routes.splice(routes.indexOf(route), 1)
          }
        },
      },
    },
    deps,
  )
  // Dispatch exactly like the DSH webServer: the exact table first.
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(
      (candidate) => candidate.kind === 'exact' && candidate.path === pathname,
    )
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  disposeRoutes()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

const CONFIG_URL = '/api/motion-pet-physics/config'

const put = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${CONFIG_URL}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('GET /api/motion-pet-physics/config', () => {
  it('returns defaults when no file exists on disk', async () => {
    const res = await fetch(`${base}${CONFIG_URL}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).config).toEqual(DEFAULT_CONFIG)
  })

  it('returns the persisted config after a save', async () => {
    await put({ physics: { gravity: 5000 } })
    const got = await (await fetch(`${base}${CONFIG_URL}`)).json()
    expect(got.config.physics.gravity).toBe(5000)
    // Untouched fields keep their defaults (partial PUT semantics).
    expect(got.config.physics.restitution).toBe(DEFAULT_CONFIG.physics.restitution)
    expect(got.config.sampleWindowMs).toBe(DEFAULT_CONFIG.sampleWindowMs)
  })

  it('rejects other methods', async () => {
    const res = await fetch(`${base}${CONFIG_URL}`, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })
})

describe('PUT /api/motion-pet-physics/config', () => {
  it('accepts a full card draft — every field of every section, slide fields included', async () => {
    // The settings card PUTs complete drafts. This round-trip locks the
    // card↔validator shape agreement: a field the card can send but the
    // host allowlist forgets ("unknown field") surfaced to a user once
    // (stale host) and must never surface from a mismatched source tree.
    const draft = {
      physics: {
        gravity: 4200,
        restitution: 0.55,
        friction: 0.1,
        throwMultiplier: 1.2,
        minThrowSpeed: 300,
        settleSpeed: 140,
        maxSpeed: 3800,
        maxFlightMs: 15_000,
        minBounceHeightPx: 20,
        groundFriction: 3,
      },
      bounceAnimation: { enabled: true, id: 'user:physics-bounce-pop', interrupt: true },
      flashPose: { enabled: true, poseKey: 'error', holdMs: 900 },
      slideAnimationId: 'user:physics-slide-dash',
      sampleWindowMs: 140,
      effectDebounceMs: 180,
      applyFalseTolerance: 3,
    }
    const res = await put(draft)
    expect(res.status).toBe(200)
    expect((await res.json()).config).toEqual(draft)
    const got = await (await fetch(`${base}${CONFIG_URL}`)).json()
    expect(got.config).toEqual(draft)
  })

  it('persists a valid partial patch to disk (atomic write lands)', async () => {
    const res = await put({ physics: { gravity: 4200, friction: 0.2 }, effectDebounceMs: 200 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: ThrowPhysicsPluginConfig }
    expect(body.config.physics.gravity).toBe(4200)
    expect(body.config.physics.friction).toBe(0.2)
    expect(body.config.effectDebounceMs).toBe(200)
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual(body.config)
  })

  it('rejects unknown top-level fields with 400 INVALID_CONFIG', async () => {
    const res = await put({ physics: { gravity: 3000 }, injected: 'x' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toEqual([{ path: 'injected', message: 'unknown field' }])
  })

  it('rejects unknown section fields with 400 and the field path', async () => {
    const res = await put({ physics: { gravityy: 1 } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toEqual([{ path: 'physics.gravityy', message: 'unknown field' }])
  })

  it('rejects out-of-range numbers with the expected range in the message', async () => {
    const res = await put({ physics: { gravity: 99 } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toEqual([
      { path: 'physics.gravity', message: 'expected a number between 100 and 100000' },
    ])
  })

  it('rejects wrong types and non-integer tolerance', async () => {
    const badBool = await put({ bounceAnimation: { enabled: 'yes' } })
    expect(badBool.status).toBe(400)
    expect(((await badBool.json()) as { error: { details: unknown[] } }).error.details).toEqual([
      { path: 'bounceAnimation.enabled', message: 'expected a boolean' },
    ])
    const badInt = await put({ applyFalseTolerance: 2.5 })
    expect(badInt.status).toBe(400)
    const badPose = await put({ flashPose: { poseKey: 'sleeping' } })
    expect(badPose.status).toBe(400)
    expect(((await badPose.json()) as { error: { details: Array<{ message: string }> } }).error.details[0].message).toContain('idle')
  })

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await put('{ nope', { 'content-type': 'application/json' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON')
    const huge = await put(`{"pad":"${'x'.repeat(20 * 1024)}"}`)
    expect(huge.status).toBe(413)
  })

  it('serializes concurrent partial PUTs: no lost update', async () => {
    const [a, b] = await Promise.all([
      put({ physics: { gravity: 5000 } }),
      put({ effectDebounceMs: 300 }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const got = await (await fetch(`${base}${CONFIG_URL}`)).json()
    expect(got.config.physics.gravity).toBe(5000)
    expect(got.config.effectDebounceMs).toBe(300)
  })

  it('fences cross-origin writes (403) but allows metadata-less clients', async () => {
    const crossSite = await fetch(`${base}${CONFIG_URL}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ physics: { gravity: 5000 } }),
    })
    expect(crossSite.status).toBe(403)
    expect(((await crossSite.json()) as { error: { code: string } }).error.code).toBe('CROSS_ORIGIN')

    const foreignOrigin = await fetch(`${base}${CONFIG_URL}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ physics: { gravity: 5000 } }),
    })
    expect(foreignOrigin.status).toBe(403)

    // No Sec-Fetch-Site / Origin metadata (curl, CLI): allowed.
    const curlish = await put({ physics: { gravity: 5000 } })
    expect(curlish.status).toBe(200)
  })

  it('allows a same-origin Origin (M5b): Origin matching the Host header passes', async () => {
    const sameOrigin = await fetch(`${base}${CONFIG_URL}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ physics: { gravity: 5000 } }),
    })
    expect(sameOrigin.status).toBe(200)
    expect(((await sameOrigin.json()) as { config: ThrowPhysicsPluginConfig }).config.physics.gravity).toBe(5000)
  })

  it("rejects an opaque 'null' Origin (M5b): sandboxed frames and file:// pages cannot write", async () => {
    const nullOrigin = await fetch(`${base}${CONFIG_URL}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ physics: { gravity: 5000 } }),
    })
    expect(nullOrigin.status).toBe(403)
    expect(((await nullOrigin.json()) as { error: { code: string } }).error.code).toBe('CROSS_ORIGIN')
  })
})

describe('corrupt / hand-edited config file', () => {
  it('a corrupt file falls back to defaults, warns, and rewrites the defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await writeFile(join(dir, 'config.json'), '{ not json', 'utf8')
      const got = await (await fetch(`${base}${CONFIG_URL}`)).json()
      expect(got.config).toEqual(DEFAULT_CONFIG)
      // Self-healed on disk: the file is now the valid defaults.
      expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual(DEFAULT_CONFIG)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a hand-edited file with wrong fields keeps the known-good parts and repairs the rest', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ physics: { gravity: 6000, bogus: 1 }, unknownSection: true, sampleWindowMs: 200 }),
      'utf8',
    )
    const got = await (await fetch(`${base}${CONFIG_URL}`)).json()
    expect(got.config.physics.gravity).toBe(6000) // the sane hand edit survives
    expect(got.config.sampleWindowMs).toBe(200)
    expect(got.config.physics).not.toHaveProperty('bogus') // unknown dropped
    expect(got.config).not.toHaveProperty('unknownSection')
    expect(got.config.bounceAnimation).toEqual(DEFAULT_CONFIG.bounceAnimation)
  })
})

describe('validation helpers', () => {
  it('validateConfigPatch merges a partial patch onto the base and clones it', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    const merged = validateConfigPatch({ physics: { restitution: 0.9 } }, base)
    expect(merged.physics.restitution).toBe(0.9)
    expect(merged.physics.gravity).toBe(base.physics.gravity)
    merged.physics.gravity = 1
    expect(base.physics.gravity).toBe(DEFAULT_CONFIG.physics.gravity) // no shared refs
  })

  it('repairConfig resets everything unknown or invalid onto defaults', () => {
    const repaired = repairConfig({ physics: { restitution: 'loud' }, sampleWindowMs: 400 })
    expect(repaired.physics.restitution).toBe(DEFAULT_CONFIG.physics.restitution)
    expect(repaired.sampleWindowMs).toBe(400)
    expect(repaired).toEqual({ ...structuredClone(DEFAULT_CONFIG), sampleWindowMs: 400 })
  })
})
