// Jednorázový sběr externích dat pro per-měnový audit skóre (research
// report) — běží na GitHub Actions (sandbox Claude nemá odchozí síť na
// FRED/CFTC), zapisuje data/research/*.json. Není to cron — dispatch-only,
// data jsou historická a stahují se jednou.
//
// Zdroje (vše bez API klíče):
//  - FRED fredgraph.csv (denní: US výnosy, VIX, WTI, zlato, DXY proxy;
//    měsíční: 3M interbank sazby, 10y výnosy, CPI YoY pro 8 měn, měď)
//  - CFTC Socrata publicreporting.cftc.gov:
//      6dca-aqww  legacy futures-only (noncommercial/commercial) — od ~1986
//      gpe5-46if  Traders in Financial Futures (dealer/asset mgr/leveraged) — od 2006
//
// Vědomé mezery (proprietární/bez volné historie): PMI (S&P Global), MOVE
// index, Citi Economic Surprise Index, forward/expected rates (OIS killing),
// iron ore. Zapsáno do meta.limitations výstupu.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data/research");

const FRED_SERIES = {
  // denní
  us2y: "DGS2", us10y: "DGS10", fedfunds: "DFF", vix: "VIXCLS",
  wti: "DCOILWTICO", dxy_broad: "DTWEXBGS",
  // zlato: London PM fix (končí 2024?) + fallback IMF měsíční
  gold_pm: "GOLDPMGBD228NLBM",
  // měsíční — 3M interbank (short rate proxy) per měna
  ir3m_US: "IR3TIB01USM156N", ir3m_EA: "IR3TIB01EZM156N", ir3m_GB: "IR3TIB01GBM156N",
  ir3m_JP: "IR3TIB01JPM156N", ir3m_AU: "IR3TIB01AUM156N", ir3m_CA: "IR3TIB01CAM156N",
  ir3m_CH: "IR3TIB01CHM156N", ir3m_NZ: "IR3TIB01NZM156N",
  // měsíční — 10y výnosy per měna
  y10_US: "IRLTLT01USM156N", y10_EA: "IRLTLT01EZM156N", y10_GB: "IRLTLT01GBM156N",
  y10_JP: "IRLTLT01JPM156N", y10_AU: "IRLTLT01AUM156N", y10_CA: "IRLTLT01CAM156N",
  y10_CH: "IRLTLT01CHM156N", y10_NZ: "IRLTLT01NZM156N",
  // měsíční — CPI YoY (growth rate same period previous year)
  cpi_US: "CPALTT01USM659N", cpi_EA: "CPALTT01EZM659N", cpi_GB: "CPALTT01GBM659N",
  cpi_JP: "CPALTT01JPM659N", cpi_AU: "CPALTT01AUQ659N", cpi_CA: "CPALTT01CAM659N",
  cpi_CH: "CPALTT01CHM659N", cpi_NZ: "CPALTT01NZQ659N",
  // komodity — měsíční IMF
  copper: "PCOPPUSDM", iron_ore: "PIORECRUSDM", gold_imf: "PGOLDUSDM",
};

const COT_MARKETS = {
  EUR: "EURO FX", JPY: "JAPANESE YEN", GBP: "BRITISH POUND",
  CHF: "SWISS FRANC", AUD: "AUSTRALIAN DOLLAR", NZD: "NZ DOLLAR",
  CAD: "CANADIAN DOLLAR", USD: "U.S. DOLLAR INDEX",
};
// starší názvy trhů v legacy datasetu (název se v čase měnil — LIKE match)
const COT_LIKE = {
  EUR: "EURO FX%", JPY: "JAPANESE YEN%", GBP: "BRITISH POUND%",
  CHF: "SWISS FRANC%", AUD: "AUSTRALIAN DOLLAR%", NZD: "%NZ DOLLAR%",
  CAD: "CANADIAN DOLLAR%", USD: "%DOLLAR INDEX%",
};

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "Mozilla/5.0 (research)" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

async function fetchFred(id) {
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  const rows = text.trim().split("\n").slice(1).map((l) => {
    const [d, v] = l.split(",");
    const num = parseFloat(v);
    return { d, v: Number.isFinite(num) ? num : null };
  }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.v != null);
  return rows;
}

