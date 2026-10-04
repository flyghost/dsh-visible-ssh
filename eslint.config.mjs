// Flat config (ESLint 9+). Run it with `npm run lint` — part of `npm run ci`.
//
// What gets linted: the hand-written source (`plugin/src/**`, including the
// hand-written client half), the build/refresh scripts (`plugin/scripts/**`),
// and the test suites (`test/**`, minus `test/env/` which holds generated and
// downloaded trees, and `test/node_modules/`).
//
// What is ignored on purpose: build output (`plugin/lib/`), every installed
// tree, the scratch area, and the engine binaries (not source, not readable
// as text — they are checked by `test/artifact-check.mjs` against the
// sha256s in `packages/engine-win32-x64/engine.lock`).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      '**/node_modules/**',
      'plugin/lib/**',
      'test/env/**',
      'scratch/**',
      'packages/engine-win32-x64/*.exe',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `tsc --noEmit` (npm run typecheck) is the real gate for names and types,
    // so `no-undef` would only add noise: the Node globals this repo leans on
    // (`process`, `console`, `Buffer`, `fetch`, …) are numerous, differ across
    // Node releases, and the client half reaches `react` through `require`
    // because it is deliberately not compiled by tsc.
    rules: { 'no-undef': 'off' },
  },
]
