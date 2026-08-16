/**
 * jsdom has no ResizeObserver / IntersectionObserver, and the zag machines
 * behind Ark's ScrollArea, Collapsible and autoresize-textarea construct one
 * on mount. Install inert stubs so mounting a component under test doesn't
 * die inside a third-party effect.
 *
 * Deliberately no-ops rather than fakes: nothing here asserts on layout, and a
 * stub that *fired* callbacks would invent scroll/resize events the real
 * browser never produced.
 *
 * Call from `beforeAll` in any test that renders an Ark component.
 */
class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

export function installDomObservers() {
  const g = globalThis as Record<string, unknown>
  g.ResizeObserver ??= InertObserver
  g.IntersectionObserver ??= InertObserver
}
