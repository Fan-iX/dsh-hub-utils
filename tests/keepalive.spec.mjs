// Tests for dsh-hub-utils: the host half's quit and download routes, the browser
// half's sidebar action and document-header download action, and the panel's
// keep-alive and quit exchanges (including the quit confirmation stacked on top
// of the panel). The host half imports nothing, so this suite needs no SDK link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  apply as hostApply, DOWNLOAD_PATH, id as pluginId, inject as hostInject, QUIT_HEADER, QUIT_PATH,
} from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(root, 'client', 'index.js')
const source = readFileSync(BUNDLE, 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The shell's baseline module table; a dynamic bundle may require nothing else. */
const BASELINE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])

let registration
globalThis.window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  __DSH_HUB__: { version: 1 },
}
await import(pathToFileURL(BUNDLE).href)

// The host half only mounts under a hub-spawned process.
process.env.DSH_HUB = '1'

// --- the host half ----------------------------------------------------------

/** A response stub recording status, headers, chunks, and the `finish` listener. */
const makeRes = () => ({
  status: undefined,
  headers: undefined,
  body: undefined,
  finish: undefined,
  chunks: [],
  headersSent: false,
  writableEnded: false,
  destroyed: false,
  writeHead(status, headers) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  },
  write(chunk) {
    this.chunks.push(Buffer.from(chunk))
    return true
  },
  end(body) {
    if (body !== undefined) this.body = body
    this.writableEnded = true
  },
  once(event, listener) { if (event === 'finish') this.finish = listener },
  on() {},
  off() {},
  destroy() { this.destroyed = true },
})

/** One regular five-byte file behind the filesystem face. */
const makeFileFs = ({ type = 'file', contained = true, data = [1, 2, 3, 4, 5] } = {}) => ({
  resolve: async (value) => ({ path: value }),
  lstat: async () => ({ type }),
  contains: () => contained,
  stat: async () => ({ type, size: data.length, version: 'v1' }),
  readByteRange: async (_target, { offset, length }) => new Uint8Array(data.slice(offset, offset + length)),
})

/** The registered route at one path. */
const routeAt = (seen, path) => seen.routes.find((route) => route.path === path)

/**
 * A context stub that records routes, the log, and every exit request.
 * @param options.appExit - the launcher's exit request, or undefined to model a host without one.
 * @param options.rejection - what `connection.admit` answers; undefined means admitted.
 * @param options.fs - the filesystem stub; defaults to a readable five-byte file.
 * @param options.sessions - the session lookup; defaults to no sessions.
 */
const makeCtx = ({ appExit, rejection, fs, sessions } = {}) => {
  const seen = { routes: [], route: undefined, exits: [], logs: [], admittances: 0 }
  seen.ctx = {
    effect: (register) => { register(); return () => {} },
    get: (name) => name === 'appExit' ? appExit : undefined,
    logger: { info: (...args) => { seen.logs.push(args.join(' ')) } },
    webServer: {
      register: (route) => {
        seen.routes.push(route)
        if (seen.route === undefined) seen.route = route
        return () => {}
      },
    },
    connection: {
      admit: () => {
        seen.admittances += 1
        return rejection === undefined ? { peer: 'operator' } : { rejection }
      },
    },
    fs: fs ?? makeFileFs(),
    sessions: sessions ?? { get: () => undefined },
    sandboxPolicy: { workspaceRoot: '/workspace' },
  }
  return seen
}

test('the host half declares its route and its gates', () => {
  assert.equal(pluginId, 'dsh-hub-utils')
  assert.deepEqual(hostInject, ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy'])
  assert.equal(QUIT_PATH, '/dsh-hub-utils/quit')
  assert.equal(QUIT_HEADER, 'x-dsh-hub-utils')
})

test('the host half mounts exact routes at its exported paths', () => {
  const seen = makeCtx()
  hostApply(seen.ctx)
  assert.deepEqual(seen.routes.map((route) => route.path), [QUIT_PATH, DOWNLOAD_PATH])
  assert.ok(seen.routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'))
})

test('a bare dsh web registers no quit route', () => {
  const previous = process.env.DSH_HUB
  delete process.env.DSH_HUB
  try {
    const seen = makeCtx({ appExit: () => {} })
    hostApply(seen.ctx)
    assert.deepEqual(seen.routes, [])
  } finally {
    process.env.DSH_HUB = previous
  }
})

test('an unauthenticated request is refused the way the index and /api refuse it', () => {
  const seen = makeCtx({ appExit: () => {}, rejection: 401 })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'POST', headers: { [QUIT_HEADER]: 'quit' } }, res)
  assert.equal(res.status, 401)
  assert.match(res.body, /authentication required/)
  assert.deepEqual(seen.exits, [])
})

