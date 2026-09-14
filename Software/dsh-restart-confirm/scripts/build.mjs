#!/usr/bin/env node
/**
 * Build the client/host artifacts.
 *
 * Both halves are hand-written plain JavaScript that needs no transpilation —
 * the host half is ESM and the client half is the classic-script bundle format
 * `dsh-client-modules` expects. "Building" therefore means syntax-checking the
 * sources, validating the client bundle protocol, and copying them to `lib/`,
 * which is what `package.json` exports.
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

let failed = false
for (const artifact of artifacts) {
  const file = join(root, artifact.source)
  const source = readFileSync(file, 'utf8')
  try {
    checkSyntax(artifact.source, source, artifact.kind)
    if (artifact.kind === 'script') checkClientBundle(source)
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
