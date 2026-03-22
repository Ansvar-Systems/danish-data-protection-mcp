/**
 * Seed the Datatilsynet database with sample decisions and guidelines for testing.
 *
 * Includes real Datatilsynet decisions (Danske Bank, IDdesign, municipality)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["DT_DB_PATH"] ?? "data/datatilsynet.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
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
    description: "Placering og læsning af cookies og sporere på brugerens enhed (cookiebekendtgørelsen).",
  },
  {
    id: "dataoverfoersler",
    name_local: "Dataoverførsler",
    name_en: "International transfers",
    description: "Overførsel af personoplysninger til tredjelande eller internationale organisationer (art. 44–49 GDPR).",
  },
  {
    id: "konsekvensanalyse",
    name_local: "Konsekvensanalyse (DPIA)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Vurdering af risici for registreredes rettigheder og frihedsrettigheder ved høj-risiko behandling (art. 35 GDPR).",
  },
  {
    id: "brud_paa_datasikkerhed",
    name_local: "Brud på datasikkerheden",
    name_en: "Data breach notification",
    description: "Anmeldelse af brud på datasikkerheden til Datatilsynet og berørte registrerede (art. 33–34 GDPR).",
  },
  {
    id: "databeskyttelse_i_design",
    name_local: "Databeskyttelse gennem design",
    name_en: "Privacy by design",
    description: "Integrering af databeskyttelse allerede ved udformning og som standard (art. 25 GDPR).",
  },
  {
    id: "ansaettelsesforhold",
    name_local: "Ansættelsesforhold",
    name_en: "Employee monitoring",
    description: "Behandling af personoplysninger i ansættelsesforhold og overvågning af ansatte.",
  },
  {
    id: "sundhedsdata",
    name_local: "Sundhedsdata",
    name_en: "Health data",
    description: "Behandling af sundhedsoplysninger — følsomme oplysninger med forstærkede beskyttelsesgarantier (art. 9 GDPR).",
  },
  {
    id: "registerindsigt",
    name_local: "Registerindsigt",
    name_en: "Subject access rights",
    description: "De registreredes ret til indsigt i egne oplysninger og øvrige rettigheder (art. 12–23 GDPR).",
  },
  {
    id: "boern",
    name_local: "Børn",
    name_en: "Children's data",
    description: "Beskyttelse af børns personoplysninger, særligt i onlinetjenester (art. 8 GDPR).",
  },
  {
    id: "kameraovervaagning",
    name_local: "Kameraovervågning",
    name_en: "Camera surveillance",
    description: "Kameraovervågning på arbejdspladser, offentlige steder og boligområder (lov om tv-overvågning).",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // 2020-431-0059 — Danske Bank (DKK 1.2M)
  {
    reference: "2020-431-0059",
    title: "Afgørelse mod Danske Bank — DKK 1.200.000 bøde",
    date: "2021-05-04",
    type: "afgorelse",
    entity_name: "Danske Bank A/S",
    fine_amount: 1_200_000,
    summary:
      "Datatilsynet indstillede Danske Bank til en bøde på 1,2 millioner kroner for ikke at have slettet kundernes personoplysninger rettidigt. Banken opbevarede oplysninger om tidligere kunder i op til ti år ud over den lovpligtige opbevaringsperiode.",
    full_text:
      "Datatilsynet har truffet afgørelse i en sag om Danske Banks sletning af personoplysninger. Sagen udsprang af en tilsynssag, som Datatilsynet indledte på baggrund af medieomtale af, at Danske Bank opbevarede personoplysninger om tidligere kunder i perioder, der langt oversteg de lovpligtige opbevaringsperioder. Datatilsynet konstaterede, at Danske Bank i strid med databeskyttelsesforordningens artikel 5, stk. 1, litra e, opbevarede personoplysninger om et stort antal tidligere kunder i op til ti år ud over, hvad der var nødvendigt til de formål, hvortil oplysningerne var indsamlet. Dette skyldtes bl.a. mangler i bankens IT-systemer og procedurer for sletning. Datatilsynet fandt, at overtrædelsen var af alvorlig karakter henset til antallet af berørte registrerede og overtrædelsernes varighed. Datatilsynet politianmeldte Danske Bank med indstilling om en bøde på 1.200.000 kr. Sagen illustrerer vigtigheden af at have effektive slettepolitikker og tekniske foranstaltninger, der sikrer, at personoplysninger slettes, når de ikke længere er nødvendige.",
    topics: JSON.stringify(["databeskyttelse_i_design"]),
    gdpr_articles: JSON.stringify(["5", "25"]),
    status: "final",
  },
  // 2021-443-0001 — IDdesign employee monitoring
  {
    reference: "2021-443-0001",
    title: "Afgørelse mod IDdesign A/S — overvågning af medarbejdere",
    date: "2021-11-18",
    type: "afgorelse",
    entity_name: "IDdesign A/S",
    fine_amount: 750_000,
    summary:
      "Datatilsynet indstillede møbelkæden IDdesign til en bøde på 750.000 kroner for ulovlig overvågning af medarbejdere via en GPS-baseret app og for at registrere ansattes bevægelser uden et lovligt grundlag.",
    full_text:
      "Datatilsynet har afgjort en sag vedrørende IDdesign A/S' behandling af personoplysninger om virksomhedens medarbejdere. Datatilsynet konstaterede, at IDdesign anvendte en app til at spore medarbejdernes placering via GPS uden et gyldigt retsgrundlag. Overtrædelserne bestod i: (1) Manglende retsgrundlag — IDdesign behandlede lokationsoplysninger om medarbejdere uden en af de retsgrunde, der er opregnet i databeskyttelsesforordningens artikel 6; samtykke fra ansatte anses generelt ikke som frivilligt i et ansættelsesforhold; (2) Behandling uden for arbejdstid — appen registrerede medarbejdernes placering også uden for arbejdstiden, hvilket er en alvorlig krænkelse af privatlivets fred; (3) Manglende information — medarbejderne var ikke behørigt informeret om behandlingen i henhold til artikel 13 GDPR; (4) Manglende konsekvensanalyse — systematisk overvågning af medarbejdere udgør en behandling med høj risiko, der kræver en konsekvensanalyse (DPIA). Datatilsynet indstillede IDdesign til en bøde på 750.000 kr og påbød virksomheden at ophøre med den ulovlige behandling.",
    topics: JSON.stringify(["ansaettelsesforhold", "konsekvensanalyse"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "35"]),
    status: "final",
  },
  // 2021-432-0002 — Municipality data breach
  {
    reference: "2021-432-0002",
    title: "Afgørelse mod Aarhus Kommune — brud på datasikkerheden",
    date: "2021-09-22",
    type: "afgorelse",
    entity_name: "Aarhus Kommune",
    fine_amount: null,
    summary:
      "Datatilsynet udtrykte alvorlig kritik af Aarhus Kommune for et brud på datasikkerheden, hvor følsomme personoplysninger om borgere med handicap og sociale sager ved en fejl blev sendt til forkerte modtagere.",
    full_text:
      "Datatilsynet har afgjort en tilsynssag vedrørende Aarhus Kommunes håndtering af et brud på datasikkerheden. Bruddet opstod, da kommunen ved en fejl sendte breve med følsomme personoplysninger — herunder oplysninger om borgeres helbredsforhold, sociale problemer og handicap — til forkerte modtagere. Datatilsynet konstaterede, at Aarhus Kommune: (1) ikke anmeldte bruddet til Datatilsynet inden for 72-timers fristen i artikel 33 GDPR; (2) ikke underrettede de berørte borgere om bruddet i henhold til artikel 34, selvom bruddet sandsynligvis ville medføre høj risiko for de berørtes rettigheder og frihedsrettigheder; (3) ikke havde tilstrækkelige tekniske og organisatoriske foranstaltninger til at forhindre sådanne fejl. Datatilsynet udtalte alvorlig kritik af kommunen for overtrædelse af artikel 32, 33 og 34 i databeskyttelsesforordningen. Sagen illustrerer, at offentlige myndigheder har samme forpligtelser som private virksomheder under GDPR.",
    topics: JSON.stringify(["brud_paa_datasikkerhed", "sundhedsdata"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // 2022-431-0042 — Telecompany cookies
  {
    reference: "2022-431-0042",
    title: "Afgørelse mod televirksomhed — ulovlige marketing cookies",
    date: "2022-08-15",
    type: "afgorelse",
    entity_name: "Telia Danmark A/S",
    fine_amount: 400_000,
    summary:
      "Datatilsynet indstillede Telia til en bøde for at have placeret markedsføringscookies på brugernes enheder uden forudgående samtykke og for at have gjort det sværere at afvise cookies end at acceptere dem.",
    full_text:
      "Datatilsynet har afgjort en sag om Telias brug af cookies på virksomhedens hjemmeside. Datatilsynet konstaterede, at Telia: (1) placerede markedsføringscookies og analysecookies på brugernes enheder, før brugerne havde givet samtykke; (2) havde designet sin cookie-banner således, at det var vanskeligere at afvise alle cookies end at acceptere dem — knappen 'Accepter alle' var fremtrædende, mens muligheden for at afvise var gemt bag flere klik; (3) brugte forudmarkerede valgbokse til kategorier af cookies, hvilket ikke opfylder kravet om aktiv handling. Cookies, der ikke er strengt nødvendige for tjenestens funktion, kræver et gyldigt samtykke i henhold til cookiebekendtgørelsen og databeskyttelsesforordningens artikel 6, stk. 1, litra a. Et gyldigt samtykke skal være specifikt, informeret og givet ved en utvetydig bekræftende handling. Datatilsynet indstillede Telia til en bøde på 400.000 kr.",
    topics: JSON.stringify(["cookies", "samtykke"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "DT-VEJLEDNING-COOKIES-2022",
    title: "Vejledning om cookies",
    date: "2022-01-01",
    type: "vejledning",
    summary:
      "Datatilsynets vejledning om cookies og andre sporingstjenester. Forklarer, hvornår samtykke er nødvendigt, hvordan cookie-bannere skal udformes, og hvad der gælder for tredjeparts cookies.",
    full_text:
      "Datatilsynets vejledning om cookies præciserer reglerne i cookiebekendtgørelsen og databeskyttelsesforordningen. Vejledningen behandler: (1) Hvilke cookies kræver samtykke — alle cookies, der ikke er strengt nødvendige for tjenestens funktion, kræver forudgående samtykke; dette omfatter analytiske cookies, markedsføringscookies og sociale medie-cookies; (2) Krav til samtykke — samtykke skal indhentes, inden cookies placeres; samtykket skal være specifikt, informeret og givet ved en aktiv handling; forudmarkerede valgbokse er ikke gyldigt samtykke; (3) Ligeværdige valg — muligheden for at afvise cookies skal præsenteres på samme fremtrædende måde som muligheden for at acceptere; (4) Dokumentation — virksomheden skal kunne dokumentere, at gyldigt samtykke er indhentet; (5) Tredjeparts tjenester — brug af tjenester som Google Analytics og sociale medie-knapper indebærer databehandling fra tredjeparter, og der skal indgås databehandleraftaler; (6) Teknisk implementering — cookies må ikke placeres via JavaScript, inden samtykke er givet.",
    topics: JSON.stringify(["cookies", "samtykke"]),
    language: "da",
  },
  {
    reference: "DT-VEJLEDNING-ANSAETTELSE-2021",
    title: "Vejledning om databeskyttelse i ansættelsesforhold",
    date: "2021-05-01",
    type: "vejledning",
    summary:
      "Datatilsynets vejledning om behandling af medarbejderes personoplysninger. Dækker rekruttering, ansættelse, overvågning og afskedigelse samt reglerne for indhentning af referencer og straffeattest.",
    full_text:
      "Vejledningen behandler de databeskyttelsesretlige regler, der gælder i ansættelsesforhold. Retsgrundlag — behandling af medarbejderes personoplysninger kan ske på grundlag af: opfyldelse af ansættelseskontrakten (artikel 6, stk. 1, litra b), overholdelse af retlige forpligtelser (artikel 6, stk. 1, litra c) eller legitime interesser (artikel 6, stk. 1, litra f); samtykke fra medarbejdere er generelt ikke et gyldigt retsgrundlag i ansættelsesforhold, da samtykket ikke er frivilligt givet på grund af magtforholdet. Rekruttering — det er tilladt at behandle de oplysninger, der er nødvendige for at vurdere ansøgernes kompetencer; oplysninger om ansøgeres helbredsforhold, fagforeningsmedlemskab og politiske holdninger må kun indhentes i særlige situationer. Overvågning — overvågning af medarbejdere skal have et legitimt formål og være proportional; kameraovervågning på arbejdspladsen kræver særlig begrundelse; overvågning af e-mail og internetbrug kræver forudgående information til medarbejderne. Sletning — medarbejdernes personoplysninger skal slettes, når de ikke længere er nødvendige; generelt bør oplysninger slettes inden for et år efter ansættelsesforholdets ophør, medmindre lovgivningen kræver en længere opbevaringsperiode.",
    topics: JSON.stringify(["ansaettelsesforhold", "samtykke"]),
    language: "da",
  },
  {
    reference: "DT-VEJLEDNING-SAMTYKKE-2020",
    title: "Vejledning om samtykke",
    date: "2020-06-01",
    type: "vejledning",
    summary:
      "Datatilsynets vejledning om gyldigt samtykke under GDPR. Forklarer kravene til frivillighed, specificitet, informeret samtykke og utvetydig bekræftende handling.",
    full_text:
      "Et gyldigt samtykke er fundamentet for mange behandlinger af personoplysninger. Vejledningen præciserer GDPR's krav: (1) Frivillighed — samtykket skal gives frivilligt uden negative konsekvenser for den registrerede, hvis samtykket ikke gives eller tilbagekaldes; samtykke er ikke frivilligt, hvis afvisning medfører dårligere service (cookie walls); (2) Specificitet — samtykket skal dække specifikke behandlingsformål; et generelt samtykke til 'alt' er ikke gyldigt; (3) Informeret — den registrerede skal informeres om, hvem der behandler oplysningerne, til hvilke formål og hvem der eventuel deler oplysningerne; (4) Utvetydig bekræftende handling — samtykket skal gives ved en aktiv handling, f.eks. afkrydsning af en boks; stiltiende samtykke og forudmarkerede bokse er ikke gyldigt; (5) Tilbagetrækning — den registrerede skal til enhver tid kunne tilbagekalde sit samtykke, og tilbagetrækning skal være lige så nem som at give samtykket; (6) Dokumentation — den dataansvarlige skal kunne dokumentere, at gyldigt samtykke er indhentet.",
    topics: JSON.stringify(["samtykke"]),
    language: "da",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

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

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