test('a request the Host/Origin fence rejects never reaches the launcher', () => {
  const seen = makeCtx({ appExit: () => {}, rejection: 403 })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'POST', headers: { [QUIT_HEADER]: 'quit' } }, res)
  assert.equal(res.status, 403)
  assert.match(res.body, /Host\/Origin fence/)
  assert.deepEqual(seen.exits, [])
})

test('a non-POST is refused without asking the launcher to exit', () => {
  const seen = makeCtx({ appExit: () => {} })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
  assert.deepEqual(seen.exits, [])
})

test('a POST without the confirmation header is refused', () => {
  const seen = makeCtx({ appExit: () => {} })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'POST', headers: {} }, res)
  assert.equal(res.status, 403)
  assert.match(res.body, /x-dsh-hub-utils/)
  assert.deepEqual(seen.exits, [])
})

test('a host without appExit fails loudly instead of pretending to stop', () => {
  const seen = makeCtx({ appExit: undefined })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'POST', headers: { [QUIT_HEADER]: 'quit' } }, res)
  assert.equal(res.status, 500)
  assert.match(res.body, /appExit/)
  assert.deepEqual(seen.exits, [])
})

test('an accepted request answers first, then asks the launcher to exit', async () => {
  const seen = makeCtx({ appExit: (code) => { seen.exits.push(code) } })
  hostApply(seen.ctx)
  const res = makeRes()
  seen.route.handler({ method: 'POST', headers: { [QUIT_HEADER]: 'quit' } }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body, '{"ok":true}\n')
  assert.deepEqual(seen.exits, [], 'the browser must have its answer before the process leaves')
  assert.equal(typeof res.finish, 'function', 'the exit must wait for the response to flush')

  res.finish()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(seen.exits, [0])
})

// --- the download route -----------------------------------------------------

const downloadRequest = (query) => ({
  method: 'GET',
  url: `${DOWNLOAD_PATH}?${new URLSearchParams(query).toString()}`,
  headers: {},
})

test('an unauthenticated download is refused like every other route', async () => {
  const seen = makeCtx({ rejection: 401 })
  hostApply(seen.ctx)
  const res = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ session: 's1', path: 'a.txt' }), res)
  assert.equal(res.status, 401)
  assert.equal(res.chunks.length, 0)
})

test('a download request outside GET is refused', async () => {
  const seen = makeCtx()
  hostApply(seen.ctx)
  const res = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler({ method: 'POST', url: DOWNLOAD_PATH, headers: {} }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET')
})

test('a download request without a session or path is refused', async () => {
  const seen = makeCtx()
  hostApply(seen.ctx)
  const missingSession = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ path: 'a.txt' }), missingSession)
  assert.equal(missingSession.status, 400)
  const missingPath = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ session: 's1' }), missingPath)
  assert.equal(missingPath.status, 400)
})

test('an unknown session downloads nothing', async () => {
  const seen = makeCtx()
  hostApply(seen.ctx)
  const res = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ session: 'gone', path: 'a.txt' }), res)
  assert.equal(res.status, 404)
})

test('only a regular file inside the session workspace is downloadable', async () => {
  for (const fs of [
    makeFileFs({ type: 'directory' }),
    makeFileFs({ type: 'symlink' }),
    makeFileFs({ contained: false }),
  ]) {
    const seen = makeCtx({ fs, sessions: { get: () => ({ header: { cwd: '/workspace' } }) } })
    hostApply(seen.ctx)
    const res = makeRes()
    await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ session: 's1', path: 'a.txt' }), res)
    assert.equal(res.status, 404)
    assert.equal(res.chunks.length, 0)
  }
})

