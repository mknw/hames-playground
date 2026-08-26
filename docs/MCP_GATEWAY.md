# MCP Gateway Documentation

The MCP Gateway is Docker's tool for managing and running MCP (Model Context Protocol) servers in containers. It provides a unified interface for AI clients to access multiple MCP tools through a single gateway.

## Project-Specific Setup

> **Important**: This project uses **Docker Compose** to run the MCP Gateway, NOT the `docker mcp gateway run` CLI command. This ensures a reproducible setup for VPS deployment.

### How It Works in This Project

```
┌─────────────────────────────────────────────────────────────┐
│  SolidStart UI / BAML Agent                                 │
│  (calls MCP Gateway at http://localhost:8811/mcp)           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  MCP Gateway (docker-compose service)                       │
│  Port: 8811 | Transport: streaming                          │
│  Config: docker-compose.yaml:37-59                          │
└─────────────────────────────────────────────────────────────┘
            │                                │
            │  MCP servers (containers)      │  Backend services
            ▼                                ▼
┌────────┐┌──────┐┌───────┐┌──────┐    ┌────────┐
│neo4j-  ││fetch ││web_   ││cont- │    │ neo4j  │ :7687
│cypher  ││      ││search ││ext7  │    │        │ :7474
└────────┘└──────┘└───────┘└──────┘    └────────┘
┌───────┐┌──────┐┌──────┐             ┌──────────┐
│rust-  ││mem-  ││data- │             │ postgres │ :5432
│mcp-fs ││ory   ││base  │             │          │
└───────┘└──────┘└──────┘             └──────────┘
                   ┌──────┐            ┌────────┐
                   │redis │            │ redis  │ :6379
                   └──────┘            └────────┘
```

### Registered Servers

| Server | Title | Tools | Auth | Backend |
|--------|-------|-------|------|---------|
| `neo4j-cypher` | Neo4j Cypher | `get_neo4j_schema`, `read_neo4j_cypher`, `write_neo4j_cypher` | Password (hardcoded) | neo4j container |
| `fetch` | Fetch | `fetch` | None | - |
| `web_search` | DuckDuckGo | `search`, `fetch_content` | None | - |
| `context7` | Context7 | `resolve-library-id`, `get-library-docs` | None | - |
| `rust-mcp-filesystem` | Rust Filesystem | `read_text_file`, `write_file`, `edit_file`, `search_files`, +10 more | None (volume mounts) | - |
| `memory` | Memory | `create_entities`, `create_relations`, `search_nodes`, `read_graph`, +5 more | None (volume) | - |
| `redis` | Redis | `get`, `set`, `delete`, `hget`, `hset`, `lpush`, `sadd`, `zadd`, +24 more | Password (hardcoded) | redis container |
| `database-server` | MCP Database Server | `query_database`, `list_tables`, `describe_table`, `connect_to_database`, +2 more | URL (hardcoded) | postgres container |

### Configuration Strategy

The gateway supports two mechanisms for providing credentials to MCP servers:

| Mechanism | Set via | Requires |
|-----------|---------|----------|
| `env:` templates (`{{server.key}}`) | `mcp-config.yaml` or `mcp-config-set` tool | Config values in mcp-config.yaml |
| `secrets:` entries | `--secrets` flag (Docker Desktop or .env file) | Secrets provider on gateway |

**This project's approach**: hardcode credentials for infrastructure we control (neo4j, redis, postgres) in `mcp-config.yaml`, matching the container defaults. A server needing a *user-provided* credential would use the env template hack instead, so that `mcp-config-set` can supply the value at runtime without a `--secrets` provider; the GitHub server was the only one that did, and it was removed in #226 E3 (no agent used it, and the `gh` CLI covers this repo's own GitHub work).

| Server | Credential | Strategy |
|--------|-----------|----------|
| neo4j-cypher | `password` | Hardcoded in mcp-config.yaml (matches `NEO4J_AUTH=neo4j/password`) |
| redis | `password` | Hardcoded in mcp-config.yaml (empty, alpine default) |
| database-server | `database_url` | Hardcoded in mcp-config.yaml (matches postgres container) |

### Configuration Files (Source of Truth)

