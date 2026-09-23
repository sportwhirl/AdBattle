-- Forward-only permission repair after the four existing wallet migrations.
-- The original ledger migration revoked INSERT/UPDATE/DELETE but left these
-- three privileges when the hosted project supplied broad table defaults.
-- Apply to adbattle-test first. No rows, policies, RPCs, service-role grants,
-- or schema-wide default privileges are changed.
begin;

revoke truncate, references, trigger on table
  public.wallets,
  public.wallet_topups,
  public.wallet_transactions,
  public.ad_settlement_state,
  public.support_settlements
from authenticated restrict;

-- A direct revoke cannot remove privileges inherited from another role or
-- PUBLIC. Roll back instead of reporting success if a separate grant remains.
do $$
declare
  wallet_table text;
begin
  foreach wallet_table in array array[
    'wallets', 'wallet_topups', 'wallet_transactions',
    'ad_settlement_state', 'support_settlements'
  ] loop
    if has_table_privilege('authenticated', 'public.' || wallet_table,
        'TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('authenticated', 'public.' || wallet_table, 'REFERENCES') then
      raise exception 'WALLET_EXTRA_PRIVILEGE_REMAINS: public.% — inspect inherited/PUBLIC grants', wallet_table;
    end if;
    if not has_table_privilege('authenticated', 'public.' || wallet_table, 'SELECT') then
      raise exception 'WALLET_READ_PRIVILEGE_MISSING: public.%', wallet_table;
    end if;
  end loop;
end;
$$;

commit;
