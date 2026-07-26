/// <reference types="@solidjs/start/env" />

declare namespace NodeJS {
  interface ProcessEnv {
    MISTRAL_API_KEY: string;
    // ----- Entra ID (Microsoft) OIDC — #119 -----
    /** Entra tenant (directory) GUID. Single-tenant authority. */
    AZURE_TENANT_ID: string;
    /** App registration (client) id. */
    AZURE_CLIENT_ID: string;
    /** Client secret from the app's Certificates & secrets. Server-only. */
    AZURE_CLIENT_SECRET: string;
    /** HMAC key for signed auth cookies (`openssl rand -base64 32`). */
    AUTH_SESSION_SECRET: string;
    /** Encrypts the per-user MSAL token cache at rest (#110). Falls back to
     *  an HKDF derivation from AUTH_SESSION_SECRET when unset. */
    TOKEN_ENCRYPTION_KEY: string;
    /** OIDC redirect URI; must match a registered Redirect URI. */
    AUTH_REDIRECT_URI: string;
    /** Post-sign-out landing URI. */
    AUTH_POST_LOGOUT_REDIRECT_URI: string;
    /** Postgres connection string (Neon / local docker). */
    DATABASE_URL: string;
  }
}

interface ImportMetaEnv {
  readonly VITE_ALLOWED_EMAILS: string;
  readonly VITE_DEV_BYPASS_AUTH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
