// Jednorázový diagnostický skript — ověřuje dostupnost a obsah kandidátních RSS zdrojů
// pro analytické výhledy (FX páry i indexy), naživo z GitHub Actions runneru (tenhle
// sandbox nemá výstup na internet). Nic nezapisuje do data/, jen loguje výsledky.
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; AIMarketRadar/1.0)' };

function xmlTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
}
function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  return blocks.map(b => ({
    title: xmlTag(b, 'title'),
    pub: xmlTag(b, isAtom ? 'updated' : 'pubDate') || xmlTag(b, 'published') || ''
  })).filter(x => x.title);
}

const CANDIDATES = [
  { name: 'ActionForex', url: 'https://www.actionforex.com/feed/' },
  { name: 'MarketPulse (OANDA)', url: 'https://www.marketpulse.com/feed/' },
  { name: 'FXEmpire', url: 'https://www.fxempire.com/feed' },
  { name: 'ForexCrunch', url: 'https://www.forexcrunch.com/feed/' },
  { name: 'DailyFX (all) — už v DEFAULT_RSS', url: 'https://www.dailyfx.com/feeds/all' },
  { name: 'Investing.com technical analysis (baseline)', url: 'https://www.investing.com/rss/technical_analysis.rss' },
  { name: 'Investing.com stock market news (indexy, baseline)', url: 'https://www.investing.com/rss/stock_market_news.rss' },
  { name: 'Seeking Alpha market outlook', url: 'https://seekingalpha.com/market_currents.xml' },
  { name: 'FXStreet news (baseline, už v DEFAULT_RSS)', url: 'https://www.fxstreet.com/rss/news' }
];

(async () => {
  for (const c of CANDIDATES) {
    const t0 = Date.now();
    try {
      const r = await fetch(c.url, { headers: UA, signal: AbortSignal.timeout(15000) });
      const ms = Date.now() - t0;
      if (!r.ok) {
        console.log(`[FAIL] ${c.name} — HTTP ${r.status} (${ms}ms) — ${c.url}`);
        continue;
      }
      const xml = await r.text();
      const items = parseFeed(xml);
      if (!items.length) {
        console.log(`[EMPTY] ${c.name} — HTTP 200 ale 0 parsovatelných <item> (${ms}ms, ${xml.length}B) — ${c.url}`);
        continue;
      }
      const newest = items[0];
      const newestAge = newest.pub ? Math.round((Date.now() - new Date(newest.pub).getTime()) / 3600000) : null;
      console.log(`[OK] ${c.name} — ${items.length} položek (${ms}ms) — nejnovější: "${newest.title.slice(0,90)}" (${newestAge !== null ? newestAge + 'h stará' : 'bez data'})`);
      items.slice(0, 3).forEach((it, i) => console.log(`      ${i+1}. ${it.title.slice(0,100)}`));
    } catch (e) {
      console.log(`[ERROR] ${c.name} — ${e.message} — ${c.url}`);
    }
  }
})();
