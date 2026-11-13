// analyzer-state-capture: každých ~5 min uloží NOVÝ stav Analyzeru (data/analyzer_state.json z GitHubu)
// do analyzer_state_history. Díky tomu existuje historie "co Analyzer ukazoval v čase T" pro snapshot obchodů.
// Veřejná data, žádný vstup od volajícího; duplicity zahazuje UNIQUE(asof).
import { createClient } from "npm:@supabase/supabase-js@2";
const SRC = "https://raw.githubusercontent.com/PitrrV/Fx-Analyzer/main/data/analyzer_state.json";
Deno.serve(async () => {
  try {
    const r = await fetch(SRC + "?t=" + Math.floor(Date.now() / 60000), { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return new Response(JSON.stringify({ ok: false, error: "fetch " + r.status }), { status: 502 });
    const txt = await r.text(); if (txt.length > 300_000) return new Response(JSON.stringify({ ok: false, error: "too large" }), { status: 502 });
    const st = JSON.parse(txt);
    if (!st || typeof st.asof !== "string" || !Number.isFinite(Date.parse(st.asof)) || !st.cur || typeof st.cur !== "object")
      return new Response(JSON.stringify({ ok: false, error: "bad shape" }), { status: 502 });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { sources, ...state } = st;
    const { error } = await db.from("analyzer_state_history").upsert({ asof: st.asof, state, sources: sources || {} }, { onConflict: "asof", ignoreDuplicates: true });
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, asof: st.asof }), { headers: { "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 500 }); }
});
