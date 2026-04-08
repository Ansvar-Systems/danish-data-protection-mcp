# Tools

This MCP server exposes **8 tools** under the `dk_dp_` prefix.

## Tool Reference

### Search and Retrieval

| Tool | Description | Required Args |
|------|-------------|---------------|
| `dk_dp_search_decisions` | Full-text search across Datatilsynet decisions (afgørelser, sanctions, indskærpelser). Returns reference, entity name, fine amount, GDPR articles. | `query` |
| `dk_dp_get_decision` | Get a specific decision by reference number (e.g., `2020-431-0059`). | `reference` |
| `dk_dp_search_guidelines` | Search Datatilsynet guidance documents: vejledninger, retningslinjer, FAQs. | `query` |
| `dk_dp_get_guideline` | Get a specific guidance document by database ID. | `id` |

### Discovery

| Tool | Description | Required Args |
|------|-------------|---------------|
| `dk_dp_list_topics` | List all covered data protection topics with Danish and English names. Use IDs to filter search results. | — |
| `dk_dp_about` | Return server metadata: version, data source, coverage summary, and tool list. | — |

### Meta / Governance

| Tool | Description | Required Args |
|------|-------------|---------------|
| `dk_dp_list_sources` | List authoritative sources and provenance: URLs, licensing, coverage scope, and freshness metadata. | — |
| `dk_dp_check_data_freshness` | Check data freshness for each source. Reports last-updated timestamp, age in days, staleness status, and update command. | — |

## Optional Arguments

All search tools accept optional filter arguments:

| Argument | Type | Tools | Description |
|----------|------|-------|-------------|
| `type` | string enum | `dk_dp_search_decisions`, `dk_dp_search_guidelines` | Filter by record type |
| `topic` | string | `dk_dp_search_decisions`, `dk_dp_search_guidelines` | Filter by topic ID |
| `limit` | number (1–100) | `dk_dp_search_decisions`, `dk_dp_search_guidelines` | Max results (default 20) |

## Response Format

All tool responses include a `_meta` block with provenance information:

```json
{
  "_meta": {
    "disclaimer": "...",
    "source_url": "https://www.datatilsynet.dk/",
    "copyright": "© Datatilsynet (Danish Data Protection Authority)...",
    "data_age": "2026-01-15T12:00:00.000Z"
  }
}
```
