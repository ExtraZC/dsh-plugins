/**
 * dsh-restart-confirm: HOST half.
 *
 * Watches the running profile directory (`$DSH_HOME/profiles/<name>`) for the
 * mutations `dsh plugin add|remove|update` performs — `package.json` and
 * `cordis.patch.yml` — and turns "the running process no longer matches the
 * configuration on disk" into an explicit user decision instead of a silent
 * disconnect:
 *
 *   GET  /__restart-confirm/state    -> { pending, requestedAt, reason, revision, autoRestartAt, restarting }
 *   POST /__restart-confirm/respond  -> body { action: 'now' | 'later' }
 *   POST /__restart-confirm/restart  -> restart without a pending change
 *
 * The actual restart re-executes this process. `dsh.service` ships
 * `Restart=always`, so a clean `process.exit(0)` is enough and needs no root
 * privilege, no helper script and no systemd unit of its own. Override the
 * strategy with `restartCommand` when the service is managed differently.
 *
 * ESM module format (cordis bundle rule): named exports apply/inject/name.
 *
 * @module dsh-restart-confirm
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-restart-confirm'

/**
 * `webServer` is a hard dependency: without an HTTP surface the browser half
 * has nothing to poll, so the plugin has no reason to load.
 */
export const inject = ['webServer']

/** Files whose mutation means the running process diverged from the profile. */
const WATCHED_FILES = ['package.json', 'cordis.patch.yml']

/** Polling fallback cadence; `fs.watch` is the fast path, this is the safety net. */
const POLL_MS = 2000

/** Schema for the patch-row config. */
export const Config = z.object({
  /** Milliseconds a pending restart waits for an answer before restarting anyway. */
  autoRestartSec: z.natural().default(180),
  /** Profile directory to watch; auto-detected from the plugin location by default. */
  profileDir: z.string(),
  /** Watch the profile directory for changes. @default true */
  watch: z.boolean().default(true),
  /** Restart strategy: `process-exit` (needs systemd `Restart=always`) or `command`. */
  restartMode: z.union([z.const('process-exit'), z.const('command')]).default('process-exit'),
  /** Executable used when `restartMode` is `command`. */
  restartCommand: z.string().default('systemctl'),
  /** Arguments for `restartCommand`. */
  restartArgs: z.array(z.string()).default(['restart', 'dsh.service']),
  /** Milliseconds between the response write and the restart, so the page sees the answer first. */
  exitDelayMs: z.natural().default(400),
})

// --- profile location --------------------------------------------------------

/**
 * Resolve `$DSH_HOME` the same way the harness does.
 * @returns {string} Absolute DSH home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (typeof home === 'string' && home.length > 0) return path.join(home, '.dsh')
  return path.join(process.cwd(), '.dsh')
}

/**
 * Walk up from this module until the enclosing `profiles/<name>` directory is
 * found. This plugin is installed as `$DSH_HOME/profiles/<name>/node_modules/
 * <package>`, so the module location is authoritative — it names the profile
 * that actually loaded the plugin, even with several profiles present.
 * @param {string} from - Absolute path of a file or directory inside the package.
 * @returns {string | undefined} The profile directory, when one encloses `from`.
 */
function profileDirFrom(from) {
  let dir = path.resolve(from)
  const root = path.parse(dir).root
  while (dir !== root) {
    if (path.basename(path.dirname(dir)) === 'profiles' && path.basename(dir) !== 'node_modules') {
      return dir
    }
    dir = path.dirname(dir)
  }
  return undefined
}

/**
 * Decide which profile directory to watch.
 * @param {string | undefined} configured - `profileDir` from the patch row.
 * @returns {string} Absolute profile directory.
 */
