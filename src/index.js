/**
 * dsh-hub-utils: host half.
 *
 * The panel itself lives in the browser half. This half provides the two
 * actions that need the host process: a bounded exit (`appExit`), the same path
 * `dsh web` takes on SIGTERM, so the tree is disposed and the session log is
 * flushed rather than dropped; and a workspace-file download route, because a
 * browser that reaches the instance through a hub cannot read the host's files
 * directly.
 *
 * A plugin route is not covered by the browser fence automatically — the web
 * server hands registered routes the raw request — so each handler applies it
 * through `ctx.connection.admit` itself. Network position is not treated as
 * authority: the backend port is reachable by root, by its own user, and
 * (without the supervisor's iptables guard) by every other local user.
 *
 * The download route is confined to the live Session's workspace: the path is
 * resolved below that root, the final entry must be a regular file, and the
 * resolved target must stay inside the root. Raw host paths never appear in an
 * error body.
 */

import { once } from 'node:events'
import path from 'node:path'

/** Unique across the profile: the loader rejects two rows with one id. */
export const id = 'dsh-hub-utils'

/** The web server, the browser auth service, and the workspace file sources. */
export const inject = ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy']

/** Where the browser half posts, and the header it must carry. */
export const QUIT_PATH = '/dsh-hub-utils/quit'

/** The request header the quit route requires, which a cross-site form cannot set. */
export const QUIT_HEADER = 'x-dsh-hub-utils'

/** Where the browser asks for one workspace file; the route streams it as an attachment. */
export const DOWNLOAD_PATH = '/dsh-hub-utils/download'

/** How long the process waits after replying, so the browser reads the answer first. */
const QUIT_DELAY_MS = 100

/** Largest slice read from the filesystem between writes to the response. */
const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024

/**
 * Register the quit and download routes.
 * @param ctx - the plugin context, carrying the web server.
 */
export function apply(ctx) {
  // Only a hub-spawned instance exposes these routes; a bare `dsh web` keeps its
  // original surface. The hub sets this marker in the spawned environment.
  if (process.env.DSH_HUB !== '1') return
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: QUIT_PATH,
    handler: (req, res) => { handleQuit(ctx, req, res) },
  }), 'dsh-hub-utils: quit route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DOWNLOAD_PATH,
    handler: (req, res) => handleDownload(ctx, req, res),
  }), 'dsh-hub-utils: download route')
}

/**
 * Answer one request to the quit route, asking the launcher to exit on success.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response the handler owns.
 */
function handleQuit(ctx, req, res) {
  // The same gate the index and every `/api` channel pass: the Host/Origin fence
  // first, then the authority-bound `dsh-auth-*` browser cookie.
  const admission = ctx.connection.admit(req)
  if (admission.rejection !== undefined) {
    respond(res, admission.rejection, admission.rejection === 401
      ? 'dsh web authentication required; reopen the URL printed by dsh web.'
      : 'request rejected by the Host/Origin fence')
    return
  }
  if (req.method !== 'POST') {
    respond(res, 405, 'POST only', { allow: 'POST' })
    return
  }
  // A cross-site form can send a POST but cannot attach a custom header, so it
  // cannot reach the exit even if it ever obtained a session cookie.
  if (req.headers[QUIT_HEADER] !== 'quit') {
    respond(res, 403, `missing the ${QUIT_HEADER}: quit header`)
    return
  }
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    respond(res, 500, 'this host provides no appExit: the quit action needs a launcher that owns shutdown')
    return
  }
  ctx.logger.info('dsh-hub-utils: quit requested; closing this instance')
  respond(res, 200, '{"ok":true}', { 'content-type': 'application/json', 'cache-control': 'no-store' })
  // `finish` means the response reached the socket; the short delay above all
  // gives the browser time to read it before this process starts going away.
  res.once('finish', () => {
    setTimeout(() => { exit(0) }, QUIT_DELAY_MS)
  })
}

/**
 * Stream one regular file from a Session's workspace as a download.
 *
 * `content-disposition: attachment` makes this a native browser download with
 * the browser's own progress UI; the body is written in slices instead of
 * buffering the file. A range is deliberately not accepted here: the caller
 * asks for the whole file and the browser owns retry/resume behavior.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response the handler owns.
 */
async function handleDownload(ctx, req, res) {
  const admission = ctx.connection.admit(req)
  if (admission.rejection !== undefined) {
    respond(res, admission.rejection, admission.rejection === 401
      ? 'dsh web authentication required; reopen the URL printed by dsh web.'
      : 'request rejected by the Host/Origin fence')
    return
  }
  if (req.method !== 'GET') {
    respond(res, 405, 'GET only', { allow: 'GET' })
    return
  }
  const url = new URL(req.url, 'http://localhost')
  const sessionId = url.searchParams.get('session') ?? ''
  const filePath = url.searchParams.get('path') ?? ''
  if (sessionId === '' || filePath === '') {
    respond(res, 400, 'session and path are required')
    return
  }
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    respond(res, 404, 'file not found')
    return
  }
  const workspaceRoot = session.header?.cwd ?? ctx.sandboxPolicy.workspaceRoot
  let target
  let info
  try {
    const root = await ctx.fs.resolve(workspaceRoot)
    const entry = await ctx.fs.lstat(filePath, { cwd: workspaceRoot })
    if (entry === undefined || entry.type !== 'file') {
      respond(res, 404, 'file not found')
      return
    }
    target = await ctx.fs.resolve(filePath, { cwd: workspaceRoot })
    if (!ctx.fs.contains(root, target)) {
      respond(res, 404, 'file not found')
      return
    }
    info = await ctx.fs.stat(target)
  } catch (err) {
    respond(res, 404, 'file not found')
    return
  }
  if (info === undefined || info.type !== 'file') {
    respond(res, 404, 'file not found')
    return
  }
  const filename = path.posix.basename(filePath)
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    ...(info.size === undefined ? {} : { 'content-length': String(info.size) }),
    'content-disposition': attachmentHeader(filename),
    'cache-control': 'no-store',
  })
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)
  try {
    let offset = 0
    const total = info.size ?? Number.MAX_SAFE_INTEGER
    while (offset < total) {
      const length = Math.min(DOWNLOAD_CHUNK_BYTES, total - offset)
      const chunk = await ctx.fs.readByteRange(target, { offset, length }, controller.signal)
      if (chunk.length === 0) break
      offset += chunk.length
      if (!res.write(chunk)) {
        // A client abort can strand a pending drain; the abort signal wakes it.
        await Promise.race([once(res, 'drain'), once(controller.signal, 'abort')])
      }
      if (chunk.length < length) break
    }
    res.end()
  } catch (err) {
    if (!controller.signal.aborted && !res.destroyed) res.destroy()
  } finally {
    res.off('close', onClose)
  }
}

/**
 * Build the attachment header, with an ASCII fallback and the exact UTF-8 name.
 * @param name - the file's basename.
 * @returns the header value.
 */
function attachmentHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * Write one small plain response.
 * @param res - the response to write.
 * @param status - the status code.
 * @param body - the body text.
 * @param headers - extra headers; a text content type is supplied when absent.
 */
function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body + '\n')
}
