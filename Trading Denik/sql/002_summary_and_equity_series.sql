alter table public.mt5_entry_snapshots add column if not exists summary jsonb;
-- Equity/balance řada po časových blocích (poslední vzorek v bloku). SECURITY INVOKER => platí RLS, uživatel vidí jen své účty.
create or replace function public.mt5_equity_series(p_account uuid, p_since timestamptz, p_bucket_minutes int)
returns table(ts timestamptz, balance numeric, equity numeric)
language sql stable security invoker set search_path = public as $$
  select distinct on (b) b as ts, s.balance, s.equity from (
    select to_timestamp(floor(extract(epoch from s0.ts) / (greatest(p_bucket_minutes,1) * 60)) * (greatest(p_bucket_minutes,1) * 60)) as b, s0.ts, s0.balance, s0.equity
    from public.mt5_equity_samples s0 where s0.account_id = p_account and s0.ts >= p_since) s
  order by b, s.ts desc;
$$;
revoke execute on function public.mt5_equity_series(uuid, timestamptz, int) from public, anon;
grant execute on function public.mt5_equity_series(uuid, timestamptz, int) to authenticated;
