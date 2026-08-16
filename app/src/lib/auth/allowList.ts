/**
 * Email allow-list validation utilities
 * Manages access control based on allowed email addresses
 */

/**
 * Gets the list of allowed email addresses from environment variable
 * @returns Array of allowed email addresses (lowercase)
 */
export function getAllowedEmails(): string[] {
  const allowedEmailsEnv = import.meta.env.VITE_ALLOWED_EMAILS;

  if (!allowedEmailsEnv) {
    console.warn('[allowList] VITE_ALLOWED_EMAILS not configured. All emails will be rejected.');
    return [];
  }

  // Split by comma, trim whitespace, convert to lowercase
  return allowedEmailsEnv
    .split(',')
    .map((email: string) => email.trim().toLowerCase())
    .filter((email: string) => email.length > 0);
}

/**
 * Checks if an email address is in the allow-list
 * @param email - Email address to check
 * @returns true if email is allowed, false otherwise
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const allowedEmails = getAllowedEmails();

  if (allowedEmails.length === 0) {
    console.warn('[allowList] No allowed emails configured. Rejecting access.');
    return false;
  }

  // Check for exact match
  if (allowedEmails.includes(normalizedEmail)) {
    return true;
  }

  // Check for wildcard domain matches (e.g., *@company.com)
  const wildcardDomains = allowedEmails.filter(e => e.startsWith('*@'));
  for (const wildcardDomain of wildcardDomains) {
    const domain = wildcardDomain.substring(1); // Remove the *
    if (normalizedEmail.endsWith(domain)) {
      return true;
    }
  }

  return false;
}

/**
 * Gets a user-friendly error message for unauthorized access
 * @returns Error message string
 */
export function getUnauthorizedMessage(): string {
  return 'Access is restricted to authorized users only. If you need access, please contact the administrator.';
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
      : 'Access denied: No email address provided.';
    throw new Error(message);
  }
}
