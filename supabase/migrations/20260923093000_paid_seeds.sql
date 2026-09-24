-- One-time paid Seeds. A Seed is an irreversible one-cent wallet Support
-- plus a permanent per-user/per-ad marker created in the same transaction.
begin;

-- Production's legacy likes table contains free, reversible actions with no
-- wallet proof. Do not relabel or retrocharge them. If any non-owner Like now
-- exists, stop for an explicit product/data review instead of silently
-- dropping legitimate history from the paid Seed rankings. The known legacy
-- self-like remains archived in place and is intentionally not counted.
do $$
declare
  policy_row record;
begin
  if to_regclass('public.likes') is not null then
    -- Close the race where a final free Like could be inserted between the
    -- validation below and the privilege/policy retirement.
    execute 'lock table public.likes in access exclusive mode';

    if exists (
      select 1
      from public.likes l
      left join public.ads a on a.id = l.ad_id
      where l.user_id is null
        or l.ad_id is null
        or a.id is null
        or l.user_id is distinct from a.user_id
    ) then
      raise exception 'LEGACY_LIKES_REQUIRE_REVIEW';
    end if;

    for policy_row in
      select p.policyname
      from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'likes'
        and p.cmd <> 'SELECT'
    loop
      execute format(
        'drop policy %I on public.likes',
        policy_row.policyname
      );
    end loop;

    -- Keep SELECT temporarily so a cached pre-deployment frontend can still
    -- render while backend-first rollout completes. No client or service key
    -- can create, edit, or remove a legacy Like after this migration commits.
    revoke insert, update, delete, truncate, references, trigger
      on public.likes from public, anon, authenticated, service_role;

    if to_regclass('public.likes_id_seq') is not null then
      revoke update, usage on sequence public.likes_id_seq
        from public, anon, authenticated, service_role;
    end if;

    comment on table public.likes is
      'Archived free Likes. Paid, irreversible Seeds are stored in public.ad_seeds.';
  end if;
end;
$$;

create table public.ad_seeds (
  user_id uuid not null references auth.users(id) on delete cascade,
  ad_id bigint not null references public.ads(id) on delete cascade,
  support_id bigint not null unique references public.supports(id),
  wallet_request_id uuid not null unique,
  created_at timestamptz not null default now(),
  primary key (user_id, ad_id)
);

create index ad_seeds_ad_id_idx on public.ad_seeds(ad_id);

alter table public.ad_seeds enable row level security;
revoke all on public.ad_seeds
  from public, anon, authenticated, service_role;

