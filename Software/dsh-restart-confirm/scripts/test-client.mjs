#!/usr/bin/env node
/**
 * Client-half behaviour check.
 *
 * Executes `lib/client.js` in a VM that mimics the browser bundle contract:
 * `window.__ModuleLoader__` captures the factory, `require` serves the React
 * baseline modules the shell seeds, and a fake `slots` service records the
 * registration. The bar component is then rendered with a minimal React
 * implementation to prove it produces a restart bar once the host reports a
 * pending change.
 *
 * Usage: node --experimental-vm-modules scripts/test-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Registrations captured from the bundle. */
const registrations = []
/** Requests the bar issued. */
const requests = []

const win = {
  __ModuleLoader__: {
    load: (registration) => registrations.push(registration),
  },
}

// --- minimal React baseline ------------------------------------------------
//
// Enough of the hooks contract to drive the bar across renders: state that
// survives, effects with cleanup, and a fake interval registry so the test
// controls when a poll happens.

const hooks = []
let hookIndex = 0
/** Cleanups registered by the current render's effects. */
let effectCleanups = []
/** The currently mounted component. */
let mounted = null

/**
 * Re-render after a state update, mirroring React: state written during the
 * new pass does not schedule an unbounded chain, because each pass tears the
 * previous pass's effects down and re-registers them once.
 */
function rerender() {
  if (mounted === null || scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    pass()
  })
}

const react = {
  useState: (initial) => {
    const index = hookIndex++
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [
      hooks[index],
      (value) => {
        // React bails out when the value is unchanged; without that, a poll
        // that sets state on every tick would drive an endless render loop.
        if (Object.is(hooks[index], value)) return
        hooks[index] = value
        rerender()
      },
    ]
  },
  useRef: (initial) => {
    const index = hookIndex++
    hooks[index] ??= { current: initial }
    return hooks[index]
  },
  useCallback: (callback) => {
    hookIndex++
    return callback
  },
  useEffect: (effect) => {
    hookIndex++
    effectCleanups.push(effect())
  },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
}

/** Rendered output of the currently mounted component. */
let tree = null
/** Set while a render pass is scheduled, to coalesce synchronous updates. */
let scheduled = false

/**
 * Run one render pass: tear down the previous render's effects so a re-render
 * starts clean, exactly once per pass.
 */
function pass() {
  for (const cleanup of effectCleanups.splice(0)) if (typeof cleanup === 'function') cleanup()
  hookIndex = 0
  tree = mounted()
}

function render(component) {
  mounted = () => component({})
  pass()
  return tree
}

/** Let pending promise callbacks (a poll and its state updates) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Registered interval callbacks, fired explicitly by `tick()`. */
const intervalCallbacks = []

/**
 * Run one poll cycle the way the browser would: fire the registered interval
 * callback and let its promises settle.
 * @param {number} [times] - How many cycles to run.
 */
async function tick(times = 1) {
  for (let index = 0; index < times; index += 1) {
    for (const callback of [...intervalCallbacks]) callback()
    await settle()
  }
}

const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: Symbol('Fragment'),
}

/** Current host response; set to `'down'` to simulate the restart window. */
let stateResponse = { pending: false }

const context = {
  window: win,
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  console,
  setTimeout,
  clearTimeout,
  // A synchronous interval registry: the test decides when a poll happens, and
  // no live timer keeps the process alive after the assertions finish.
  setInterval: (callback) => {
    intervalCallbacks.push(callback)
    return intervalCallbacks.length - 1
  },
  clearInterval: (id) => {
    if (typeof id === 'number') intervalCallbacks[id] = () => {}
  },
  Date,
  Math,
  JSON,
  Promise,
  fetch: async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET', body: options.body })
    if (String(url).includes('/state')) {
      if (stateResponse === 'down') throw new Error('service down')
      return { ok: true, json: async () => stateResponse }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  },
}
context.globalThis = context
context.crypto = webcrypto

vm.createContext(context)
new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context)

// --- bundle protocol ---------------------------------------------------------

assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
const registration = registrations[0]
assert.equal(registration.id, 'dsh-restart-confirm')
assert.equal(typeof registration.factory, 'function')

const loader = (spec) => {
  if (spec === 'react') return react
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`client-modules: require("${spec}") missed the module table`)
}
const plugin = registration.factory(loader)

assert.equal(typeof plugin.apply, 'function')
// The bundle executed in another realm, so copy before comparing.
assert.deepEqual([...plugin.inject], ['slots'])

// --- slot registration -------------------------------------------------------

