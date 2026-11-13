// mt5-ingest: přijímá READ-ONLY data z MT5 konektoru (Python), idempotentně je ukládá a skládá pozice.
// Autentizace: hlavička x-mt5-token (náhodný 256bit token; v DB jen SHA-256 hash, token patří jednomu účtu).
// Funkce nemá žádnou cestu zpět k brokerovi — jen přijímá a ukládá data.
import { createClient } from "npm:@supabase/supabase-js@2";
import { derivePositions, diffSlTp, pickEntryState, summarizeState } from "./derive.mjs";

const J = { "Content-Type": "application/json" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: J });
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const chunk = <T,>(a: T[], k: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += k) o.push(a.slice(i, i + k)); return o; };
async function sha256hex(t: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const iso = (ms: number) => new Date(ms).toISOString();

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = req.headers.get("x-mt5-token") || "";
  if (!/^mt5_[0-9a-f]{64}$/.test(token)) return json({ error: "unauthorized" }, 401);
  const raw = await req.text();
  if (raw.length > 4_000_000) return json({ error: "payload too large" }, 413);
  let b: any; try { b = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  if (!b || typeof b !== "object") return json({ error: "bad payload" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: acc } = await db.from("mt5_accounts").select("id,sync_enabled,currency").eq("token_hash", await sha256hex(token)).maybeSingle();
  if (!acc) return json({ error: "unauthorized" }, 401);
  if (!acc.sync_enabled) return json({ error: "sync disabled for this account" }, 403);
  const A = acc.id as string;
  const fail = async (where: string, e: unknown) => {
    const msg = `error@${where}: ${String((e as any)?.message || e)}`.slice(0, 300);
    await db.from("mt5_accounts").update({ last_seen_at: new Date().toISOString(), last_ingest_status: msg }).eq("id", A);
    return json({ error: msg }, 500);
  };
  const must = (r: { error: any }, where: string) => { if (r.error) throw new Error(`${where}: ${r.error.message}`); };

  try {
    // 1) syrové deals (nemění se; duplicitní ticket = totéž)
    const deals = (Array.isArray(b.deals) ? b.deals : []).slice(0, 5000)
      .filter((d: any) => Number.isFinite(Number(d?.ticket)) && Number.isFinite(Number(d?.time_msc)))
      .map((d: any) => ({ account_id: A, deal_ticket: Number(d.ticket), position_id: n(d.position_id), order_ticket: n(d.order), time_msc: Number(d.time_msc),
        symbol: s(d.symbol), type: String(d.type || "").toUpperCase(), entry: s(d.entry)?.toUpperCase() ?? null, volume: n(d.volume) ?? 0, price: n(d.price),
        profit: n(d.profit) ?? 0, commission: n(d.commission) ?? 0, swap: n(d.swap) ?? 0, fee: n(d.fee) ?? 0, comment: s(d.comment)?.slice(0, 200) ?? null,
        reason: s(d.reason), magic: n(d.magic) }));
    for (const c of chunk(deals, 500)) must(await db.from("mt5_deals").upsert(c, { onConflict: "account_id,deal_ticket" }), "deals");

    // 2) objednávky (historie i pending) — z nich bereme SL/TP zadané při otevření
    const orders = (Array.isArray(b.orders) ? b.orders : []).slice(0, 5000).filter((o: any) => Number.isFinite(Number(o?.ticket)))
      .map((o: any) => ({ account_id: A, order_ticket: Number(o.ticket), position_id: n(o.position_id), symbol: s(o.symbol), type: s(o.type), state: s(o.state),
        is_pending: !!o.is_pending, time_setup_msc: n(o.time_setup_msc), time_done_msc: n(o.time_done_msc), volume_initial: n(o.volume_initial),
        volume_current: n(o.volume_current), price_open: n(o.price_open), sl: n(o.sl), tp: n(o.tp), updated_at: new Date().toISOString() }));
    for (const c of chunk(orders, 500)) must(await db.from("mt5_orders").upsert(c, { onConflict: "account_id,order_ticket" }), "orders");

    // 3) specifikace symbolů (pro přepočet rizika na peníze)
    const specsIn = b.specs && typeof b.specs === "object" ? Object.entries(b.specs).slice(0, 300) : [];
    if (specsIn.length) must(await db.from("mt5_symbol_specs").upsert(specsIn.map(([symbol, v]: [string, any]) => ({ account_id: A, symbol, tick_size: n(v?.tick_size),
      tick_value: n(v?.tick_value), contract_size: n(v?.contract_size), digits: n(v?.digits), captured_at: new Date().toISOString() })), { onConflict: "account_id,symbol" }), "specs");

    // 4) otevřené pozice (pozorování) — vidíme z nich SL/TP a floating
    const obsList = (Array.isArray(b.positions) ? b.positions : []).slice(0, 500).filter((p: any) => Number.isFinite(Number(p?.ticket)))
      .map((p: any) => ({ position_id: Number(p.ticket), symbol: s(p.symbol), side: String(p.type || "").toUpperCase(), volume: n(p.volume), price_open: n(p.price_open),
        sl: n(p.sl) ?? 0, tp: n(p.tp) ?? 0, profit: n(p.profit) ?? 0, swap: n(p.swap) ?? 0, time_msc: n(p.time_msc), time_update_msc: n(p.time_update_msc) }));
    const obs = new Map(obsList.map((p) => [p.position_id, p]));

    // 5) přepočet dotčených pozic ze VŠECH jejich dealů v DB
    const ids = [...new Set<number>([...deals.map((d) => d.position_id).filter((x) => x), ...obsList.map((p) => p.position_id)] as number[])];
    let allDeals: any[] = [], prevRows: any[] = [];
    for (const c of chunk(ids, 150)) {
      const d = await db.from("mt5_deals").select("*").eq("account_id", A).in("position_id", c); must(d, "load deals"); allDeals = allDeals.concat(d.data || []);
      const p = await db.from("mt5_positions").select("*").eq("account_id", A).in("position_id", c); must(p, "load positions"); prevRows = prevRows.concat(p.data || []);
    }
    const prevMap = new Map(prevRows.map((r) => [r.position_key, r]));
    const entryTickets = [...new Set(allDeals.filter((d) => d.entry === "IN" && d.order_ticket).map((d) => d.order_ticket))];
    const ordMap: Record<string, { sl: number | null; tp: number | null }> = {};
    for (const c of chunk(entryTickets, 150)) { const r = await db.from("mt5_orders").select("order_ticket,sl,tp").eq("account_id", A).in("order_ticket", c); must(r, "load orders");
      for (const o of r.data || []) ordMap[String(o.order_ticket)] = { sl: o.sl, tp: o.tp }; }
    const specR = await db.from("mt5_symbol_specs").select("symbol,tick_size,tick_value").eq("account_id", A); must(specR, "load specs");
    const specs: Record<string, any> = {}; for (const r of specR.data || []) specs[r.symbol] = r;
    const observed: Record<string, { firstSl: number | null; firstTp: number | null }> = {};
    for (const p of obsList) { const ex = prevMap.get(String(p.position_id)); observed[String(p.position_id)] = { firstSl: ex?.initial_sl ?? (p.sl > 0 ? p.sl : null), firstTp: ex?.initial_tp ?? (p.tp > 0 ? p.tp : null) }; }
    const dd = allDeals.map((d) => ({ ...d, deal_ticket: Number(d.deal_ticket), position_id: Number(d.position_id), time_msc: Number(d.time_msc), order_ticket: d.order_ticket == null ? null : Number(d.order_ticket) }));
    const { positions, events } = derivePositions(dd, { orders: ordMap, specs, observed });

    const now = new Date().toISOString();
    const rows: any[] = positions.map((p: any) => {
      const prev = prevMap.get(p.position_key); const o = p.status === "open" ? obs.get(p.position_id) : undefined;
      const flags: any = { ...(prev?.flags || {}), ...p.flags }; delete flags.from_observation;
      if (o) flags.floating = Math.round((o.profit + o.swap) * 100) / 100; else delete flags.floating;
      return { account_id: A, ...p, current_sl: o ? (o.sl > 0 ? o.sl : null) : prev?.current_sl ?? null, current_tp: o ? (o.tp > 0 ? o.tp : null) : prev?.current_tp ?? null, flags, updated_at: now };
    });
    for (const o of obsList) { // pozorovaná otevřená pozice bez dealů v DB (konektor je pošle při dalším průchodu) => zatím jen "stub"
      if (rows.some((r) => r.position_id === o.position_id && r.status === "open")) continue;
      const side = o.side === "SELL" || o.side === "BUY" ? o.side : null; if (!side) continue;
      rows.push({ account_id: A, position_key: String(o.position_id), position_id: o.position_id, symbol: o.symbol, side, status: "open", opened_at: o.time_msc ? iso(o.time_msc) : null,
        volume_in: o.volume, volume_out: 0, volume_open: o.volume, open_price: o.price_open, initial_sl: null, initial_sl_source: null, initial_tp: null,
        current_sl: o.sl > 0 ? o.sl : null, current_tp: o.tp > 0 ? o.tp : null, flags: { from_observation: true, floating: o.profit + o.swap }, updated_at: now });
    }
    for (const c of chunk(rows, 300)) must(await db.from("mt5_positions").upsert(c, { onConflict: "account_id,position_key" }), "positions");

    // 6) události (idempotentní klíče) + změny SL/TP pozorované při běžícím konektoru
    const evRows: any[] = events.map((e: any) => ({ account_id: A, ...e }));
    let slTpChanges = 0;
    for (const o of obsList) {
      const row = rows.find((r) => r.position_id === o.position_id && r.status === "open"); const key = row ? row.position_key : String(o.position_id);
      const prev = prevMap.get(key); const ch = diffSlTp(prev, o, Date.now());
      if (ch) { evRows.push({ account_id: A, event_key: ch.event_key, position_key: key, kind: ch.kind, event_time: ch.event_time, payload: ch.payload }); slTpChanges++; }
    }
    for (const c of chunk(evRows, 500)) must(await db.from("mt5_position_events").upsert(c, { onConflict: "account_id,event_key", ignoreDuplicates: true }), "events");

    // 7) equity vzorek + stav účtu
    const eq = b.equity && typeof b.equity === "object" ? b.equity : null; const ac = b.account && typeof b.account === "object" ? b.account : {};
    if (eq && n(eq.equity) !== null) {
      const ts = new Date(Math.floor((Date.parse(eq.ts) || Date.now()) / 1000) * 1000).toISOString();
      must(await db.from("mt5_equity_samples").upsert({ account_id: A, ts, balance: n(eq.balance), equity: n(eq.equity), margin: n(eq.margin), free_margin: n(eq.free_margin), floating: n(eq.profit) }, { onConflict: "account_id,ts" }), "equity");
    }
    const upd: any = { last_seen_at: now, last_ingest_status: "ok", balance: n(ac.balance) ?? n(eq?.balance), equity: n(ac.equity) ?? n(eq?.equity) };
    if (["hedging", "netting", "exchange"].includes(String(ac.margin_mode))) upd.margin_mode = ac.margin_mode;
    if (/^[A-Za-z]{3}$/.test(String(ac.currency || ""))) upd.currency = String(ac.currency).toUpperCase();
    if (ac.login != null) upd.login_hint = String(ac.login).slice(-3);
    must(await db.from("mt5_accounts").update(upd).eq("id", A), "account");

    // 8) snapshot Analyzeru při vstupu: jen data platná v okamžiku vstupu, jednou a navždy.
    // Počká, až existuje novější stav (pak jsou všechny dřívější jistě uložené); po 2 h dokončí i bez toho.
    const posR = await db.from("mt5_positions").select("position_key,opened_at,symbol,side").eq("account_id", A).not("opened_at", "is", null).order("opened_at", { ascending: false }).limit(2000); must(posR, "snap positions");
    const snapR = await db.from("mt5_entry_snapshots").select("position_key").eq("account_id", A).limit(5000); must(snapR, "snap existing");
    const have = new Set((snapR.data || []).map((x: any) => x.position_key));
    const posAll = new Map((posR.data || []).map((x: any) => [x.position_key, x]));
    const missing = (posR.data || []).filter((p: any) => !have.has(p.position_key)).slice(0, 100);
    let snapshots = 0, pending = 0;
    for (const p of missing) {
      const openedMs = Date.parse(p.opened_at);
      const later = await db.from("analyzer_state_history").select("id").gt("asof", p.opened_at).limit(1); must(later, "snap later");
      if (!(later.data || []).length && Date.now() - openedMs < 2 * 3600e3) { pending++; continue; }
      const bestR = await db.from("analyzer_state_history").select("id,asof,state,sources").lte("asof", p.opened_at).order("asof", { ascending: false }).limit(1); must(bestR, "snap best");
      const pick = pickEntryState(bestR.data || [], openedMs);
      const posInfo = (posAll.get(p.position_key) || {}) as any;
      const fullState = pick.state ? { ...pick.state.state, sources: pick.state.sources } : null;
      must(await db.from("mt5_entry_snapshots").upsert({ account_id: A, position_key: p.position_key, opened_at: p.opened_at, state_id: pick.state?.id ?? null, state_asof: pick.state?.asof ?? null,
        lag_seconds: pick.lag_seconds, available: pick.available, stale: pick.stale, data: fullState, summary: fullState ? summarizeState(fullState, posInfo.symbol, posInfo.side) : null },
        { onConflict: "account_id,position_key", ignoreDuplicates: true }), "snapshot");
      snapshots++;
    }
    return json({ ok: true, deals: deals.length, orders: orders.length, positions: rows.length, events: evRows.length, sl_tp_changes: slTpChanges, snapshots, snapshots_pending: pending });
  } catch (e) { return await fail("process", e); }
});
