export function assertProxyNode(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 5))
    throw new Error('Hermetic Eval requires Node >=24.5 for NODE_USE_ENV_PROXY')
}

export function proxyEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    GENERAL_EVAL_CHILD: '1',
    E2E_EGRESS_BACKSTOP: url,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
}

export async function assertEgressSelfTest(
  take: () => Promise<Array<{ target: string }>>,
): Promise<void> {
  await fetch('http://egress-selftest.invalid/', { signal: AbortSignal.timeout(3000) }).catch(
    () => undefined,
  )
  const attempts = await take()
  if (
    !attempts.some((a) =>
      ['http://egress-selftest.invalid/', 'egress-selftest.invalid:80'].includes(a.target),
    )
  )
    throw new Error('Hermetic egress self-test failed; refusing to run')
}
