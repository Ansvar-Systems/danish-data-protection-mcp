# Coverage

This MCP server provides access to data from **Datatilsynet** (Danish Data Protection Authority).

## Sources

| Source | Type | Jurisdiction | Language | License |
|--------|------|-------------|----------|---------|
| [Datatilsynet](https://www.datatilsynet.dk/) | Regulatory authority | DK | Danish (da) | Open Government Data |

## Data Types

### Decisions (`decisions` table)
- **Afgørelser** — formal GDPR enforcement decisions
- **Sanctions** — administrative fines and penalties
- **Indskærpelser** — reprimands and orders to comply
- **Udtalelser** — opinions and statements

### Guidelines (`guidelines` table)
- **Vejledninger** — official GDPR implementation guides
- **Retningslinjer** — binding guidelines and rules
- **FAQs** — frequently asked questions and answers

## Topics Covered

| Topic ID | Danish | English |
|----------|--------|---------|
| `cookies` | Cookies | Cookies |
| `samtykke` | Samtykke | Consent |
| `ansættelsesforhold` | Ansættelsesforhold | Employment relations |
| `kameraovervågning` | Kameraovervågning | CCTV / video surveillance |
| `sundhedsdata` | Sundhedsdata | Health data |
| `dataoverfoersler` | Dataoverførsler | Data transfers |
| `konsekvensanalyse` | Konsekvensanalyse | Data protection impact assessment (DPIA) |
| `registerindsigt` | Registerindsigt | Right of access |
| `børn` | Børn | Children |

## Update Frequency

Data is ingested from the Datatilsynet website. To update the local database:

```bash
npm run ingest
```

## Limitations

- Database updates are periodic and may lag official Datatilsynet publications by days to weeks.
- Coverage of older decisions may be incomplete.
- Full text is available for most decisions; some older records may contain summaries only.
- This data is for research purposes only — not legal or regulatory advice.
