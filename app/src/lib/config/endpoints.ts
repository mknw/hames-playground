/**
 * Environment-aware endpoint configuration
 * Automatically switches between development and Docker Compose endpoints
 */

export interface Endpoints {
  mcpGateway: string;
  n8n: string;
  neo4j: {
    http: string;
    bolt: string;
  };
}

/**
 * Get endpoints based on current environment
 * - Development: localhost URLs
 * - Docker: service names from docker-compose.yaml
 */
export function getEndpoints(): Endpoints {
  const isDev = import.meta.env.DEV;

  return {
    mcpGateway: isDev
      ? 'http://localhost:3000/mcp'
      : 'http://mcp-gateway:3000/mcp',

    n8n: isDev
      ? 'http://localhost:5678'
      : 'http://n8n:5678',

    neo4j: {
      http: isDev
        ? 'http://localhost:7474'
        : 'http://neo4j:7474',
      bolt: isDev
        ? 'bolt://localhost:7687'
        : 'bolt://neo4j:7687'
    }
  };
}

/**
 * Get a specific endpoint URL
 */
export function getEndpoint(service: 'mcpGateway' | 'n8n' | 'neo4jHttp' | 'neo4jBolt'): string {
  const endpoints = getEndpoints();

  switch (service) {
    case 'mcpGateway':
      return endpoints.mcpGateway;
    case 'n8n':
      return endpoints.n8n;
    case 'neo4jHttp':
      return endpoints.neo4j.http;
    case 'neo4jBolt':
      return endpoints.neo4j.bolt;
  }
}
