// Neo4j Database Export
// Generated: 2025-12-02 16:55:31
//
// To import: Run this file with cypher-shell or Neo4j Browser
//
// Usage:
//   docker exec neo4j-mldsgraph cypher-shell -u neo4j -p password < neo4j_dumps/export-YYYYMMDD_HHMMSS.cypher

// Clear existing data (CAUTION: This deletes everything!)
// MATCH (n) DETACH DELETE n;

// ============================================
// Schema: Indexes and Constraints
// ============================================



// ============================================
// Nodes
// ============================================

:begin
CREATE CONSTRAINT UNIQUE_IMPORT_NAME FOR (node:`UNIQUE IMPORT LABEL`) REQUIRE (node.`UNIQUE IMPORT ID`) IS UNIQUE;
:commit
CALL db.awaitIndexes(300);
:begin
UNWIND [{_id:0, properties:{observations:["SolidJS is a reactive UI framework used for the frontend", "SolidJS uses fine-grained reactivity without virtual DOM", "The UI runs at localhost:3001 during development"], name:"SolidJS", type:"framework", version:"1.9.10"}}, {_id:1, properties:{observations:["SolidStart is the meta-framework providing SSR and server functions", "SolidStart server functions use the use server directive", "SolidStart replaced API routes with server functions in this project"], name:"SolidStart", type:"meta-framework"}}, {_id:2, properties:{observations:["BAML provides structured LLM prompting with type-safe outputs", "BAML generates TypeScript clients from .baml function definitions", "BAML must use dynamic imports to avoid bundling native modules for client", "BAML functions include ProcessUserMessage, InterpretGraphResults, ValidateWriteOperation"], name:"BAML", type:"framework", version:"0.213.0"}}, {_id:3, properties:{observations:["Neo4j is the graph database storing knowledge graph data", "Neo4j uses Cypher as its query language", "Neo4j includes APOC and n10s plugins for extended functionality", "Neo4j browser is accessible at localhost:7474"], name:"Neo4j", type:"database", version:"5.26"}}, {_id:4, properties:{observations:["UTCP stands for Universal Tool Calling Protocol", "UTCP enables agent-to-tool communication through MCP gateway", "UTCP supports file, text, HTTP, and code-mode adapters", "UTCP wraps MCP tools for use in agentic workflows"], name:"UTCP", type:"protocol"}}, {_id:5, properties:{observations:["Cytoscape.js renders interactive graph visualizations", "Cytoscape supports multiple layouts including force-directed and hierarchical", "Cytoscape requires valid container dimensions before initialization"], name:"Cytoscape.js", type:"library", version:"3.33.1"}}, {_id:6, properties:{observations:["Docker runs all backend services in containers", "Docker Compose orchestrates multi-container deployment", "Services communicate via the app-network bridge network"], name:"Docker", type:"platform"}}, {_id:7, properties:{observations:["n8n provides workflow automation capabilities", "n8n can trigger MCP tools via AI Agent nodes", "n8n is accessible at localhost:5678"], name:"n8n", type:"platform"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:Technology;
UNWIND [{_id:8, properties:{image:"neo4j:5.26", port:7474, observations:["Neo4j service runs the graph database", "Neo4j exposes bolt protocol on port 7687", "Neo4j data is persisted in ./neo4j_data volume"], name:"neo4j"}}, {_id:9, properties:{image:"docker/mcp-gateway", port:3000, observations:["MCP Gateway proxies tool calls to MCP servers", "MCP Gateway uses custom-catalog.yaml for tool definitions", "MCP Gateway connects to Neo4j via bolt protocol"], name:"mcp-gateway"}}, {_id:10, properties:{image:"docker.n8n.io/n8nio/n8n", port:5678, observations:["n8n service provides workflow automation UI", "n8n can connect to MCP Gateway for AI agent tools", "n8n data is persisted in ./n8n_data volume"], name:"n8n"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:Service;
UNWIND [{_id:16, properties:{provider:"groq", observations:["Groq is the primary LLM provider for fast inference", "Groq uses the openai-generic provider pattern", "Groq has exponential retry policy configured"], name:"CustomGroq", model:"llama-3.3-70b-versatile"}}, {_id:17, properties:{provider:"openai", observations:["GPT-5-mini is used as fallback when Groq fails", "GPT-5-mini uses OpenAI responses API"], name:"CustomGPT5Mini", model:"gpt-5-mini"}}, {_id:18, properties:{provider:"fallback", observations:["GroqWithFallback tries Groq first, then falls back to GPT-5-mini", "This is the recommended client for production reliability"], name:"GroqWithFallback"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:LLMClient;
UNWIND [{_id:23, properties:{observations:["User sends message through ChatInterface", "AgentOrchestrator calls processAgentMessage server function", "BAML processes message and determines action", "Tool handlers execute via UTCP if needed", "Results transform to Cytoscape elements for visualization"], name:"AgentMessageFlow"}}, {_id:24, properties:{observations:["Agent proposes write query with explanation", "UI displays approve/reject buttons to user", "On approval, executeApprovedWrite is called", "On rejection, rejectWrite records the decision"], name:"WriteApprovalFlow"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:Workflow;
UNWIND [{_id:19, properties:{server:"neo4j-cypher", observations:["read_neo4j_cypher executes read-only Cypher queries", "Returns JSON results from Neo4j"], name:"read_neo4j_cypher"}}, {_id:20, properties:{server:"neo4j-cypher", observations:["write_neo4j_cypher executes write Cypher queries", "Requires user approval in the agent workflow"], name:"write_neo4j_cypher"}}, {_id:21, properties:{server:"neo4j-cypher", observations:["get_neo4j_schema retrieves the graph database schema", "Used to inform the agent about available node types and relationships"], name:"get_neo4j_schema"}}, {_id:22, properties:{server:"fetch", observations:["fetch tool retrieves content from URLs", "Used for web research and document fetching"], name:"fetch"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:Tool;
UNWIND [{_id:11, properties:{observations:["REMOVED (#151) — this module no longer exists in the repo; it has no path", "utcp-baml-agent contains the main agent logic", "utcp-baml-agent implements the 12-Factor Agents pattern", "utcp-baml-agent uses BAML for LLM reasoning and UTCP for tool execution", "utcp-baml-agent includes orchestrator, agent loop, state, and tools"], name:"utcp-baml-agent"}}, {_id:12, properties:{path:"app/src/lib/neo4j", observations:["neo4j module provides direct database access using neo4j-driver", "neo4j module handles schema fetching and manual Cypher execution", "neo4j module is used for non-agentic operations"], name:"neo4j"}}, {_id:13, properties:{observations:["REMOVED (#151) — this module no longer exists in the repo; it has no path", "utcp module configures the UTCP client for MCP gateway", "utcp module wraps KGTools, WebTools, and N8nTools", "utcp module is used for agentic tool operations"], name:"utcp"}}, {_id:14, properties:{path:"app/src/lib/graph", observations:["graph module transforms Neo4j results to Cytoscape elements", "graph module handles node and edge conversion"], name:"graph"}}, {_id:15, properties:{path:"app/src/lib/auth", observations:["auth module handles user authentication", "auth module uses cookie-based sessions", "auth module includes email allow-list functionality"], name:"auth"}}] AS row
CREATE (n:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row._id}) SET n += row.properties SET n:Module;
:commit
:begin
UNWIND [{start: {_id:11}, end: {_id:2}, properties:{}}, {start: {_id:11}, end: {_id:4}, properties:{}}, {start: {_id:12}, end: {_id:3}, properties:{}}, {start: {_id:14}, end: {_id:5}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:USES]->(end) SET r += row.properties;
UNWIND [{start: {_id:9}, end: {_id:8}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:CONNECTS_TO]->(end) SET r += row.properties;
UNWIND [{start: {_id:16}, end: {_id:17}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:FALLS_BACK_TO]->(end) SET r += row.properties;
UNWIND [{start: {_id:8}, end: {_id:6}, properties:{}}, {start: {_id:9}, end: {_id:6}, properties:{}}, {start: {_id:10}, end: {_id:6}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:RUNS_ON]->(end) SET r += row.properties;
UNWIND [{start: {_id:11}, end: {_id:23}, properties:{}}, {start: {_id:11}, end: {_id:24}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:IMPLEMENTS]->(end) SET r += row.properties;
UNWIND [{start: {_id:1}, end: {_id:0}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:USES]->(end) SET r += row.properties;
UNWIND [{start: {_id:9}, end: {_id:19}, properties:{}}, {start: {_id:9}, end: {_id:20}, properties:{}}, {start: {_id:9}, end: {_id:21}, properties:{}}, {start: {_id:9}, end: {_id:22}, properties:{}}] AS row
MATCH (start:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.start._id})
MATCH (end:`UNIQUE IMPORT LABEL`{`UNIQUE IMPORT ID`: row.end._id})
CREATE (start)-[r:EXPOSES]->(end) SET r += row.properties;
:commit
:begin
MATCH (n:`UNIQUE IMPORT LABEL`)  WITH n LIMIT 20000 REMOVE n:`UNIQUE IMPORT LABEL` REMOVE n.`UNIQUE IMPORT ID`;
:commit
:begin
DROP CONSTRAINT UNIQUE_IMPORT_NAME;
:commit
