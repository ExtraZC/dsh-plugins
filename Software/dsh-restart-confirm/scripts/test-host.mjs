#!/usr/bin/env node
/**
 * Host-half behaviour check.
 *
 * Drives `lib/index.js` against a throwaway profile directory and a mocked
 * `webServer`/`ctx` pair, so the plugin's routes, change detection and
 * confirmation flow are exercised without booting the real harness.
 *
 * Usage: node --experimental-vm-modules scripts/test-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Config, apply, inject, name } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-restart-confirm-'))
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

/** Collect the routes the plugin registers. */
const routes = new Map()
/** Capture the effect disposer so the test can simulate an unload. */
let disposeEffect
const logs = []

const ws = {
  register(route) {
    assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctx = {
  get: (service) => (service === 'webServer' ? ws : undefined),
  logger: () => ({
    info: (message) => logs.push(`info: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  }),
  effect: (execute) => {
    assert.equal(disposeEffect, undefined, 'apply must install a single effect')
    disposeEffect = execute()
  },
}

/** Read a config with schema defaults applied. */
const config = Config({ profileDir, autoRestartSec: 0 })

assert.equal(name, 'dsh-restart-confirm')
assert.deepEqual(inject, ['webServer'])

apply(ctx, config)
assert.deepEqual([...routes.keys()].sort(), [
  '/__restart-confirm/respond',
  '/__restart-confirm/restart',
  '/__restart-confirm/state',
])

/**
 * Call one registered route and collect the JSON response.
 * @param {string} path - Route path.
 * @param {{ method?: string, body?: string }} [options] - Request shape.
 * @returns {Promise<{ status: number, body: any }>} Response status and parsed JSON.
 */
async function call(path, options = {}) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} is registered`)
  const body = options.body ?? ''
  const req = Readable.from(body.length > 0 ? [Buffer.from(body)] : [])
  req.method = options.method ?? 'GET'
  let status = 200
  let payload = ''
  const headers = new Map()
  const res = {
    setHeader: (key, value) => headers.set(key.toLowerCase(), value),
    end: (value) => {
      payload = value ?? ''
    },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (value) => {
      status = value
    },
  })
  await route.handler(req, res)
  return { status, body: JSON.parse(payload), headers }
}

// --- no pending change ------------------------------------------------------

let state = await call('/__restart-confirm/state')
assert.equal(state.status, 200)
assert.equal(state.body.pending, false)
assert.equal(state.body.restarting, false)
assert.equal(state.body.profileDir, profileDir)

// --- a profile change arms the bar -----------------------------------------

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { x: '1' } }))
await new Promise((resolve) => setTimeout(resolve, 600))

state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, true, 'a rewritten package.json must arm the bar')
assert.equal(state.body.reason, 'profile files changed')
assert.ok(typeof state.body.requestedAt === 'string')
assert.ok(/^[0-9a-f]{40}$/.test(state.body.revision))
assert.equal(state.body.autoRestartAt, null, 'autoRestartSec: 0 disables the countdown')

// --- a metadata-only change (touch) is not a profile change -----------------

await call('/__restart-confirm/respond', { method: 'POST', body: JSON.stringify({ action: 'later' }) })
const future = new Date(Date.now() + 5000)
utimesSync(join(profileDir, 'cordis.patch.yml'), future, future)
await new Promise((resolve) => setTimeout(resolve, 2600))
state = await call('/__restart-confirm/state')
assert.equal(
  state.body.pending,
  false,
  'a pure touch of unchanged files must not arm the bar (nothing to restart for)'
)

// --- an unwatched file does not arm it -------------------------------------

writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
await new Promise((resolve) => setTimeout(resolve, 600))
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, false, 'only package.json and cordis.patch.yml count as changes')
writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
await new Promise((resolve) => setTimeout(resolve, 600))
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, false, 'pnpm-lock.yaml stays uninteresting')

// --- "later" clears the pending flag and must stay cleared ------------------

writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n# touched\n')
await new Promise((resolve) => setTimeout(resolve, 600))
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, true)

