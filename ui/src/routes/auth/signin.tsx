import { Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";

/**
 * Sign-in page. Direct Entra OIDC (#119): a single "Sign in with Microsoft"
 * action that hands off to the server route `/api/auth/login`, which starts
 * the auth-code flow. No client-side auth SDK — the exchange is server-side.
 *
 * `?error=…` is set by the callback route on a failed sign-in so we can show a
 * hint here without leaking details.
 */
export default function SignIn() {
  const [params] = useSearchParams();

  return (
    <div class="px-4 py-12 bg-gray-50 flex min-h-screen items-center justify-center lg:px-8 sm:px-6">
      <div class="p-8 rounded-lg bg-white max-w-md w-full shadow-md">
        <div class="mb-8 text-center">
          <h2 class="text-3xl text-gray-900 font-bold">DTalk.ai Knowledge System</h2>
          <p class="text-sm text-gray-600 mt-2">
            Sign in with your Microsoft work account to continue
          </p>
        </div>

        <Show when={params.error}>
          <div class="mb-4 p-3 border border-red-200 rounded-md bg-red-50">
            <p class="text-sm text-red-600">
              Sign-in didn't complete. Please try again.
            </p>
          </div>
        </Show>

        {/*
          `rel="external"` is REQUIRED: without it @solidjs/router intercepts
          the click and treats /api/auth/login as a client page route (→ 404),
          so the server handler never runs. rel="external" forces a real
          browser navigation that hits the API route and 302s to Entra.
        */}
        <a
          href="/api/auth/login"
          rel="external"
          class="text-white font-medium px-4 py-3 rounded-md bg-blue-600 flex gap-2 w-full shadow-sm items-center justify-center focus:outline-none hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <span class="i-mdi-microsoft" style={{ width: "20px", height: "20px" }} />
          Sign in with Microsoft
        </a>

        <p class="text-xs text-gray-500 mt-6 text-center">
          Access is restricted to authorized accounts. If you need access,
          please contact the administrator.
        </p>
      </div>
    </div>
  );
}
