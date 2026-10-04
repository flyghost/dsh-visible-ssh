// Mint the DSH web browser-session cookie and install it into the shared browser.
//
// Why: the GUI at http://127.0.0.1:43120/ answers "forbidden"/401 to anything without a
// signed browser-session cookie. The launch token in `?token=…` is process-local
// (@deepseek-ai/dsh-client-connection: processLaunchToken -> WeakMap, never persisted),
// but the signing secret IS durable: ~/.dsh/.credentials.yaml, record
// "client-connection/browser-session", payload.secret (32 bytes, base64url).
//
// Cookie format (same package, lib/index.js):
//   name  = "dsh-auth-" + base64url(sha256(authority))          authority = Host header
//   value = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
//   payload = { version: 1, authority, issuedAt, expiresAt }
// The server additionally requires expiresAt - issuedAt <= maxAgeMilliseconds (days-scale).
//
// Usage: DSH_CREDENTIALS=<path to .credentials.yaml> node test/tools/mint-dsh-cookie.mjs [cdpUrl] [authority ...]
//        …or pass --credentials <path> instead of the env var.
// Prints only derived names/status, never the secret.
//
// The credentials file is **never guessed**: this tool does not go looking in your home
// directory on its own. Give it explicitly, or it stops.

import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

// playwright is installed with the rest of the harness (test/node_modules), so resolve it
// against test/package.json instead of by bare specifier.
const requireFromTool = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = requireFromTool('playwright')

const argv = process.argv.slice(2)
const at = argv.findIndex((word) => word === '--credentials' || word.startsWith('--credentials='))
let credentialsPath = process.env.DSH_CREDENTIALS ?? ''
if (at !== -1) {
  credentialsPath = argv[at] === '--credentials' ? argv[at + 1] ?? '' : argv[at].slice('--credentials='.length)
  argv.splice(at, argv[at] === '--credentials' ? 2 : 1)
}
if (credentialsPath === '') {
  console.log(JSON.stringify({ skipped: 'no credentials file given — this tool never reads your home directory on its own. Pass DSH_CREDENTIALS=<path> (usually %USERPROFILE%\\.dsh\\.credentials.yaml) or --credentials <path>.' }, null, 2))
  process.exit(1)
}

const cdpUrl = argv[0] ?? 'http://127.0.0.1:9222'
const authorities = argv.slice(1)
if (authorities.length === 0) authorities.push('127.0.0.1:43120', 'localhost:43120')

const yaml = readFileSync(credentialsPath, 'utf8')
const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(yaml)
if (match === null) throw new Error(`no browser-session secret in ${credentialsPath}`)
const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
if (secret.byteLength !== 32) throw new Error(`secret is ${String(secret.byteLength)} bytes, expected 32`)

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const cookies = authorities.map((authority) => {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  const body = b64url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now - 1_000,
    expiresAt: now + 60 * 60 * 1_000
  }), 'utf8'))
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  const host = authority.replace(/:\d+$/u, '')
  return { name, value, host, authority }
})

const browser = await chromium.connectOverCDP(cdpUrl)
const context = browser.contexts()[0]
if (context === undefined) throw new Error('no browser context over CDP')
for (const cookie of cookies) {
  await context.addCookies([{
    name: cookie.name,
    value: cookie.value,
    domain: cookie.host,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    expires: Math.floor((now + 60 * 60 * 1_000) / 1_000)
  }])
  console.log(`cookie installed  authority=${cookie.authority}  name=${cookie.name}`)
}

for (const authority of authorities) {
  const res = await context.request.get(`http://${authority}/`)
  const text = await res.text()
  console.log(`GET http://${authority}/ -> ${String(res.status())} ${JSON.stringify(text.slice(0, 120))}`)
}

// Leave the browser running: no browser.close(), just drop the CDP socket.
process.exit(0)
