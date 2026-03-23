/**
 * Datatilsynet Ingestion Crawler
 *
 * Scrapes the Danish Data Protection Authority website (datatilsynet.dk)
 * and populates the SQLite database with decisions, guidance documents,
 * and topics.
 *
 * Data sources:
 *   1. Decisions (afgørelser)  — /afgoerelser/afgoerelser/YYYY/MMM/slug
 *      Discovered via year/month index pages. The listing pages use
 *      GoBasic CMS client-side rendering, so the crawler extracts the
 *      base64-encoded context payload, constructs a server-side list
 *      endpoint call, and falls back to <a>-tag extraction if the
 *      endpoint is unavailable.
 *   2. Fine cases (bødesager)  — /afgoerelser/boedesager (static HTML)
 *   3. Guidance (vejledninger)  — /regler-og-vejledning/... topic pages
 *   4. Topics                  — seeded from a controlled vocabulary
 *
 * The CMS serves decision listing pages via JS (GoBasic.Presentation
 * ListHelper), but individual decision and guidance pages are static
 * HTML — cheerio parses those directly.
 *
 * Usage:
 *   npx tsx scripts/ingest-datatilsynet.ts               # full crawl
 *   npx tsx scripts/ingest-datatilsynet.ts --resume       # resume from last checkpoint
 *   npx tsx scripts/ingest-datatilsynet.ts --dry-run      # log what would be inserted
 *   npx tsx scripts/ingest-datatilsynet.ts --force        # drop and recreate DB first
 *   npx tsx scripts/ingest-datatilsynet.ts --decisions-only
 *   npx tsx scripts/ingest-datatilsynet.ts --guidance-only
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["DT_DB_PATH"] ?? "data/datatilsynet.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.datatilsynet.dk";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "AnsvarDatatilsynetCrawler/1.0 (+https://ansvar.eu; compliance research)";

// Decision index years to crawl (2018 = first year under GDPR enforcement)
const DECISION_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const DANISH_MONTHS = [
  "jan", "feb", "mar", "apr", "maj", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

// Guidance topic pages to crawl (static HTML, discovered from site nav)
const GUIDANCE_TOPIC_URLS: Array<{ url: string; type: string }> = [
  { url: "/regler-og-vejledning/grundlaeggende-begreber", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/hvad-er-dine-forpligtelser/de-grundlaeggende-principper", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/hvornaar-maa-du-behandle-personoplysninger", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/hvornaar-behandler-du-personoplysninger", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/rollefordeling-dataansvarlig-og-databehandler", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/helbred", type: "vejledning" },
  { url: "/regler-og-vejledning/grundlaeggende-begreber/paavisningskrav-og-dataminimering", type: "vejledning" },
  { url: "/regler-og-vejledning/de-registreredes-rettigheder-", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/sletning", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/de-10-brud", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/katalog-over-foranstaltninger", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/risikovurdering", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/konsekvensanalyse", type: "vejledning" },
  { url: "/regler-og-vejledning/behandlingssikkerhed/haandtering-af-brud-paa-persondatasikkerheden", type: "vejledning" },
  { url: "/regler-og-vejledning/cookies-og-lignende-teknologier", type: "vejledning" },
  { url: "/regler-og-vejledning/databeskyttelse-i-forbindelse-med-ansaettelsesforhold", type: "vejledning" },
  { url: "/regler-og-vejledning/databeskyttelsesraadgivere-dpoer", type: "vejledning" },
  { url: "/regler-og-vejledning/fortegnelse", type: "vejledning" },
  { url: "/regler-og-vejledning/markedsfoering-og-profilering-", type: "vejledning" },
  { url: "/regler-og-vejledning/forskning-og-statistik", type: "vejledning" },
  { url: "/regler-og-vejledning/skoler-og-daginstitutioner", type: "vejledning" },
  { url: "/regler-og-vejledning/kunstig-intelligens", type: "vejledning" },
  { url: "/regler-og-vejledning/cloud", type: "vejledning" },
  { url: "/regler-og-vejledning/optagelser-og-overvaagning", type: "vejledning" },
  { url: "/regler-og-vejledning/medier-registre-og-arkiver", type: "vejledning" },
  { url: "/regler-og-vejledning/adfaerdskodekser-og-certificeringsordninger", type: "vejledning" },
  { url: "/regler-og-vejledning/gdpr-univers-for-smaa-virksomheder", type: "vejledning" },
  { url: "/regler-og-vejledning/gdpr-univers-for-smaa-foreninger", type: "vejledning" },
  { url: "/regler-og-vejledning/forbundne-biler-og-datasikkerhed", type: "vejledning" },
  { url: "/regler-og-vejledning/lovgivning", type: "lovgivning" },
  { url: "/regler-og-vejledning/ofte-stillede-spoergsmaal", type: "faq" },
  { url: "/regler-og-vejledning/myter-om-gdpr", type: "vejledning" },
  { url: "/internationalt/tredjelandsoverfoersler", type: "vejledning" },
  { url: "/internationalt/overfoersler-til-usa", type: "vejledning" },
  { url: "/internationalt/one-stop-shop-og-graenseoverskridende-sager", type: "vejledning" },
];

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const decisionsOnly = args.includes("--decisions-only");
const guidanceOnly = args.includes("--guidance-only");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string | null;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string | null;
  full_text: string;
  topics: string;
  language: string;
}

interface Progress {
  completed_decision_urls: string[];
  completed_guidance_urls: string[];
  discovered_decision_urls: string[];
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "da,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        console.warn(
          `  [retry ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
        );
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  return resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Progress persistence
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as Progress;
    } catch {
      console.warn(`Warning: could not parse ${PROGRESS_FILE}, starting fresh`);
    }
  }
  return {
    completed_decision_urls: [],
    completed_guidance_urls: [],
    discovered_decision_urls: [],
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Topic vocabulary
// ---------------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const TOPICS: TopicRow[] = [
  {
    id: "samtykke",
    name_local: "Samtykke",
    name_en: "Consent",
    description: "Indsamling, gyldighed og tilbagekaldelse af samtykke til behandling af personoplysninger (art. 7 GDPR).",
  },
  {
    id: "cookies",
    name_local: "Cookies og sporere",
    name_en: "Cookies and trackers",
    description: "Placering og l\u00e6sning af cookies og sporere p\u00e5 brugerens enhed (cookiebekendtg\u00f8relsen).",
  },
  {
    id: "dataoverfoersler",
    name_local: "Dataoverf\u00f8rsler",
    name_en: "International transfers",
    description: "Overf\u00f8rsel af personoplysninger til tredjelande eller internationale organisationer (art. 44\u201349 GDPR).",
  },
  {
    id: "konsekvensanalyse",
    name_local: "Konsekvensanalyse (DPIA)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Vurdering af risici for registreredes rettigheder og frihedsrettigheder ved h\u00f8j-risiko behandling (art. 35 GDPR).",
  },
  {
    id: "brud_paa_datasikkerhed",
    name_local: "Brud p\u00e5 datasikkerheden",
    name_en: "Data breach notification",
    description: "Anmeldelse af brud p\u00e5 datasikkerheden til Datatilsynet og ber\u00f8rte registrerede (art. 33\u201334 GDPR).",
  },
  {
    id: "databeskyttelse_i_design",
    name_local: "Databeskyttelse gennem design",
    name_en: "Privacy by design",
    description: "Integrering af databeskyttelse allerede ved udformning og som standard (art. 25 GDPR).",
  },
  {
    id: "ansaettelsesforhold",
    name_local: "Ans\u00e6ttelsesforhold",
    name_en: "Employee monitoring",
    description: "Behandling af personoplysninger i ans\u00e6ttelsesforhold og overv\u00e5gning af ansatte.",
  },
  {
    id: "sundhedsdata",
    name_local: "Sundhedsdata",
    name_en: "Health data",
    description: "Behandling af sundhedsoplysninger \u2014 f\u00f8lsomme oplysninger med forst\u00e6rkede beskyttelsesgarantier (art. 9 GDPR).",
  },
  {
    id: "registerindsigt",
    name_local: "Registerindsigt",
    name_en: "Subject access rights",
    description: "De registreredes ret til indsigt i egne oplysninger og \u00f8vrige rettigheder (art. 12\u201323 GDPR).",
  },
  {
    id: "boern",
    name_local: "B\u00f8rn",
    name_en: "Children's data",
    description: "Beskyttelse af b\u00f8rns personoplysninger, s\u00e6rligt i onlinetjenester (art. 8 GDPR).",
  },
  {
    id: "kameraovervaagning",
    name_local: "Kameraoverv\u00e5gning",
    name_en: "Camera surveillance",
    description: "Kameraoverv\u00e5gning p\u00e5 arbejdspladser, offentlige steder og boligomr\u00e5der (lov om tv-overv\u00e5gning).",
  },
  {
    id: "behandlingssikkerhed",
    name_local: "Behandlingssikkerhed",
    name_en: "Processing security",
    description: "Tekniske og organisatoriske foranstaltninger til sikring af personoplysninger (art. 32 GDPR).",
  },
  {
    id: "behandlingsgrundlag",
    name_local: "Behandlingsgrundlag",
    name_en: "Legal basis for processing",
    description: "Retsgrundlaget for behandling af personoplysninger (art. 6 GDPR).",
  },
  {
    id: "databehandler",
    name_local: "Databehandler",
    name_en: "Data processor",
    description: "Databehandlerens forpligtelser og databehandleraftaler (art. 28 GDPR).",
  },
  {
    id: "oplysningspligt",
    name_local: "Oplysningspligt",
    name_en: "Transparency / duty to inform",
    description: "Den dataansvarliges pligt til at oplyse registrerede om behandling af deres personoplysninger (art. 13\u201314 GDPR).",
  },
  {
    id: "sletning",
    name_local: "Sletning",
    name_en: "Erasure / right to be forgotten",
    description: "Retten til sletning og forpligtelsen til at slette personoplysninger, der ikke l\u00e6ngere er n\u00f8dvendige (art. 17 GDPR).",
  },
  {
    id: "kunstig_intelligens",
    name_local: "Kunstig intelligens",
    name_en: "Artificial intelligence",
    description: "Databeskyttelsesretlige sp\u00f8rgsm\u00e5l ved brug af kunstig intelligens og maskinl\u00e6ring.",
  },
  {
    id: "markedsfoering",
    name_local: "Markedsf\u00f8ring",
    name_en: "Marketing",
    description: "Behandling af personoplysninger til markedsf\u00f8ringsform\u00e5l, herunder profilering og direkte markedsf\u00f8ring.",
  },
  {
    id: "cloud",
    name_local: "Cloud",
    name_en: "Cloud services",
    description: "Databeskyttelse ved brug af cloudtjenester, herunder tredjeparts cloud-udbydere.",
  },
  {
    id: "fortegnelse",
    name_local: "Fortegnelse",
    name_en: "Records of processing activities",
    description: "Kravet om at f\u00f8re fortegnelse over behandlingsaktiviteter (art. 30 GDPR).",
  },
];

// Keyword → topic mapping for auto-classification
const KEYWORD_TOPIC_MAP: Record<string, string[]> = {
  "samtykke": ["samtykke"],
  "consent": ["samtykke"],
  "cookie": ["cookies"],
  "cookies": ["cookies"],
  "sporing": ["cookies"],
  "overf\u00f8rsel": ["dataoverfoersler"],
  "tredjeland": ["dataoverfoersler"],
  "transfer": ["dataoverfoersler"],
  "konsekvensanalyse": ["konsekvensanalyse"],
  "dpia": ["konsekvensanalyse"],
  "brud": ["brud_paa_datasikkerhed"],
  "sikkerhedsbrud": ["brud_paa_datasikkerhed"],
  "breach": ["brud_paa_datasikkerhed"],
  "privacy by design": ["databeskyttelse_i_design"],
  "databeskyttelse gennem design": ["databeskyttelse_i_design"],
  "ans\u00e6ttelse": ["ansaettelsesforhold"],
  "medarbejder": ["ansaettelsesforhold"],
  "overv\u00e5gning": ["ansaettelsesforhold", "kameraovervaagning"],
  "sundhed": ["sundhedsdata"],
  "helbredsoplysnin": ["sundhedsdata"],
  "patient": ["sundhedsdata"],
  "indsigt": ["registerindsigt"],
  "rettigheder": ["registerindsigt"],
  "b\u00f8rn": ["boern"],
  "unge": ["boern"],
  "skole": ["boern"],
  "kamera": ["kameraovervaagning"],
  "tv-overv\u00e5gning": ["kameraovervaagning"],
  "sikkerhed": ["behandlingssikkerhed"],
  "kryptering": ["behandlingssikkerhed"],
  "behandlingsgrundlag": ["behandlingsgrundlag"],
  "retsgrundlag": ["behandlingsgrundlag"],
  "databehandler": ["databehandler"],
  "oplysningspligt": ["oplysningspligt"],
  "sletning": ["sletning"],
  "opbevaring": ["sletning"],
  "kunstig intelligens": ["kunstig_intelligens"],
  "ai": ["kunstig_intelligens"],
  "maskinl\u00e6ring": ["kunstig_intelligens"],
  "markedsf\u00f8ring": ["markedsfoering"],
  "profilering": ["markedsfoering"],
  "cloud": ["cloud"],
  "fortegnelse": ["fortegnelse"],
};

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the page title from an individual decision or guidance page.
 */
