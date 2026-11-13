// Čistá logika: z dealů MT5 poskládá pozice a události. Žádný I/O => testovatelné v Node i v Deno.
// Idempotence: výstup závisí jen na množině dealů (duplicitní ticket se zahodí, pořadí příchodu je jedno).
const EPS = 1e-9;
const remaining = (c) => c.volIn - c.volOut;
const REAL_TYPES = new Set(["BUY", "SELL"]);
const iso = (ms) => new Date(Number(ms)).toISOString();
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round = (v, d = 8) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function derivePositions(rawDeals, ctx = {}) {
  const orders = ctx.orders || {};      // order_ticket -> {sl,tp}
  const specs = ctx.specs || {};        // symbol -> {tick_size,tick_value}
  const obs = ctx.observed || {};       // position_id -> {firstSl,firstTp}
  const seen = new Set();
  const deals = rawDeals
    .filter((d) => REAL_TYPES.has(d.type) && d.position_id != null && d.position_id !== 0)
    .filter((d) => (seen.has(String(d.deal_ticket)) ? false : (seen.add(String(d.deal_ticket)), true)))
    .sort((a, b) => a.time_msc - b.time_msc || Number(a.deal_ticket) - Number(b.deal_ticket));
  const byPos = new Map();
  for (const d of deals) { const k = String(d.position_id); if (!byPos.has(k)) byPos.set(k, []); byPos.get(k).push(d); }
  const positions = [], events = [];

  for (const [pid, list] of byPos) {
    let n = 0, cur = null;
    const start = (d, vol, price, flags = {}) => {
      n += 1;
      cur = { key: n === 1 ? pid : `${pid}#${n}`, position_id: Number(pid), symbol: d.symbol, side: d.type, volIn: 0, volOut: 0,
        openVW: 0, closeVW: 0, profit: 0, commission: 0, swap: 0, fee: 0, openedAt: d.time_msc, closedAt: null,
        entryOrder: d.order_ticket ?? null, firstVol: vol, flags: { ...flags } };
      positions.push(cur);
      return cur;
    };
    const addIn = (c, d, vol, price, frac = 1) => {
      c.volIn += vol; c.openVW += price * vol;
      c.commission += (num(d.commission) || 0) * frac; c.fee += (num(d.fee) || 0) * frac; c.swap += (num(d.swap) || 0) * frac;
    };
    const addOut = (c, d, vol, price, frac = 1) => {
      c.volOut += vol; c.closeVW += price * vol;
      c.profit += (num(d.profit) || 0); c.commission += (num(d.commission) || 0) * frac;
      c.fee += (num(d.fee) || 0) * frac; c.swap += (num(d.swap) || 0) * frac;
    };
    const ev = (c, d, kind, payload) => events.push({ event_key: `deal:${d.deal_ticket}:${kind}`, position_key: c.key, kind, event_time: iso(d.time_msc), payload });

    for (const d of list) {
      const vol = num(d.volume) || 0, price = num(d.price) || 0;
      if (d.entry === "IN") {
        if (!cur || cur.closedAt != null) { start(d, vol, price); addIn(cur, d, vol, price); ev(cur, d, "open", { side: d.type, volume: vol, price }); }
        else { addIn(cur, d, vol, price); ev(cur, d, "add", { volume: vol, price }); }
      } else if (d.entry === "OUT" || d.entry === "OUT_BY") {
        if (!cur) { start(d, vol, price, { incomplete_history: true }); cur.openedAt = null; cur.volIn = vol; cur.side = d.type === "BUY" ? "SELL" : "BUY"; }
        addOut(cur, d, vol, price);
        if (remaining(cur) <= EPS) { cur.closedAt = d.time_msc; ev(cur, d, "close", { volume: vol, price, profit: num(d.profit) }); }
        else ev(cur, d, "partial", { volume: vol, price, profit: num(d.profit), remaining: round(remaining(cur)) });
      } else if (d.entry === "INOUT") {
        if (cur && cur.closedAt == null && remaining(cur) > EPS) {
          const closeVol = remaining(cur), frac = vol > 0 ? closeVol / vol : 1;
          cur.flags.reversal = true;
          addOut(cur, d, closeVol, price, frac); cur.closedAt = d.time_msc;
          ev(cur, d, "close", { volume: closeVol, price, profit: num(d.profit), reversal: true });
          const newVol = vol - closeVol;
          if (newVol > EPS) { start(d, newVol, price, { reversal: true }); addIn(cur, d, newVol, price, 1 - frac); ev(cur, d, "open", { side: d.type, volume: newVol, price, reversal: true }); }
        } else { start(d, vol, price, { incomplete_history: true, reversal: true }); addIn(cur, d, vol, price); ev(cur, d, "open", { side: d.type, volume: vol, price }); }
      }
    }
  }

  const out = positions.map((c) => {
    const open = c.closedAt == null;
    const openPrice = c.volIn > EPS ? c.openVW / c.volIn : null;
    const closePrice = c.volOut > EPS ? c.closeVW / c.volOut : null;
    const ord = c.entryOrder != null ? orders[String(c.entryOrder)] : null;
    const o = obs[String(c.position_id)] || {};
    let sl = null, slSrc = null, tp = null;
    if (ord && num(ord.sl) > 0) { sl = num(ord.sl); slSrc = "order"; }
    else if (num(o.firstSl) > 0) { sl = num(o.firstSl); slSrc = "first_observed"; }
    if (ord && num(ord.tp) > 0) tp = num(ord.tp); else if (num(o.firstTp) > 0) tp = num(o.firstTp);
    const spec = specs[c.symbol];
    let risk = null;
    if (sl && openPrice != null && spec && num(spec.tick_size) > 0 && num(spec.tick_value) > 0) {
      risk = (Math.abs(openPrice - sl) / spec.tick_size) * spec.tick_value * c.firstVol;
    }
    const net = c.profit + c.commission + c.swap + c.fee;
    const flags = { ...c.flags, risk_basis: risk != null ? "first_entry_volume" : null };
    return {
      position_key: c.key, position_id: c.position_id, symbol: c.symbol, side: c.side, status: open ? "open" : "closed",
      opened_at: c.openedAt != null ? iso(c.openedAt) : null, closed_at: open ? null : iso(c.closedAt),
      volume_in: round(c.volIn), volume_out: round(c.volOut), volume_open: round(Math.max(0, remaining(c))),
      open_price: round(openPrice), close_price: round(closePrice),
      initial_sl: sl, initial_sl_source: slSrc, initial_tp: tp,
      profit: round(c.profit, 2), commission: round(c.commission, 2), swap: round(c.swap, 2), fee: round(c.fee, 2), net_pnl: round(net, 2),
      risk_money: risk != null ? round(risk, 2) : null,
      r_multiple: !open && risk > 0 ? round(net / risk, 4) : null,
      hold_seconds: !open && c.openedAt != null ? Math.round((c.closedAt - c.openedAt) / 1000) : null,
      entry_order_ticket: c.entryOrder, flags,
    };
  });
  return { positions: out, events };
}

