-- Read-only catalog audit for the wallet branch. Run in adbattle-test SQL Editor.
-- No SET ROLE, DML, RPC execution, payments, secret reads, or schema changes.
-- Complements scripts/test_wallet_access.py's real two-user REST read checks.
-- An explicit table/column grant is checked even if RLS currently hides rows.
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN and protected identity sequences are
-- intentionally included in least-privilege review; they are not claims that
-- PostgREST exposes those SQL operations directly.
with recursive
expected_tables(name, client_read) as (values
  ('wallets', true), ('wallet_topups', true), ('wallet_transactions', true),
  ('ad_settlement_state', true), ('support_settlements', true),
  ('wallet_payment_risks', false), ('wallet_payment_risk_events', false),
  ('wallet_transfer_guards', false), ('ad_seeds', false), ('supports', true)
),
tables as (
  select e.*, c.oid, c.relrowsecurity
  from expected_tables e left join pg_class c on c.oid = to_regclass('public.' || e.name)
),
client_roles as (
  select n.name, r.oid, r.rolsuper, r.rolbypassrls
  from (values ('anon'), ('authenticated')) n(name)
  left join pg_roles r on r.rolname = n.name
),
privileges(name) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
  ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')),
table_checks as (
  select 'table_privilege'::text as category,
    r.name || ':public.' || t.name || ':' || p.name as object_name,
    (p.name = 'SELECT' and t.client_read and
      (r.name = 'authenticated' or t.name = 'supports')) as expected,
    case when t.oid is null or r.oid is null then null else
      has_table_privilege(r.oid, t.oid, p.name)
      or case when p.name in ('SELECT','INSERT','UPDATE','REFERENCES')
        then has_any_column_privilege(r.oid, t.oid, p.name) else false end
    end as actual
  from tables t cross join client_roles r cross join privileges p
),
expected_sequences(name, required) as (values
  ('ads_id_seq', true), ('likes_id_seq', false),
  ('supports_id_seq', true), ('wallet_topups_id_seq', true),
  ('wallet_transactions_id_seq', true)
),
sequences as (
  select e.name, e.required, c.oid
  from expected_sequences e
  left join pg_class c on c.oid = to_regclass('public.' || e.name)
    and c.relkind = 'S'
),
sequence_privileges(name) as (values ('USAGE'), ('SELECT'), ('UPDATE')),
sequence_checks as (
  select 'sequence_privilege'::text as category,
    r.name || ':public.' || s.name || ':' || p.name as object_name,
    false as expected,
    case when s.oid is null or r.oid is null then null
      else has_sequence_privilege(r.oid, s.oid, p.name) end as actual
  from sequences s cross join client_roles r cross join sequence_privileges p
  where s.required or s.oid is not null
),
legacy_likes as (
  select c.oid, c.relrowsecurity
  from pg_class c
  where c.oid = to_regclass('public.likes')
    and c.relkind in ('r', 'p')
),
legacy_likes_checks as (
  select 'legacy_likes_read'::text as category,
    r.name || ':public.likes:SELECT' as object_name,
    true as expected,
    has_table_privilege(r.oid, l.oid, 'SELECT') as actual
  from legacy_likes l cross join client_roles r
  union all
  select 'legacy_likes_privilege_boundary',
    r.name || ':public.likes:unsafe_table_or_column_privileges',
    false,
    has_table_privilege(
      r.oid, l.oid,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_any_column_privilege(r.oid, l.oid, 'INSERT,UPDATE,REFERENCES')
  from legacy_likes l cross join client_roles r
  union all
  select 'row_security', 'public.likes', true, relrowsecurity
  from legacy_likes
),
ads_state as (
  select c.oid, c.relrowsecurity,
    exists (
      select 1 from pg_attribute x
      where x.attrelid = c.oid
        and x.attname = 'image_storage_path'
        and x.attnum > 0
        and not x.attisdropped
    ) as has_image_storage_path,
    to_regprocedure('public.get_public_ads()') is not null as has_public_ads_rpc,
    to_regprocedure('public.get_my_ads()') is not null as has_owner_ads_rpc
  from (select to_regclass('public.ads') as oid) a
  left join pg_class c on c.oid = a.oid and c.relkind in ('r', 'p')
),
ads_boundary_checks as (
  select 'ads_privilege_boundary'::text as category,
    r.name || ':public.ads:unsafe_table_or_column_privileges' as object_name,
    false as expected,
    case when a.oid is null or r.oid is null then null else
      has_table_privilege(
        r.oid, a.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      ) or has_any_column_privilege(r.oid, a.oid, 'UPDATE,REFERENCES')
    end as actual
  from client_roles r
  cross join ads_state a
  union all
  select 'ads_insert_boundary',
    r.name || ':public.ads:exact_insert_columns',
    true,
    case when a.oid is null or r.oid is null then null else
      not has_table_privilege(r.oid, a.oid, 'INSERT')
      and (
        select coalesce(array_agg(c.attname::text order by c.attname), array[]::text[])
        from pg_attribute c
        where c.attrelid = a.oid
          and c.attnum > 0
          and not c.attisdropped
          and has_column_privilege(r.oid, c.attrelid, c.attnum, 'INSERT')
      ) = case
        when r.name <> 'authenticated' then array[]::text[]
        when a.has_image_storage_path then array[
          'caption', 'image_storage_path', 'image_url',
          'promotion_allocation', 'title', 'user_id'
        ]::text[]
        else array[
          'caption', 'image_url', 'promotion_allocation', 'title', 'user_id'
        ]::text[]
      end
    end
  from client_roles r
  cross join ads_state a
  union all
  select 'ads_read_boundary',
    r.name || ':public.ads:direct_select',
    not a.has_image_storage_path,
    case when a.oid is null or r.oid is null then null
      when a.has_image_storage_path then
        has_table_privilege(r.oid, a.oid, 'SELECT')
        or has_any_column_privilege(r.oid, a.oid, 'SELECT')
      else has_table_privilege(r.oid, a.oid, 'SELECT')
    end
  from client_roles r cross join ads_state a
  union all
  select 'ads_read_mode', 'public.ads:coherent_schema', true,
    case when a.oid is null then null else
      (a.has_image_storage_path and a.has_public_ads_rpc and a.has_owner_ads_rpc)
      or (not a.has_image_storage_path and not a.has_public_ads_rpc and not a.has_owner_ads_rpc)
    end
  from ads_state a
  union all
  select 'row_security', 'public.ads', true, relrowsecurity
  from ads_state
),
expected_functions(signature, anon_allowed, authenticated_allowed, service_allowed) as (values
  ('public.record_wallet_topup(text,text,uuid,bigint)', false, false, true),
  ('public.spend_wallet_support(uuid,bigint,bigint,uuid)', false, false, true),
  ('public.seed_ad_from_wallet(uuid,bigint,uuid)', false, false, true),
  ('public.support_ad_from_wallet(uuid,bigint,bigint,uuid)', false, false, true),
  ('public.get_seed_counts()', true, true, false),
  ('public.get_my_seeded_ad_ids()', false, true, false),
  ('public.claim_due_wallet_settlements(integer)', false, false, true),
  ('public.retry_wallet_settlement(uuid,text)', false, false, true),
  ('public.complete_wallet_settlement(uuid,text)', false, false, true),
  ('public.record_wallet_payment_risk(text,uuid,bigint,boolean,text,text)', false, false, true),
  ('public.prepare_wallet_transfer(uuid)', false, false, true),
  ('public.authorize_wallet_capability_recovery(uuid,text,text,text)', false, false, true),
  ('public.authorize_wallet_balance_recovery(uuid,text,text,text,bigint,text)', false, false, true),
  ('public.record_wallet_topup_unchecked(text,text,uuid,bigint)', false, false, false),
  ('public.claim_due_wallet_settlements_unchecked(integer)', false, false, false),
  ('public.prepare_wallet_transfer_before_recovery(uuid)', false, false, false),
  ('public.prepare_wallet_transfer_before_balance_recovery(uuid)', false, false, false)
),
functions as (
  select e.*, to_regprocedure(e.signature) as oid from expected_functions e
),
function_roles as (
  select n.name, r.oid from (values ('anon'),('authenticated'),('service_role')) n(name)
  left join pg_roles r on r.rolname = n.name
),
function_checks as (
  select 'function_privilege'::text as category, r.name || ':' || f.signature as object_name,
    case r.name
      when 'anon' then f.anon_allowed
      when 'authenticated' then f.authenticated_allowed
      when 'service_role' then f.service_allowed
    end as expected,
    case when f.oid is null or r.oid is null then null
      else has_function_privilege(r.oid, f.oid, 'EXECUTE') end as actual
  from functions f cross join function_roles r
),
rls_checks as (
  select 'row_security'::text as category, 'public.' || name as object_name,
    true as expected, relrowsecurity as actual from tables
),
role_checks as (
  select 'role_bypass'::text as category, name as object_name,
    false as expected, rolsuper or rolbypassrls as actual from client_roles
  union all
  select 'service_role_membership', c.name, false,
    case when c.oid is null or s.oid is null then null
      else pg_has_role(c.oid, s.oid, 'MEMBER') end
  from client_roles c left join pg_roles s on s.rolname = 'service_role'
),
view_tree(oid) as (
  select oid from tables where oid is not null
  union
  select rw.ev_class from view_tree parent
  join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = parent.oid
    and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite rw on rw.oid = d.objid
  where rw.ev_class <> parent.oid
),
checks as (
  select * from table_checks union all select * from sequence_checks
  union all select * from legacy_likes_checks
  union all select * from ads_boundary_checks
  union all select * from function_checks
  union all select * from rls_checks union all select * from role_checks
),
results as (
  select category, object_name,
    case when actual is null then 'MISSING'
      when actual = expected then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', expected, 'actual', actual) as details
  from checks
  union all
  select 'unexpected_function_overload', p.oid::regprocedure::text, 'REVIEW',
    jsonb_build_object('reason', 'Unlisted overload of a protected wallet RPC')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select split_part(split_part(signature, '.', 2), '(', 1) from functions)
    and not exists (select 1 from functions f where f.oid = p.oid)
  union all
  select 'dependent_view', r.name || ':' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
    'REVIEW', jsonb_build_object('reason', 'Client-readable view depends on a wallet table; review its security separately',
      'options', c.reloptions)
  from view_tree v join pg_class c on c.oid = v.oid
  join pg_namespace n on n.oid = c.relnamespace cross join client_roles r
  where c.relkind in ('v','m') and r.oid is not null
    and (has_table_privilege(r.oid,c.oid,'SELECT') or has_any_column_privilege(r.oid,c.oid,'SELECT'))
)
select
  case when count(*) filter (where status <> 'PASS') = 0 then 'PASS' else 'REVIEW_REQUIRED' end as audit_status,
  count(*) as checks_total,
  count(*) filter (where status <> 'PASS') as nonpassing_checks,
  coalesce(jsonb_agg(jsonb_build_object('category',category,'object_name',object_name,
    'status',status,'details',details) order by category,object_name)
    filter (where status <> 'PASS'), '[]'::jsonb) as findings
from results;