function resolveProfileDir(configured) {
  if (typeof configured === 'string' && configured.length > 0) return path.resolve(configured)
  const fromModule = profileDirFrom(path.dirname(fileURLToPath(import.meta.url)))
  if (fromModule !== undefined) return fromModule
  const envProfile = process.env.DSH_PROFILE
  if (typeof envProfile === 'string' && envProfile.length > 0) {
    return path.join(dshHome(), 'profiles', envProfile)
  }
  return path.join(dshHome(), 'profiles', 'web')
}

// --- tiny helpers ------------------------------------------------------------

/**
 * Read a file, returning `undefined` for a missing one.
 * @param {string} file - Absolute path.
 * @returns {Buffer | undefined} File contents.
 */
function readIfExists(file) {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Fingerprint the watched files.
 *
 * The **content** digest identifies the configuration itself and is the only
 * thing that arms the confirmation bar: a different profile means the running
 * process no longer matches the disk, and a pure `touch` of unchanged files
 * means nothing needs restarting. The digest stays stable across the
 * metadata-only writes several install paths perform.
 *
 * @param {string} dir - Profile directory.
 * @returns {string} Hex digest of the watched files, `-` for a missing file.
 */
function revisionOf(dir) {
  const hash = createHash('sha1')
  for (const file of WATCHED_FILES) {
    const body = readIfExists(path.join(dir, file))
    hash.update(`${file}\0`)
    hash.update(body === undefined ? '-' : body)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Write JSON through a temporary file so a concurrent reader never observes a
 * half-written document.
 * @param {string} file - Destination path.
 * @param {unknown} value - JSON-serializable value.
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * Read a request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @returns {Promise<string>} Decoded body text.
 */
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

// --- restart -----------------------------------------------------------------

/**
 * Re-execute the service.
 *
 * `process-exit` relies on the unit's `Restart=always` and is the default
 * because it needs no privilege at all. `command` runs an external
 * restart command (for example `systemctl restart dsh.service`) for hosts
 * where the service is not supervised that way.
 * @param {object} config - Resolved plugin config.
 * @param {{ info: (message: string) => void, error: (message: string) => void }} logger - Cordis logger.
 */
function performRestart(config, logger) {
  if (config.restartMode === 'command') {
    logger.info(`restarting via ${config.restartCommand} ${config.restartArgs.join(' ')}`)
    execFile(config.restartCommand, config.restartArgs, (error) => {
      if (error !== null && error !== undefined) {
        logger.error(`restart command failed: ${error.message}`)
        return
      }
      // The command may have restarted a unit that owned this process; when
      // this process is still alive afterwards, exit so a supervisor can
      // bring it back with the new configuration.
      setTimeout(() => process.exit(0), config.exitDelayMs)
    })
    return
  }
  logger.info('restarting: exiting so the service supervisor starts a fresh process')
  // Deferred so the HTTP response to the page is flushed before the socket dies.
  setTimeout(() => process.exit(0), config.exitDelayMs)
}

// --- apply -------------------------------------------------------------------

/**
 * Register the restart-confirm routes and start watching the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - Resolved plugin config.
 */
export function apply(ctx, config) {
  const ws = ctx.get('webServer')
  if (ws === undefined) return

  const logger = ctx.logger(name)
  const dir = resolveProfileDir(config.profileDir)
  const autoRestartMs = config.autoRestartSec * 1000

  /** @type {{ requestedAt: string, reason: string, revision: string, autoRestartAt: number | null } | undefined} */
  let pending
  /** @type {NodeJS.Timeout | undefined} */
  let autoTimer
  /** @type {NodeJS.Timeout | undefined} */
  let armTimer
  let restarting = false
  /** Content identity of the configuration the bar treats as acknowledged. */
  let baseline = revisionOf(dir)

  const state = () => ({
    pending: pending !== undefined,
    restarting,
    profileDir: dir,
    ...pending === undefined
      ? {}
      : {
          requestedAt: pending.requestedAt,
          reason: pending.reason,
          revision: pending.revision,
          // Fixed deadline captured when the bar was armed. Recomputing it per
          // request would move it forward on every poll, so a page polling
          // faster than the timeout would watch a countdown that never drops.
          autoRestartAt: pending.autoRestartAt,
        },
  })

  /** Drop the pending state and cancel the auto-restart timer. */
  function clearPending() {
    pending = undefined
    if (autoTimer !== undefined) {
      clearTimeout(autoTimer)
      autoTimer = undefined
    }
  }

  /**
   * Restart now, whatever the reason.
   * @param {string} reason - Log reason.
   */
  function restartNow(reason) {
    if (restarting) return
    restarting = true
    clearPending()
    logger.info(`restart confirmed (${reason})`)
    performRestart(config, logger)
  }

  /**
   * Arm the confirmation bar for a detected profile change. A further content
   * change re-arms with the newer revision and restarts the countdown.
   * @param {string} revision - Content digest of the changed profile files.
   * @param {string} reason - Human-readable cause shown in the bar.
   */
  function arm(revision, reason) {
    baseline = revision
    if (autoTimer !== undefined) clearTimeout(autoTimer)
    pending = {
      requestedAt: new Date().toISOString(),
      reason,
      revision,
      autoRestartAt: autoRestartMs > 0 ? Date.now() + autoRestartMs : null,
    }
    logger.info(`profile changed (${reason}); awaiting restart confirmation`)
    if (autoRestartMs > 0) {
      autoTimer = setTimeout(() => restartNow('auto timeout'), autoRestartMs)
    }
  }

  // Detection compares content digests, so it catches in-place edits and stays
  // stable across the metadata-only writes an installer may perform. It runs on
  // both a debounced `fs.watch` event and a slow poll.
  function detect() {
    if (restarting) return
    const revision = revisionOf(dir)
    if (revision === baseline) return
    arm(revision, 'profile files changed')
  }

  const disposers = []
  if (config.watch) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        const changed = filename === null ? undefined : String(filename)
        if (changed !== undefined && !WATCHED_FILES.includes(changed)) return
        if (armTimer !== undefined) clearTimeout(armTimer)
        // Debounce: `dsh plugin` rewrites several files in one operation.
        armTimer = setTimeout(() => {
          armTimer = undefined
          detect()
        }, 250)
      })
      disposers.push(() => watcher.close())
      logger.info(`watching ${dir} for plugin changes`)
    } catch (error) {
      logger.error(`cannot watch ${dir}: ${error.message}; relying on polling`)
    }
    const poll = setInterval(detect, POLL_MS)
    poll.unref?.()
    disposers.push(() => clearInterval(poll))
  }

  const routes = [
    {
      kind: 'exact',
      path: '/__restart-confirm/state',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, state())
      },
    },
    {
      kind: 'exact',
      path: '/__restart-confirm/respond',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw.length > 0) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const action = String(body.action ?? '')
        if (action !== 'now' && action !== 'later') {
          sendJson(res, 400, { error: "action must be 'now' or 'later'" })
          return
        }
        if (action === 'later') {
          logger.info('restart deferred by the page')
          // Acknowledge the configuration currently on disk, otherwise the very
          // next poll would consider the change new again and re-arm the bar.
          // A later, further content change still arms it.
          if (pending !== undefined) baseline = revisionOf(dir)
          clearPending()
          sendJson(res, 200, { ok: true, action })
          return
        }
        sendJson(res, 200, { ok: true, action })
        restartNow('page confirmation')
      },
    },
    {
      kind: 'exact',
      path: '/__restart-confirm/restart',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, { ok: true })
        restartNow('explicit request')
      },
    },
  ]

  ctx.effect(() => {
    const off = routes.map((route) => ws.register(route))
    return () => {
      for (const dispose of off) dispose()
      if (armTimer !== undefined) clearTimeout(armTimer)
      if (autoTimer !== undefined) clearTimeout(autoTimer)
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-restart-confirm: routes + profile watcher')
}
