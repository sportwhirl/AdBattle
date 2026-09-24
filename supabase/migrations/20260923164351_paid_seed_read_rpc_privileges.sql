-- Supabase-hosted projects may grant service_role EXECUTE on newly created
-- functions through default privileges. The paid-Seed read RPCs are intended
-- only for browser reads: public counts for anon/authenticated, and a signed-in
-- user's own Seed IDs for authenticated. Keep the service key on the two
-- purpose-aware write RPCs, but remove it from these read RPCs.
begin;

revoke execute on function public.get_seed_counts()
  from service_role;
revoke execute on function public.get_my_seeded_ad_ids()
  from service_role;

commit;
