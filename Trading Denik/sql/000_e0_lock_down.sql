-- E0 (aplikováno do produkční Supabase 2026-11-13, migrace e0_lock_down_fundamental_tables_and_dispatch_fns)
-- Policy "service role full access" byla určená roli public s USING true => anon klíč mohl číst/psát/mazat.
-- service_role RLS obchází, policy stačí odstranit (RLS zůstává zapnuté).
drop policy if exists "service role full access" on public.fundamental_block_observations;
drop policy if exists "service role full access" on public.fundamental_expectations_history;
drop policy if exists "service role full access" on public.fundamental_shadow_snapshots;
-- Dispatch funkce volá jen pg_cron (postgres), ne klienti přes /rest/v1/rpc.
revoke execute on function public.trigger_fetch_calendar_dispatch() from public, anon, authenticated;
revoke execute on function public.trigger_fx_analyzer_data_refresh_dispatch() from public, anon, authenticated;
