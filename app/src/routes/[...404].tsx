import { A } from '@solidjs/router'

export default function NotFound() {
  return (
    <main class="text-gray-700 mx-auto p-4 text-center">
      <h1 class="max-6-xs text-6xl text-sky-700 font-thin my-16 uppercase">Not Found</h1>
      <p class="mt-8">
        Visit{' '}
        <a
          href="https://solidjs.com"
          target="_blank"
          rel="noopener noreferrer"
          class="text-sky-600 hover:underline"
        >
          solidjs.com
        </a>{' '}
        to learn how to build Solid apps.
      </p>
      <p class="my-4">
        <A href="/" class="text-sky-600 hover:underline">
          Chat
        </A>
        {' - '}
        <A href="/dashboard" class="text-sky-600 hover:underline">
          Metrics
        </A>
      </p>
    </main>
  )
}
