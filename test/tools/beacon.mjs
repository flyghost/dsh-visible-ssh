// One question, one listener: when the agent edits plugin/lib/client/index.js, does a
// RUNNING DSH GUI ever re-execute those bytes?
//
// The platform answers "no" on paper — dsh-client-modules snapshots each client
// bundle at startup and serves it immutably under a rev-parameterised URL, and
// `rebuilt()` (the HMR hook) is documented as "the only entry point through which
// bundle content changes reach the graph".  HMR is supposed to call it.  Whether
// it actually does so for a junction-installed third-party plugin is exactly the
// kind of thing that "looks like it passes" from reading code, so the client half
// gets a top-level beacon: every evaluation of the bundle pings this server.
//
// A hit after an edit, with nobody touching the browser, means the GUI hot-swapped
// the module (no refresh).  A hit only after a manual reload means something else
// is re-serving old bytes.  No hit at all means the bytes never moved and the host
// must be restarted.  Cross-origin, so CORS is wide open and no-cors beacons are
// accepted too; both are harmless on loopback.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The log lives with the other generated state (test/env/browser), not in git. */
const LOG = join(HERE, '..', 'env', 'browser', 'beacon.log')
const PORT = Number(process.argv[2] ?? 8099)

writeFileSync(LOG, '')

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
  const agent = String(req.headers['origin'] ?? req.headers['user-agent'] ?? '').slice(0, 60)
  const line = `${new Date().toISOString()} ${req.method} ${req.url} origin=${agent}`
  appendFileSync(LOG, `${line}\n`)
  console.log(line)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end('{"ok":true}\n')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`beacon: http://127.0.0.1:${PORT}/ (log ${LOG})`)
})
