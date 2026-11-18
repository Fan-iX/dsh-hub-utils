// Browser half of dsh-hub-utils: one sidebar action that opens a small control
// panel for the current instance. The panel carries two actions:
//
//   - Keep alive: asks dsh-hub not to reap this instance while the page is
//     closed (the hub's /hub/api/keepalive route).
//   - Quit: asks the host launcher for a bounded exit (this package's own
//     /dsh-hub-utils/quit route, served by the host half).
//
// Hand-written rather than built — the `clientBundle` tsdown preset is not part
// of the published SDK, so this file is already in the runtime's dynamic-bundle
// format (`window.__ModuleLoader__.load`). It requires only the shell's baseline
// modules and holds no relative `require`, because the runtime hands a factory
// one synchronous chunk and does not resolve siblings. There is no JSX, because
// nothing compiles it.
//
// The keep-alive exchange is a plain same-origin fetch: the page is served by
// dsh-hub, so a relative path reaches the hub's route with the hub session
// cookie attached. That route answers JSON only when the instance really runs
// under dsh-hub, which is how the panel tells a bare `dsh web` apart.
window.__ModuleLoader__.load({
  id: 'dsh-hub-utils',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var jsxRuntime = require('react/jsx-runtime')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var jsx = jsxRuntime.jsx
    var jsxs = jsxRuntime.jsxs

    /** Dictionary namespace owned by this browser half. */
    var NS = 'settings.dshHubUtils'

    /** The hub route behind the keep-alive switch; see dsh-hub's backend/web.mjs. */
    var KEEPALIVE_PATH = '/hub/api/keepalive'

    /**
     * Session-expiry watcher: probe for the server's remaining TTL, then keep
     * one timer at that deadline; tab activation re-probes. See startSessionWatch.
     */
    var SESSION_PATH = '/hub/api/session'
    var LOGIN_PATH = '/hub/login'
    var EXPIRY_MARGIN_MS = 2000

    /** The host half's quit route and its required header; see `src/index.js`. */
    var QUIT_PATH = '/dsh-hub-utils/quit'
    var QUIT_HEADER = 'x-dsh-hub-utils'

    /** The host route that streams one workspace file; see `src/index.js`. */
    var DOWNLOAD_PATH = '/dsh-hub-utils/download'

    /** How long the page waits for the instance to leave before reloading into a new one. */
    var RELOAD_AFTER_MS = 3000

    /** How long the quit confirmation waits before dismissing itself untouched. */
    var CONFIRM_WINDOW_MS = 5000

    var stack = { display: 'flex', flexDirection: 'column', gap: '20px' }
    var section = { display: 'flex', flexDirection: 'column', gap: '10px' }
    var row = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }
    var titleStyle = { color: 'var(--dsw-alias-label-primary, #0f1115)', fontSize: '14px', fontWeight: 600 }
    var bodyStyle = { color: 'var(--dsw-alias-label-tertiary, #81858c)', fontSize: '13px', lineHeight: 1.6 }

    /** English copy. */
    var en = {
      action: 'dsh-hub settings',
      panelTitle: 'dsh-hub settings',
      keepTitle: 'Keep running when idle',
      keepBody: 'Enabled: dsh-hub keeps this Harness instance running after you close the page. Disabled: this Harness will be stopped when idle and a fresh one starts on your next visit.',
      keepHelpLabel: 'About keep-alive',
      loading: 'Reading the current setting…',
      keepOn: 'This instance keeps running after the page closes.',
      keepOff: 'An idle instance is stopped after the page closes.',
      unsupported: 'Keep-alive is not available on this dsh-hub build.',
      keepFailed: 'Could not read the keep-alive setting.',
      saveFailed: 'Could not save the setting. Try again.',
      downloadFile: 'Download file',
      retry: 'Retry',
      quit: 'Quit',
      quitDialogTitle: 'Quit this instance?',
      quitDialogBody: 'The instance exits. Unsaved work in running tasks is lost.',
      quitConfirmAction: 'Quit',
      cancel: 'Cancel',
      closing: 'Quitting…',
      quitFailed: 'The quit request failed.',
      denied: 'Session expired. Reload to sign in again.',
      reload: 'Reload',
      close: 'Close',
    }

    /** Simplified Chinese copy. */
    var zh = {
      action: 'dsh-hub 设置',
      panelTitle: 'dsh-hub 设置',
      keepTitle: '保持活跃',
      keepBody: '开启：即使关闭页面，dsh-hub 也会维持当前Harness实例的运行。关闭：当前Harness实例空闲时会被回收，下次访问时再启动一个新实例。',
      keepHelpLabel: '关于保持活跃',
      loading: '正在读取当前设置…',
      keepOn: '关闭页面后，这个实例会继续运行。',
      keepOff: '关闭页面后，空闲实例会被回收。',
      unsupported: '当前 dsh-hub 版本不支持保持活跃。',
      keepFailed: '无法读取保持活跃设置。',
      saveFailed: '无法保存设置，请重试。',
      downloadFile: '下载文件',
      retry: '重试',
      quit: '退出',
      quitDialogTitle: '要退出当前实例吗？',
      quitDialogBody: '实例会退出。正在运行的任务中未保存的内容会丢失。',
      quitConfirmAction: '确认退出',
      cancel: '取消',
      closing: '正在退出…',
      quitFailed: '退出请求失败。',
      denied: '会话已失效，请刷新后重新登录。',
      reload: '刷新',
      close: '关闭',
    }

    /**
     * Read the hub's current keep-alive state.
     * @returns a promise of `{ supported: false }` outside dsh-hub, or the state.
     */
    function readKeepAlive() {
      return fetch(KEEPALIVE_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      }).then(function (response) {
        var json = /application\/json/i.test(response.headers.get('content-type') || '')
        if (!response.ok || !json) return { supported: false }
        return response.json().then(function (body) {
          return { supported: true, keepAlive: body.keepAlive === true }
        })
      })
    }

    /**
     * The sidebar action and its panel.
     * @param props - the sidebar's column state and the page's copy.
     * @returns the button and, while open, the panel dialog.
     */
    function HubPanelAction(props) {
      var t = props.t
      var wide = props.wide === true
      var state = react.useState({
        open: false,
        keep: { phase: 'loading', keepAlive: false, busy: false, failed: false },
        quit: 'idle',
        confirmOpen: false,
      })
      var current = state[0]
      var setCurrent = state[1]
      var alive = react.useRef(true)
      react.useEffect(function () {
        alive.current = true
        return function () { alive.current = false }
      }, [])

      var update = function (patch) {
        setCurrent(function (prev) { return Object.assign({}, prev, patch) })
      }
      var updateKeep = function (patch) {
        setCurrent(function (prev) {
          return Object.assign({}, prev, { keep: Object.assign({}, prev.keep, patch) })
        })
      }

      var load = function () {
        updateKeep({ phase: 'loading', failed: false })
        readKeepAlive().then(function (next) {
          if (!alive.current) return
          if (!next.supported) { updateKeep({ phase: 'unsupported', keepAlive: false }); return }
          updateKeep({ phase: 'ready', keepAlive: next.keepAlive })
        }).catch(function () {
          if (alive.current) updateKeep({ phase: 'error' })
        })
      }
      // Read the real state on open, so the panel never renders a guessed value.
      react.useEffect(function () {
        if (!current.open) return undefined
        load()
        return undefined
      }, [current.open])

      // An unanswered confirmation must not sit over the page forever.
      react.useEffect(function () {
        if (!current.confirmOpen) return undefined
        var timer = setTimeout(function () { update({ confirmOpen: false }) }, CONFIRM_WINDOW_MS)
        return function () { clearTimeout(timer) }
      }, [current.confirmOpen])

      var toggle = function (next) {
        updateKeep({ busy: true, failed: false })
        fetch(KEEPALIVE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keepAlive: next }),
          cache: 'no-store',
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          return response.json()
        }).then(function (body) {
          if (!alive.current) return
          updateKeep({ phase: 'ready', keepAlive: body.keepAlive === true, busy: false, failed: false })
        }).catch(function () {
          if (alive.current) updateKeep({ busy: false, failed: true })
        })
      }

      var quit = function () {
        update({ quit: 'closing' })
        var headers = {}
        headers[QUIT_HEADER] = 'quit'
        fetch(QUIT_PATH, { method: 'POST', headers: headers, cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) {
              var refused = response.status === 401 || response.status === 403
              var error = new Error('HTTP ' + String(response.status))
              error.refused = refused
              throw error
            }
            setTimeout(function () { window.location.reload() }, RELOAD_AFTER_MS)
          })
          .catch(function (error) {
            update({ quit: error && error.refused === true ? 'denied' : 'failed', confirmOpen: false })
          })
      }

      var openConfirm = function () { update({ confirmOpen: true, quit: 'idle' }) }
      var cancelConfirm = function () { update({ confirmOpen: false }) }
      var close = function () { update({ open: false, quit: 'idle', confirmOpen: false }) }
      var open = function () { update({ open: true }) }

      var keep = current.keep
      var keepCaption = keep.phase === 'loading' ? t('loading')
        : keep.phase === 'unsupported' ? t('unsupported')
          : keep.phase === 'error' ? t('keepFailed')
            : keep.failed ? t('saveFailed')
              : keep.keepAlive ? t('keepOn') : t('keepOff')
      var keepSection = jsxs('div', { style: section, children: [
        jsxs('div', { style: row, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
            jsx('div', { style: titleStyle, children: t('keepTitle') }),
            jsx(primitives.Tooltip, {
              // Portal: the dialog's stacking context caps an in-flow bubble
              // below its own layer; the portaled bubble sits above every modal.
              portal: true,
              side: 'top',
              maxWidth: 280,
              label: t('keepBody'),
              children: jsx('span', {
                tabIndex: 0,
                role: 'img',
                'aria-label': t('keepHelpLabel'),
                style: { display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary, #81858c)', cursor: 'help' },
                children: jsx(primitives.IconQuestionOutlineRegular, {}),
              }),
            }),
          ] }),
          keep.phase === 'ready'
            ? jsx(primitives.Switch, {
              checked: keep.keepAlive,
              disabled: keep.busy,
              label: t('keepTitle'),
              onChange: toggle,
            })
            : null,
        ] }),
        jsx('div', { style: bodyStyle, children: keepCaption }),
        keep.phase === 'error'
          ? jsx(primitives.Button, { variant: 'ghost', size: 'sm', onClick: load, children: t('retry') })
          : null,
      ] })

      var quitLabel = current.quit === 'closing' ? t('closing')
        : current.quit === 'denied' ? t('reload')
          : current.quit === 'failed' ? t('retry')
            : t('quit')
      var quitClick = current.quit === 'denied'
        ? function () { window.location.reload() }
        : openConfirm

      var button = jsx(primitives.Button, {
        key: 'action',
        variant: 'ghost',
        size: 'sm',
        icon: jsx('span', {
          style: { display: 'inline-flex' },
          children: jsx(primitives.IconSlidersTwoOutlineRegular, {}),
        }),
        'aria-label': t('action'),
        onClick: open,
        children: wide ? t('action') : null,
      })
      var panel = jsxs(primitives.Modal, {
        key: 'panel',
        open: current.open,
        onClose: close,
        title: t('panelTitle'),
        closeLabel: t('close'),
        // The quit action takes the footer seat, styled like the removed close
        // button but in the theme's error colour; the header close button closes.
        footer: jsx(primitives.Button, {
          variant: 'ghost',
          className: 'dsh-hub-utils-danger',
          disabled: current.quit === 'closing',
          onClick: quitClick,
          children: quitLabel,
        }),
        children: jsxs('div', { style: stack, children: [
          keepSection,
          current.quit === 'failed' ? jsx('div', { style: bodyStyle, children: t('quitFailed') }) : null,
          current.quit === 'denied' ? jsx('div', { style: bodyStyle, children: t('denied') }) : null,
        ] }),
      })
      // A second dialog on top of the panel; the modal layer stacks it, gives it
      // Escape and focus, and returns focus to the panel when it closes.
      var confirmDialog = jsxs(primitives.Modal, {
        key: 'quit-confirm',
        className: 'dsh-hub-utils-confirm',
        open: current.confirmOpen,
        onClose: cancelConfirm,
        title: t('quitDialogTitle'),
        description: t('quitDialogBody'),
        closeLabel: t('cancel'),
        footer: [
          jsx(primitives.Button, { key: 'cancel', variant: 'ghost', onClick: cancelConfirm, children: t('cancel') }),
          jsx(primitives.Button, {
            key: 'confirm',
            variant: 'ghost',
            className: 'dsh-hub-utils-danger',
            disabled: current.quit === 'closing',
            onClick: quit,
            children: current.quit === 'closing' ? t('closing') : t('quitConfirmAction'),
          }),
        ],
      })
      return jsxs(jsxRuntime.Fragment, { children: [button, panel, confirmDialog] })
    }

    /**
     * dsh-hub-utils styles: the quit confirmation's title is bold, which the
     * shell's default modal title is not. Scoped to the dialog class passed in.
     * @returns a disposer removing the injected rule.
     */
    function installStyles() {
      if (typeof document === 'undefined') return function () {}
      var style = document.createElement('style')
      style.textContent = [
        '.dsh-hub-utils-confirm h2 { font-weight: 700; }',
        // Filled danger button: the doubled class outranks the primitive's
        // variant/hover rules, so the red fill survives the ghost variant.
        '.dsh-hub-utils-danger.dsh-hub-utils-danger { background: var(--dsw-static-red-600, #ec1313); color: #fff; }',
        '.dsh-hub-utils-danger.dsh-hub-utils-danger:hover { background: color-mix(in srgb, var(--dsw-static-red-600, #ec1313) 86%, #000); }',
        // Same geometry and hover token as the preview toolbar's own buttons.
        '.dsh-hub-utils-download { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; color: var(--dsw-alias-label-secondary); line-height: 1; background: transparent; border: none; border-radius: var(--dsw-radius-sm); cursor: pointer; }',
        '.dsh-hub-utils-download svg { width: 15px; height: 15px; }',
        '@media (hover: hover) { .dsh-hub-utils-download:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); } }',
      ].join('\n')
      document.head.appendChild(style)
      return function () { style.remove() }
    }

    /** True when the page came through dsh-hub, which injects this marker. */
    function isDshHub() {
      return typeof window !== 'undefined' && window.__DSH_HUB__ !== undefined
    }

    /**
     * Refresh into the login page when the hub session expires.
     *
     * The hub answers a non-document request without a session with 401, and
     * `GET /hub/api/session` reports the remaining TTL for a live one. This
     * watcher probes on load and on tab activation (`visibilitychange`,
     * `pageshow` after bfcache, `focus`), and schedules one timer for the
     * reported deadline so a session expiring mid-use reloads the page (the hub
     * then sends it to `/hub/login`). It does not wrap fetch or read dsh's UI,
     * state, or error messages.
     * @returns a disposer that clears the timer and removes the listeners.
     */
    function startSessionWatch() {
      var w = typeof window !== 'undefined' ? window : null
      if (w === null || typeof w.fetch !== 'function') return function () {}
      var stopped = false
      var timer = null

      var redirect = function () {
        if (stopped) return
        var location = w.location
        if (!location || typeof location.assign !== 'function') return
        if (location.pathname === LOGIN_PATH) return
        stopped = true
        location.assign(LOGIN_PATH)
      }

      var reload = function () {
        var location = w.location
        if (location && typeof location.reload === 'function') { location.reload(); return }
        redirect()
      }

      var schedule = function (remainingSec) {
        if (timer !== null) { clearTimeout(timer); timer = null }
        var delay = Math.max(0, remainingSec * 1000 + EXPIRY_MARGIN_MS)
        timer = setTimeout(function () {
          timer = null
          if (stopped) return
          // A hidden tab may have been throttled; the visibility probe decides.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          reload()
        }, delay)
      }

      var check = function () {
        if (stopped) return undefined
        return w.fetch(SESSION_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
          .then(function (response) {
            if (response.status === 401) { redirect(); return }
            // A hub older than this plugin redirects the probe instead of
            // answering 401; the followed URL is the login page.
            if (response.redirected && /\/hub\/login(?:[?#]|$)/.test(String(response.url ?? ''))) {
              redirect()
              return
            }
            if (!response.ok) return
            return response.json().then(function (body) {
              if (stopped) return
              var remaining = Number(body && body.expiresInSec)
              if (!Number.isFinite(remaining) || remaining <= 0) { redirect(); return }
              schedule(remaining)
            })
          })
          .catch(function () { /* hub unreachable: leave the page alone */ })
      }

      var onVisible = function () {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        check()
      }
      var onShow = function (event) {
        // A normal load already probed; only a bfcache restore needs this.
        if (event && event.persisted === true) check()
      }
      var onFocus = function () { check() }
      if (typeof w.addEventListener === 'function') {
        w.addEventListener('focus', onFocus)
        w.addEventListener('pageshow', onShow)
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisible)
      }

      check()

      return function dispose() {
        stopped = true
        if (timer !== null) { clearTimeout(timer); timer = null }
        if (typeof w.removeEventListener === 'function') {
          w.removeEventListener('focus', onFocus)
          w.removeEventListener('pageshow', onShow)
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisible)
        }
      }
    }

    /**
     * Mount the sidebar action and its dictionaries, but only under dsh-hub.
     * @param ctx - the browser plugin context.
     */
    /** The download route URL for one workspace file. */
    function downloadUrl(sessionId, filePath) {
      return DOWNLOAD_PATH + '?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath)
    }

    /** Hand the URL to the browser's native downloader. */
    function startDownload(url) {
      if (typeof document === 'undefined') return
      var link = document.createElement('a')
      link.href = url
      link.download = ''
      link.rel = 'noopener'
      if (document.body) document.body.appendChild(link)
      link.click()
      if (link.parentNode) link.parentNode.removeChild(link)
    }

    /**
     * The download button in the file preview header.
     * @param props - the session, the file's absolute path, and the locale seat.
     * @returns the icon button with its tooltip.
     */
    function DownloadDocumentAction(props) {
      var label = props.t('downloadFile')
      var download = function () {
        if (typeof props.sessionId !== 'string' || typeof props.absolutePath !== 'string') return
        if (props.absolutePath === '') return
        startDownload(downloadUrl(props.sessionId, props.absolutePath))
      }
      return jsx(primitives.Tooltip, {
        label: label,
        side: 'bottom',
        delayMs: 500,
        children: jsx('button', {
          type: 'button',
          className: 'dsh-hub-utils-download',
          'aria-label': label,
          children: jsx(primitives.IconDownloadOutlineRegular, {}),
          onClick: download,
        }),
      })
    }

    function apply(ctx) {
      if (!isDshHub()) return
      ctx.effect(startSessionWatch, 'dsh-hub-utils: session watch')
      ctx.effect(installStyles, 'dsh-hub-utils: styles')
      ctx.effect(function () { return ctx.locale.register(NS, { en: en, zh: zh }) }, 'dsh-hub-utils: dictionaries')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-hub-utils',
            locale: NS,
          }, HubPanelAction)
        })
      }, 'dsh-hub-utils: sidebar action')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.tab.document.actions', function () {
          return ctx.slots.register({
            name: 'sidebar.right.tab.document.actions',
            id: 'dsh-hub-utils',
            locale: NS,
          }, DownloadDocumentAction)
        })
      }, 'dsh-hub-utils: download action')
    }

    exports.NS = NS
    exports.KEEPALIVE_PATH = KEEPALIVE_PATH
    exports.QUIT_PATH = QUIT_PATH
    exports.QUIT_HEADER = QUIT_HEADER
    exports.SESSION_PATH = SESSION_PATH
    exports.LOGIN_PATH = LOGIN_PATH
    exports.DOWNLOAD_PATH = DOWNLOAD_PATH
    exports.downloadUrl = downloadUrl
    exports.startSessionWatch = startSessionWatch
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
