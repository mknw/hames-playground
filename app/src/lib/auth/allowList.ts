/**
 * Email allow-list validation utilities
 * Manages access control based on allowed email addresses
 */

/**
 * Gets the list of allowed email addresses from environment variable
 * @returns Array of allowed email addresses (lowercase)
 */
export function getAllowedEmails(): string[] {
  // `process.env` first, `import.meta.env` second. Vite inlines VITE_-prefixed
  // vars at BUILD time, which is fine on the host (the build reads app/.env)
  // but wrong for the container image (#197): the list would be frozen into
  // the image, so a new tenant or a changed domain would need a rebuild — and
  // an image built without app/.env present would bake in *nothing* and reject
  // every sign-in. This module is server-only (auth/server.ts,
  // api/auth/callback.ts), so process.env is available and is the right source
  // of truth at runtime; the build-time value stays as the fallback so
  // `pnpm dev` and the host build behave exactly as before.
  const allowedEmailsEnv =
    (typeof process !== 'undefined' ? process.env.VITE_ALLOWED_EMAILS : undefined) ||
    import.meta.env.VITE_ALLOWED_EMAILS

  if (!allowedEmailsEnv) {
    console.warn('[allowList] VITE_ALLOWED_EMAILS not configured. All emails will be rejected.')
    return []
  }

  // Split by comma, trim whitespace, convert to lowercase
  return allowedEmailsEnv
    .split(',')
    .map((email: string) => email.trim().toLowerCase())
    .filter((email: string) => email.length > 0)
}

/**
 * Checks if an email address is in the allow-list
 * @param email - Email address to check
 * @returns true if email is allowed, false otherwise
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) {
    return false
  }

  const normalizedEmail = email.trim().toLowerCase()
  const allowedEmails = getAllowedEmails()

  if (allowedEmails.length === 0) {
    console.warn('[allowList] No allowed emails configured. Rejecting access.')
    return false
  }

  // Check for exact match
  if (allowedEmails.includes(normalizedEmail)) {
    return true
  }

  // Check for wildcard domain matches (e.g., *@company.com)
  const wildcardDomains = allowedEmails.filter((e) => e.startsWith('*@'))
  for (const wildcardDomain of wildcardDomains) {
    const domain = wildcardDomain.substring(1) // Remove the *
    if (normalizedEmail.endsWith(domain)) {
      return true
    }
  }

  return false
}

/**
 * Gets a user-friendly error message for unauthorized access
 * @returns Error message string
 */
export function getUnauthorizedMessage(): string {
  return 'Access is restricted to authorized users only. If you need access, please contact the administrator.'
}

/**
 * Validates email and throws error if not allowed
 * Useful for server-side validation
 * @param email - Email to validate
 * @throws Error if email is not allowed
 */
export function requireAllowedEmail(email: string | null | undefined): void {
  if (!isEmailAllowed(email)) {
    const message = email
      ? `Access denied: ${email} is not authorized to use this application.`
      : 'Access denied: No email address provided.'
    throw new Error(message)
  }
}
