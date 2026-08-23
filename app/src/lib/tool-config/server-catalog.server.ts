/**
 * Server Catalog — real gateway server names for code-mode factory scoping.
 *
 * The code-mode factory is scoped by SERVER name: `code-mode {servers:[...]}`.
 * Those names are the keys in `configs/custom-catalog.yaml` (`neo4j-cypher`,
 * `web_search`, `rust-mcp-filesystem`, …) — which the client-side
 * `inferServer()` cannot produce (it yields namespaces like `neo4j`/`web`/
 * `filesystem`). This module is the single source of truth that maps the live
 * gateway tools onto their real server names, feeding BOTH the actor's
 * up-front catalog prompt and the Tools-panel UI.
 *
 * Sources:
 *   - configs/custom-catalog.yaml  → server keys, titles, declared tools, secrets
 *   - configs/mcp-config.yaml      → which servers are enabled
 *   - listTools() (live gateway)   → ground-truth tool universe + liveness
 *
 * Tool → real-server assignment: a tool declared under a server in the catalog
 * wins; otherwise we bridge `inferServer()`'s namespace to the real server name
 * (handles e.g. web_search, which declares no tools in the catalog).
 */
"use server";

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listTools } from "../harness-patterns/mcp-client.server";
import { inferServer } from "../harness-patterns/tools.server";
import {
  CODE_MODE_PRESET_SERVERS,
  type CatalogServer,
} from "./constants";

// ============================================================================
// Config file location
// ============================================================================

/** `process.cwd()` is the `app/` dir (mirrors baml-adapters.server.ts:235), so
 *  the repo-root `configs/` is one level up. Fall back to a few candidates so
 *  a differently-rooted process (CI, prod) still resolves. */
function resolveConfigPath(file: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "..", "configs", file),
    path.resolve(process.cwd(), "configs", file),
    path.resolve(process.cwd(), "..", "..", "configs", file),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ============================================================================
// Catalog parsing (cached — config is static within a process lifetime)
// ============================================================================

interface ParsedServer {
  title: string;
  declaredTools: string[];
  secrets: string[];
}

let customCatalogCache: Map<string, ParsedServer> | null = null;
let enabledCache: Set<string> | null = null;

/** Parse `custom-catalog.yaml` → server key → {title, declaredTools, secrets}.
 *  The top-level shape is `{ name, registry: { <serverKey>: {...} } }`. */
function parseCustomCatalog(): Map<string, ParsedServer> {
  if (customCatalogCache) return customCatalogCache;
  const out = new Map<string, ParsedServer>();
  const file = resolveConfigPath("custom-catalog.yaml");
  if (!file) {
    customCatalogCache = out;
    return out;
  }
  try {
    const doc = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
    const registry = (doc?.registry ?? doc) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(registry)) {
      if (!raw || typeof raw !== "object") continue;
      const spec = raw as Record<string, unknown>;
      // A server spec always has at least one of these; `name`/`registry`
      // top-level scalars are skipped by the object check above.
      const tools = Array.isArray(spec.tools)
        ? (spec.tools as Array<Record<string, unknown>>)
            .map((t) => String(t?.name ?? ""))
            .filter(Boolean)
        : [];
      const secrets = Array.isArray(spec.secrets)
        ? (spec.secrets as Array<Record<string, unknown>>)
            .map((s) => String(s?.name ?? ""))
            .filter(Boolean)
        : [];
      out.set(key, {
        title: typeof spec.title === "string" ? spec.title : key,
        declaredTools: tools,
        secrets,
      });
    }
  } catch (err) {
    // Unparseable catalog — degrade to empty (callers tolerate it). The result
    // is cached for the process lifetime, so this one failure means an empty
    // Tools panel until the next restart: say so once, loudly (sf-M4).
    console.error(
      "[tool-config] custom-catalog.yaml could not be parsed — the server catalog is EMPTY " +
        "for the rest of this process:",
      err,
    );
  }
  customCatalogCache = out;
  return out;
}

/** Parse `mcp-config.yaml` → set of server keys with `enabled: true`. */
function parseEnabledServers(): Set<string> {
  if (enabledCache) return enabledCache;
  const out = new Set<string>();
  const file = resolveConfigPath("mcp-config.yaml");
  if (!file) {
    enabledCache = out;
    return out;
  }
  try {
    const doc = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(doc ?? {})) {
      if (raw && typeof raw === "object" && (raw as Record<string, unknown>).enabled === true) {
        out.add(key);
      }
    }
  } catch (err) {
    // Unparseable — degrade to empty, i.e. "no server is enabled", cached for
    // the process lifetime (sf-M4).
    console.error(
      "[tool-config] mcp-config.yaml could not be parsed — NO servers will be reported as " +
        "enabled for the rest of this process:",
      err,
    );
  }
  enabledCache = out;
  return out;
}

