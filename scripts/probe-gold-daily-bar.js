// Jednorázová diagnostika (dispatch-only, nic necommituje): ověřuje, jak
// Yahoo GC=F časuje svůj "dnešní" denní bar — jestli timestamp odpovídá
// UTC půlnoci (jak předpokládá _dropUnclosedToday v engine.js), nebo jinému
// bodu (např. začátek futures seance, ~22:00-23:00 UTC) — což by vysvětlovalo,
// proč se u zlata objevil RP+ER signál, co vydržel jen 16 minut (dva po sobě
// jdoucí 15min crony), zatímco u FX párů po _dropUnclosedToday fixu (2026-10-07)
// se signál mění nejvýš 1x denně.
(async () => {
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=5d&interval=1d", {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts = res?.timestamp, closes = res?.indicators?.quote?.[0]?.close;
  const meta = res?.meta;
  console.log("now (UTC):", new Date().toISOString());
  console.log("meta.regularMarketTime:", meta?.regularMarketTime, "->", meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null);
  console.log("meta.regularMarketPrice:", meta?.regularMarketPrice);
  console.log("\nposledních 5 denních barů (timestamp -> ISO, close):");
  for (let i = Math.max(0, ts.length - 5); i < ts.length; i++) {
    console.log(ts[i], "->", new Date(ts[i] * 1000).toISOString(), "close:", closes[i]);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
