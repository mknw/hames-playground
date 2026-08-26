/**
 * Environment-aware endpoint configuration
 * Automatically switches between development and Docker Compose endpoints
 */

export interface Endpoints {
  mcpGateway: string
  n8n: string
  neo4j: {
    http: string
    bolt: string
  }
}

/**
 * Is this a dev build?
 *
 * `import.meta.env` is Vite's injection, and it is absent outside a Vite
 * pipeline. These endpoints are also read from **plain-node entry points** —
 * the CLI scripts under `src/lib/org-graph/scripts/` import the Neo4j driver
 * directly under `tsx` — where reading `.DEV` off `undefined` throws before any
 * of this module's callers get an endpoint at all. Guarded rather than assumed.
 *
 * Outside Vite we are on a developer's host running a script by hand, so
 * localhost is the right default: the docker-compose service names only resolve
 * from inside the compose network, which is exactly where Vite *is* present.
 */
export function resolveIsDev(env: { DEV?: boolean } | undefined): boolean {
  return env ? env.DEV === true : true
}

function isDevEnvironment(): boolean {
  // Each module gets its own `import.meta`, so the absent case cannot be
  // simulated from a test file — which is why the decision lives in the
  // exported pure helper above and this line is only the read.
  return resolveIsDev(import.meta.env as { DEV?: boolean } | undefined)
}

/**
 * Get endpoints based on current environment
 * - Development: localhost URLs
 * - Docker: service names from docker-compose.yaml
 */
export function getEndpoints(): Endpoints {
  const isDev = isDevEnvironment()

  return {
    mcpGateway: isDev ? 'http://localhost:3000/mcp' : 'http://mcp-gateway:3000/mcp',

    n8n: isDev ? 'http://localhost:5678' : 'http://n8n:5678',

    neo4j: {
      http: isDev ? 'http://localhost:7474' : 'http://neo4j:7474',
      bolt: isDev ? 'bolt://localhost:7687' : 'bolt://neo4j:7687',
    },
  }
}

/**
 * Get a specific endpoint URL
 */
export function getEndpoint(service: 'mcpGateway' | 'n8n' | 'neo4jHttp' | 'neo4jBolt'): string {
  const endpoints = getEndpoints()

  switch (service) {
    case 'mcpGateway':
      return endpoints.mcpGateway
    case 'n8n':
      return endpoints.n8n
    case 'neo4jHttp':
      return endpoints.neo4j.http
    case 'neo4jBolt':
      return endpoints.neo4j.bolt
  }
}
