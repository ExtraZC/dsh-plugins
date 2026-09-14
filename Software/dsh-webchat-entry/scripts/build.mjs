#!/usr/bin/env node
/**
 * Build the client/host artifacts.
 *
 * Both halves are hand-written plain JavaScript that needs no transpilation —
 * the host half is ESM and the client half is the classic-script bundle format
 * `dsh-client-modules` expects. "Building" therefore means validating the
 * sources against the bundle protocol and copying them to `lib/`, which is what
 * `package.json` exports.
 *
 * The require audit is the important check: a client bundle may only require a
 * platform seed word or a specifier it declared in `dsh.client.external`.
 * Requiring anything else resolves at runtime only if some *other* plugin
 * happened to load it first — the load-order race that a missing declaration
 * hides. Catching it here keeps the bundle honest.
 *
 * Usage: node scripts/build.mjs [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Module specifiers the web shell seeds into the client module table before any
 * bundle loads (`staticModules` in the built frontend). A bundle may require
 * these unconditionally; everything else must be declared as an external.
 */
const PLATFORM_SEED_WORDS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Source file -> artifact path. */
const artifacts = [
  { source: 'src/index.js', target: 'lib/index.js', kind: 'module' },
  { source: 'src/client.js', target: 'lib/client.js', kind: 'script' },
]

/**
 * Syntax-check a source as the module system that will execute it.
 * @param {string} file - Path relative to the package root.
 * @param {string} source - File contents.
 * @param {'module' | 'script'} kind - Parse goal.
 */
function checkSyntax(file, source, kind) {
  if (kind === 'module') {
    if (typeof vm.SourceTextModule !== 'function') {
      throw new Error('vm.SourceTextModule is unavailable; run node with --experimental-vm-modules')
    }
    // Construction parses the source and throws on a syntax error.
    new vm.SourceTextModule(source, { identifier: file })
    return
  }
  new vm.Script(source, { filename: file })
}

/**
 * Validate the client bundle protocol: it must register exactly the package id
 * through the module-loader facade.
 * @param {string} source - Client bundle contents.
 */
function checkClientBundle(source) {
  const registration = new RegExp(
    `window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*['"]${pkg.name.replaceAll('.', '\\.')}['"],`
  )
  if (!registration.test(source)) {
    throw new Error(
      `src/client.js must register window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, … })`
    )
  }
  if (!pkg.exports['./client']) throw new Error('package.json exports["./client"] is missing')
  if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be "web"')
}

/**
 * Audit every `require('…')` in the client bundle against the platform seed
 * table and the declared externals.
 * @param {string} source - Client bundle contents.
 */
function checkClientRequires(source) {
  const declared = new Set(pkg.dsh?.client?.external ?? [])
  const seen = new Set()
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1]
    // `require` is also how the factory itself is invoked; only bare package
    // specifiers are dependency edges worth auditing.
    seen.add(specifier)
    if (PLATFORM_SEED_WORDS.includes(specifier)) continue
    if (declared.has(specifier)) continue
    throw new Error(
      `src/client.js requires ${JSON.stringify(specifier)}, which is neither a platform seed word nor ` +
        `declared in dsh.client.external — it would resolve only by another plugin's load order`
    )
  }
  if (seen.size === 0) throw new Error('src/client.js requires nothing; expected at least a react import')
}

let failed = false
for (const artifact of artifacts) {
  const file = join(root, artifact.source)
  const source = readFileSync(file, 'utf8')
  try {
    checkSyntax(artifact.source, source, artifact.kind)
    if (artifact.kind === 'script') {
      checkClientBundle(source)
      checkClientRequires(source)
    }
  } catch (error) {
    failed = true
    process.stderr.write(`build: ${artifact.source}: ${error.message}\n`)
    continue
  }
  if (checkOnly) {
    process.stdout.write(`build: ${artifact.source} ok (not written)\n`)
    continue
  }
  const target = join(root, artifact.target)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source)
  process.stdout.write(`build: ${artifact.source} -> ${artifact.target}\n`)
}

process.exitCode = failed ? 1 : 0
