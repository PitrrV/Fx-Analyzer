/**
 * FX_ANALYZER.STATUS — první, záměrně skromný most k FX Analyzeru.
 *
 * Dělá jedinou věc, kterou lze udělat bez domýšlení: přečte datové soubory,
 * které plní GitHub Actions crony, a ohlásí, co je k dispozici a jak je to čerstvé.
 *
 * Vědomě NEinterpretuje skóre a nepočítá vlastní analýzu. Interpretace vyžaduje,
 * aby agent rozuměl scoring systému (`scoreCurrency`, `calcConvictionScore`,
 * `rankPairs`, `buildForecastV5` v engine.js), jeho vahám i jeho omezením —
 * to je samostatná fáze. Vymyšlené číslo je horší než žádné.
 *
 * Připravené místo pro rozšíření je `ADAPTERS` níže: každý budoucí FX nástroj
 * (ranking párů, conviction, COT detail, backtest) je nový soubor v tomto
 * adresáři se stejným kontraktem, ne zásah do tohoto.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ROOT } from "../../config.mjs";
import { LEVELS } from "../permissions.mjs";

/** Kořen FX Analyzeru — jarvis/ leží uvnitř repozitáře, takže o úroveň výš. */
const FX_ROOT = resolve(ROOT, "..");

/** Datové zdroje, které plní crony v .github/workflows/. */
const SOURCES = [
  { key: "calendar", file: "data/calendar.json", label: "Ekonomický kalendář" },
  { key: "cot", file: "data/cot_hist.json", label: "COT pozicování (CFTC)" },
  { key: "retail", file: "data/retail_hist.json", label: "Retail sentiment" },
  { key: "prices", file: "data/prices.json", label: "FX ceny" },
  { key: "engine", file: "data/engine_hist.json", label: "Denní snapshot engine skóre" },
];

export default {
  name: "fx_analyzer.status",
  description:
    "Zjistí stav datové vrstvy FX Analyzeru: které datové sady existují (kalendář, COT, " +
    "retail sentiment, ceny, denní snapshot skóre), jak jsou čerstvé a odkud pocházejí. " +
    "Použij, když se uživatel ptá, jestli má Analyzer aktuální data, nebo než se pustíš " +
    "do čehokoli, co na FX datech závisí. Nevrací tržní analýzu ani skóre měn — " +
    "interpretace scoring systému zatím není zapojená.",

  permissions: { level: LEVELS.READ, destructive: false },

  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Omezí dotaz na jeden zdroj. Bez uvedení vrací přehled všech.",
        enum: SOURCES.map((s) => s.key),
      },
    },
  },

  async execute({ source }) {
    const wanted = source ? SOURCES.filter((s) => s.key === source) : SOURCES;
    const now = Date.now();

    const sources = await Promise.all(
      wanted.map(async (s) => {
        try {
          const raw = await readFile(join(FX_ROOT, s.file), "utf8");
          const json = JSON.parse(raw);
          const updated = json.updated ?? latestDayKey(json);
          const ageHours = updated ? Math.round(((now - Date.parse(updated)) / 3_600_000) * 10) / 10 : null;

          return {
            key: s.key,
            label: s.label,
            available: true,
            updated: updated ?? null,
            ageHours,
            stale: ageHours != null && ageHours > 48,
            origin: json.source ?? null,
            coverage: describeCoverage(s.key, json),
          };
        } catch (err) {
          return { key: s.key, label: s.label, available: false, reason: err.code ?? err.message };
        }
      }),
    );

    const missing = sources.filter((s) => !s.available);
    const stale = sources.filter((s) => s.stale);

    const summary =
      `FX data: ${sources.length - missing.length}/${sources.length} zdrojů k dispozici` +
      (stale.length ? `, zastaralé: ${stale.map((s) => s.label).join(", ")}` : "") +
      (missing.length ? `, chybí: ${missing.map((s) => s.label).join(", ")}` : "");

    return {
      summary,
      data: {
        fxRoot: FX_ROOT,
        sources,
        note: "Skóre a ranking párů zatím nejsou zapojené — tento nástroj hlásí pouze dostupnost dat.",
      },
    };
  },
};

/** engine_hist.json nemá `updated`, ale má klíče podle dní. */
function latestDayKey(json) {
  const days = json?.days ?? json?.weeks;
  if (!days) return null;
  const keys = Object.keys(days).sort();
  const last = keys.at(-1);
  return days[last]?.ts ?? (last ? `${last}T00:00:00.000Z` : null);
}

/** Jednořádkový popis rozsahu dat, bez interpretace obsahu. */
function describeCoverage(key, json) {
  switch (key) {
    case "calendar":
      return `${json.count ?? json.events?.length ?? 0} událostí, z toho ${json.withActual ?? 0} s reálnou hodnotou`;
    case "cot":
      return `${Object.keys(json.weeks ?? {}).length} týdenních reportů`;
    case "retail":
      return `${(json.points ?? []).length} měření`;
    case "prices":
      return `${Object.keys(json.rates ?? {}).length} měn, ${(json.hist ?? []).length} historických dní`;
    case "engine":
      return `${Object.keys(json.days ?? {}).length} denních snapshotů`;
    default:
      return null;
  }
}
