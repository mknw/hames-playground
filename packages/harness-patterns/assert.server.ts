/**
 * Server-Side Assertion Utilities
 *
 * Runtime checks to ensure harness-patterns code only runs on the server.
 */

export class ServerOnlyError extends Error {
  constructor(message = 'harness-patterns must run on server') {
    super(message);
    this.name = 'ServerOnlyError';
  }
}

/**
 * Assert that code is running on the server.
 * Throws if called from browser environment.
 */
export function assertServer(): void {
  if (typeof window !== 'undefined') {
    throw new ServerOnlyError();
  }
}

/**
 * Call at module top-level to prevent client-side import.
 * Use in .server.ts files to enforce server-only execution.
 */
export function assertServerOnImport(): void {
  assertServer();
}

// Self-enforce: this module should only be imported on server
assertServerOnImport();
