import assert from "node:assert";
import { derivePositions, diffSlTp, pickEntryState, summarizeState } from "../supabase/functions/mt5-ingest/derive.mjs";
const T0 = Date.parse("2026-11-10T10:00:00Z");
const D = (t, o) => ({ deal_ticket: t, position_id: 1, order_ticket: 500 + t, time_msc: T0 + t * 60000, symbol: "EURUSD", type: "BUY", entry: "IN", volume: 1, price: 1.1, profit: 0, commission: -7, swap: 0, fee: 0, ...o });
const near = (a, b, e = 1e-6) => assert(Math.abs(a - b) < e, `${a} != ${b}`);
const ctx = { orders: { 501: { sl: 1.095, tp: 1.11 } }, specs: { EURUSD: { tick_size: 0.00001, tick_value: 1 } } };

// 1) otevření + uzavření, R z původního SL
let r = derivePositions([D(1), D(2, { type: "SELL", entry: "OUT", price: 1.105, profit: 500, commission: 0 })], ctx);
assert.strictEqual(r.positions.length, 1); let p = r.positions[0];
assert.strictEqual(p.status, "closed"); near(p.net_pnl, 493); near(p.risk_money, 500, 0.01); near(p.r_multiple, 0.986, 1e-3);
assert.strictEqual(p.initial_sl_source, "order"); assert.strictEqual(p.hold_seconds, 60);
assert.deepStrictEqual(r.events.map((e) => e.kind), ["open", "close"]);

// 2) otevřená pozice: žádné R, žádný closed_at
r = derivePositions([D(1)], ctx); assert.strictEqual(r.positions[0].status, "open"); assert.strictEqual(r.positions[0].r_multiple, null);

// 3) částečné uzavření 2 lot -> 1 + 1
r = derivePositions([D(1, { volume: 2 }), D(2, { type: "SELL", entry: "OUT", volume: 1, price: 1.102, profit: 200, commission: -3 }), D(3, { type: "SELL", entry: "OUT", volume: 1, price: 1.104, profit: 400, commission: -3 })], ctx);
assert.deepStrictEqual(r.events.map((e) => e.kind), ["open", "partial", "close"]); p = r.positions[0];
near(p.volume_in, 2); near(p.volume_out, 2); near(p.close_price, 1.103); near(p.net_pnl, 600 - 13);

// 4) duplicity a jiné pořadí příchodu => stejný výsledek
const base = [D(1), D(2, { type: "SELL", entry: "OUT", price: 1.105, profit: 500 })];
const a = derivePositions(base, ctx), b = derivePositions([base[1], base[0], base[1], base[0]], ctx);
assert.deepStrictEqual(a, b);

// 5) netting: přidání + reverzace INOUT (1 + 1 long, pak SELL 3 => zavře 2, otevře short 1)
r = derivePositions([D(1), D(2, { price: 1.101 }), D(3, { type: "SELL", entry: "INOUT", volume: 3, price: 1.103, profit: 300, commission: -9 })], {});
assert.strictEqual(r.positions.length, 2); const [p1, p2] = r.positions;
assert.strictEqual(p1.status, "closed"); assert.strictEqual(p2.status, "open"); assert.strictEqual(p2.side, "SELL"); near(p2.volume_open, 1);
assert.strictEqual(p2.position_key, "1#2"); assert.ok(p1.flags.reversal && p2.flags.reversal);
near(p1.commission, -14 - 6); near(p2.commission, -3);                  // 2/3 a 1/3 komise INOUT dealu
near(p1.profit, 300);

// 6) hedging: dvě pozice na stejném symbolu se nesmíchají
r = derivePositions([D(1, { position_id: 1 }), D(2, { position_id: 2, type: "SELL", price: 1.1 }), D(3, { position_id: 1, type: "SELL", entry: "OUT", profit: 10 })], {});
assert.strictEqual(r.positions.length, 2); assert.strictEqual(r.positions.find((x) => x.position_id === 2).side, "SELL");
assert.strictEqual(r.positions.find((x) => x.position_id === 1).status, "closed");

