// Throwaway probe for one question: can a process started inside the agent's
// file sandbox listen on loopback, and is that listener reachable from the
// user's own browser on the same machine?
//
// It answers "是沙箱里起的，但浏览器能看吗" with a URL the user can click,
// instead of an argument. No dependencies, random port, 127.0.0.1 only.
import { createServer } from 'node:http'
import { cwd, pid, platform } from 'node:process'

const server = createServer((req, res) => {
  const body = {
    ok: true,
    message: '如果你能读到这段 JSON，说明：agent 沙箱里起的进程，你的浏览器能访问。',
    pid,
    platform,
    cwd: cwd(),
    url: req.url,
    at: new Date().toISOString(),
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(`${JSON.stringify(body, null, 2)}\n`)
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  // The readiness line, on stdout, exactly like `dsh web` prints its own.
  console.log(`loopback-probe: http://127.0.0.1:${port}/ (pid ${pid})`)
})

// The job stays up until it is killed; a job that exits immediately would prove
// nothing about a long-running host.
