// PRŮZKUM (dispatch-only), 2. iterace: dvě varianty názvu USD Indexu existují
// v CFTC datasetu ("USD INDEX - ICE FUTURES U.S." a "U.S. DOLLAR INDEX - ICE
// FUTURES U.S.") — zjistit, která je AKTUÁLNÍ (nejnovější report_date) a jaká
// má datová pole, aby šlo scripts/fetch-cot.js rozšířit správně.
(async () => {
  const base = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
  for (const name of ["USD INDEX - ICE FUTURES U.S.", "U.S. DOLLAR INDEX - ICE FUTURES U.S."]) {
    const where = encodeURIComponent("market_and_exchange_names = '" + name + "'");
    const r = await fetch(base + "?$where=" + where + "&$order=report_date_as_yyyy_mm_dd DESC&$limit=3", { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(name, "-> HTTP", r.status); continue; }
    const rows = await r.json();
    console.log("\n=== " + name + " ===");
    console.log("počet vrácených řádků (max 3, nejnovější):", rows.length);
    rows.forEach((row) => {
      console.log("  report_date:", row.report_date_as_yyyy_mm_dd, "· cftc_contract_market_code:", row.cftc_contract_market_code,
        "· asset_mgr L/S:", row.asset_mgr_positions_long, "/", row.asset_mgr_positions_short,
        "· lev_money L/S:", row.lev_money_positions_long, "/", row.lev_money_positions_short);
    });
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
