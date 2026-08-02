// PRŮZKUM (dispatch-only): porovnat appku (TFF report) proti Honzově "Trading
// Analyzer" nástroji, který u USD ukazuje "Legacy" COT report (Komerční/Velcí
// spekulanti/Drobní obchodníci = Commercial/Non-Commercial/Non-Reportable).
// Uživatel zachytil z jeho appky tooltip: Velcí spekulanti (USD) Long 64.08 %,
// 35 339 kontraktů. Cíl: najít Legacy dataset pro USD Index a ověřit, jestli
// tohle číslo sedí na skutečná CFTC data (a tím i to, že náš TFF fix je
// konzistentní s jiným reportem stejného trhu, jen jinak kategorizovaným).
(async () => {
  // 1) Najít accession/dataset ID Legacy COT reportu (Futures Only) přes Socrata catalog.
  const catalogUrl = "https://api.us.socrata.com/api/catalog/v1?domains=publicreporting.cftc.gov&q=" + encodeURIComponent("Commitments of Traders") + "&limit=50";
  const cat = await fetch(catalogUrl, { signal: AbortSignal.timeout(30000) });
  console.log("catalog HTTP", cat.status);
  const catJson = await cat.json();
  const results = (catJson.results || []).map((r) => ({
    id: r.resource && r.resource.id,
    name: r.resource && r.resource.name,
  }));
  console.log("=== Nalezené datasety (name -> id) ===");
  for (const r of results) console.log(" ", r.name, "->", r.id);

  const legacy = results.find((r) => /legacy/i.test(r.name || "") && /futures only/i.test(r.name || ""));
  if (!legacy) { console.log("Legacy Futures-Only dataset nenalezen v katalogu, končím."); return; }
  console.log("\nPoužívám dataset:", legacy.name, legacy.id);

  const base = "https://publicreporting.cftc.gov/resource/" + legacy.id + ".json";
  for (const name of ["USD INDEX - ICE FUTURES U.S.", "U.S. DOLLAR INDEX - ICE FUTURES U.S."]) {
    const where = encodeURIComponent("market_and_exchange_names = '" + name + "'");
    const r = await fetch(base + "?$where=" + where + "&$order=report_date_as_yyyy_mm_dd DESC&$limit=2", { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(name, "-> HTTP", r.status); continue; }
    const rows = await r.json();
    console.log("\n=== " + name + " (Legacy) ===");
    if (!rows.length) { console.log("  0 řádků"); continue; }
    const row = rows[0];
    console.log("  report_date:", row.report_date_as_yyyy_mm_dd);
    // Vypsat VŠECHNA pole obsahující "comm" nebo "nonrept", ať vidíme přesné názvy sloupců.
    for (const [k, v] of Object.entries(row)) {
      if (/comm|nonrept|open_interest/i.test(k)) console.log("   ", k, "=", v);
    }
    const noncommL = parseFloat(row.noncomm_positions_long_all || row.noncomm_positions_long || 0);
    const noncommS = parseFloat(row.noncomm_positions_short_all || row.noncomm_positions_short || 0);
    const tot = noncommL + noncommS;
    if (tot > 0) {
      console.log("   -> Velcí spekulanti (Non-Commercial) Long %:", (noncommL / tot * 100).toFixed(2), "· long kontraktů:", noncommL);
    }
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
