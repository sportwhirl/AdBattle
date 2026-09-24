-- Forward-only PostgreSQL 17 least-privilege repair.
--
-- Hosted default privileges left MAINTAIN on the five authenticated-readable
-- wallet tables and left browser roles full access to the identity sequences
-- used by ads, wallet_topups, wallet_transactions, and supports. Identity
-- generation does not require caller access to these owned sequences. The
-- legacy supports table also retained TRUNCATE, REFERENCES, and TRIGGER. None of
-- these privileges is needed by the browser: wallet/support writes execute as
-- service-owned RPCs or through service-role Edge Functions.
--
-- This migration changes no rows, policies, functions, schema-wide defaults,
-- or service-role grants on active objects. It is safe to repeat.
begin;

revoke truncate, references, trigger, maintain
  on table public.supports
  from anon, authenticated
  restrict;

-- Public ad reads remain RLS-filtered. Only signed-in users keep the five
-- column-scoped INSERT privileges used by the production posting form.
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.ads
  from anon, authenticated
  restrict;

do $$
begin
  if exists (
    select 1
    from pg_attribute
    where attrelid = 'public.ads'::regclass
      and attname = 'image_storage_path'
      and attnum > 0
      and not attisdropped
  ) then
    execute 'grant insert (
      user_id, title, caption, image_url, promotion_allocation,
      image_storage_path
    ) on table public.ads to authenticated';
  else
    grant insert (user_id, title, caption, image_url, promotion_allocation)
      on table public.ads
      to authenticated;
  end if;
end;
$$;

revoke maintain
  on table
    public.wallets,
    public.wallet_topups,
    public.wallet_transactions,
    public.ad_settlement_state,
    public.support_settlements
  from anon, authenticated
  restrict;

revoke all privileges
  on sequence
    public.supports_id_seq,
    public.ads_id_seq,
    public.wallet_topups_id_seq,
    public.wallet_transactions_id_seq
  from anon, authenticated
  restrict;

-- Paid Seeds archive the legacy Likes table in place. PostgreSQL 17 added
-- MAINTAIN to ALL table privileges, and sequence SELECT was not part of the
-- earlier write-lock list. Remove both without touching temporary row reads.
do $$
begin
  if to_regclass('public.likes') is not null then
    revoke maintain
      on table public.likes
      from public, anon, authenticated, service_role
      restrict;

    if to_regclass('public.likes_id_seq') is not null then
      revoke all privileges
        on sequence public.likes_id_seq
        from public, anon, authenticated, service_role
        restrict;
    end if;
  end if;
end;
$$;

-- Direct revokes cannot remove privileges inherited from another role or
-- PUBLIC. Abort the transaction if effective browser access remains, required
-- read access disappeared, or the archived Like lock remains incomplete.
do $$
declare
  client_role text;
  wallet_table text;
  protected_sequence text;
  ad_insert_columns text[];
  expected_ad_insert_columns text[];
  has_image_storage_path boolean;
  has_public_ads_rpc boolean;
  has_owner_ads_rpc boolean;
  duplicate_read_mode boolean;
