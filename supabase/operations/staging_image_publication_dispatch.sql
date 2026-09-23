-- REVIEW-ONLY staging dispatch setup for AdBattle. DO NOT run until
-- ADBATTLE_IMAGE_PUBLISHER_SECRET (Edge Functions > Secrets) holds the SAME
-- value as the already created adbattle_image_publisher_secret (Vault).
-- The existing adbattle_project_url Vault value must identify the test ref.
-- Apply as postgres to test project nccqnrcdygujulrnwair only, after the
-- image migrations and publish-ad-image Edge deployment are verified.
-- The queue row is durable; this trigger is a best-effort wakeup, and cron
-- retries jobs if the immediate HTTP request is lost or publication fails.

begin;

do $$
begin
  if current_user <> 'postgres'
     or (select decrypted_secret from vault.decrypted_secrets
           where name='adbattle_project_url')
        is distinct from 'https://nccqnrcdygujulrnwair.supabase.co'
     or coalesce(length((select decrypted_secret from vault.decrypted_secrets
           where name='adbattle_image_publisher_secret')),0) < 32
     or not exists (select 1 from pg_extension where extname='pg_net')
     or not exists (select 1 from pg_extension where extname='pg_cron')
     or to_regclass('public.ad_image_publication_queue') is null
     or exists (select 1 from cron.job
                where jobname='adbattle-image-publication-sweep')
     or exists (select 1 from pg_trigger
                where tgrelid='public.ad_image_publication_queue'::regclass
                  and tgname='adbattle_image_publication_wakeup') then
    raise exception 'STAGING_IMAGE_DISPATCH_PREFLIGHT_FAILED';
  end if;
end;
$$;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- This is deliberately outside exposed public schema. No dynamic path,
-- recipient, or secret is taken from the incoming webhook or HTTP request.
create function app_private.dispatch_image_publisher(p_ad_id bigint)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_body jsonb;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets
    where name='adbattle_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets
    where name='adbattle_image_publisher_secret';
  if v_url is distinct from 'https://nccqnrcdygujulrnwair.supabase.co'
     or coalesce(length(v_secret),0) < 32 then
    raise exception 'STAGING_PUBLISHER_CONFIG_UNAVAILABLE';
  end if;
  if p_ad_id is not null and p_ad_id <= 0 then
    raise exception 'INVALID_AD_ID';
  end if;
  v_body := case when p_ad_id is null
    then '{"action":"sweep"}'::jsonb
    else jsonb_build_object('record',jsonb_build_object('ad_id',p_ad_id))
  end;
  return net.http_post(
    url := v_url || '/functions/v1/publish-ad-image',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-adbattle-publisher-secret',v_secret),
    body := v_body,
    timeout_milliseconds := 30000
  );
end;
$$;
revoke all on function app_private.dispatch_image_publisher(bigint)
  from public, anon, authenticated;

-- Do not roll back the scanner's status update or durable queue INSERT just
-- because a best-effort pg_net wakeup cannot be scheduled.
create function app_private.wake_ad_image_publisher()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform app_private.dispatch_image_publisher(new.ad_id);
  exception when others then
    raise warning 'Ad image publisher wakeup deferred; scheduled sweep will retry';
  end;
  return new;
end;
$$;
revoke all on function app_private.wake_ad_image_publisher()
  from public, anon, authenticated;

create trigger adbattle_image_publication_wakeup
after insert on public.ad_image_publication_queue
for each row execute function app_private.wake_ad_image_publisher();

select cron.schedule(
  'adbattle-image-publication-sweep',
  '* * * * *',
  $cron$select app_private.dispatch_image_publisher(null::bigint);$cron$
);

commit;

-- Post-apply, read-only checks (do not print job command or Vault values):
-- select jobname,active,schedule,username from cron.job
--   where jobname='adbattle-image-publication-sweep';
-- select tgname,tgenabled from pg_trigger
--   where tgrelid='public.ad_image_publication_queue'::regclass
--     and tgname='adbattle_image_publication_wakeup';
-- select r.status,r.start_time,r.end_time
--   from cron.job_run_details r join cron.job j on j.jobid=r.jobid
--   where j.jobname='adbattle-image-publication-sweep'
--   order by r.start_time desc limit 5;
-- `cron.job_run_details.status='succeeded'` proves SQL dispatch only, not
-- HTTP delivery. An operator can explicitly call
--   select app_private.dispatch_image_publisher(null::bigint) as request_id;
-- then check the returned request ID after the transaction commits:
--   select id,status_code,error_msg from net._http_response
--     where id=<request_id>;
-- Confirm a 200 response, then test a real newly uploaded ad through both
-- scan orders and inspect queue age, final public hash, and approved state.
