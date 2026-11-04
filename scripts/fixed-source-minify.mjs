import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

export function sourceParser(root) {
  const web = createRequire(path.join(root, 'web/package.json'))
  return createRequire(web.resolve('eslint'))('espree')
}

function comparable(ast) {
  return JSON.stringify(ast, (key, value) =>
    ['range', 'loc', 'start', 'end', 'raw', 'tokens', 'comments'].includes(key)
      ? undefined
      : typeof value === 'bigint' ? `${value}n` : value,
  )
}

/** Remove only token gaps/comments; unlike a compiler printer, never rewrite expressions. */
export function exactWhitespaceMinify(code, root) {
  const parser = sourceParser(root)
  const ast = parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', tokens: true, range: true })
  const words = new Set(['Identifier', 'Keyword', 'Boolean', 'Null', 'Numeric', 'PrivateIdentifier'])
  const punctuators = ['++', '--', '=>', '==', '!=', '===', '!==', '<<', '>>', '>>>', '<=', '>=', '&&', '||', '??', '**', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=', '?.', '...', '<!--', '-->']
  let out = '', previous
  for (const token of ast.tokens) {
    const raw = code.slice(...token.range)
    if (previous) {
      const gap = code.slice(previous.range[1], token.range[0])
      const before = code.slice(...previous.range)
      const combined = before + raw
      const fuse = (words.has(previous.type) && words.has(token.type)) ||
        (previous.type === 'RegularExpression' && words.has(token.type)) ||
        (previous.type === 'Numeric' && raw.startsWith('.')) ||
        ((before.endsWith('/') && /^[/*]/.test(raw))) ||
        (previous.type === 'Punctuator' && token.type === 'Punctuator' &&
          punctuators.some(p => combined.startsWith(p) && p.length > before.length))
      out += /[\r\n\u2028\u2029]/.test(gap) ? '\n' : fuse ? ' ' : ''
    }
    out += raw
    previous = token
  }
  const checked = parser.parse(out, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  assert.equal(comparable(ast), comparable(checked), 'Whitespace compaction changed the exact parsed program')
  return out + '\n'
}
