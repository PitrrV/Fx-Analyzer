// PRŮZKUM (dispatch-only): existuje v CFTC TFF datasetu (gpe5-46if) přímý
// COT report pro USD Index (ICE Futures U.S., ticker DX)? Appka dnes USD
// počítá jen synteticky (opačný průměr ostatních 7 měn, viz scripts/fetch-cot.js
// scoreWeek) — cílem je zjistit přesný market_and_exchange_names + burzu, aby
// šlo přidat skutečné USD COT stejným způsobem jako ostatní měny.
(async () => {
  const base = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
  const where = encodeURIComponent("market_and_exchange_names like '%DOLLAR%' OR market_and_exchange_names like '%USD INDEX%'");
  const r = await fetch(base + "?$where=" + where + "&$order=report_date_as_yyyy_mm_dd DESC&$limit=2000", { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("CFTC API HTTP " + r.status);
  const rows = await r.json();
  console.log("řádků nalezeno:", rows.length);
  const names = [...new Set(rows.map((r) => r.market_and_exchange_names))];
  console.log("distinct market_and_exchange_names obsahující DOLLAR/USD INDEX:");
  names.forEach((n) => console.log("  ·", n));

  const latest = rows.filter((r) => names.includes(r.market_and_exchange_names)).sort((a, b) => (b.report_date_as_yyyy_mm_dd || "").localeCompare(a.report_date_as_yyyy_mm_dd || ""))[0];
  if (latest) {
    console.log("\nNejnovější řádek (report_date " + latest.report_date_as_yyyy_mm_dd + "):");
    console.log("  market_and_exchange_names:", latest.market_and_exchange_names);
    console.log("  contract_market_name:", latest.contract_market_name);
    console.log("  cftc_contract_market_code:", latest.cftc_contract_market_code);
    console.log("  asset_mgr_positions_long/short:", latest.asset_mgr_positions_long, "/", latest.asset_mgr_positions_short);
    console.log("  lev_money_positions_long/short:", latest.lev_money_positions_long, "/", latest.lev_money_positions_short);
  } else {
    console.log("\n⚠ Žádný řádek pro DOLLAR/USD INDEX nenalezen v posledních 2000 (celý dataset, bez cutoffu na datum).");
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
