// @vitest-environment node
/**
 * Every file under `docs/images/` stays small and consistently named.
 *
 * The repo is public and these images are reused in READMEs and on the project
 * website, so an unoptimised multi-megabyte PNG is paid for by every clone and
 * every page load. Budget: 500 KB per file; names are lowercase kebab-case.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const IMAGES_DIR = path.resolve(__dirname, '../../../docs/images')
const MAX_BYTES = 500 * 1024
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+$/

const files = readdirSync(IMAGES_DIR, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(IMAGES_DIR, path.join(e.parentPath, e.name)))

describe('docs/images', () => {
  it('has images to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('names every file in lowercase kebab-case', () => {
    expect(files.filter((f) => !KEBAB.test(f))).toEqual([])
  })

  it('keeps every file at or under 500 KB', () => {
    const oversized = files.filter((f) => statSync(path.join(IMAGES_DIR, f)).size > MAX_BYTES)
    expect(oversized).toEqual([])
  })
})
