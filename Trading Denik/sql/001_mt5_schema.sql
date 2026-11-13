-- MT5 Trading deník — schéma. Všechny tabulky mají RLS; čtení jen vlastník účtu,
-- zápis výhradně přes edge funkci mt5-ingest (service_role) a RPC níže.
create table if not exists public.mt5_accounts(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  broker text, server text,
  currency text not null default 'USD',
  margin_mode text check (margin_mode in ('hedging','netting','exchange')),
  login_hint text,                         -- jen poslední 3 číslice, celé číslo účtu se neukládá
  sync_enabled boolean not null default true,
  token_hash text not null unique,         -- SHA-256 tokenu konektoru; token samotný se neukládá
  balance numeric, equity numeric,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz, last_ingest_status text);
create index if not exists mt5_accounts_user on public.mt5_accounts(user_id);

create table if not exists public.mt5_deals(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  deal_ticket bigint not null, position_id bigint, order_ticket bigint,
  time_msc bigint not null, symbol text, type text not null, entry text,
  volume numeric not null default 0, price numeric,
  profit numeric not null default 0, commission numeric not null default 0,
  swap numeric not null default 0, fee numeric not null default 0,
  comment text, reason text, magic bigint,
  received_at timestamptz not null default now(),
  primary key(account_id, deal_ticket));
create index if not exists mt5_deals_pos on public.mt5_deals(account_id, position_id);

create table if not exists public.mt5_orders(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  order_ticket bigint not null, position_id bigint, symbol text, type text, state text,
  is_pending boolean not null default false,
  time_setup_msc bigint, time_done_msc bigint,
  volume_initial numeric, volume_current numeric, price_open numeric, sl numeric, tp numeric,
  updated_at timestamptz not null default now(),
  primary key(account_id, order_ticket));

create table if not exists public.mt5_positions(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  position_key text not null,              -- position_id, nebo position_id#2 po reverzi na netting účtu
  position_id bigint not null, symbol text, side text check (side in ('BUY','SELL')),
  status text not null check (status in ('open','closed')),
  opened_at timestamptz, closed_at timestamptz,
  volume_in numeric, volume_out numeric, volume_open numeric,
  open_price numeric, close_price numeric,
  initial_sl numeric, initial_sl_source text, initial_tp numeric, current_sl numeric, current_tp numeric,
  profit numeric, commission numeric, swap numeric, fee numeric, net_pnl numeric,
  risk_money numeric, r_multiple numeric, hold_seconds bigint,
  entry_order_ticket bigint, flags jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(account_id, position_key));
create index if not exists mt5_positions_open on public.mt5_positions(account_id, status, opened_at desc);

create table if not exists public.mt5_position_events(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  event_key text not null, position_key text not null,
  kind text not null check (kind in ('open','add','partial','close','modify_sl_tp')),
  event_time timestamptz not null, payload jsonb not null default '{}'::jsonb,
  primary key(account_id, event_key));
create index if not exists mt5_events_pos on public.mt5_position_events(account_id, position_key, event_time);

create table if not exists public.mt5_equity_samples(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  ts timestamptz not null, balance numeric, equity numeric, margin numeric, free_margin numeric, floating numeric,
  primary key(account_id, ts));

create table if not exists public.mt5_symbol_specs(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  symbol text not null, tick_size numeric, tick_value numeric, contract_size numeric, digits int,
  captured_at timestamptz not null default now(),
  primary key(account_id, symbol));

-- Historie stavu Analyzeru (point-in-time). Plní ji edge funkce analyzer-state-capture každých 15 min.
create table if not exists public.analyzer_state_history(
  id bigserial primary key,
  asof timestamptz not null unique,
  state jsonb not null, sources jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());