let response = await call('/__restart-confirm/respond', {
  method: 'POST',
  body: JSON.stringify({ action: 'later' }),
})
assert.equal(response.status, 200)
assert.deepEqual(response.body, { ok: true, action: 'later' })
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, false, '"later" clears the pending state')
assert.ok(logs.some((line) => line.includes('restart deferred by the page')))

// The deferral must be stable: a poll that sees the same revision must not
// re-arm the bar, or "later" would be useless.
await new Promise((resolve) => setTimeout(resolve, 2600))
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, false, '"later" must survive the next poll cycle')

// A further change after "later" arms the bar again.
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n# touched again\n')
await new Promise((resolve) => setTimeout(resolve, 600))
state = await call('/__restart-confirm/state')
assert.equal(state.body.pending, true, 'a new change after "later" arms the bar again')
await call('/__restart-confirm/respond', { method: 'POST', body: JSON.stringify({ action: 'later' }) })

// --- the auto-restart deadline is fixed when the bar is armed ---------------

// The client polls every 3s. If the host derived the deadline per request, the
// countdown would be pushed forward on every poll and never appear to move —
// the "stuck at 181s" regression. Cover the host half of that contract here.
const countdown = Config({ profileDir, autoRestartSec: 30 })
const countdownRoutes = new Map()
const countdownLogs = []
const countdownCtx = {
  get: () => ({
    register: (route) => {
      countdownRoutes.set(route.path, route)
      return () => countdownRoutes.delete(route.path)
    },
  }),
  logger: () => ({ info: (message) => countdownLogs.push(message), error: () => {} }),
  effect: (execute) => execute(),
}
apply(countdownCtx, countdown)

/**
 * Call a route registered by the countdown instance.
 * @param {string} path - Route path.
 * @returns {Promise<any>} Parsed JSON body.
 */
async function countdownCall(path) {
  const route = countdownRoutes.get(path)
  const req = Readable.from([])
  req.method = 'GET'
  let payload = ''
  const res = { setHeader: () => {}, end: (value) => { payload = value ?? '' } }
  Object.defineProperty(res, 'statusCode', { get: () => 200, set: () => {} })
  await route.handler(req, res)
  return JSON.parse(payload)
}

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { y: '2' } }))
await new Promise((resolve) => setTimeout(resolve, 600))

const first = await countdownCall('/__restart-confirm/state')
assert.equal(first.pending, true)
assert.ok(typeof first.autoRestartAt === 'number', 'a pending bar must expose a deadline')
assert.ok(first.autoRestartAt > Date.now(), 'the deadline must be in the future')
assert.ok(
  first.autoRestartAt <= Date.now() + 30_000,
  'the deadline must not exceed the configured timeout'
)

await new Promise((resolve) => setTimeout(resolve, 1200))
const second = await countdownCall('/__restart-confirm/state')
assert.equal(second.pending, true)
assert.equal(
  second.autoRestartAt,
  first.autoRestartAt,
  'the deadline must not move forward between polls'
)
assert.ok(
  first.autoRestartAt - Date.now() < 30_000,
  'the remaining time must decrease as the deadline stays fixed'
)

// --- validation -------------------------------------------------------------

response = await call('/__restart-confirm/respond', { method: 'POST', body: '{' })
assert.equal(response.status, 400)
response = await call('/__restart-confirm/respond', {
  method: 'POST',
  body: JSON.stringify({ action: 'maybe' }),
})
assert.equal(response.status, 400)
response = await call('/__restart-confirm/respond', { method: 'GET' })
assert.equal(response.status, 405)
response = await call('/__restart-confirm/state', { method: 'POST' })
assert.equal(response.status, 405)
response = await call('/__restart-confirm/state')
assert.equal(response.headers.get('cache-control'), 'no-store')

// --- unload removes the routes ---------------------------------------------

disposeEffect()
assert.equal(routes.size, 0, 'the plugin effect must release its routes')

rmSync(home, { recursive: true, force: true })
const artifact = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
for (const named of ['export const name', 'export const inject', 'export function apply']) {
  assert.ok(artifact.includes(named), `lib/index.js must keep the named export: ${named}`)
}
process.stdout.write('test-host: all assertions passed\n')

// The countdown instance armed a real auto-restart timer, which is deliberately
// not kept alive for the process; exit explicitly once the assertions are done.
process.exit(0)
