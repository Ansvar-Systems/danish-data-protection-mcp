#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "danish-data-protection-mcp";
const SOURCE_URL = "https://www.datatilsynet.dk/";
const DISCLAIMER =
  "This data is sourced from official Datatilsynet publications and is provided for research purposes only. Not legal or regulatory advice. Verify all references against primary sources before making compliance decisions.";
const COPYRIGHT =
  "© Datatilsynet (Danish Data Protection Authority). Data used under open government license.";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

function getDbMtime(): string {
  const dbPath = process.env["DT_DB_PATH"] ?? "data/datatilsynet.db";
  try {
    return statSync(dbPath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "dk_dp_search_decisions",
    description:
      "Full-text search across Datatilsynet decisions (afgørelser, sanctions, indskærpelser). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Danish (e.g., 'samtykke cookies', 'Danske Bank')" },
        type: {
          type: "string",
          enum: ["sanction", "afgorelse", "indskærpelse", "udtalelse"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_dp_get_decision",
    description:
      "Get a specific Datatilsynet decision by reference number (e.g., '2020-431-0059').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Datatilsynet decision reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "dk_dp_search_guidelines",
    description:
      "Search Datatilsynet guidance documents: vejledninger, retningslinjer, and FAQs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Danish" },
        type: {
          type: "string",
          enum: ["vejledning", "retningslinje", "FAQ", "udtalelse"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_dp_get_guideline",
    description: "Get a specific Datatilsynet guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "dk_dp_list_topics",
    description: "List all covered data protection topics with Danish and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_dp_list_sources",
    description:
      "List authoritative sources and provenance used by this MCP server. Returns data source URLs, licensing, coverage scope, and freshness metadata.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "dk_dp_check_data_freshness",
    description:
      "Check data freshness for each source. Reports last-updated timestamps, staleness status, and provides update instructions.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["sanction", "afgorelse", "indskærpelse", "udtalelse"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["vejledning", "retningslinje", "FAQ", "udtalelse"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? {
              ...(data as Record<string, unknown>),
              _meta: {
                disclaimer: DISCLAIMER,
                source_url: SOURCE_URL,
                copyright: COPYRIGHT,
                data_age: getDbMtime(),
              },
            }
          : data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "dk_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          return textContent({ results, count: results.length });
        }
        case "dk_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) return errorContent(`Decision not found: ${parsed.reference}`);
          return textContent(decision);
        }
        case "dk_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          return textContent({ results, count: results.length });
        }
        case "dk_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) return errorContent(`Guideline not found: id=${parsed.id}`);
          return textContent(guideline);
        }
        case "dk_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length });
        }
        case "dk_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description: "Datatilsynet (Danish Data Protection Authority) MCP server. Provides access to Danish data protection authority decisions, sanctions, afgørelser, and official guidance documents.",
            data_source: SOURCE_URL,
            coverage: {
              decisions: "Datatilsynet afgørelser, sanctions, and indskærpelser",
              guidelines: "Datatilsynet vejledninger, retningslinjer, and FAQs",
              topics: "Cookies, ansættelsesforhold, samtykke, kameraovervågning, sundhedsdata, dataoverførsler, konsekvensanalyse, registerindsigt, børn",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }
        case "dk_dp_list_sources": {
          return textContent({
            sources: [
              {
                id: "datatilsynet",
                name: "Datatilsynet (Danish Data Protection Authority)",
                url: SOURCE_URL,
                type: "regulatory_authority",
                jurisdiction: "DK",
                language: "da",
                license: "Open Government Data",
                coverage: "Decisions (afgørelser, sanctions, indskærpelser) and guidance (vejledninger, retningslinjer, FAQs)",
                last_updated: getDbMtime(),
              },
            ],
          });
        }
        case "dk_dp_check_data_freshness": {
          const dbPath = process.env["DT_DB_PATH"] ?? "data/datatilsynet.db";
          const lastUpdated = getDbMtime();
          const ageMs = Date.now() - new Date(lastUpdated).getTime();
          const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
          const status = ageDays > 7 ? "stale" : ageDays >= 0 ? "ok" : "unknown";
          return textContent({
            sources: [
              {
                id: "datatilsynet",
                name: "Datatilsynet",
                db_path: dbPath,
                last_updated: lastUpdated,
                age_days: ageDays,
                status,
                update_command: "npm run ingest",
              },
            ],
          });
        }
        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      // Reentrancy guard: mcpServer.close() can synchronously re-fire
      // transport.onclose through the SDK, which would re-enter this handler
      // and recurse until the stack overflows ("RangeError: Maximum call
      // stack size exceeded" observed in prod logs). Also chain to the SDK's
      // internal _onclose wrapper (set by mcpServer.connect) to preserve its
      // cleanup of _responseHandlers, _progressHandlers, and in-flight aborts.
      const sdkOnClose = transport.onclose;
      let closing = false;
      transport.onclose = () => {
        if (closing) return;
        closing = true;
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
        sdkOnClose?.();
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