// Změna SL/TP otevřené pozice: MT5 ji v historii neuchovává, vidíme ji jen při pozorování (polling).
export function diffSlTp(prev, observed, timeMs) {
  const p = { sl: num(prev?.current_sl) || 0, tp: num(prev?.current_tp) || 0 };
  const o = { sl: num(observed.sl) || 0, tp: num(observed.tp) || 0 };
  if (Math.abs(p.sl - o.sl) < 1e-12 && Math.abs(p.tp - o.tp) < 1e-12) return null;
  const first = prev == null || (prev.current_sl == null && prev.current_tp == null);
  if (first) return null; // první pozorování není změna
  return { kind: "modify_sl_tp", event_key: `mod:${observed.position_id}:${observed.time_update_msc || timeMs}:${o.sl}:${o.tp}`,
    event_time: iso(observed.time_update_msc || timeMs), payload: { sl_from: p.sl || null, sl_to: o.sl || null, tp_from: p.tp || null, tp_to: o.tp || null } };
}

// Stav Analyzeru platný v okamžiku vstupu: nejnovější záznam s asof <= čas vstupu. Nikdy novější.
export function pickEntryState(states, openedAtMs, maxLagMs = 6 * 3600e3) {
  let best = null;
  for (const s of states) { const t = Date.parse(s.asof); if (t <= openedAtMs && (!best || t > Date.parse(best.asof))) best = s; }
  if (!best) return { available: false, stale: false, state: null, lag_seconds: null };
  const lag = openedAtMs - Date.parse(best.asof);
  return { available: true, stale: lag > maxLagMs, state: best, lag_seconds: Math.round(lag / 1000) };
}