/** Bridge `inferServer()`'s client namespace → real catalog server name, for
 *  the servers whose names differ. Used only when a live tool isn't claimed by
 *  any server's declared-tool list. Servers whose namespace already equals
 *  their key (memory, github, redis, context7) need no entry. */
const NAMESPACE_TO_SERVER: Record<string, string> = {
  neo4j: "neo4j-cypher",
  web: "web_search",
  filesystem: "rust-mcp-filesystem",
  database: "database-server",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * The enabled gateway servers with real names + their live tools. Cross-checks
 * the static catalog against `listTools()` so a config-enabled-but-down server
 * doesn't get advertised with phantom tools. Best-effort: if the gateway is
 * unreachable, falls back to each server's declared tools.
 */
export async function getServerCatalog(): Promise<CatalogServer[]> {
  const catalog = parseCustomCatalog();
  const enabled = parseEnabledServers();

  let liveNames: string[] = [];
  try {
    liveNames = (await listTools()).map((t) => t.name);
  } catch {
    liveNames = [];
  }

  // tool → real server, declared-tools index first.
  const declaredIndex = new Map<string, string>();
  for (const [key, spec] of catalog) {
    for (const t of spec.declaredTools) declaredIndex.set(t, key);
  }
  const assign = (tool: string): string =>
    declaredIndex.get(tool) ??
    NAMESPACE_TO_SERVER[inferServer(tool)] ??
    inferServer(tool);

  // Group live tools by their assigned real server.
  const liveByServer = new Map<string, string[]>();
  for (const tool of liveNames) {
    // Skip the gateway meta-tools — they're not catalog servers; the UI shows
    // them as locked "Required" and the actor always has them.
    if (tool === "code-mode" || tool === "mcp-find" || tool === "mcp-add" || tool === "mcp-exec") {
      continue;
    }
    const server = assign(tool);
    const arr = liveByServer.get(server) ?? [];
    arr.push(tool);
    liveByServer.set(server, arr);
  }

  const result: CatalogServer[] = [];
  for (const [key, spec] of catalog) {
    const isEnabled = enabled.has(key);
    if (!isEnabled) continue;
    const live = liveByServer.get(key);
    const toolNames = live && live.length > 0 ? live : spec.declaredTools;
    result.push({
      key,
      title: spec.title,
      tools: toolNames.sort().map((name) => ({ name })),
      enabled: true,
      secretGated: spec.secrets.length > 0,
      secrets: spec.secrets,
    });
  }
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

/** Real server name that owns a tool, or undefined if unknown. */
export async function serverForTool(toolName: string): Promise<string | undefined> {
  const catalog = await getServerCatalog();
  for (const s of catalog) {
    if (s.tools.some((t) => t.name === toolName)) return s.key;
  }
  return undefined;
}

/**
 * The default "code mode" scope: every tool exposed by the preset servers
 * (CODE_MODE_PRESET_SERVERS) that is currently enabled. Meta-tools are NOT
 * included — callers union them in separately. Used as the fallback selection
 * for a fresh conversation so the actor can reach Neo4j/web on turn 0.
 */
export async function getPresetTools(): Promise<string[]> {
  const catalog = await getServerCatalog();
  const preset = new Set(CODE_MODE_PRESET_SERVERS);
  const tools: string[] = [];
  for (const s of catalog) {
    if (preset.has(s.key)) tools.push(...s.tools.map((t) => t.name));
  }
  return Array.from(new Set(tools));
}

// ============================================================================
// Master-catalog search preview (read-only; enabling is a follow-up, #87)
// ============================================================================

let masterServerNamesCache: string[] | null = null;

/** Server keys defined in the full Docker MCP catalog (configs/catalog.yaml,
 *  ~1.3k servers). Parsed once, lazily, and cached. */
function masterServerNames(): string[] {
  if (masterServerNamesCache) return masterServerNamesCache;
  let names: string[] = [];
  const file = resolveConfigPath("catalog.yaml");
  if (file) {
    try {
      const doc = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
      const registry = (doc?.registry ?? doc) as Record<string, unknown>;
      names = Object.keys(registry ?? {});
    } catch (err) {
      // The master catalog is only used for the "N more in catalog" preview, so
      // an empty list degrades a hint rather than a capability — but silently
      // losing 1.3k entries looked identical to "no matches" (sf-M4).
      console.error("[tool-config] catalog.yaml could not be parsed:", err);
      names = [];
    }
  }
  masterServerNamesCache = names;
  return names;
}

/**
 * Read-only preview: which master-catalog servers match a query but aren't yet
 * enabled. The Tools-panel search shows this as "N more in catalog"; actually
 * enabling them (mcp-add + secrets) is the hot-swap follow-up (#87).
 */
export async function searchMasterCatalog(
  query: string,
): Promise<{ matches: string[]; total: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [], total: 0 };
  const enabled = parseEnabledServers();
  const hits = masterServerNames().filter(
    (name) => name.toLowerCase().includes(q) && !enabled.has(name),
  );
  return { matches: hits.slice(0, 20), total: hits.length };
}
