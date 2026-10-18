/** Host call boundary. Keep the generated client untouched; check before invoking it. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { b as generated } from './baml_client'
import { assertBamlCallAllowed, privateInferenceOnly } from './clients.server'

assertServerOnImport()

export const b: typeof generated = new Proxy(generated, {
  get(target, property) {
    const value = Reflect.get(target, property)
    if (typeof value === 'function') {
      return (...args: unknown[]) => {
        if (privateInferenceOnly()) {
          // BAML takes options POSITIONALLY. A trailing bag in the wrong slot
          // can otherwise pass a guard and silently drop the override (#154).
          assertBamlCallAllowed(
            String(property),
            args.length === value.length ? args.at(-1) : undefined,
          )
        }
        return Reflect.apply(value, target, args)
      }
    }
    if (
      privateInferenceOnly() &&
      value !== null &&
      typeof value === 'object' &&
      property !== 'bamlOptions'
    ) {
      throw new Error(
        'Private-only inference: unguarded BAML client access is refused before any request.',
      )
    }
    return value
  },
})