| File | Purpose | Verify |
|------|---------|--------|
| `docker-compose.yaml:37-56` | Gateway service definition | Port 8811, servers list |
| `custom-catalog.yaml` | MCP server definitions with env mappings | All 9 servers |
| `mcp-config.yaml` | Server connection parameters and defaults | Neo4j, Redis, Postgres credentials |

### Current Docker Compose Configuration

From `docker-compose.yaml`:

```yaml
mcp-gateway:
  image: docker/mcp-gateway
  restart: unless-stopped
  command:
    - --enable-all-servers
    - --config=/mcp/config.yaml
    - --catalog=/mcp/custom-catalog.yaml
    - --transport=streaming
    - --port=8811
    - --verbose
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - ./configs/mcp-config.yaml:/mcp/config.yaml:ro
    - ./configs/custom-catalog.yaml:/mcp/custom-catalog.yaml:ro
    - ./configs/catalog.yaml:/mcp/catalog.yaml:ro
    - ./docker-config.json:/root/.docker/config.json:ro
  ports:
    - "8811:8811"
  networks:
    - app-network
  depends_on:
    neo4j:
      condition: service_healthy
```

### Starting the Gateway

```bash
# Start all services (including gateway)
docker compose up -d

# View gateway logs
docker compose logs -f mcp-gateway

# Restart gateway after config changes
docker compose restart mcp-gateway
```

### When the gateway is not there (#276)

Every gateway read in the app degrades rather than throwing, which is right on
its own and used to add up to something wrong: with the gateway refusing
connections, `listTools()` returned only the app-side tools, so each agent's
`tools.<namespace> ?? []` handed its loop an empty allowlist, the loop called
nothing, and the synthesizer answered the question anyway. A `done` row and a
confident answer no tool contributed to.

What happens now, all of it in `app/src/lib/harness-patterns/`:

1. **`mcp-client.server.ts` recovers what it owns.** A failed `listTools` is
   retried once per lease (`withReconnect`), and if that fails the WHOLE
   connection pool is rebuilt and the call is tried once more — a gateway
   restart drops all four pooled keep-alives at once, and the per-lease
   reconnect only heals the one it was holding.
2. **`gateway-health.server.ts` records the outcome.** Only `listTools` writes
   it: a failing tool CALL is ordinary (the controller sees the error and
   decides), while a catalog that cannot be fetched means no tool can be chosen
   at all. One successful read clears it.
3. **The loops refuse instead of guessing.** `simpleLoop` / `actorCritic` handed
   an empty tool list _while the gateway is known unreachable_ record an
   `irrecoverable` error naming the outage, which stops the chain
   (`errorSeverity`, see the harness SPEC) so the synthesizer never answers
   around the hole. An empty list with a healthy gateway is left alone — the
   sandbox agents pass one deliberately, since their tools arrive over
   `docker exec`.

**The app does not restart the gateway container, deliberately.** It could — the
docker socket is reachable in both shapes the app runs in — and it should not:
the gateway is shared by every user, so one degraded conversation would tear
down everyone else's in-flight tool calls; the socket is root-equivalent and is
mounted for the sandbox alone; the service is already `restart: unless-stopped`,
so Docker restarts a gateway that exits; and `MCP_GATEWAY_URL` may name a
gateway that is not this deployment's container at all. The case a hook would
add is a gateway that is up and wedged, which is an owner decision. Until then,
the command above is the operator's, and the app's job is to say the tools are
unavailable rather than to pretend otherwise.

---

## General MCP Gateway Reference

The sections below are general reference documentation for the Docker MCP Gateway. For local development with Claude Desktop or other CLI usage, you can use the `docker mcp` CLI plugin.

### CLI Plugin Installation (Optional)

```bash
git clone https://github.com/docker/mcp-gateway.git
cd mcp-gateway
mkdir -p "$HOME/.docker/cli-plugins/"
make docker-mcp
```

After installation:
```bash
docker mcp --help
```

### CLI Usage (Not Used in This Project)

These commands are for reference only. This project uses Docker Compose instead.