test('an admitted download answers as an attachment and streams every byte', async () => {
  const seen = makeCtx({
    fs: makeFileFs({ data: [1, 2, 3, 4, 5] }),
    sessions: { get: (id) => id === 's1' ? { header: { cwd: '/workspace' } } : undefined },
  })
  hostApply(seen.ctx)
  const res = makeRes()
  await routeAt(seen, DOWNLOAD_PATH).handler(downloadRequest({ session: 's1', path: 'dir/a b.txt' }), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['content-length'], '5')
  assert.match(res.headers['content-disposition'], /^attachment; filename="a b\.txt"; filename\*=UTF-8''a%20b\.txt$/)
  assert.deepEqual(Buffer.concat(res.chunks), Buffer.from([1, 2, 3, 4, 5]))
  assert.equal(res.writableEnded, true)
})

// --- the browser half -------------------------------------------------------

const stubRequire = (specifier) => {
  if (specifier === 'react') return { useState: (initial) => [initial, () => {}], useEffect: () => {}, useRef: (value) => ({ current: value }) }
  if (specifier === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Button: 'Button',
      Modal: 'Modal',
      Switch: 'Switch',
      Tooltip: 'Tooltip',
      IconQuestionOutlineRegular: 'IconQuestionOutlineRegular',
      IconSlidersTwoOutlineRegular: 'IconSlidersTwoOutlineRegular',
      IconDownloadOutlineRegular: 'IconDownloadOutlineRegular',
    }
  }
  throw new Error(`the bundle required an undeclared external: ${specifier}`)
}

const baseState = () => ({
  open: false,
  keep: { phase: 'loading', keepAlive: false, busy: false, failed: false },
  quit: 'idle',
  confirmOpen: false,
})

const readyKeep = (keepAlive) => ({ phase: 'ready', keepAlive, busy: false, failed: false })

/**
 * A hook stub with one `useState` that applies functional updates and records
 * them, so one render models one state and a setter can be inspected.
 * @param initial - the state this mount should start from.
 */
const makeHooks = (initial) => {
  const seen = { state: initial, transitions: [], effects: [] }
  return {
    seen,
    react: {
      useState: () => [seen.state, (next) => {
        seen.state = typeof next === 'function' ? next(seen.state) : next
        seen.transitions.push(seen.state)
      }],
      useEffect: (fn, deps) => { seen.effects.push({ fn, deps }) },
      useRef: (value) => ({ current: value }),
    },
  }
}

/** Install the plugin with controllable hooks and hand back the action. */
const mountAction = (initial) => {
  const hooks = makeHooks(initial)
  let component
  let documentAction
  registration.factory((specifier) => (specifier === 'react' ? hooks.react : stubRequire(specifier))).apply({
    locale: { register: () => () => {} },
    effect: (register) => { register(); return () => {} },
    slots: {
      inject: (name, contribute) => contribute(),
      register: (options, value) => {
        if (options.name === 'sidebar.right.tab.document.actions') documentAction = value
        else component = value
        return () => {}
      },
    },
  })
  return { component, hooks, documentAction, render: (props = {}) => component({ t: (key) => key, wide: true, ...props }) }
}

/** Visit every element node in a render tree, including a modal's footer prop. */
const walk = (node, visit) => {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') return
  visit(node)
  const children = node.props?.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
  if (node.props?.footer !== undefined) walk(node.props.footer, visit)
}

const findAll = (tree, type) => {
  const found = []
  walk(tree, (node) => { if (node.type === type) found.push(node) })
  return found
}

const find = (tree, type) => findAll(tree, type)[0]

/** The first Button whose text is `label`. */
const button = (tree, label) => findAll(tree, 'Button').find((node) => node.props?.children === label)

/** Every text leaf, joined, for copy assertions. */
const text = (tree) => {
  const parts = []
  walk(tree, (node) => {
    if (typeof node.props?.children === 'string') parts.push(node.props.children)
  })
  return parts.join(' ')
}

/** The panel dialog and the quit confirmation stacked above it. */
const dialogs = (tree) => findAll(tree, 'Modal')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the manifest declares a web client half alongside the host half', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['.'].default, './src/index.js')
  assert.equal(pkg.exports['./client'].default, './client/index.js')
  assert.ok(pkg.files.includes('client'))
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  ])
})