// 7) vklady/výběry nejsou obchody; OUT bez IN v historii je označen
r = derivePositions([{ ...D(1), type: "BALANCE", position_id: 0, entry: "IN" }, D(2, { position_id: 9, entry: "OUT", type: "SELL", profit: 5 })], {});
assert.strictEqual(r.positions.length, 1); assert.ok(r.positions[0].flags.incomplete_history); assert.strictEqual(r.positions[0].opened_at, null);

// 8) bez SL => R se nedopočítá
r = derivePositions([D(1, { order_ticket: 9 }), D(2, { type: "SELL", entry: "OUT", price: 1.1, profit: 10 })], ctx);
assert.strictEqual(r.positions[0].r_multiple, null); assert.strictEqual(r.positions[0].initial_sl, null);

// 9) změny SL/TP: první pozorování není změna, další ano, stejné hodnoty nic
assert.strictEqual(diffSlTp(null, { position_id: 1, sl: 1.09, tp: 0 }, T0), null);
assert.strictEqual(diffSlTp({ current_sl: 1.09, current_tp: null }, { position_id: 1, sl: 1.09, tp: 0 }, T0), null);
const m = diffSlTp({ current_sl: 1.09, current_tp: null }, { position_id: 1, sl: 1.1, tp: 1.12, time_update_msc: T0 }, T0);
assert.strictEqual(m.kind, "modify_sl_tp"); assert.strictEqual(m.payload.sl_to, 1.1); near(m.payload.sl_from, 1.09);

// 10) snapshot: nikdy ne novější než vstup; bez dat -> available=false
const st = [{ asof: "2026-11-10T09:45:00Z", id: 1 }, { asof: "2026-11-10T10:15:00Z", id: 2 }, { asof: "2026-11-09T01:00:00Z", id: 0 }];
let s = pickEntryState(st, Date.parse("2026-11-10T10:00:00Z")); assert.strictEqual(s.state.id, 1); assert.strictEqual(s.lag_seconds, 900); assert.strictEqual(s.stale, false);
s = pickEntryState(st, Date.parse("2026-11-08T00:00:00Z")); assert.strictEqual(s.available, false); assert.strictEqual(s.state, null);
s = pickEntryState(st, Date.parse("2026-11-10T20:00:00Z")); assert.strictEqual(s.state.id, 2); assert.strictEqual(s.stale, true);
// 11) souhrn stavu: COT/retail/bias vůči směru; chybějící údaje = null + seznam `missing`
const state = { cur: { EUR: { score: 1.2, cot_pct: 70, comp: { cot: { raw: 1.5 }, season: { raw: 0.2 } } }, USD: { score: -0.5, cot_pct: 30, comp: { cot: { raw: -1 }, season: { raw: 0 } } } },
  cot: { EUR: { lev_net: -78559, asset_net: 144925 }, USD: null }, retail: { pairs: { EURUSD: { l: 30, s: 70 } } }, pairs: [{ pair: "EURUSD", dir: "BUY", diff: 1.7, conviction: 3 }],
  reversal: { EURUSD: { type: "SHORT" } }, seasonal_radar: null, sources: { cot: { report_week: "2026-11-03" } } };
let q = summarizeState(state, "EURUSD.pro", "BUY");
assert.strictEqual(q.pair, "EURUSD"); assert.strictEqual(q.with_bias, true); assert.strictEqual(q.cot_agrees, true); assert.strictEqual(q.retail_contra, true);
assert.strictEqual(q.cot_lev_net_quote, null); assert.strictEqual(q.reversal, "SHORT");
q = summarizeState(state, "EURUSD", "SELL"); assert.strictEqual(q.with_bias, false); assert.strictEqual(q.cot_agrees, false); assert.strictEqual(q.retail_contra, false);
q = summarizeState({ cur: {}, pairs: [] }, "GBPJPY", "BUY"); assert.strictEqual(q.cot_agrees, null); assert.strictEqual(q.retail_contra, null); assert.ok(q.missing.includes("score_base"));
q = summarizeState(null, "XAUUSD", "BUY"); assert.ok(q.missing.includes("state"));
console.log("derive: všechny testy OK");
