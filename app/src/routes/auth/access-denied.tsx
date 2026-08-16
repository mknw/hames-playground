import { A } from "@solidjs/router";

export default function AccessDenied() {
  return (
    <div class="px-4 py-12 bg-gray-50 flex min-h-screen items-center justify-center lg:px-8 sm:px-6">
      <div class="p-8 rounded-lg bg-white max-w-md w-full shadow-md">
        <div class="text-center">
          {/* Error Icon */}
          <div class="mx-auto mb-4 rounded-full bg-red-100 flex h-16 w-16 items-center justify-center">
            <svg
              class="text-red-600 h-10 w-10"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>

          <h2 class="text-2xl text-gray-900 font-bold mb-4">Access Denied</h2>

          <div class="mb-6 p-4 text-left border border-gray-200 rounded-md bg-gray-50">
            <p class="text-sm text-gray-700 mb-3">
              Your account is not authorized to access this application.
            </p>
            <p class="text-sm text-gray-600 mb-3">
              Access to seederis.ai Knowledge System is restricted to authorized users only. If you believe you should have access, please contact the administrator.
            </p>
            <div class="mt-3 pt-3 border-t border-gray-300">
              <p class="text-xs text-gray-500 font-semibold mb-1">Need access?</p>
              <p class="text-xs text-gray-600">
                Contact your system administrator to request access to this application.
              </p>
            </div>
          </div>

          <A
            href="/auth/signin"
            class="text-white font-medium px-4 py-2 rounded-md bg-blue-600 w-full inline-block shadow-sm transition-colors focus:outline-none hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Return to Sign In
          </A>
        </div>
      </div>
    </div>
  );
}