test('the bundle registers its own id and requires only baseline externals', () => {
  assert.equal(registration.id, 'dsh-hub-utils')
  const specifiers = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) {
    assert.ok(!specifier.startsWith('.'), `relative require is unsupported by the runtime: ${specifier}`)
    assert.ok(BASELINE.has(specifier), `not a baseline external: ${specifier}`)
  }
})

test('the browser half mounts the sidebar action and the document download action', () => {
  const registrations = []
  const face = registration.factory(stubRequire)
  face.apply({
    locale: { register: () => () => {} },
    effect: (register) => { register(); return () => {} },
    slots: {
      inject: (name, contribute) => contribute(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  })
  assert.equal(registrations.length, 2)
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.footer.action')
  const documentAction = registrations.find((entry) => entry.options.name === 'sidebar.right.tab.document.actions')
  assert.equal(sidebar.options.id, 'dsh-hub-utils')
  assert.equal(sidebar.options.locale, 'settings.dshHubUtils')
  assert.equal(documentAction.options.id, 'dsh-hub-utils')
  assert.equal(documentAction.options.locale, 'settings.dshHubUtils')
  assert.deepEqual(face.inject, ['slots', 'locale'])
})

test('outside dsh-hub the sidebar action is not contributed', () => {
  const marker = globalThis.window.__DSH_HUB__
  delete globalThis.window.__DSH_HUB__
  try {
    const registrations = []
    const effects = []
    registration.factory(stubRequire).apply({
      locale: { register: () => () => {} },
      effect: (register) => { effects.push(register); register(); return () => {} },
      slots: {
        inject: (name, contribute) => contribute(),
        register: (options) => { registrations.push(options); return () => {} },
      },
    })
    assert.equal(registrations.length, 0)
    assert.equal(effects.length, 0, 'no styles, dictionaries, or slot work either')
  } finally {
    globalThis.window.__DSH_HUB__ = marker
  }
})

test('the action shows the panel icon, its label only when wide, and opens the panel', () => {
  const { render, hooks } = mountAction(baseState())
  const wide = button(render(), 'action')
  assert.equal(wide.type, 'Button')
  assert.equal(wide.props.icon.props.children.type, 'IconSlidersTwoOutlineRegular')
  assert.equal(wide.props['aria-label'], 'action')
  assert.equal(wide.props.children, 'action')

  wide.props.onClick()
  assert.equal(hooks.seen.state.open, true, 'the first press only opens the panel')

  assert.equal(button(render({ wide: false }), 'action'), undefined, 'the 56px rail shows the icon alone')
})

test('the panel carries the keep-alive and quit controls', () => {
  const { render } = mountAction({ ...baseState(), open: true, keep: readyKeep(true) })
  const tree = render()
  const panel = dialogs(tree)[0]
  assert.equal(panel.props.open, true)
  assert.equal(panel.props.title, 'panelTitle')
  assert.equal(find(tree, 'Switch').props.checked, true)
  assert.match(text(tree), /keepTitle/)
  assert.match(text(tree), /keepOn/, 'the on/off caption survives')
  assert.equal(button(tree, 'close'), undefined, 'the footer close button is gone')

  const quit = button(tree, 'quit')
  assert.ok(quit, 'the quit action takes the footer seat')
  assert.equal(quit.props.variant, 'ghost', "the badge geometry stays the primitive's")
  assert.equal(quit.props.className, 'dsh-hub-utils-danger', 'filled red with white text')

  const help = find(tree, 'Tooltip')
  assert.ok(help, 'the explanation moves into a tooltip')
  assert.equal(help.props.portal, true, 'the bubble must escape the dialog stacking context')
  assert.equal(help.props.label, 'keepBody')
  assert.equal(help.props.children.props.children.type, 'IconQuestionOutlineRegular')
  assert.equal(help.props.children.props['aria-label'], 'keepHelpLabel')
})

test('the keep-alive switch posts the opposite state as JSON', async () => {
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ keepAlive: true, running: true }),
    })
  }
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false) })
  find(render(), 'Switch').props.onChange(true)
  await tick()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/hub/api/keepalive')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.body, '{"keepAlive":true}')
  assert.equal(hooks.seen.state.keep.keepAlive, true)
})

