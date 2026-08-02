// PRŮZKUM (dispatch-only): porovnat appku (TFF report) proti Honzově "Trading
// Analyzer" nástroji, který u USD ukazuje "Legacy" COT report (Komerční/Velcí
// spekulanti/Drobní obchodníci = Commercial/Non-Commercial/Non-Reportable).
// Uživatel zachytil z jeho appky tooltip: Velcí spekulanti (USD) Long 64.08 %,
// 35 339 kontraktů. Cíl: najít Legacy dataset pro USD Index a ověřit, jestli
// tohle číslo sedí na skutečná CFTC data (a tím i to, že náš TFF fix je
// konzistentní s jiným reportem stejného trhu, jen jinak kategorizovaným).
(async () => {
  // Socrata catalog API (s q= i bez) vrátil 0 výsledků pro tuhle doménu — zkusíme
  // rovnou pár známých/odhadovaných dataset ID CFTC Legacy COT (Futures Only) a
  // podle přítomnosti typických polí (noncomm_positions_long_all apod.) ověříme,
  // které je správné.
  const candidates = ["6dca-aqww", "jun7-fc8e", "72hh-3qpy"];
  let base = null, usedId = null;
  for (const id of candidates) {
    const testUrl = "https://publicreporting.cftc.gov/resource/" + id + ".json?$limit=1";
    const tr = await fetch(testUrl, { signal: AbortSignal.timeout(20000) });
    console.log("kandidát", id, "-> HTTP", tr.status);
    if (!tr.ok) continue;
    const trows = await tr.json();
    if (!Array.isArray(trows) || !trows.length) { console.log("  0 řádků"); continue; }
    const cols = Object.keys(trows[0]);
    const isLegacy = cols.some((c) => /^noncomm_positions_long/i.test(c)) && cols.some((c) => /^comm_positions_long/i.test(c));
    console.log("  sloupce (ukázka):", cols.slice(0, 12).join(", "));
    console.log("  vypadá jako Legacy report:", isLegacy);
    if (isLegacy) { base = "https://publicreporting.cftc.gov/resource/" + id + ".json"; usedId = id; break; }
  }
  if (!base) { console.log("\nŽádný kandidát nevypadá jako Legacy report, končím."); return; }
  console.log("\nPoužívám dataset:", usedId);
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
