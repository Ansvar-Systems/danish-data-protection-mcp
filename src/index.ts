#!/usr/bin/env node

/**
 * Danish Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying Datatilsynet decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: dk_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "danish-data-protection-mcp";
const SOURCE_URL = "https://www.datatilsynet.dk/";
const DISCLAIMER =
  "This data is sourced from official Datatilsynet publications and is provided for research purposes only. Not legal or regulatory advice. Verify all references against primary sources before making compliance decisions.";
const COPYRIGHT =
  "© Datatilsynet (Danish Data Protection Authority). Data used under open government license.";

function getDbMtime(): string {
  const dbPath = process.env["DT_DB_PATH"] ?? "data/datatilsynet.db";
  try {
    return statSync(dbPath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "dk_dp_search_decisions",
    description:
      "Full-text search across Datatilsynet decisions (afgørelser, sanctions, indskærpelser). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Danish (e.g., 'samtykke cookies', 'kameraovervågning', 'Danske Bank')",
        },
        type: {
          type: "string",
          enum: ["sanction", "afgorelse", "indskærpelse", "udtalelse"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'samtykke', 'cookies', 'dataoverfoersler'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_dp_get_decision",
    description:
      "Get a specific Datatilsynet decision by reference number (e.g., '2020-431-0059', '2021-443-0001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Datatilsynet decision reference (e.g., '2020-431-0059', '2021-443-0001')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "dk_dp_search_guidelines",
    description:
      "Search Datatilsynet guidance documents: vejledninger, retningslinjer, and FAQs. Covers GDPR implementation, DPIA methodology, cookie consent, kameraovervågning, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Danish (e.g., 'cookies', 'konsekvensanalyse', 'ansættelsesforhold')",
        },
        type: {
          type: "string",
          enum: ["vejledning", "retningslinje", "FAQ", "udtalelse"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'konsekvensanalyse', 'cookies', 'dataoverfoersler'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_dp_get_guideline",
    description:
      "Get a specific Datatilsynet guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from dk_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "dk_dp_list_topics",
    description:
      "List all covered data protection topics with Danish and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_dp_list_sources",
    description:
      "List authoritative sources and provenance used by this MCP server. Returns data source URLs, licensing, coverage scope, and freshness metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_dp_check_data_freshness",
    description:
      "Check data freshness for each source. Reports last-updated timestamps, staleness status, and provides update instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  const payload =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? {
          ...(data as unknown as Record<string, unknown>),
          _meta: {
            disclaimer: DISCLAIMER,
            source_url: SOURCE_URL,
            copyright: COPYRIGHT,
            data_age: getDbMtime(),
          },
        }
      : data;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "dk_dp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "dk_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`);
        }
        const dec = decision as unknown as Record<string, unknown>;
        return textContent({
          ...dec,
          _citation: buildCitation(
            String(dec.reference ?? parsed.reference),
            String(dec.title ?? dec.reference ?? parsed.reference),
            "dk_dp_get_decision",
            { reference: parsed.reference },
            dec.url != null ? String(dec.url) : undefined,
          ),
        });
      }

      case "dk_dp_search_guidelines": {
        const parsed = SearchGuidelinesArgs.parse(args);
        const results = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "dk_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`);
        }
        const gl = guideline as unknown as Record<string, unknown>;
        return textContent({
          ...gl,
          _citation: buildCitation(
            String(gl.title ?? `Guideline ${parsed.id}`),
            String(gl.title ?? `Guideline ${parsed.id}`),
            "dk_dp_get_guideline",
            { id: String(parsed.id) },
            gl.url != null ? String(gl.url) : undefined,
          ),
        });
      }

      case "dk_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
      }

      case "dk_dp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "Datatilsynet (Danish Data Protection Authority) MCP server. Provides access to Danish data protection authority decisions, sanctions, afgørelser, and official guidance documents.",
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