create or replace function public.seed_ad_from_wallet(
  p_user_id uuid,
  p_ad_id bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wallet_balance bigint;
  ad_owner uuid;
  existing_seed public.ad_seeds%rowtype;
  existing_request public.wallet_transactions%rowtype;
  seed_exists boolean;
  request_exists boolean;
  support_result jsonb;
  created_support_id bigint;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'INVALID_SEED_REQUEST';
  end if;

  -- Match spend_wallet_support's lock order. This serializes two Seed clicks
  -- by the same user before either can pass the permanent-marker check.
  select w.available_cents
  into wallet_balance
  from public.wallets w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'WALLET_NOT_FUNDED';
  end if;

  select a.user_id
  into ad_owner
  from public.ads a
  where a.id = p_ad_id
  for update;

  if not found then
    raise exception 'AD_NOT_FOUND';
  end if;

  if ad_owner = p_user_id then
    raise exception 'SEED_OWN_AD';
  end if;

  select s.*
  into existing_seed
  from public.ad_seeds s
  where s.user_id = p_user_id
    and s.ad_id = p_ad_id;
  seed_exists := found;

  select wt.*
  into existing_request
  from public.wallet_transactions wt
  where wt.request_id = p_request_id;
  request_exists := found;

  if seed_exists then
    if request_exists and (
      existing_request.metadata->>'purpose' is distinct from 'seed'
        or existing_request.user_id <> p_user_id
        or existing_request.entry_type <> 'support_debit'
        or existing_request.ad_id is distinct from p_ad_id
        or existing_request.amount_cents <> -1
        or existing_request.support_id is distinct from existing_seed.support_id
        or p_request_id <> existing_seed.wallet_request_id
    ) then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;

    return jsonb_build_object(
      'recorded', false,
      'seeded', true,
      'already_seeded', true,
      'balance_cents', wallet_balance,
      'support_id', existing_seed.support_id
    );
  end if;

  if request_exists
    and existing_request.metadata->>'purpose' is distinct from 'seed'
  then
    raise exception 'REQUEST_ID_CONFLICT';
  end if;

  support_result := public.spend_wallet_support(
    p_user_id,
    p_ad_id,
    1,
    p_request_id
  );
  created_support_id := (support_result->>'support_id')::bigint;

  update public.wallet_transactions wt
  set metadata = wt.metadata || jsonb_build_object('purpose', 'seed')
  where wt.request_id = p_request_id
    and wt.user_id = p_user_id
    and wt.entry_type = 'support_debit'
    and wt.ad_id = p_ad_id
    and wt.support_id = created_support_id
    and wt.amount_cents = -1;

  if not found then
    raise exception 'SEED_LEDGER_MISMATCH';
  end if;

  update public.supports s
  set source = 'wallet_seed'
  where s.id = created_support_id
    and s.user_id = p_user_id
    and s.ad_id = p_ad_id
    and s.wallet_request_id = p_request_id
    and s.source in ('wallet', 'wallet_seed');

  if not found then
    raise exception 'SEED_SUPPORT_MISMATCH';
  end if;

  insert into public.ad_seeds (
    user_id,
    ad_id,
    support_id,
    wallet_request_id
  ) values (
    p_user_id,
    p_ad_id,
    created_support_id,
    p_request_id
  );

  return support_result || jsonb_build_object(
    'seeded', true,
    'already_seeded', false
  );
end;
$$;

-- Browser-originated ordinary Support uses this wrapper so a request UUID
-- reserved for a paid Seed cannot be replayed as a different action.
create or replace function public.support_ad_from_wallet(
  p_user_id uuid,
  p_ad_id bigint,
  p_amount_cents bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_request public.wallet_transactions%rowtype;
  support_result jsonb;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  perform 1
  from public.wallets w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'WALLET_NOT_FUNDED';
  end if;

  select wt.*
  into existing_request
  from public.wallet_transactions wt
  where wt.request_id = p_request_id;

  if found and coalesce(
    existing_request.metadata->>'purpose',
    'support'
  ) <> 'support' then
    raise exception 'REQUEST_ID_CONFLICT';
  end if;

  support_result := public.spend_wallet_support(
    p_user_id,
    p_ad_id,
    p_amount_cents,
    p_request_id
  );

  update public.wallet_transactions wt
  set metadata = wt.metadata || jsonb_build_object('purpose', 'support')
  where wt.request_id = p_request_id
    and wt.user_id = p_user_id
    and wt.entry_type = 'support_debit'
    and wt.ad_id = p_ad_id
    and wt.support_id = (support_result->>'support_id')::bigint
    and wt.amount_cents = -p_amount_cents;

  if not found then
    raise exception 'SUPPORT_LEDGER_MISMATCH';
  end if;

  return support_result;
end;
$$;

create or replace function public.get_seed_counts()
returns table(ad_id bigint, seed_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.ad_id, count(*)::bigint
  from public.ad_seeds s
  join public.ads a on a.id = s.ad_id
  where a.moderation_status = 'approved'
  group by s.ad_id
$$;

create or replace function public.get_my_seeded_ad_ids()
returns table(ad_id bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.ad_id
  from public.ad_seeds s
  where s.user_id = auth.uid()
  order by s.created_at desc, s.ad_id desc
$$;

revoke all on function public.seed_ad_from_wallet(uuid, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.seed_ad_from_wallet(uuid, bigint, uuid)
  to service_role;

revoke all on function public.support_ad_from_wallet(uuid, bigint, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.support_ad_from_wallet(uuid, bigint, bigint, uuid)
  to service_role;

-- Keep the existing private service-role grant on the lower-level primitive
-- during backend-first rollout, so the previously deployed Support function
-- continues to work between the migration and its Edge Function update.
-- Browser requests in the new function use only the purpose-aware wrappers.

revoke all on function public.get_seed_counts()
  from public, anon, authenticated;
grant execute on function public.get_seed_counts()
  to anon, authenticated;

revoke all on function public.get_my_seeded_ad_ids()
  from public, anon, authenticated;
grant execute on function public.get_my_seeded_ad_ids()
  to authenticated;

commit;