const slotEntries = []
const slots = {
  inject: (key, callback) => {
    assert.equal(key, 'shell.overlay')
    callback()
  },
  register: (spec, component) => {
    slotEntries.push({ spec, component })
  },
}
plugin.apply({ slots })

assert.equal(slotEntries.length, 1, 'apply must register one shell.overlay entry')
// Cross-realm object: compare the copied fields, not the object identity.
assert.deepEqual({ ...slotEntries[0].spec }, {
  name: 'shell.overlay',
  id: 'restart-confirm',
  order: 100,
})
assert.equal(typeof slotEntries[0].component, 'function')

// --- rendering ---------------------------------------------------------------

const Bar = slotEntries[0].component

/** The bar's description line, or undefined when the bar renders nothing. */
function descriptionOf(current) {
  if (current === null) return undefined
  const [text] = current.props.children.props.children
  return text.props.children[1].props.children
}

/** The bar's title line, or undefined when the bar renders nothing. */
function titleOf(current) {
  if (current === null) return undefined
  const [text] = current.props.children.props.children
  return text.props.children[0].props.children
}

/** Seconds left as rendered, or null when no countdown is shown. */
function secondsLeftOf(current) {
  const match = /(\d+)/.exec(String(descriptionOf(current) ?? ''))
  return match === null ? null : Number(match[1])
}

// No pending change: the bar renders nothing.
assert.equal(render(Bar), null)

// A pending change renders the confirmation bar with both actions.
const deadline = Date.now() + 180_000
stateResponse = {
  pending: true,
  restarting: false,
  requestedAt: new Date().toISOString(),
  reason: 'profile files changed',
  revision: 'a'.repeat(40),
  autoRestartAt: deadline,
}
await tick()
assert.ok(tree, 'a pending change must render the bar')
assert.equal(tree.props['data-dsh-restart-confirm'], '')
const [text, actions] = tree.props.children.props.children
assert.equal(text.props.children[0].props.children, '检测到插件变更')
assert.match(descriptionOf(tree), /重启服务后/)
assert.match(descriptionOf(tree), /自动重启/)

const [later, now] = actions.props.children
assert.equal(later.props.children, '稍后')
assert.equal(now.props.children, '立即重启')

// The bar polls the host state exactly through the documented route.
assert.ok(requests.some((request) => request.url === '/__restart-confirm/state'))

// The countdown is anchored to the deadline the host fixed when it armed the
// bar, so it decreases with real time instead of being reset by every poll.
// This is the "stuck at 181s" regression.
const before = secondsLeftOf(tree)
assert.ok(before !== null && before > 0, `a countdown must be rendered, got ${String(before)}`)

// Advance the clock by 10s and poll twice more. A host that recomputed the
// deadline per request would render the same number on every poll instead.
const realNow = Date.now
Date.now = () => realNow.call(Date) + 10_000
await tick(2)
const after = secondsLeftOf(tree)
assert.equal(
  after,
  before - 10,
  `the countdown must drop with real time (was ${String(before)}, became ${String(after)})`
)

// Polling again with the clock held still must not push the countdown back up:
// the deadline is stable, so repeats can only hold or decrease.
await tick()
Date.now = realNow
assert.equal(
  secondsLeftOf(tree),
  after,
  'a repeated poll at the same instant must not change the countdown'
)

// While the service is down the bar stays put: the restart is under way.
stateResponse = 'down'
await tick()
assert.ok(tree, 'the bar must survive the restart window')

// "Restart now" posts the documented action and switches to the restarting copy.
await now.props.onClick()
const posted = requests.find((request) => request.method === 'POST')
assert.ok(posted, 'clicking restart must POST to the host')
assert.equal(posted.url, '/__restart-confirm/respond')
assert.deepEqual(JSON.parse(posted.body), { action: 'now' })
await tick()
assert.ok(tree, 'the bar stays visible while the restart runs')
assert.equal(titleOf(tree), '正在重启…', 'a confirmed restart shows the restarting copy')

// Once the restarted service answers again the bar must disappear. This is the
// "popup never closes" regression: the page is not reloaded by the restart.
stateResponse = { pending: false, restarting: false, profileDir: '/home/user/.dsh/profiles/web' }
await tick()
assert.equal(tree, null, 'the bar must disappear once the restarted service answers again')

// A brand-new pending change after that arms the bar again.
stateResponse = {
  pending: true,
  restarting: false,
  reason: 'profile files changed',
  revision: 'b'.repeat(40),
  autoRestartAt: Date.now() + 60_000,
}
await tick()
assert.ok(tree, 'a later change must arm the bar again')

process.stdout.write('test-client: all assertions passed\n')