```bash
# Run with stdio transport (for single client like Claude Desktop)
docker mcp gateway run

# Run with HTTP streaming
docker mcp gateway run --port 8811 --transport streaming

# Run specific servers only
docker mcp gateway run --servers neo4j-cypher,fetch

# Enable ALL servers from catalogs
docker mcp gateway run --enable-all-servers

# Run with verbose logging
docker mcp gateway run --verbose --log-calls

# Dry run (test configuration without starting)
docker mcp gateway run --verbose --dry-run
```

## Command Line Flags

### Server Selection
| Flag | Description |
|------|-------------|
| `--servers` | Comma-separated list of server names to enable |
| `--enable-all-servers` | Enable all servers from loaded catalogs |
| `--working-set` | Use a named working set (requires feature flag) |
| `--tools` | Filter specific tools (format: `server:tool` or `server:*`) |

### Configuration
| Flag | Description |
|------|-------------|
| `--catalog` | Path to catalog file(s) |
| `--config` | Path to config file(s) |
| `--registry` | Path to registry file(s) |
| `--secrets` | Secret provider path(s), e.g., `docker-desktop:./.env` |

### Transport
| Flag | Description |
|------|-------------|
| `--transport` | `stdio`, `sse`, or `streaming` (default: stdio) |
| `--port` | TCP port for sse/streaming transport |

### Resources
| Flag | Description |
|------|-------------|
| `--cpus` | CPUs per MCP server (default: 1) |
| `--memory` | Memory per MCP server (default: 2Gb) |

### Debugging
| Flag | Description |
|------|-------------|
| `--verbose` | Enable verbose output |
| `--log-calls` | Log tool calls (default: true) |
| `--dry-run` | Test configuration without listening |
| `--watch` | Auto-reload on config changes (default: true) |

### Security
| Flag | Description |
|------|-------------|
| `--block-secrets` | Block secrets in tool communications (default: true) |
| `--block-network` | Block forbidden network resources |
| `--verify-signatures` | Verify server image signatures |

## Auto-Discovery and Dynamic Tools

### Enable All Servers
Use `--enable-all-servers` to enable every server in your loaded catalogs:
```bash
docker mcp gateway run --enable-all-servers --transport streaming --port 3000
```

### Dynamic Tools Feature
The `dynamic-tools` feature (enabled by default) exposes internal MCP tools that AI agents can use:

- **mcp-find**: Search for available MCP servers in the catalog
- **mcp-add**: Add servers to the registry and reload
- **mcp-remove**: Remove servers and reload

This allows AI agents to dynamically discover and enable new MCP servers during a session.

**Note**: Dynamic tools are automatically disabled when using explicit `--servers` flag.

### Self-Describing Images
Docker images can include their own catalog metadata via labels:
```bash
docker mcp gateway run --server docker://namespace/image:latest
```

The image must have:
```dockerfile
LABEL io.docker.server.metadata="{... server metadata JSON ...}"
```

## Catalog Management

### Default Catalog
The gateway uses Docker's online catalog by default:
- v2: `http://desktop.docker.com/mcp/catalog/v2/catalog.yaml`
- v3: `http://desktop.docker.com/mcp/catalog/v3/catalog.yaml` (with OAuth DCR)

### Custom Catalogs

#### Create a Catalog
```bash
docker mcp catalog create my-catalog
```

#### Bootstrap from Docker's Catalog
```bash
docker mcp catalog bootstrap ./starter-catalog.yaml
```

#### Add Servers to Catalog
```bash
docker mcp catalog add my-catalog server-name ./source.yaml
```

#### Import from MCP Registry
```bash
docker mcp catalog import my-catalog \
  --mcp-registry https://registry.modelcontextprotocol.io/v0/servers/{id}
```

### Catalog YAML Format

```yaml
name: my-catalog
displayName: My Custom Catalog
registry:
  server-name:
    description: Server description
    title: Display Name
    type: server
    image: mcp/server@sha256:...
    tools:
      - name: tool_name
    env:
      - name: ENV_VAR
        value: '{{server-name.config_key}}'
    secrets:
      - name: server-name.secret
        env: SECRET_ENV
    config:
      - name: server-name
        type: object
        properties:
          config_key:
            type: string
```

**Important**: Always use SHA256 digests (`@sha256:...`) not tags (`:latest`) for image references.

## Configuration Files

