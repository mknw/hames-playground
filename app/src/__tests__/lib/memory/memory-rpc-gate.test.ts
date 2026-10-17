/** SD-13 source pin. The mutations below run against the same scanner as production. */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'
const path = 'src/lib/memory/actions.server.ts'
const source = readFileSync(path, 'utf8')
function violations(text: string): string[] {
  const file = ts.createSourceFile('actions.server.ts', text, ts.ScriptTarget.Latest, true)
  const errors: string[] = []
  const allowed: Record<string, string[]> = {
    listMyMemories: [],
    forgetMemory: ['memoryId'],
    forgetAllMemories: [],
    setMemoryEnabled: ['enabled'],
    exportMyMemories: [],
  }
  const dbImports = new Set<string>()
  for (const node of file.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.moduleSpecifier.text.startsWith('../db/')
    )
      continue
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) dbImports.add(binding.name.text)
  }
  function isUser(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return node.text === 'user'
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return isUser(node.expression)
    return false
  }
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
    const name = node.name?.text ?? ''
    const parameters = node.parameters.map((p) => p.name.getText(file))
    if (
      !Object.hasOwn(allowed, name) ||
      JSON.stringify(parameters) !== JSON.stringify(allowed[name])
    )
      errors.push(`${name}: unexpected export or parameters`)
    function walk(child: ts.Node) {
      if (
        ts.isBinaryExpression(child) &&
        child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        isUser(child.left)
      )
        errors.push(`${name}: principal assignment`)
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        dbImports.has(child.expression.text)
      ) {
        const first = child.arguments[0]
        if (
          !first ||
          !ts.isPropertyAccessExpression(first) ||
          !ts.isIdentifier(first.expression) ||
          first.expression.text !== 'user' ||
          first.name.text !== 'id'
        )
          errors.push(`${name}: database owner must be user.id`)
      }
      ts.forEachChild(child, walk)
    }
    walk(node.body)
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
  ).toContain('scoped: unexpected export or parameters')
})

it('mutation M3: a caller-chosen snake_case owner is refused', () => {
  expect(
    violations(
      source +
        '\nexport async function listFor(user_id: string) { const user = await requireUser(); void user; return listMemoriesForUser(user_id) }',
    ),
  ).toEqual(
    expect.arrayContaining([
      'listFor: unexpected export or parameters',
      'listFor: database owner must be user.id',
    ]),
  )
})
it('mutation M5: overwriting the gated principal is refused', () => {
  const mutated = source
    .replace('forgetMemory(memoryId: string)', 'forgetMemory(memoryId: string, who?: string)')
    .replace('  if (typeof memoryId', '  if (who) user.id = who\n  if (typeof memoryId')
  expect(violations(mutated)).toEqual(
    expect.arrayContaining([
      'forgetMemory: unexpected export or parameters',
      'forgetMemory: principal assignment',
    ]),
  )
})
it('mutation: replacing the principal or a database owner fails independently of parameter names', () => {
  expect(
    violations(
      source.replace(
        'const memories = await listMemoriesForUser(user.id)',
        'user = { id: "other" }; const memories = await listMemoriesForUser(user.id)',
      ),
    ),
  ).toContain('listMyMemories: principal assignment')
  expect(
    violations(source.replace('listMemoriesForUser(user.id)', 'listMemoriesForUser("other")')),
  ).toContain('listMyMemories: database owner must be user.id')
})
