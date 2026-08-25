/**
 * host/routes.ts — the one HTTP endpoint this companion serves:
 * GET/PUT `/api/motion-pet-physics/config` on the bare node:http the DSH
 * webServer service exposes (same hand-rolled method dispatch / body parsing
 * / error mapping pattern as the main plugin's host/routes.ts, M0 finding §6
 * there — copied semantics, independent code).
 *
 * - GET returns `{ config }`; read-only, never origin-guarded.
 * - PUT accepts a partial or complete config; validation and the atomic
 *   merge-write live in PhysicsConfigStore (reject, never clamp: 400
 *   INVALID_CONFIG with per-field paths and expected ranges).
 * - PUT is fenced against cross-origin writes (Sec-Fetch-Site / Origin
 *   metadata; non-browser clients without metadata stay allowed) — the same
 *   §20 defense-in-depth the main plugin adopted for its write routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ThrowPhysicsPluginConfig } from '../client/config'
import { ConfigValidationError } from './config'

const CONFIG_PATH = '/api/motion-pet-physics/config'
/** 16 fields of small numbers; 16 KiB is orders of magnitude beyond need. */
const JSON_BODY_LIMIT = 16 * 1024

/** Everything the routes need from persistence, injected for tests. */
export interface ConfigRoutesDeps {
  loadConfig(): Promise<ThrowPhysicsPluginConfig>
  updateConfig(patch: unknown): Promise<ThrowPhysicsPluginConfig>
}

/** Minimal slice of the host context the route registers against. */
export interface ConfigRoutesHost {
  webServer: {
    register(route: WebRoute): () => void
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  sendJson(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } })
}

/** Unified error → HTTP mapping; the handler throws, the wrapper answers. */
function mapError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof HttpError) {
    sendError(res, error.status, error.code, error.message, error.details)
    return
  }
  if (error instanceof ConfigValidationError) {
    sendError(res, 400, 'INVALID_CONFIG', error.message, error.issues)
    return
  }
  sendError(res, 500, 'INTERNAL', 'internal error')
}

/** Read a request body with a hard size cap (drains on overflow). */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) {
      req.resume()
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`)
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/**
 * Cross-origin write fence (main-plugin semantics, external review EXT-2
 * there): browser writes must be same-origin. CORS "simple" requests never
 * preflight, so a malicious page could otherwise PUT config cross-origin
 * with side effects landing even though the response is blocked. Non-browser
 * clients (no Sec-Fetch-Site / Origin metadata — curl, the CLI) stay
 * allowed; GETs are read-only and never guarded.
 */
function rejectsCrossOriginWrite(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'cross-site'
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      // Same-origin writes carry an Origin matching the Host header; 'null'
      // (file://, sandboxed iframes) and foreign hosts are rejected.
      return new URL(origin).host !== req.headers.host
    } catch {
      return true
    }
  }
  return false
}

async function handleConfig(req: IncomingMessage, res: ServerResponse, deps: ConfigRoutesDeps): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, { config: await deps.loadConfig() })
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    // Strict validation against the current on-disk config + atomic save —
    // serialized inside updateConfig so overlapping PUTs cannot lose fields.
    const config = await deps.updateConfig(raw)
    sendJson(res, 200, { config })
    return
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET or PUT')
}

/** Register the config route; the returned disposer unregisters it. */
export function registerConfigRoutes(host: ConfigRoutesHost, deps: ConfigRoutesDeps): () => void {
  const handler: WebRoute['handler'] = async (req, res) => {
    try {
      if (rejectsCrossOriginWrite(req)) {
        throw new HttpError(403, 'CROSS_ORIGIN', 'cross-origin writes are not allowed')
      }
      if (parsePathname(req.url) !== CONFIG_PATH) {
        // The exact dispatch should never land anything else here; guard anyway.
        throw new HttpError(404, 'NOT_FOUND', 'unknown route')
      }
      await handleConfig(req, res, deps)
    } catch (error) {
      mapError(res, error)
    }
  }
  return host.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler })
}
