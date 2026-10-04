#!/usr/bin/env node
/**
 * Build — or check — everything the test harness needs that is deliberately NOT in git.
 *
 * Three kinds of state live under `test/env/`, and every one of them is either a
 * downloaded tree or a link into this repository, so none of it belongs in the
 * repository:
 *
 *   node_modules/              the workspace deps (typescript, cordis, dsh-tools)
 *   test/node_modules/         playwright, which npm does not hoist to the root
 *   test/env/host/node_modules a real DSH web host, for the browser-level check
 *   test/env/home/             an isolated DSH_HOME (rebuilt from env/home.seed/)
 *   test/env/browser/          browser profiles — a human starts those browsers
 *   test/env/tmp/, evidence/   suite sandboxes, screenshots
 *
 * What IS in git: `test/package.json`, `test/env/host/package.json`, and
 * `test/env/home.seed/` — the manifests and the home template. This script turns
 * those into a working environment, and `--check` says whether one already exists
 * without changing anything.
 *
 * It never touches the operator's real `~/.dsh`: it only writes inside `test/`.
 *
 * Usage:
 *   node test/tools/setup-env.mjs            # build what is missing
 *   node test/tools/setup-env.mjs --check    # report only; exit 1 if incomplete
 *   node test/tools/setup-env.mjs --force    # reinstall deps and rebuild the home
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST = resolve(HERE, '..')
const REPO = resolve(TEST, '..')
const ENV = join(TEST, 'env')
const HOME = join(ENV, 'home')
const SEED = join(ENV, 'home.seed')
const HOST = join(ENV, 'host')
const PROFILE_LINK = join(HOME, 'profiles', 'web', 'node_modules', 'dsh-visible-ssh')

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const force = args.has('--force')

let problems = 0
const say = (status, name, detail = '') => console.log(`${status.padEnd(4)} ${name}${detail === '' ? '' : ` — ${detail}`}`)
const ok = (name, detail) => say('ok', name, detail)
const missing = (name, detail) => { problems += 1; say(checkOnly ? 'FAIL' : 'skip', name, detail) }

/** Present as a LINK, not as its target: `existsSync` follows links, so a dangling
 *  junction reads as absent and would be re-created on top of itself. */
const present = (path) => { try { lstatSync(path); return true } catch { return false } }

/** The target a junction/symlink points at, or null when it is not a link.
 *  Windows reports it with a `\\?\` prefix for junctions; normalise both sides. */
function linkTarget(path) {
  try { return readlinkSync(path).replace(/^\\\\\?\\/, '').replace(/\\/g, '/') } catch { return null }
}
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/** Remove a directory link WITHOUT walking into it — `rm -rf` on a junction deletes
 *  the target's contents, which here would be the plugin or a 500 MB npm tree. */
function removeLink(path) {
  try { rmdirSync(path); return true } catch { /* fall through to cmd */ }
  return spawnSync('cmd', ['/c', 'rmdir', path], { stdio: 'ignore' }).status === 0
}

function makeJunction(link, target) {
  mkdirSync(dirname(link), { recursive: true })
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `New-Item -ItemType Junction -Path '${link}' -Target '${target}' | Out-Null`,
  ], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`could not create the junction ${link} -> ${target}`)
}

function ensureJunction(link, target, name) {
  if (present(link)) {
    if (samePath(linkTarget(link), target)) { ok(name, linkTarget(link)); return }
    if (checkOnly) { missing(name, `points at ${linkTarget(link) ?? 'a real directory'}, expected ${target}`); return }
    removeLink(link)
  } else if (checkOnly) {
    missing(name, `no link at ${link}`)
    return
  }
  if (checkOnly) return
  makeJunction(link, target)
  ok(name, `${link} -> ${target}`)
}

/** Install a tree that has its own manifest, or the workspace root itself.
 *  `marker` is the path whose presence means "this is installed" — for the
 *  workspace root that is a package the install must have hoisted, because the
 *  root always has a `node_modules/` as soon as anything is installed. */
