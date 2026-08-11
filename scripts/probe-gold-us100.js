// PRŮZKUM (dispatch-only): ověřit reálné zdroje dat pro případné rozšíření
// appky o zlato (XAUUSD) a US100/Nasdaq-100.
//
// Na rozdíl od FX měn nemají zlato ani US100 vlastní "zemi" s centrální
// bankou/kalendářem (viz CURRENCY_COUNTRIES v engine.js) — fundamentální
// skóre appky (CB politika, ekonomický kalendář) na ně tak napřímo nejde
// napasovat. Co ale jde ověřit a případně použít:
//   1) COT pozicování — zlato je FYZICKÁ komodita, takže NENÍ v TFF reportu
//      (ten appka používá pro FX), ale v "Disaggregated Futures-Only"
//      reportu (jiné kategorie: Producer/Merchant, Swap Dealers, Managed
//      Money, Other Reportables). US100 (Nasdaq-100 E-mini) je NAOPAK
//      finanční future, takže by měl být přímo v appkou už používaném TFF
//      datasetu (gpe5-46if) vedle USD Indexu.
//   2) Cenová historie zdarma bez klíče — appka pro sezónnost/RP+ER používá
//      Stooq (stejný zdroj jako FX páry) — zkusíme, jaké tickery tam pro
//      zlato a Nasdaq-100 reálně existují.
(async () => {
  const TFF_DATASET = "gpe5-46if"; // appka už tohle používá pro FX (viz fetch-cot.js)
  const DISAGG_DATASET = "72hh-3qpy"; // Disaggregated Futures-Only — komodity vč. zlata

  async function socrata(dataset, params) {
    const url = "https://publicreporting.cftc.gov/resource/" + dataset + ".json?" + params;
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    console.log("  GET", url, "-> HTTP", r.status);
    if (!r.ok) return [];
    return r.json();
  }

  console.log("=== 1) US100 / Nasdaq-100 v TFF datasetu (" + TFF_DATASET + ") ===");
  const nasdaqRows = await socrata(
    TFF_DATASET,
    "$select=distinct market_and_exchange_names&$where=" +
      encodeURIComponent("upper(market_and_exchange_names) like '%NASDAQ%'") +
      "&$limit=20"
  );
  if (nasdaqRows.length) {
    console.log("  Nalezené trhy:");
    nasdaqRows.forEach((r) => console.log("   -", r.market_and_exchange_names));
  } else {
    console.log("  Nic nenalezeno pod 'NASDAQ' — zkusím 'E-MINI' a 'NAS100'.");
    const alt = await socrata(
      TFF_DATASET,
      "$select=distinct market_and_exchange_names&$where=" +
        encodeURIComponent("upper(market_and_exchange_names) like '%E-MINI%'") +
        "&$limit=30"
    );
    alt.forEach((r) => console.log("   -", r.market_and_exchange_names));
  }

  console.log("\n=== 2) Detail nejnovějšího řádku pro Nasdaq-100 (pokud nalezen) ===");
  if (nasdaqRows.length) {
    const name = nasdaqRows[0].market_and_exchange_names;
    const where = encodeURIComponent("market_and_exchange_names = '" + name + "'");
    const rows = await socrata(TFF_DATASET, "$where=" + where + "&$order=report_date_as_yyyy_mm_dd DESC&$limit=1");
    if (rows.length) {
      const row = rows[0];
      console.log("  report_date:", row.report_date_as_yyyy_mm_dd);
      console.log("  sloupce (ukázka):", Object.keys(row).slice(0, 15).join(", "));
      console.log(
        "  Asset Mgr long/short:",
        row.asset_mgr_positions_long, "/", row.asset_mgr_positions_short,
        "· Lev Funds long/short:", row.lev_money_positions_long, "/", row.lev_money_positions_short
      );
    }
  }

  console.log("\n=== 3) Zlato v Disaggregated datasetu (" + DISAGG_DATASET + ") ===");
  const goldRows = await socrata(
    DISAGG_DATASET,
    "$select=distinct market_and_exchange_names&$where=" +
      encodeURIComponent("upper(market_and_exchange_names) like '%GOLD%'") +
      "&$limit=20"
  );
  goldRows.forEach((r) => console.log("   -", r.market_and_exchange_names));

  console.log("\n=== 4) Detail nejnovějšího řádku pro Gold (pokud nalezen) ===");
  const comex = goldRows.find((r) => /COMMODITY EXCHANGE|COMEX/i.test(r.market_and_exchange_names)) || goldRows[0];
  if (comex) {
    const where = encodeURIComponent("market_and_exchange_names = '" + comex.market_and_exchange_names + "'");
    const rows = await socrata(DISAGG_DATASET, "$where=" + where + "&$order=report_date_as_yyyy_mm_dd DESC&$limit=1");
    if (rows.length) {
      const row = rows[0];
      console.log("  trh:", comex.market_and_exchange_names);
      console.log("  report_date:", row.report_date_as_yyyy_mm_dd);
      for (const [k, v] of Object.entries(row)) {
        if (/m_money|swap|prod_merc|open_interest/i.test(k)) console.log("   ", k, "=", v);
      }
    }
  } else {
    console.log("  Nic nenalezeno pod 'GOLD'.");
  }

  console.log("\n=== 5) Stooq cenová historie (zdarma, appka to už používá pro FX/ropu) ===");
  const tickers = ["xauusd", "xauusd.f", "ndx", "^ndx", "us100", "nq.f"];
  for (const t of tickers) {
    try {
      const r = await fetch("https://stooq.com/q/d/l/?s=" + encodeURIComponent(t) + "&i=d", {
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      const lines = txt.trim().split("\n");
      const looksValid = lines.length > 5 && /^Date,Open,High,Low,Close/i.test(lines[0]);
      console.log(
        "  ticker '" + t + "' -> HTTP", r.status,
        "· řádků:", lines.length,
        "· vypadá jako platná CSV:", looksValid,
        looksValid ? ("· poslední řádek: " + lines[lines.length - 1]) : ("· ukázka: " + txt.slice(0, 80).replace(/\n/g, " "))
      );
    } catch (e) {
      console.log("  ticker '" + t + "' -> chyba:", e.message);
    }
  }
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