-- Snapshot Analyzeru při otevření pozice. Vkládá se jen jednou a nikdy se nepřepisuje.
create table if not exists public.mt5_entry_snapshots(
  account_id uuid not null references public.mt5_accounts(id) on delete cascade,
  position_key text not null,
  opened_at timestamptz not null,
  state_id bigint references public.analyzer_state_history(id),
  state_asof timestamptz, lag_seconds int,
  available boolean not null, stale boolean not null default false,
  data jsonb,                               -- NULL když stav k okamžiku vstupu neexistoval
  created_at timestamptz not null default now(),
  primary key(account_id, position_key));

-- RLS
alter table public.mt5_accounts enable row level security;
alter table public.mt5_deals enable row level security;
alter table public.mt5_orders enable row level security;
alter table public.mt5_positions enable row level security;
alter table public.mt5_position_events enable row level security;
alter table public.mt5_equity_samples enable row level security;
alter table public.mt5_symbol_specs enable row level security;
alter table public.mt5_entry_snapshots enable row level security;
alter table public.analyzer_state_history enable row level security;

create policy own_select on public.mt5_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy own_update on public.mt5_accounts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
do $$ declare t text; begin
  foreach t in array array['mt5_deals','mt5_orders','mt5_positions','mt5_position_events','mt5_equity_samples','mt5_symbol_specs','mt5_entry_snapshots'] loop
    execute format('create policy own_select on public.%I for select to authenticated using (exists (select 1 from public.mt5_accounts a where a.id = account_id and a.user_id = (select auth.uid())))', t);
  end loop; end $$;
create policy auth_read on public.analyzer_state_history for select to authenticated using (true);

-- Oprávnění: klient smí jen číst (a u účtu měnit label/broker/server/sync_enabled). Token_hash se klientovi nevrací.
revoke all on public.mt5_accounts, public.mt5_deals, public.mt5_orders, public.mt5_positions, public.mt5_position_events,
  public.mt5_equity_samples, public.mt5_symbol_specs, public.mt5_entry_snapshots, public.analyzer_state_history from anon, authenticated;
grant select(id,user_id,label,broker,server,currency,margin_mode,login_hint,sync_enabled,balance,equity,created_at,last_seen_at,last_ingest_status) on public.mt5_accounts to authenticated;
grant update(label,broker,server,sync_enabled) on public.mt5_accounts to authenticated;
grant select on public.mt5_deals, public.mt5_orders, public.mt5_positions, public.mt5_position_events,
  public.mt5_equity_samples, public.mt5_symbol_specs, public.mt5_entry_snapshots, public.analyzer_state_history to authenticated;
revoke all on sequence public.analyzer_state_history_id_seq from anon, authenticated;

-- Vytvoření účtu: vrátí token konektoru JEDNOU (v DB zůstane jen hash).
create or replace function public.mt5_create_account(p_label text, p_broker text default null, p_server text default null, p_currency text default 'USD')
returns table(account_id uuid, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); tok text; aid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if (select count(*) from mt5_accounts where user_id = uid) >= 10 then raise exception 'limit 10 accounts'; end if;
  tok := 'mt5_' || encode(gen_random_bytes(32), 'hex');
  insert into mt5_accounts(user_id,label,broker,server,currency,token_hash)
  values (uid, p_label, p_broker, p_server, upper(coalesce(nullif(p_currency,''),'USD')), encode(digest(tok,'sha256'),'hex'))
  returning id into aid;
  return query select aid, tok;
end $$;
create or replace function public.mt5_rotate_token(p_account uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  tok := 'mt5_' || encode(gen_random_bytes(32), 'hex');
  update mt5_accounts set token_hash = encode(digest(tok,'sha256'),'hex') where id = p_account and user_id = auth.uid();
  if not found then raise exception 'account not found'; end if;
  return tok;
end $$;
revoke execute on function public.mt5_create_account(text,text,text,text), public.mt5_rotate_token(uuid) from public, anon;
grant execute on function public.mt5_create_account(text,text,text,text), public.mt5_rotate_token(uuid) to authenticated;