// Kompaktní souhrn stavu Analyzeru pro konkrétní pár a směr obchodu (pro statistiky a AI Coach).
// Čte VÝHRADNĚ zadaný stav (platný při vstupu). Co ve stavu není, zůstává null a je vyjmenováno v `missing`.
export function summarizeState(state, symbol, side) {
  const m = String(symbol || "").toUpperCase().match(/^[A-Z]{6}/);
  const pair = m ? m[0] : null;
  const out = { pair, base: null, quote: null, missing: [] };
  if (!state || !pair) { out.missing.push("state"); return out; }
  const base = pair.slice(0, 3), quote = pair.slice(3, 6); out.base = base; out.quote = quote;
  const sg = (v) => (v == null ? null : Number(v));
  const cb = state.cur?.[base], cq = state.cur?.[quote];
  const pr = (state.pairs || []).find((p) => p.pair === pair);
  out.pair_dir = pr?.dir ?? null; out.pair_diff = sg(pr?.diff); out.pair_conviction = pr?.conviction ?? null;
  out.score_base = sg(cb?.score); out.score_quote = sg(cq?.score);
  out.cot_score_base = sg(cb?.comp?.cot?.raw); out.cot_score_quote = sg(cq?.comp?.cot?.raw);
  out.cot_pct_base = sg(cb?.cot_pct); out.cot_pct_quote = sg(cq?.cot_pct);
  out.cot_lev_net_base = sg(state.cot?.[base]?.lev_net); out.cot_lev_net_quote = sg(state.cot?.[quote]?.lev_net);
  out.cot_am_net_base = sg(state.cot?.[base]?.asset_net); out.cot_am_net_quote = sg(state.cot?.[quote]?.asset_net);
  out.retail_long_pct = sg(state.retail?.pairs?.[pair]?.l);
  out.season_base = sg(cb?.comp?.season?.raw); out.season_quote = sg(cq?.comp?.season?.raw);
  out.reversal = state.reversal?.[pair]?.type ?? null;
  out.seasonal_radar = state.seasonal_radar?.[pair]?.dir ?? null;
  out.sources = state.sources ?? null;
  const buy = side === "BUY";
  out.with_bias = out.pair_dir == null ? null : (out.pair_dir === "BUY") === buy;
  const cd = out.cot_score_base != null && out.cot_score_quote != null ? out.cot_score_base - out.cot_score_quote : null;
  out.cot_agrees = cd == null || cd === 0 ? null : (cd > 0) === buy;
  out.retail_contra = out.retail_long_pct == null ? null : buy ? out.retail_long_pct <= 40 : out.retail_long_pct >= 60;
  for (const k of ["pair_dir", "score_base", "score_quote", "cot_score_base", "cot_score_quote", "retail_long_pct", "season_base", "season_quote"]) if (out[k] == null) out.missing.push(k);
  return out;
}
