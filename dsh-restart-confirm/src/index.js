// dsh-restart-confirm: HOST half.
//
// Backs the "restart confirmation bar" for the automatic web-service restart
// that this machine triggers after every plugin install (systemd
// dsh-web-restart.path -> dsh-web-restart.service). The systemd helper
// (restart-with-confirm.sh) writes ~/.dsh/restart-pending.json and then waits
// for the user's choice; this host half exposes that state to the browser and
// records the choice into ~/.dsh/restart-response.json, which the helper
// polls. On "now" the helper restarts the service; on "later" it skips.
//
//   GET  /__restart-confirm/state    -> { pending, requestedAt, reason } | { pending:false }
//   POST /__restart-confirm/respond  -> body { action: 'now' | 'later' }
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const name = 'dsh-restart-confirm'
// webServer is a hard dependency: without a web surface there is nothing to
// confirm and the plugin has no reason to load.
const inject = ['webServer']

// --- paths -------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function pendingPath() {
  return path.join(dshHome(), 'restart-pending.json')
}

function responsePath() {
  return path.join(dshHome(), 'restart-response.json')
}

// --- tiny json/io helpers ----------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Atomic write (tmp + rename) so the systemd helper never sees a half-written
// file while polling.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// --- handlers ----------------------------------------------------------------

// The page polls this to learn whether a restart is pending. Once the user has
// answered, the response file exists and we report pending:false so the bar
// hides even before the helper has cleaned up.
async function stateHandler(_ctx, req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  const responded = readJson(responsePath())
  if (responded) {
    sendJson(res, 200, { pending: false, responded: responded.action })
    return
  }
  const pending = readJson(pendingPath())
  if (!pending) {
    sendJson(res, 200, { pending: false })
    return
  }
  sendJson(res, 200, {
    pending: true,
    requestedAt: pending.requestedAt ?? null,
    reason: pending.reason ?? null,
  })
}

// The page posts the user's choice here. The systemd helper polls for this
// file, so a "now" answer restarts within ~2s and "later" cancels the restart.
async function respondHandler(_ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  let body = {}
  try {
    const raw = await readBody(req)
    if (raw) body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'bad json body' })
    return
  }
  const action = String(body.action ?? '')
  if (action !== 'now' && action !== 'later') {
    sendJson(res, 400, { error: "action must be 'now' or 'later'" })
    return
  }
  try {
    writeJsonAtomic(responsePath(), {
      action,
      respondedAt: new Date().toISOString(),
    })
    sendJson(res, 200, { ok: true, action })
  } catch (e) {
    sendJson(res, 500, { error: e.message })
  }
}

// --- apply -------------------------------------------------------------------

function apply(ctx) {
  const ws = ctx.get('webServer')
  if (ws === undefined) return
  ctx.effect(() =>
    ws.register({
      kind: 'exact',
      path: '/__restart-confirm/state',
      handler: (req, res) => stateHandler(ctx, req, res),
    })
  )
  ctx.effect(() =>
    ws.register({
      kind: 'exact',
      path: '/__restart-confirm/respond',
      handler: (req, res) => respondHandler(ctx, req, res),
    })
  )
}

export { apply, inject, name }
