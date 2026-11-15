// Offline přehrání diagnostického reportu z konektoru (diagnose.py) přes stejnou logiku, jakou používá server (derive.mjs).
// Použití: node tests/replay_diag.mjs cesta/diag_report.json
// Kontroly: kolik pozic a jakého druhu, vlajky neúplné historie/reverzace, výsledek, a soulad součtu všech dealů se zůstatkem účtu.
import fs from "node:fs";
import { derivePositions } from "../supabase/functions/mt5-ingest/derive.mjs";
const rep = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const deals = rep.deals.map((d) => ({ ...d, deal_ticket: d.ticket, order_ticket: d.order }));   // stejné mapování jako edge funkce (order -> order_ticket)
const orders = {}; for (const o of rep.orders || []) orders[String(o.ticket)] = { sl: o.sl, tp: o.tp };
const specs = rep.specs || {};
const { positions, events } = derivePositions(deals, { orders, specs });
const closed = positions.filter((p) => p.status === "closed"), open = positions.filter((p) => p.status === "open");
const net = closed.reduce((s, p) => s + p.net_pnl, 0), wins = closed.filter((p) => p.net_pnl > 0).length;
const sumAll = rep.deals.reduce((s, d) => s + (+d.profit || 0) + (+d.commission || 0) + (+d.swap || 0) + (+d.fee || 0), 0);
const withR = closed.filter((p) => p.r_multiple != null).length;
console.log(`účet ${rep.account.login} · ${rep.account.margin_mode} · ${rep.account.currency} · okno od ${rep.window.from.slice(0, 10)}`);
console.log(`deals ${rep.deals.length} (typy ${JSON.stringify(rep.deal_types)}, entry ${JSON.stringify(rep.deal_entries)})`);
console.log(`pozice: zavřených ${closed.length}, otevřených ${open.length} (v MT5 otevřených ${rep.counts.open_positions}) · události ${events.length}`);
console.log(`zavřený výsledek po nákladech ${net.toFixed(2)} · ziskových ${wins}/${closed.length} · s vypočteným R ${withR}/${closed.length} (zbytek bez SL nebo bez specifikace symbolu)`);
console.log(`vlajky: neúplná historie ${positions.filter((p) => p.flags.incomplete_history).length}, reverzace ${positions.filter((p) => p.flags.reversal).length}`);
console.log(`soulad se zůstatkem: součet všech dealů ${sumAll.toFixed(2)} vs. zůstatek účtu ${rep.account.balance} (rozdíl ${(rep.account.balance - sumAll).toFixed(2)}; shodné jen když okno pokrývá celou historii účtu)`);
let problems = 0;
if (open.length !== rep.counts.open_positions) { console.log("PROBLÉM: počet otevřených pozic z dealů se liší od MT5"); problems++; }
for (const w of rep.warnings || []) console.log("UPOZORNĚNÍ z reportu:", w);
process.exit(problems ? 1 : 0);