test('opening the panel reads the keep-alive state from the hub', async () => {
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ keepAlive: true, running: true }),
    })
  }
  const { render, hooks } = mountAction({ ...baseState(), open: true })
  render()
  const loads = hooks.seen.effects.filter((entry) => Array.isArray(entry.deps) && entry.deps[0] === true)
  assert.ok(loads.length > 0, 'opening must schedule a read')
  loads[0].fn()
  await tick()

  assert.equal(calls[0].url, '/hub/api/keepalive')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(hooks.seen.state.keep.phase, 'ready')
  assert.equal(hooks.seen.state.keep.keepAlive, true)
})

test('a hub without the keep-alive route still shows the quit action', () => {
  const state = { ...baseState(), open: true, keep: { phase: 'unsupported', keepAlive: false, busy: false, failed: false } }
  const { render } = mountAction(state)
  const tree = render()
  assert.equal(find(tree, 'Switch'), undefined)
  assert.match(text(tree), /unsupported/)
  assert.ok(button(tree, 'quit'))
})

test('the quit action opens a second dialog stacked above the panel', () => {
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false) })
  button(render(), 'quit').props.onClick()
  assert.equal(hooks.seen.state.confirmOpen, true)

  const stack = dialogs(render())
  assert.equal(stack.length, 2, 'the confirmation is a second dialog, not an inline row')
  assert.equal(stack[0].props.open, true, 'the panel stays open underneath')
  assert.equal(stack[1].props.open, true)
  assert.equal(stack[1].props.className, 'dsh-hub-utils-confirm')
  assert.equal(stack[1].props.title, 'quitDialogTitle')
  assert.equal(stack[1].props.description, 'quitDialogBody')
  const [cancel, confirm] = stack[1].props.footer
  assert.equal(cancel.props.children, 'cancel')
  assert.equal(confirm.props.children, 'quitConfirmAction')
  assert.equal(confirm.props.className, 'dsh-hub-utils-danger', 'both danger buttons share the red fill')
})

test('the confirmation title is bold and the danger buttons are filled red', () => {
  assert.match(source, /\.dsh-hub-utils-confirm h2 \{ font-weight: 700; \}/)
  assert.match(source, /\.dsh-hub-utils-danger\.dsh-hub-utils-danger \{ background: var\(--dsw-static-red-600, #ec1313\); color: #fff; \}/)
  const seen = mountAction(baseState())
  assert.ok(seen.component)
})

test('cancelling or Escape on the confirmation leaves the panel untouched', () => {
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false), confirmOpen: true })
  dialogs(render())[1].props.footer[0].props.onClick()
  assert.equal(hooks.seen.state.confirmOpen, false)
  assert.equal(hooks.seen.state.quit, 'idle')
  assert.equal(hooks.seen.state.open, true, 'the panel is still open')

  dialogs(render())[1].props.onClose()
  assert.equal(hooks.seen.state.confirmOpen, false)
})

test('an untouched confirmation dismisses itself after the window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false), confirmOpen: true })
  render()
  const opens = hooks.seen.effects.filter((entry) => Array.isArray(entry.deps) && entry.deps[0] === true)
  const dismiss = opens.at(-1)
  assert.ok(dismiss, 'a confirmation must schedule its own dismissal')
  dismiss.fn()
  t.mock.timers.tick(5000)
  assert.equal(hooks.seen.state.confirmOpen, false, 'five idle seconds close it')
})

test('confirming the dialog posts the quit request and keeps the dialog while closing', async () => {
  const calls = []
  const reloads = []
  globalThis.window = {
    __ModuleLoader__: globalThis.window.__ModuleLoader__,
    __DSH_HUB__: { version: 1 },
    location: { reload: () => { reloads.push(true) } },
  }
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: true, status: 200 })
  }
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false), confirmOpen: true })
  assert.deepEqual(calls, [], 'opening the confirmation sends nothing')
  dialogs(render())[1].props.footer[1].props.onClick()
  await tick()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/dsh-hub-utils/quit')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-dsh-hub-utils'], 'quit')
  assert.equal(hooks.seen.state.quit, 'closing')
  assert.equal(hooks.seen.state.confirmOpen, true, 'the dialog shows the closing state')
  assert.deepEqual(reloads, [], 'the reload waits for the instance to leave')
})