begin
  select exists (
    select 1
    from pg_attribute
    where attrelid = 'public.ads'::regclass
      and attname = 'image_storage_path'
      and attnum > 0
      and not attisdropped
  ) into has_image_storage_path;

  has_public_ads_rpc := to_regprocedure('public.get_public_ads()') is not null;
  has_owner_ads_rpc := to_regprocedure('public.get_my_ads()') is not null;

  if not (
    (has_image_storage_path and has_public_ads_rpc and has_owner_ads_rpc)
    or (not has_image_storage_path and not has_public_ads_rpc and not has_owner_ads_rpc)
  ) then
    raise exception
      'ADS_READ_MODE_INCOMPLETE: image_storage_path=%, get_public_ads=%, get_my_ads=%',
      has_image_storage_path,
      has_public_ads_rpc,
      has_owner_ads_rpc;
  end if;

  duplicate_read_mode := has_image_storage_path;
  expected_ad_insert_columns := array[
    'caption', 'image_url', 'promotion_allocation', 'title', 'user_id'
  ]::text[];

  if has_image_storage_path then
    expected_ad_insert_columns := array[
      'caption', 'image_storage_path', 'image_url',
      'promotion_allocation', 'title', 'user_id'
    ]::text[];
  end if;

  foreach client_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(
      client_role,
      'public.supports',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_any_column_privilege(
      client_role,
      'public.supports',
      'INSERT,UPDATE,REFERENCES'
    ) then
      raise exception
        'SUPPORTS_CLIENT_PRIVILEGE_REMAINS: % — inspect inherited/PUBLIC grants',
        client_role;
    end if;

    if not has_table_privilege(client_role, 'public.supports', 'SELECT') then
      raise exception 'SUPPORTS_READ_PRIVILEGE_MISSING: %', client_role;
    end if;

    foreach protected_sequence in array array[
      'supports_id_seq',
      'ads_id_seq',
      'wallet_topups_id_seq',
      'wallet_transactions_id_seq'
    ] loop
      if has_sequence_privilege(
        client_role,
        'public.' || protected_sequence,
        'USAGE,SELECT,UPDATE'
      ) then
        raise exception
          'CLIENT_SEQUENCE_PRIVILEGE_REMAINS: % public.% — inspect inherited/PUBLIC grants',
          client_role,
          protected_sequence;
      end if;
    end loop;

    foreach wallet_table in array array[
      'wallets',
      'wallet_topups',
      'wallet_transactions',
      'ad_settlement_state',
      'support_settlements'
    ] loop
      if has_table_privilege(
        client_role,
        'public.' || wallet_table,
        'MAINTAIN'
      ) then
        raise exception
          'WALLET_MAINTAIN_PRIVILEGE_REMAINS: % public.% — inspect inherited/PUBLIC grants',
          client_role,
          wallet_table;
      end if;

      if client_role = 'authenticated' and not has_table_privilege(
        client_role,
        'public.' || wallet_table,
        'SELECT'
      ) then
        raise exception 'WALLET_READ_PRIVILEGE_MISSING: public.%', wallet_table;
      end if;
    end loop;

    if duplicate_read_mode then
      if has_table_privilege(client_role, 'public.ads', 'SELECT')
        or has_any_column_privilege(client_role, 'public.ads', 'SELECT') then
        raise exception
          'ADS_DIRECT_READ_PRIVILEGE_REMAINS: % — duplicate mode uses reviewed RPCs',
          client_role;
      end if;
    elsif not has_table_privilege(client_role, 'public.ads', 'SELECT') then
      raise exception 'ADS_READ_PRIVILEGE_MISSING: %', client_role;
    end if;

    if has_table_privilege(
      client_role,
      'public.ads',
      'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_any_column_privilege(
      client_role,
      'public.ads',
      'UPDATE,REFERENCES'
    ) then
      raise exception
        'ADS_CLIENT_PRIVILEGE_REMAINS: % — inspect inherited/PUBLIC grants',
        client_role;
    end if;

    select coalesce(array_agg(a.attname::text order by a.attname), array[]::text[])
    into ad_insert_columns
    from pg_attribute a
    where a.attrelid = 'public.ads'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and has_column_privilege(client_role, a.attrelid, a.attnum, 'INSERT');

    if client_role = 'authenticated' then
      if has_table_privilege(client_role, 'public.ads', 'INSERT')
        or ad_insert_columns is distinct from expected_ad_insert_columns then
        raise exception
          'ADS_INSERT_BOUNDARY_INVALID: % columns=%',
          client_role,
          ad_insert_columns;
      end if;
    elsif has_table_privilege(client_role, 'public.ads', 'INSERT')
      or cardinality(ad_insert_columns) <> 0 then
      raise exception
        'ADS_INSERT_BOUNDARY_INVALID: % columns=%',
        client_role,
        ad_insert_columns;
    end if;

    if to_regclass('public.likes') is not null then
      if has_table_privilege(
        client_role,
        'public.likes',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      ) or has_any_column_privilege(
        client_role,
        'public.likes',
        'INSERT,UPDATE,REFERENCES'
      ) then
        raise exception
          'LEGACY_LIKES_CLIENT_PRIVILEGE_REMAINS: % — inspect inherited/PUBLIC grants',
          client_role;
      end if;

      if to_regclass('public.likes_id_seq') is not null and has_sequence_privilege(
        client_role,
        'public.likes_id_seq',
        'USAGE,SELECT,UPDATE'
      ) then
        raise exception
          'LEGACY_LIKES_SEQUENCE_PRIVILEGE_REMAINS: % — inspect inherited/PUBLIC grants',
          client_role;
      end if;
    end if;
  end loop;

  if to_regclass('public.likes') is not null then
    if has_table_privilege(
      'service_role',
      'public.likes',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_any_column_privilege(
      'service_role',
      'public.likes',
      'INSERT,UPDATE,REFERENCES'
    ) then
      raise exception
        'LEGACY_LIKES_SERVICE_PRIVILEGE_REMAINS — inspect inherited/PUBLIC grants';
    end if;

    if to_regclass('public.likes_id_seq') is not null and has_sequence_privilege(
      'service_role',
      'public.likes_id_seq',
      'USAGE,SELECT,UPDATE'
    ) then
      raise exception
        'LEGACY_LIKES_SERVICE_SEQUENCE_PRIVILEGE_REMAINS — inspect inherited/PUBLIC grants';
    end if;
  end if;
end;
$$;

commit;