function extractTitle($: cheerio.CheerioAPI): string {
  // Primary: the main h1 heading
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;

  // Fallback: og:title meta tag
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
  if (ogTitle) return ogTitle;

  // Fallback: <title> tag
  const title = $("title").text().trim();
  return title || "Untitled";
}

/**
 * Extract the publication date from a decision or guidance page.
 * Datatilsynet uses DD-MM-YYYY format in page content.
 */
function extractDate($: cheerio.CheerioAPI): string | null {
  // Look for date in the standard date element
  const dateEl = $(".LongDate, .ShortDate, .date, time").first();
  if (dateEl.length) {
    const parsed = parseDanishDate(dateEl.text().trim());
    if (parsed) return parsed;
  }

  // Look for date pattern in the introductory text area
  const bodyText = $(".LongRichText, .content-area, #ContentPlaceHolderDefault_leftMenu_ctrl")
    .first()
    .text();

  // Match DD-MM-YYYY or DD. month YYYY patterns
  const isoMatch = bodyText.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (isoMatch) {
    const [, dd, mm, yyyy] = isoMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  // Match "27. maj 2024" style dates
  const danishDateMatch = bodyText.match(
    /(\d{1,2})\.\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\s+(\d{4})/i,
  );
  if (danishDateMatch) {
    return parseDanishLongDate(danishDateMatch[0]!);
  }

  // Extract from URL path (year/month at minimum)
  return null;
}

/**
 * Parse DD-MM-YYYY into YYYY-MM-DD.
 */
function parseDanishDate(text: string): string | null {
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return parseDanishLongDate(text);
}

const DANISH_MONTH_MAP: Record<string, string> = {
  "januar": "01", "februar": "02", "marts": "03", "april": "04",
  "maj": "05", "juni": "06", "juli": "07", "august": "08",
  "september": "09", "oktober": "10", "november": "11", "december": "12",
};

/**
 * Parse "27. maj 2024" into "2024-05-27".
 */
function parseDanishLongDate(text: string): string | null {
  const m = text.match(
    /(\d{1,2})\.\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\s+(\d{4})/i,
  );
  if (!m) return null;
  const day = m[1]!.padStart(2, "0");
  const month = DANISH_MONTH_MAP[m[2]!.toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${day}`;
}

/**
 * Derive a date from the URL path when no date is found on the page.
 * E.g. /afgoerelser/afgoerelser/2024/jan/slug → "2024-01-01"
 */
function dateFromUrlPath(url: string): string | null {
  const m = url.match(/\/(\d{4})\/(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)/i);
  if (!m) return null;
  const year = m[1]!;
  const monthIdx = DANISH_MONTHS.indexOf(m[2]!.toLowerCase());
  if (monthIdx < 0) return null;
  const month = String(monthIdx + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/**
 * Extract the main body text from a page, stripping navigation and chrome.
 */
function extractBodyText($: cheerio.CheerioAPI): string {
  // Remove nav, header, footer, script, style elements
  $("nav, header, footer, script, style, .breadcrumb, .navigation, #mainNavigation_ctrl_menuItem, .sidebar, .cookie-consent").remove();

  // Target the main content area
  const contentArea = $("#ContentPlaceHolderDefault_leftMenu_ctrl, .content-area, main, article").first();
  const raw = contentArea.length ? contentArea.text() : $("body").text();

  return raw
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the first paragraph or two as a summary (max ~500 chars).
 */
function extractSummary($: cheerio.CheerioAPI): string | null {
  const paragraphs = $("#ContentPlaceHolderDefault_leftMenu_ctrl p, .content-area p, main p, article p");
  const texts: string[] = [];
  let totalLen = 0;

  paragraphs.each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 30 && totalLen < 500) {
      texts.push(t);
      totalLen += t.length;
    }
  });

  return texts.length > 0 ? texts.join(" ") : null;
}

/**
 * Extract category tags from a decision page.
 * Datatilsynet marks decisions with categories (sanction type, keywords, etc.)
 * which appear as tag-like elements.
 */
function extractCategoryTags($: cheerio.CheerioAPI): string[] {
  const tags: string[] = [];

  // Look for categorization elements
  $(".categorization a, .tags a, .labels a, .keyword a").each((_, el) => {
    const text = $(el).text().trim();
    if (text) tags.push(text);
  });

  // Also check for inline tag-like elements
  $(".tag, .badge, .label").each((_, el) => {
    const text = $(el).text().trim();
    if (text && !tags.includes(text)) tags.push(text);
  });

  return tags;
}

/**
 * Determine decision type from category tags and page content.
 */
function classifyDecisionType(tags: string[], bodyText: string): string {
  const combined = [...tags, bodyText.slice(0, 2000)].join(" ").toLowerCase();

  if (combined.includes("politianmeldelse") || combined.includes("b\u00f8de")) return "boedesag";
  if (combined.includes("p\u00e5bud") || combined.includes("forbud")) return "paabud";
  if (combined.includes("alvorlig kritik")) return "alvorlig_kritik";
  if (combined.includes("kritik")) return "kritik";
  if (combined.includes("udtalelse") || combined.includes("svar p\u00e5 foresp\u00f8rgsel")) return "udtalelse";
  if (combined.includes("tilladelse")) return "tilladelse";
  if (combined.includes("klage")) return "klage";
  if (combined.includes("tilsyn") || combined.includes("egendriftssag")) return "tilsyn";

  return "afgorelse";
}

/**
 * Extract entity name from decision text and title.
 * Looks for patterns like "mod [Entity]", "vedrørende [Entity]", etc.
 */
function extractEntityName(title: string, bodyText: string): string | null {
  // Pattern: "mod Virksomhed A/S" or "vedrørende Virksomhed"
  const patterns = [
    /(?:mod|vedr\u00f8rende|om)\s+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF\s&\-\.]+(?:A\/S|ApS|I\/S|K\/S|P\/S|Kommune|Region|Styrelsen|Ministeriet|Forening))/,
    /([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF\s&\-\.]+(?:A\/S|ApS|I\/S))/,
    /([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+\s+Kommune)/,
    /([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+\s+Region)/,
  ];

  // Check title first
  for (const pattern of patterns) {
    const m = title.match(pattern);
    if (m?.[1]) return m[1].trim();
  }

  // Check first 1000 chars of body
  const intro = bodyText.slice(0, 1000);
  for (const pattern of patterns) {
    const m = intro.match(pattern);
    if (m?.[1]) return m[1].trim();
  }

  return null;
}

/**
 * Extract fine amount from decision text.
 * Danish fine amounts: "1.200.000 kr." or "DKK 1.200.000" etc.
 */
function extractFineAmount(text: string): number | null {
  // Match patterns like "1.200.000 kr", "200.000 kroner", "DKK 1.200.000"
  const patterns = [
    /(\d{1,3}(?:\.\d{3})*)\s*(?:kr\.?|kroner|DKK)/gi,
    /(?:DKK|kr\.?)\s*(\d{1,3}(?:\.\d{3})*)/gi,
    /b\u00f8de\s+(?:p\u00e5\s+)?(\d{1,3}(?:\.\d{3})*)\s*(?:kr\.?|kroner)/gi,
  ];

  let maxAmount = 0;

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const numStr = m[1]!.replace(/\./g, "");
      const num = parseInt(numStr, 10);
      // Only consider amounts >= 10,000 as fines (filter out small numbers)
      if (num >= 10_000 && num > maxAmount) {
        maxAmount = num;
      }
    }
  }

  return maxAmount > 0 ? maxAmount : null;
}

/**
 * Extract GDPR article references from text.
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // Match "artikel 5", "art. 32", "artikel 6, stk. 1, litra a"
  const patterns = [
    /art(?:ikel)?\.?\s*(\d{1,3})/gi,
    /article\s*(\d{1,3})/gi,
    /GDPR[',\s]+art(?:ikel)?\.?\s*(\d{1,3})/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const artNum = m[1]!;
      // Only include GDPR-range articles (1-99)
      if (parseInt(artNum, 10) <= 99) {
        articles.add(artNum);
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Auto-classify topics based on text content and category tags.
 */
function classifyTopics(text: string, tags: string[]): string[] {
  const topics = new Set<string>();
  const combined = [text.slice(0, 3000), ...tags].join(" ").toLowerCase();

  for (const [keyword, topicIds] of Object.entries(KEYWORD_TOPIC_MAP)) {
    if (combined.includes(keyword.toLowerCase())) {
      for (const id of topicIds) {
        topics.add(id);
      }
    }
  }

  return [...topics];
}

/**
 * Generate a stable reference ID from a URL path.
 * E.g. /afgoerelser/afgoerelser/2024/jan/hvidovre-kommune → "DT-2024-01-hvidovre-kommune"
 */
function referenceFromUrl(url: string): string {
  const path = url.replace(BASE_URL, "");
  const m = path.match(/\/(\d{4})\/(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\/(.+?)(?:\/|$)/i);
  if (m) {
    const year = m[1]!;
    const monthIdx = DANISH_MONTHS.indexOf(m[2]!.toLowerCase());
    const month = String(monthIdx + 1).padStart(2, "0");
    const slug = m[3]!;
    return `DT-${year}-${month}-${slug}`;
  }

  // Fallback: hash the path
  const slug = path.replace(/^\//, "").replace(/\//g, "-").replace(/[^a-z0-9\-]/gi, "");
  return `DT-${slug}`;
}

/**
 * Generate a guidance reference from URL path.
 */
function guidanceReferenceFromUrl(url: string): string {
  const path = url.replace(BASE_URL, "");
  const slug = path.replace(/^\//, "").replace(/\//g, "-").replace(/[^a-z0-9\-\u00e6\u00f8\u00e5]/gi, "");
  return `DT-VEJ-${slug}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Phase 1: Decision URL discovery
// ---------------------------------------------------------------------------

/**
 * Discover decision URLs from year/month index pages.
 * The listing pages use JS rendering (GoBasic CMS), so we try multiple
 * strategies:
 *   1. Extract <a> tags pointing to decision detail pages
 *   2. Parse the base64 context and look for embedded item data
 *   3. Crawl the boedesager page for statically-linked decision pages
 */
async function discoverDecisionUrls(progress: Progress): Promise<string[]> {
  const urls = new Set<string>(progress.discovered_decision_urls);
  const startCount = urls.size;

  console.log("\n=== Phase 1: Discovering decision URLs ===\n");

  // Strategy 1: Crawl year/month index pages and extract any <a> tags
  for (const year of DECISION_YEARS) {
    if (year > new Date().getFullYear()) continue;

    for (const month of DANISH_MONTHS) {
      const indexUrl = `${BASE_URL}/afgoerelser/afgoerelser/${year}/${month}`;
      try {
        const html = await fetchHtml(indexUrl);
        const $ = cheerio.load(html);

        // Extract all links pointing to decision detail pages
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
          // Match decision URL pattern: /afgoerelser/afgoerelser/YYYY/MMM/slug
          if (/\/afgoerelser\/afgoerelser\/\d{4}\/[a-z]{3}\/[a-z0-9]/.test(fullUrl)) {
            // Exclude index pages (year, month listings)
            const pathParts = fullUrl.replace(BASE_URL, "").split("/").filter(Boolean);
            if (pathParts.length >= 5) {
              urls.add(fullUrl);
            }
          }
        });

        console.log(`  [index] ${year}/${month} — total discovered: ${urls.size}`);
      } catch (err) {
        // 404 for future months is expected
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("404")) {
          console.warn(`  [warn] ${indexUrl}: ${msg}`);
        }
      }
    }
  }

  // Strategy 2: Crawl the boedesager page for statically-linked decisions
  console.log("\n  Crawling b\u00f8desager (fine cases) page...");
  try {
    const html = await fetchHtml(`${BASE_URL}/afgoerelser/boedesager`);
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      if (/\/afgoerelser\/afgoerelser\/\d{4}\//.test(fullUrl)) {
        const pathParts = fullUrl.replace(BASE_URL, "").split("/").filter(Boolean);
        if (pathParts.length >= 5) {
          urls.add(fullUrl);
        }
      }
      // Also capture news pages that are decision announcements
      if (/\/presse-og-nyheder\/nyhedsarkiv\/\d{4}\//.test(fullUrl)) {
        // We skip news pages for now — only track decision pages
      }
    });
    console.log(`  [b\u00f8desager] total discovered: ${urls.size}`);
  } catch (err) {
    console.warn(`  [warn] b\u00f8desager: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 3: Crawl the main decisions overview page
  console.log("\n  Crawling main decisions overview...");
  try {
    const html = await fetchHtml(`${BASE_URL}/afgoerelser/afgoerelser`);
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      if (/\/afgoerelser\/afgoerelser\/\d{4}\/[a-z]{3}\/[a-z0-9]/.test(fullUrl)) {
        const pathParts = fullUrl.replace(BASE_URL, "").split("/").filter(Boolean);
        if (pathParts.length >= 5) {
          urls.add(fullUrl);
        }
      }
    });
    console.log(`  [overview] total discovered: ${urls.size}`);
  } catch (err) {
    console.warn(`  [warn] overview: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 4: Follow links from each discovered decision to find more
  // (decisions sometimes link to related decisions)
  // This is done during Phase 2 detail crawling.

  const discovered = [...urls];
  progress.discovered_decision_urls = discovered;
  saveProgress(progress);

  console.log(`\n  Discovery complete: ${discovered.length} URLs (${discovered.length - startCount} new)`);
  return discovered;
}

// ---------------------------------------------------------------------------
// Phase 2: Decision detail crawling
// ---------------------------------------------------------------------------

async function crawlDecision(
  url: string,
  db: Database.Database,
  insertStmt: Database.Statement,
  progress: Progress,
): Promise<boolean> {
  const ref = referenceFromUrl(url);

  // Check if already in DB
  const existing = db
    .prepare("SELECT id FROM decisions WHERE reference = ?")
    .get(ref) as { id: number } | undefined;
  if (existing) {
    return false; // Already ingested
  }

  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const title = extractTitle($);
    if (!title || title === "Untitled") {
      console.warn(`  [skip] ${url}: no title found`);
      return false;
    }

    const bodyText = extractBodyText($);
    if (bodyText.length < 100) {
      console.warn(`  [skip] ${url}: body text too short (${bodyText.length} chars)`);
      return false;
    }

    const date = extractDate($) ?? dateFromUrlPath(url);
    const tags = extractCategoryTags($);
    const type = classifyDecisionType(tags, bodyText);
    const entityName = extractEntityName(title, bodyText);
    const fineAmount = extractFineAmount(bodyText);
    const gdprArticles = extractGdprArticles(bodyText);
    const topics = classifyTopics(bodyText, tags);
    const summary = extractSummary($);

    const row: DecisionRow = {
      reference: ref,
      title,
      date,
      type,
      entity_name: entityName,
      fine_amount: fineAmount,
      summary,
      full_text: bodyText,
      topics: JSON.stringify(topics),
      gdpr_articles: JSON.stringify(gdprArticles),
      status: "final",
    };

    if (dryRun) {
      console.log(`  [dry-run] Would insert decision: ${ref}`);
      console.log(`    Title: ${title}`);
      console.log(`    Date: ${date ?? "unknown"}`);
      console.log(`    Type: ${type}`);
      console.log(`    Entity: ${entityName ?? "unknown"}`);
      console.log(`    Fine: ${fineAmount ? `${fineAmount.toLocaleString("da-DK")} kr.` : "none"}`);
      console.log(`    GDPR articles: ${gdprArticles.join(", ") || "none"}`);
      console.log(`    Topics: ${topics.join(", ") || "none"}`);
      console.log(`    Body length: ${bodyText.length} chars`);
    } else {
      insertStmt.run(
        row.reference,
        row.title,
        row.date,
        row.type,
        row.entity_name,
        row.fine_amount,
        row.summary,
        row.full_text,
        row.topics,
        row.gdpr_articles,
        row.status,
      );
    }

    // Discover linked decisions from this page
    const linked$ = cheerio.load(html);
    linked$("a[href]").each((_, el) => {
      const href = linked$(el).attr("href");
      if (!href) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      if (/\/afgoerelser\/afgoerelser\/\d{4}\/[a-z]{3}\/[a-z0-9]/.test(fullUrl)) {
        const pathParts = fullUrl.replace(BASE_URL, "").split("/").filter(Boolean);
        if (pathParts.length >= 5 && !progress.discovered_decision_urls.includes(fullUrl)) {
          progress.discovered_decision_urls.push(fullUrl);
        }
      }
    });

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [error] ${url}: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Guidance crawling
// ---------------------------------------------------------------------------

async function crawlGuidance(
  entry: { url: string; type: string },
  db: Database.Database,
  insertStmt: Database.Statement,
): Promise<boolean> {
  const fullUrl = entry.url.startsWith("http") ? entry.url : `${BASE_URL}${entry.url}`;
  const ref = guidanceReferenceFromUrl(entry.url);

  // Check if already in DB
  const existing = db
    .prepare("SELECT id FROM guidelines WHERE reference = ?")
    .get(ref) as { id: number } | undefined;
  if (existing) {
    return false;
  }

  try {
    const html = await fetchHtml(fullUrl);
    const $ = cheerio.load(html);

    const title = extractTitle($);
    if (!title || title === "Untitled") {
      console.warn(`  [skip] ${fullUrl}: no title found`);
      return false;
    }

    const bodyText = extractBodyText($);
    if (bodyText.length < 50) {
      console.warn(`  [skip] ${fullUrl}: body text too short (${bodyText.length} chars)`);
      return false;
    }

    const date = extractDate($);
    const summary = extractSummary($);
    const tags = extractCategoryTags($);
    const topics = classifyTopics(bodyText, tags);

    const row: GuidelineRow = {
      reference: ref,
      title,
      date,
      type: entry.type,
      summary,
      full_text: bodyText,
      topics: JSON.stringify(topics),
      language: "da",
    };

    if (dryRun) {
      console.log(`  [dry-run] Would insert guideline: ${ref}`);
      console.log(`    Title: ${title}`);
      console.log(`    Date: ${date ?? "unknown"}`);
      console.log(`    Type: ${entry.type}`);
      console.log(`    Topics: ${topics.join(", ") || "none"}`);
      console.log(`    Body length: ${bodyText.length} chars`);
    } else {
      insertStmt.run(
        row.reference,
        row.title,
        row.date,
        row.type,
        row.summary,
        row.full_text,
        row.topics,
        row.language,
      );
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [error] ${fullUrl}: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Datatilsynet Ingestion Crawler");
  console.log("==============================\n");
  console.log(`Database:  ${DB_PATH}`);
  console.log(`Progress:  ${PROGRESS_FILE}`);
  console.log(`Mode:      ${dryRun ? "DRY RUN" : force ? "FORCE (clean DB)" : resume ? "RESUME" : "FULL"}`);
  if (decisionsOnly) console.log(`Scope:     decisions only`);
  if (guidanceOnly) console.log(`Scope:     guidance only`);
  console.log();

  // --- Bootstrap database --------------------------------------------------

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  if (force && existsSync(PROGRESS_FILE)) {
    unlinkSync(PROGRESS_FILE);
    console.log(`Deleted progress file at ${PROGRESS_FILE}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  console.log(`Database initialised at ${DB_PATH}\n`);

  // --- Load or reset progress ----------------------------------------------

  const progress = resume ? loadProgress() : {
    completed_decision_urls: [] as string[],
    completed_guidance_urls: [] as string[],
    discovered_decision_urls: [] as string[],
    last_updated: new Date().toISOString(),
  };

  if (resume) {
    console.log(`Resuming from checkpoint (${progress.completed_decision_urls.length} decisions, ${progress.completed_guidance_urls.length} guidelines done)\n`);
  }

  // --- Insert topics -------------------------------------------------------

  console.log("Inserting topics...");
  const insertTopic = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );
  const insertTopicsAll = db.transaction(() => {
    for (const t of TOPICS) {
      insertTopic.run(t.id, t.name_local, t.name_en, t.description);
    }
  });
  insertTopicsAll();
  console.log(`  Inserted/verified ${TOPICS.length} topics\n`);

  // --- Decisions -----------------------------------------------------------

  if (!guidanceOnly) {
    const decisionUrls = await discoverDecisionUrls(progress);

    console.log(`\n=== Phase 2: Crawling decision detail pages ===\n`);

    const insertDecision = db.prepare(`
      INSERT OR IGNORE INTO decisions
        (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const completedSet = new Set(progress.completed_decision_urls);
    let inserted = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < decisionUrls.length; i++) {
      const url = decisionUrls[i]!;

      // Skip if already completed (resume mode)
      if (completedSet.has(url)) {
        skipped++;
        continue;
      }

      const pct = ((i + 1) / decisionUrls.length * 100).toFixed(1);
      process.stdout.write(`  [${pct}%] (${i + 1}/${decisionUrls.length}) ${url.replace(BASE_URL, "")} ... `);

      const ok = await crawlDecision(url, db, insertDecision, progress);
      if (ok) {
        inserted++;
        console.log("OK");
      } else {
        failed++;
        console.log("skip");
      }

      progress.completed_decision_urls.push(url);
      completedSet.add(url);

      // Save progress every 10 pages
      if ((i + 1) % 10 === 0) {
        saveProgress(progress);
      }
    }

    saveProgress(progress);
    console.log(`\n  Decisions: ${inserted} inserted, ${skipped} resumed, ${failed} skipped/failed`);
  }

  // --- Guidelines ----------------------------------------------------------

  if (!decisionsOnly) {
    console.log(`\n=== Phase 3: Crawling guidance pages ===\n`);

    const insertGuideline = db.prepare(`
      INSERT OR IGNORE INTO guidelines
        (reference, title, date, type, summary, full_text, topics, language)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const completedGuidanceSet = new Set(progress.completed_guidance_urls);
    let inserted = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < GUIDANCE_TOPIC_URLS.length; i++) {
      const entry = GUIDANCE_TOPIC_URLS[i]!;

      if (completedGuidanceSet.has(entry.url)) {
        skipped++;
        continue;
      }

      const pct = ((i + 1) / GUIDANCE_TOPIC_URLS.length * 100).toFixed(1);
      process.stdout.write(`  [${pct}%] (${i + 1}/${GUIDANCE_TOPIC_URLS.length}) ${entry.url} ... `);

      const ok = await crawlGuidance(entry, db, insertGuideline);
      if (ok) {
        inserted++;
        console.log("OK");
      } else {
        failed++;
        console.log("skip");
      }

      progress.completed_guidance_urls.push(entry.url);
      completedGuidanceSet.add(entry.url);

      if ((i + 1) % 10 === 0) {
        saveProgress(progress);
      }
    }

    saveProgress(progress);
    console.log(`\n  Guidelines: ${inserted} inserted, ${skipped} resumed, ${failed} skipped/failed`);
  }

  // --- Summary -------------------------------------------------------------

  const decisionCount = (
    db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
  ).cnt;
  const guidelineCount = (
    db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
  ).cnt;
  const topicCount = (
    db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
  ).cnt;
  const decisionFtsCount = (
    db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
  ).cnt;
  const guidelineFtsCount = (
    db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
  ).cnt;

  console.log(`\n==============================`);
  console.log(`Database summary:`);
  console.log(`  Topics:         ${topicCount}`);
  console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
  console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
  console.log(`\nDone. Database at ${DB_PATH}`);

  db.close();
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