async function fetchSocrata(dataset, where, fields, order) {
  const out = [];
  let offset = 0;
  const limit = 20000;
  for (;;) {
    const url = `https://publicreporting.cftc.gov/resource/${dataset}.json?$select=${encodeURIComponent(fields)}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(order)}&$limit=${limit}&$offset=${offset}`;
    const text = await fetchText(url);
    const batch = JSON.parse(text);
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { updated: new Date().toISOString(), sources: {}, failures: [], limitations: [
    "PMI (S&P Global), MOVE index, Citi Economic Surprise Index, OIS/forward expected rates, iron ore spot — proprietární, bez volné plné historie; netestováno.",
    "CPI AU/NZ jsou čtvrtletní (FRED nemá měsíční) — v panelu ffill.",
    "COT legacy sahá do ~1986; TFF (dealer/asset manager/leveraged) až od 2006.",
  ] };

  // ── FRED ──
  const fred = {};
  for (const [key, id] of Object.entries(FRED_SERIES)) {
    try {
      fred[key] = await fetchFred(id);
      console.log("FRED OK", key, id, fred[key].length, "bodů,", fred[key][0]?.d, "→", fred[key].at(-1)?.d);
      meta.sources[key] = { id, n: fred[key].length, from: fred[key][0]?.d, to: fred[key].at(-1)?.d };
    } catch (e) {
      console.log("FRED CHYBA", key, id, e.message);
      meta.failures.push("FRED " + key + " (" + id + "): " + e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  fs.writeFileSync(path.join(OUT, "fred.json"), JSON.stringify(fred));

  // ── CFTC legacy (noncommercial/commercial) — futures only ──
  const legacyFields = "market_and_exchange_names,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all,open_interest_all";
  const legacy = {};
  for (const [ccy, like] of Object.entries(COT_LIKE)) {
    try {
      const rows = await fetchSocrata("6dca-aqww",
        `market_and_exchange_names like '${like}'`,
        legacyFields, "report_date_as_yyyy_mm_dd");
      legacy[ccy] = rows.map((r) => ({
        d: String(r.report_date_as_yyyy_mm_dd).slice(0, 10),
        m: r.market_and_exchange_names,
        ncl: +r.noncomm_positions_long_all, ncs: +r.noncomm_positions_short_all,
        cl: +r.comm_positions_long_all, cs: +r.comm_positions_short_all,
        oi: +r.open_interest_all,
      }));
      console.log("COT legacy OK", ccy, legacy[ccy].length, "týdnů,", legacy[ccy][0]?.d, "→", legacy[ccy].at(-1)?.d);
      meta.sources["cot_legacy_" + ccy] = { n: legacy[ccy].length, from: legacy[ccy][0]?.d, to: legacy[ccy].at(-1)?.d };
    } catch (e) {
      console.log("COT legacy CHYBA", ccy, e.message);
      meta.failures.push("COT legacy " + ccy + ": " + e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  fs.writeFileSync(path.join(OUT, "cot_legacy.json"), JSON.stringify(legacy));

  // ── CFTC TFF (dealer / asset manager / leveraged funds) ──
  const tffFields = "market_and_exchange_names,report_date_as_yyyy_mm_dd,dealer_positions_long_all,dealer_positions_short_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short,open_interest_all";
  const tff = {};
  for (const [ccy, like] of Object.entries(COT_LIKE)) {
    try {
      const rows = await fetchSocrata("gpe5-46if",
        `market_and_exchange_names like '${like}'`,
        tffFields, "report_date_as_yyyy_mm_dd");
      tff[ccy] = rows.map((r) => ({
        d: String(r.report_date_as_yyyy_mm_dd).slice(0, 10),
        m: r.market_and_exchange_names,
        dl: +r.dealer_positions_long_all, dsh: +r.dealer_positions_short_all,
        aml: +r.asset_mgr_positions_long, ams: +r.asset_mgr_positions_short,
        lml: +r.lev_money_positions_long, lms: +r.lev_money_positions_short,
        oi: +r.open_interest_all,
      }));
      console.log("COT TFF OK", ccy, tff[ccy].length, "týdnů,", tff[ccy][0]?.d, "→", tff[ccy].at(-1)?.d);
      meta.sources["cot_tff_" + ccy] = { n: tff[ccy].length, from: tff[ccy][0]?.d, to: tff[ccy].at(-1)?.d };
    } catch (e) {
      console.log("COT TFF CHYBA", ccy, e.message);
      meta.failures.push("COT TFF " + ccy + ": " + e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  fs.writeFileSync(path.join(OUT, "cot_tff.json"), JSON.stringify(tff));

  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("\nHotovo. Selhání:", meta.failures.length ? meta.failures.join(" | ") : "žádné");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
