// Minimal experiment: WHO is denied the named pipe?
//
// Chrome died as a GRANDCHILD of the harness, so the useful question is not "can a
// process create a named pipe" but "does the ability survive one level of
// CreateProcess".  This runs the listen() twice: once in this process, once in a
// child spawned with stdio:'inherit' (piped stdio is itself denied here, so the
// child must not need a pipe to talk back — it prints straight to the console).
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const isChild = process.argv.includes('--child')

function tryListen(label) {
  return new Promise((done) => {
    const server = createServer()
    server.on('error', (error) => {
      console.log(`${label} LISTEN-ERROR`, error.code, '|', error.message)
      done(false)
    })
    server.listen(`\\\\.\\pipe\\dsh-pipe-probe-${process.pid}`, () => {
      console.log(`${label} LISTEN-OK    ${JSON.stringify(server.address())}`)
      server.close(() => done(true))
    })
  })
}

const parentCould = await tryListen(isChild ? 'child :' : 'parent:')

if (!isChild) {
  const child = spawn(process.execPath, [self, '--child'], { stdio: 'inherit' })
  const code = await new Promise((done) => child.on('exit', done))
  console.log(`--- parent could listen = ${parentCould}, child exit = ${code}`)
}