function npmInstall(dir, name, marker = join(dir, 'node_modules')) {
  const installed = present(marker)
  if (installed && !force) { ok(name, 'already installed (use --force to reinstall)'); return }
  if (checkOnly) { missing(name, `nothing at ${marker}`); return }
  // The repo-local cache keeps a confined sandbox out of the operator's global npm cache.
  const cache = join(REPO, 'scratch', 'cache', 'npm-cache')
  const argv = ['install', '--no-audit', '--no-fund', ...(existsSync(cache) ? ['--cache', cache] : [])]
  // npm on Windows is npm.cmd, and Node refuses to spawn a .cmd without a shell.
  const [file, args] = process.platform === 'win32' ? ['cmd', ['/c', 'npm', ...argv]] : ['npm', argv]
  say('npm', `${name} → npm ${argv.join(' ')}`)
  const res = spawnSync(file, args, { cwd: dir, stdio: 'inherit' })
  if (res.error) throw new Error(`could not run npm in ${dir}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`npm install failed in ${dir} (exit ${res.status})`)
  ok(name, 'installed')
}

function ensureHome() {
  const name = 'isolated home (test/env/home)'
  const profile = join(HOME, 'profiles', 'web', 'package.json')
  if (present(profile) && !force) {
    const mounts = readFileSync(profile, 'utf8').includes('dsh-visible-ssh')
    if (mounts) { ok(name, `${HOME} (from env/home.seed)`); return }
    if (checkOnly) { missing(name, `${profile} does not mount dsh-visible-ssh`); return }
  } else if (checkOnly) {
    missing(name, `no home at ${HOME} — rebuild with: node test/tools/setup-env.mjs`)
    return
  }
  if (checkOnly) return
  // Junction-aware removal: the home contains a link into this repository.
  if (present(HOME)) {
    const res = spawnSync(process.execPath, [join(HERE, 'rmtree.mjs'), HOME], { stdio: 'inherit' })
    if (res.status !== 0) throw new Error(`could not clear ${HOME}`)
  }
  cpSync(SEED, HOME, { recursive: true })
  writeFileSync(profile, readFileSync(profile, 'utf8').replaceAll('__REPO__', REPO.replace(/\\/g, '/')), 'utf8')
  ok(name, `rebuilt from env/home.seed (__REPO__ → ${REPO.replace(/\\/g, '/')})`)
}

console.log(checkOnly ? 'checking the test environment (nothing will be written)' : 'building the test environment')
// The workspace root installs `plugin/` and `test/` together (npm workspaces): one
// lockfile, one tree, and the plugin resolves its peer deps by walking up. Only the
// browser driver is left un-hoisted under `test/`, and the DSH host is its own tree.
npmInstall(REPO, 'workspace deps (typescript, cordis, dsh-tools)', join(REPO, 'node_modules', 'typescript'))
npmInstall(TEST, 'browser driver (playwright)', join(TEST, 'node_modules', 'playwright'))
npmInstall(HOST, 'DSH web host (test/env/host)')
ensureHome()
ensureJunction(PROFILE_LINK, join(REPO, 'plugin'), 'the web profile mounts dsh-visible-ssh')

for (const dir of [join(ENV, 'tmp'), join(ENV, 'evidence', 'shots'), join(ENV, 'browser')]) {
  if (checkOnly) continue
  mkdirSync(dir, { recursive: true })
}

if (checkOnly) {
  console.log(problems === 0 ? 'OK: the test environment is complete' : `FAILED: ${problems} thing(s) missing — run: node test/tools/setup-env.mjs`)
  process.exit(problems === 0 ? 0 : 1)
}
console.log(`
still manual, and only when you want those checks to run:
  - a human starts the browser:  test\\tools\\start-agent-browser.cmd
    (Chromium's Mojo IPC needs a named pipe the agent's sandbox denies)
  - a reachable remote host, always given explicitly — no check here reads your
    home directory or borrows a profile from it:
      SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…] node test/own-host-check.mjs
    which also writes the host.toml the engine reads (under test/env/tmp/, no
    password in it). To use this repo's own scripts/config/host.toml on purpose
    instead: VISIBLE_SSH_USE_REPO_CONFIG=1.
`)