test('a refused quit closes the dialog and asks for a reload', async () => {
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 401 })
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false), confirmOpen: true })
  dialogs(render())[1].props.footer[1].props.onClick()
  await tick()
  assert.equal(hooks.seen.state.quit, 'denied')
  assert.equal(hooks.seen.state.confirmOpen, false)
  assert.ok(button(render(), 'reload'))
})

test('a failed quit closes the dialog and offers retry', async () => {
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 })
  const { render, hooks } = mountAction({ ...baseState(), open: true, keep: readyKeep(false), confirmOpen: true })
  dialogs(render())[1].props.footer[1].props.onClick()
  await tick()
  assert.equal(hooks.seen.state.quit, 'failed')
  assert.equal(hooks.seen.state.confirmOpen, false)
  assert.match(text(render()), /quitFailed/)
  assert.ok(button(render(), 'retry'))
})

// --- the session watcher ----------------------------------------------------

/** A fetch-shaped response for the session probe. */
const response = (overrides = {}) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  redirected: false,
  url: '',
  json: async () => ({ expiresInSec: 3600 }),
  ...overrides,
})

/** Flush the watcher's promise chain without waiting on a timer. */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** Capture the watcher's deadline timer instead of waiting an hour. */
const captureTimers = () => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  const timers = []
  const cleared = []
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms, id: timers.length })
    return timers.length - 1
  }
  globalThis.clearTimeout = (id) => { cleared.push(id) }
  return {
    timers,
    cleared,
    restore: () => {
      globalThis.setTimeout = original.setTimeout
      globalThis.clearTimeout = original.clearTimeout
    },
  }
}

/**
 * Install the watcher over a controllable window/document.
 * @param options.fetch - the fetch implementation.
 * @param options.pathname - the page path.
 * @param options.document - an optional document stub; omitted means no document.
 */
const watch = ({ fetch, pathname = '/', document: doc } = {}) => {
  const redirects = []
  const reloads = []
  const listeners = {}
  const documentListeners = {}
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = {
    fetch,
    location: {
      pathname,
      assign: (to) => { redirects.push(to) },
      reload: () => { reloads.push(true) },
    },
    addEventListener: (name, fn) => { listeners[name] = fn },
    removeEventListener: (name) => { delete listeners[name] },
  }
  if (doc !== undefined) {
    globalThis.document = {
      visibilityState: doc.visibilityState ?? 'visible',
      addEventListener: (name, fn) => { documentListeners[name] = fn },
      removeEventListener: (name) => { delete documentListeners[name] },
    }
  } else {
    delete globalThis.document
  }
  const face = registration.factory(stubRequire)
  const nativeFetch = globalThis.window.fetch
  const stop = face.startSessionWatch()
  return {
    redirects,
    reloads,
    listeners,
    documentListeners,
    nativeFetch,
    stop: () => {
      stop()
      globalThis.window = previous.window
      globalThis.document = previous.document
    },
  }
}

test('the session watcher does not wrap fetch', async () => {
  const native = async () => response({ status: 401, ok: false })
  const seen = watch({ fetch: native })
  try {
    await flush()
    assert.equal(globalThis.window.fetch, native)
    assert.deepEqual(seen.redirects, ['/hub/login'])
  } finally {
    seen.stop()
  }
})

test('a live session schedules the deadline from expiresInSec', async () => {
  const timers = captureTimers()
  const seen = watch({ fetch: async () => response() })
  try {
    await flush()
    assert.equal(seen.redirects.length, 0)
    assert.equal(timers.timers.length, 1)
    assert.equal(timers.timers[0].ms, 3600 * 1000 + 2000, 'the margin covers the cookie/server skew')
  } finally {
    seen.stop()
    timers.restore()
  }
})

test('the deadline timer reloads the page', async () => {
  const timers = captureTimers()
  const seen = watch({ fetch: async () => response() })
  try {
    await flush()
    timers.timers[0].fn()
    assert.deepEqual(seen.reloads, [true])
  } finally {
    seen.stop()
    timers.restore()
  }
})

