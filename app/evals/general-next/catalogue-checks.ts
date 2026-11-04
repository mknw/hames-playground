/**
 * A scenario module's catalogue-sourced graders (`catalogue-graders.ts` maps them).
 * The catalogue is read with `readFileSync`, never imported as a module, once, at
 * scenario-module load: `--list` reads it too, and it carries no credential.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  catalogueGraders,
  type CatalogueGraders,
  type GraderCatalogue,
} from '../../src/lib/eval-support/catalogue-graders'

const FILE = fileURLToPath(new URL('./scenarios.catalogue.json', import.meta.url))
let cached: GraderCatalogue | undefined

export function catalogueChecks(id: string): CatalogueGraders {
  cached ??= JSON.parse(readFileSync(FILE, 'utf8')) as GraderCatalogue
  return catalogueGraders(cached, id)
}
