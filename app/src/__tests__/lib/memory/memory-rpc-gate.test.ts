/** SD-13 source pin. The mutations below run against the same scanner as production. */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'
const path = 'src/lib/memory/actions.server.ts'
const source = readFileSync(path, 'utf8')
function violations(text: string): string[] {
  const file = ts.createSourceFile('actions.server.ts', text, ts.ScriptTarget.Latest, true)
  const errors: string[] = []
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      errors.push('indirect export')
      continue
    }
    if (
      !ts.canHaveModifiers(node) ||
      !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue
    if (!ts.isFunctionDeclaration(node) || !node.body) {
      errors.push('non-function export')
      continue
    }
    const first = node.body.statements[0]?.getText(file).replace(/\s+/g, ' ').replace(/;$/, '')
    if (first !== 'const user = await requireUser()')
      errors.push(`${node.name?.text}: missing first-statement gate`)
    if (node.parameters.some((p) => /owner|userId/i.test(p.name.getText(file))))
      errors.push(`${node.name?.text}: owner argument`)
  }
  return errors
}
it('memory-rpc-gate: every memory RPC authenticates FIRST and takes no owner', () => {
  expect(source).toMatch(/^'use server'/)
  expect(violations(source)).toEqual([])
})
it('mutation: removing any first-statement gate reddens the pin', () => {
  for (const match of source.matchAll(/const user = await requireUser\(\)/g)) {
    const mutated =
      source.slice(0, match.index) +
      'const user = { id: "unguarded" }' +
      source.slice(match.index! + match[0].length)
    expect(violations(mutated)).not.toEqual([])
  }
})
it('mutation: a new ungated export or exported helper reddens the pin', () => {
  for (const addition of [
    'export async function leak() { return 1 }',
    'export { requireUser }',
    'export const helper = () => 1',
  ])
    expect(violations(source + '\n' + addition)).not.toEqual([])
  expect(
    violations(
      source +
        '\nexport async function scoped(owner: string) { const user = await requireUser(); return owner }',
    ),
  ).toContain('scoped: owner argument')
})