### mcp-config.yaml
Server-specific configuration:
```yaml
server-name:
  config_key: value
  another_key: another_value
```

### registry.yaml
List of enabled servers:
```yaml
servers:
  - neo4j-cypher
  - fetch
```

### tools.yaml
Tool filtering per server:
```yaml
neo4j-cypher:
  - read_neo4j_cypher
  - get_neo4j_schema
```

## Feature Flags

Manage experimental features:

```bash
# List features
docker mcp feature ls

# Enable a feature
docker mcp feature enable <feature-name>

# Disable a feature
docker mcp feature disable <feature-name>
```

### Available Features

| Feature | Default | Description |
|---------|---------|-------------|
| `dynamic-tools` | enabled | Internal MCP tools (mcp-find, mcp-add, mcp-remove) |
| `mcp-oauth-dcr` | enabled | Dynamic Client Registration for OAuth |
| `oauth-interceptor` | disabled | GitHub OAuth flow interception |
| `working-sets` | disabled | Working set management |
| `tool-name-prefix` | disabled | Prefix tool names with server name |

## Working Sets

Working sets organize collections of MCP servers for different contexts.

### Enable Feature
```bash
docker mcp feature enable working-sets
```

### Create Working Set
```bash
docker mcp workingset create --name dev-tools \
  --server docker://mcp/filesystem:latest
```

### Use Working Set
```bash
docker mcp gateway run --working-set dev-tools
```

### Share via OCI Registry
```bash
# Push
docker mcp workingset push my-set docker.io/org/my-set:v1.0

# Pull
docker mcp workingset pull docker.io/org/my-set:v1.0
```

## Connecting Clients

### Claude Desktop
```json
{
  "mcpServers": {
    "MCP_DOCKER": {
      "command": "docker",
      "args": ["mcp", "gateway", "run"]
    }
  }
}
```

### n8n (Docker Compose)
1. Use `--transport streaming --port 8811`
2. Configure MCP Client tool:
   - Endpoint: `http://mcp-gateway:8811/mcp`
   - Transport: HTTP Streamable
   - Authentication: None

### Python Client
```python
# Use streaming transport
endpoint = "http://localhost:8811/mcp"
```

## Troubleshooting

### Debug Startup
```bash
docker mcp gateway run --verbose --dry-run
```

### Check Specific Server
```bash
docker mcp gateway run --verbose --dry-run --servers=server-name
```

### List Available Tools
```bash
docker mcp tools ls
docker mcp tools ls --verbose
```

### Call a Tool Directly
```bash
docker mcp tools call tool-name param=value
```

### View Gateway Logs (Docker Compose)
```bash
docker logs <gateway-container-name>
```

### Common Issues

#### Server Not Found
- Check server name spelling
- Verify catalog contains the server
- Use `docker mcp catalog show` to list available servers

#### Image Pull Errors
- Use SHA256 digests, not `:latest` tags in custom catalogs
- Verify image exists: `docker pull mcp/server-name`

#### Network Issues
- Ensure Docker socket is mounted: `/var/run/docker.sock:/var/run/docker.sock`
- Use Docker service names for inter-container communication

#### Environment Variable Mapping
- Check catalog `env` section maps correctly to server expectations
- Some servers expect different env var names than the catalog default

## Server Management Commands

```bash
# List enabled servers
docker mcp server ls

# Enable servers
docker mcp server enable server1 server2

# Disable servers
docker mcp server disable server-name

# Inspect server details
docker mcp server inspect server-name

# Reset (disable all)
docker mcp server reset
```

## Configuration Management

```bash
# Read current config
docker mcp config read

# Write config
docker mcp config write '<yaml>'

# Reset config
docker mcp config reset
```

## Security

### Secrets Management
- Use Docker Desktop's secrets API (default)
- Or provide `.env` file: `--secrets=docker-desktop:./.env`

### OAuth
```bash
docker mcp oauth --help
docker mcp oauth ls
docker mcp oauth revoke <server>
```

### Policies
```bash
docker mcp policy --help
```

## Resources

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Docker MCP Catalog](https://hub.docker.com/mcp)
- [MCP Gateway GitHub](https://github.com/docker/mcp-gateway)
- [Docker Desktop Documentation](https://docs.docker.com/desktop/)