test('a hidden tab waits for the visibility probe instead of reloading', async () => {
  const timers = captureTimers()
  let status = 200
  const seen = watch({
    fetch: async () => response({ status, ok: status === 200 }),
    document: { visibilityState: 'hidden' },
  })
  try {
    await flush()
    timers.timers[0].fn()
    assert.deepEqual(seen.reloads, [])

    status = 401
    globalThis.document.visibilityState = 'visible'
    seen.documentListeners.visibilitychange()
    await flush()
    assert.deepEqual(seen.redirects, ['/hub/login'])
  } finally {
    seen.stop()
    timers.restore()
  }
})

test('visibilitychange probes only when the tab becomes visible', async () => {
  const timers = captureTimers()
  let calls = 0
  const seen = watch({
    fetch: async () => { calls += 1; return response() },
    document: { visibilityState: 'hidden' },
  })
  try {
    await flush()
    assert.equal(calls, 1, 'the load probe')
    seen.documentListeners.visibilitychange()
    await flush()
    assert.equal(calls, 1, 'a hidden tab skips the probe')
    globalThis.document.visibilityState = 'visible'
    seen.documentListeners.visibilitychange()
    await flush()
    assert.equal(calls, 2)
  } finally {
    seen.stop()
    timers.restore()
  }
})

test('focus and a bfcache restore re-probe, a normal pageshow does not', async () => {
  const timers = captureTimers()
  let calls = 0
  const seen = watch({ fetch: async () => { calls += 1; return response() } })
  try {
    await flush()
    assert.equal(calls, 1)
    seen.listeners.pageshow({ persisted: false })
    await flush()
    assert.equal(calls, 1)
    seen.listeners.pageshow({ persisted: true })
    await flush()
    assert.equal(calls, 2)
    seen.listeners.focus()
    await flush()
    assert.equal(calls, 3)
  } finally {
    seen.stop()
    timers.restore()
  }
})

test('an already-expired session redirects instead of scheduling', async () => {
  const seen = watch({ fetch: async () => response({ json: async () => ({ expiresInSec: 0 }) }) })
  try {
    await flush()
    assert.deepEqual(seen.redirects, ['/hub/login'])
  } finally {
    seen.stop()
  }
})

test('the session watcher does not redirect a page already on the login screen', async () => {
  const seen = watch({ pathname: '/hub/login', fetch: async () => response({ status: 401, ok: false }) })
  try {
    await flush()
    assert.deepEqual(seen.redirects, [])
  } finally {
    seen.stop()
  }
})

test('disposing the session watcher clears the timer and the listeners', async () => {
  const timers = captureTimers()
  const native = async () => response()
  const seen = watch({ fetch: native })
  try {
    await flush()
    assert.equal(globalThis.window.fetch, native)
    seen.stop()
    assert.deepEqual(timers.cleared, [0])
    assert.equal(seen.listeners.focus, undefined)
    assert.equal(seen.documentListeners.visibilitychange, undefined)
  } finally {
    timers.restore()
  }
})

// --- the document download action ------------------------------------------

test('the document preview header offers a downloadable file', () => {
  const { documentAction } = mountAction(baseState())
  assert.ok(documentAction, 'a document action is registered')

  const clicked = []
  const previous = globalThis.document
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => ({
      href: '',
      download: '',
      rel: '',
      click() { clicked.push(this.href) },
    }),
  }
  try {
    const tree = documentAction({ t: (key) => key, sessionId: 's1', absolutePath: '/workspace/dir/a b.txt' })
    const tooltip = find(tree, 'Tooltip')
    assert.equal(tooltip.props.label, 'downloadFile')
    assert.equal(tooltip.props.side, 'bottom')
    const button = find(tree, 'button')
    assert.equal(button.props['aria-label'], 'downloadFile')
    assert.equal(button.props.className, 'dsh-hub-utils-download')
    assert.equal(button.props.children.type, 'IconDownloadOutlineRegular')
    button.props.onClick()
    assert.deepEqual(clicked, ['/dsh-hub-utils/download?session=s1&path=%2Fworkspace%2Fdir%2Fa%20b.txt'])
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
