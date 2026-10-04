// Junction-aware recursive delete: the ONLY safe way to remove a tree that may
// contain reparse points. `Remove-Item -Recurse` / `rm -rf` can walk THROUGH a
// junction and delete the TARGET's contents — for the junction farms under test/env
// that means the real store under ~/.dsh.
//
// Directories are removed with rmdirSync, which only succeeds while EMPTY: if a
// link survived the walk, this throws instead of silently recursing into it.
//
//   node test/tools/rmtree.mjs <path> [...more]
import { lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

const counts = { links: 0, dirs: 0, files: 0 }

function purge(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    rmSync(path, { recursive: false, force: true })
    counts.links += 1
    return
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) purge(join(path, entry))
    rmdirSync(path)
    counts.dirs += 1
    return
  }
  rmSync(path, { force: true })
  counts.files += 1
}

/**
 * Present as a LINK, not as a target. `existsSync` follows links, so a DANGLING
 * junction reads as absent — and would be skipped here, left behind on disk.
 */
function present(path) {
  try { lstatSync(path); return true } catch { return false }
}

for (const target of process.argv.slice(2)) {
  if (!present(target)) {
    console.log(`absent  ${target}`)
    continue
  }
  purge(target)
  console.log(`removed ${target}`)
}
console.log(JSON.stringify(counts))
