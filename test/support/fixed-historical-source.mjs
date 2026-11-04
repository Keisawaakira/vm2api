// Sealed v1201 ABI/source regressions. These are NOT the current runtime selector.
// v1437 release acceptance lives in fixed-native-refresh.test.mjs and real loader/install tests.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const expected = {
  wrap: '7e158d30d71d726fa3ab330c126edda32fe810f78160adfe787572bfaf435547',
  cc: 'd542668ae3f14d17e66c6c71f3da1061d50700e4bb74dae05ef615ce3b8e0397',
}
export function historicalFixedSource(root, kind) {
  const directory = path.join(root, 'share', kind + '-fixed/v1201-r1')
  const file = path.join(directory, kind === 'cc' ? 'cc-node' : 'cli-node')
  if (!fs.existsSync(file)) throw Error('Historical source input missing; this is not a runtime fallback: ' + file)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (hash !== expected[kind]) throw Error('Sealed historical source changed: ' + kind)
  return directory
}
