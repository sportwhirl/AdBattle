-- Operator-only, read-only snapshot. Run in adbattle-test SQL Editor as postgres.
-- Requires the wallet migrations and PostgreSQL XML support. No installation,
-- RPC invocation, HTTP request, secret read, repair, or scheduled job is performed.
-- HEALTHY covers only these database/cron checks, not Stripe or HTTP delivery.
-- Fixed SELECT strings are evaluated only after catalog/access checks. XMLTABLE
-- lets absent extension tables produce INCOMPLETE instead of a parse-time error.
with
required(source, relation_name, columns) as (values
  ('wallet', 'public.wallets', array['user_id','available_cents','lifetime_topup_cents','lifetime_support_cents','status']),
  ('wallet', 'public.wallet_transactions', array['user_id','entry_type','amount_cents']),
  ('wallet', 'public.wallet_payment_risks', array['user_id','resolved_at','updated_at']),
  ('wallet', 'public.wallet_transfer_guards', array['settlement_id','destination','first_attempt_at','manual_review']),
  ('wallet', 'public.support_settlements', array['id','ad_id','creator_user_id','status','updated_at','next_attempt_at','stripe_transfer_id','completed_at']),
  ('wallet', 'public.ad_settlement_state', array['ad_id','creator_user_id','active_settlement_id','pending_creator_micros','pending_platform_micros','lifetime_support_cents','next_threshold_cents','last_support_at']),
  ('wallet', 'public.creator_accounts', array['user_id','stripe_account_id','onboarding_complete','charges_enabled','payouts_enabled']),
  ('scheduler', 'cron.job', array['jobid','jobname','active','schedule']),
  ('scheduler', 'cron.job_run_details', array['jobid','runid','status','start_time','end_time'])
),
access as (
  select r.source, r.relation_name,
    case when c.oid is null then 'MISSING'
      when c.relkind not in ('r','p') then 'UNSUPPORTED_RELATION'
      when exists (select 1 from unnest(r.columns) wanted(name)
        where not exists (select 1 from pg_catalog.pg_attribute a
          where a.attrelid=c.oid and a.attname=wanted.name and a.attnum>0 and not a.attisdropped))
        then 'MISSING_COLUMN'
      when not (pg_catalog.has_schema_privilege(c.relnamespace, 'USAGE')
        and pg_catalog.has_table_privilege(c.oid, 'SELECT')) then 'READ_DENIED'
      when pg_catalog.row_security_active(c.oid) then 'RLS_FILTERED'
      else 'READY' end as state
  from required r left join pg_catalog.pg_class c
    on c.oid=pg_catalog.to_regclass(r.relation_name)
),
sources(source, sql_text) as (values
  ('wallet', $wallet$
    with
    ledger as (
      select user_id, sum(amount_cents) as balance,
        sum(amount_cents) filter (where entry_type='topup') as topups,
        -sum(amount_cents) filter (where entry_type='support_debit') as spent
      from public.wallet_transactions group by user_id
    ),
    reconciled as (
      select coalesce(w.user_id,l.user_id) as user_id,
        w.user_id is null or w.available_cents <> coalesce(l.balance,0) as balance_mismatch,
        w.user_id is null or w.lifetime_topup_cents <> coalesce(l.topups,0)
          or w.lifetime_support_cents <> coalesce(l.spent,0) as lifetime_mismatch
      from public.wallets w full join ledger l on l.user_id=w.user_id
    ),
    settlements as (
      select s.*, g.settlement_id as guard_id, g.destination, g.first_attempt_at,
        g.manual_review, a.active_settlement_id,
        c.stripe_account_id as current_destination
      from public.support_settlements s
      left join public.wallet_transfer_guards g on g.settlement_id=s.id
      left join public.ad_settlement_state a on a.ad_id=s.ad_id
      left join public.creator_accounts c on c.user_id=s.creator_user_id
    ),
    eligible as (
      select a.*,
        coalesce(nullif(c.stripe_account_id,'') is not null and c.onboarding_complete
          and c.charges_enabled and c.payouts_enabled,false) as creator_ready
      from public.ad_settlement_state a
      left join public.creator_accounts c on c.user_id=a.creator_user_id
      where a.active_settlement_id is null and a.pending_creator_micros >= 10000
        and ((a.lifetime_support_cents >= a.next_threshold_cents
              and a.last_support_at <= now()-interval '5 minutes')
          or (a.pending_creator_micros+a.pending_platform_micros >= 10000000
              and a.last_support_at <= now()-interval '24 hours 5 minutes'))
    ),
    issues(check_name, problem_status, affected_count, note) as (
      select 'wallet_ledger_balance','FAIL',count(*),
        'Wallet balances must equal the sum of all ledger entries; includes orphan ledger owners.'
        from reconciled where balance_mismatch
      union all
      select 'wallet_lifetime_totals','FAIL',count(*),
        'Lifetime top-up and Support totals must match their ledger entry types.'
        from reconciled where lifetime_mismatch
      union all
      select 'negative_wallet_balances','WARN',count(*),
        'Debt can follow a spent-funds refund; reconcile it rather than resetting the balance.'
        from public.wallets where available_cents < 0
      union all
      select 'frozen_wallets','WARN',count(*),
        'Wallets on hold need operator review; the report never unfreezes them.'
        from public.wallets where status='frozen'
      union all
      select 'unresolved_payment_risks','WARN',count(*),
        'Any unresolved refund/dispute risk globally pauses automated settlements.'
        from public.wallet_payment_risks where resolved_at is null
      union all
      select 'risk_wallet_hold_consistency','FAIL',count(*),
        'An unresolved payment risk requires a present, frozen wallet.'
        from public.wallet_payment_risks r left join public.wallets w on w.user_id=r.user_id
        where r.resolved_at is null and w.status is distinct from 'frozen'
      union all
      select 'retrying_settlements','WARN',count(*),
        'Includes scheduled retries and held retries; not every retry is overdue.'
        from settlements where status='retry'
      union all
      select 'overdue_retries','WARN',count(*),
        'Retry is over five minutes past next_attempt_at, or has no retry timestamp.'
        from settlements where status='retry'
          and (next_attempt_at is null or next_attempt_at <= now()-interval '5 minutes')
      union all
      select 'stale_processing_settlements','WARN',count(*),
        'Processing has not updated for fifteen minutes (the worker reclaim interval).'
        from settlements where status='processing' and updated_at <= now()-interval '15 minutes'
      union all
      select 'manual_review_settlements','WARN',count(*),
        'Unfinished transfers with a manual review hold require reconciliation.'
        from settlements where status<>'succeeded' and manual_review
      union all
      select 'expired_transfer_retry_windows','WARN',count(*),
        'The original twenty-hour automatic retry window expired; do not reset it.'
        from settlements where status<>'succeeded' and first_attempt_at <= now()-interval '20 hours'
      union all
      select 'unfinished_settlement_integrity','FAIL',count(*),
        'Unfinished settlements require a frozen destination/guard and the matching active ad pointer.'
        from settlements where status<>'succeeded' and
          (guard_id is null or nullif(destination,'') is null or active_settlement_id is distinct from id)
      union all
      select 'changed_transfer_destinations','WARN',count(*),
        'The current creator destination differs from the frozen transfer destination; review, never overwrite.'
        from settlements where status<>'succeeded' and guard_id is not null
          and current_destination is distinct from destination
      union all
      select 'completed_settlement_integrity','FAIL',count(*),
        'Succeeded settlements need a transfer ID and completion time; unfinished rows must not claim completion.'
        from settlements where (status='succeeded' and (nullif(stripe_transfer_id,'') is null or completed_at is null))
          or (status<>'succeeded' and (stripe_transfer_id is not null or completed_at is not null))
      union all
      select 'active_settlement_pointers','FAIL',count(*),
        'An active pointer must reference an unfinished settlement for the same ad and creator.'
        from public.ad_settlement_state a left join public.support_settlements s on s.id=a.active_settlement_id
        where a.active_settlement_id is not null and
          (s.id is null or s.status='succeeded' or s.ad_id<>a.ad_id or s.creator_user_id<>a.creator_user_id)
      union all
      select 'eligible_unclaimed_settlements','WARN',count(*),
        'A ready creator has an unclaimed threshold/inactivity batch beyond a five-minute grace period; payment risks can block it.'
        from eligible where creator_ready
      union all
      select 'eligible_creator_not_ready','WARN',count(*),
        'An otherwise due batch lacks stored creator readiness; this is not a live Stripe capability check.'
        from eligible where not creator_ready
    )
    select jsonb_build_object(
      'summary', jsonb_build_object(
        'wallet_count',(select count(*) from public.wallets),
        'wallet_liability_cents',(select coalesce(sum(greatest(available_cents,0)),0) from public.wallets),
        'wallet_debt_cents',(select coalesce(sum(-least(available_cents,0)),0) from public.wallets),
        'pending_creator_micros',(select coalesce(sum(pending_creator_micros),0) from public.ad_settlement_state),
        'pending_platform_micros',(select coalesce(sum(pending_platform_micros),0) from public.ad_settlement_state),
        'unfinished_settlements',(select count(*) from settlements where status<>'succeeded'),
        'global_payment_risk_hold',(select exists(select 1 from public.wallet_payment_risks where resolved_at is null))),
      'checks',(select jsonb_agg(jsonb_build_object('check',check_name,
        'status',case when affected_count=0 then 'PASS' else problem_status end,
        'affected_count',affected_count,'note',note) order by check_name) from issues)
    ) as payload
  $wallet$),
  ('scheduler', $scheduler$
    with jobs as (
      select jobid, active, schedule from cron.job where jobname='adbattle-wallet-settlement'
    ),
    latest as (
      select r.runid, r.status, r.start_time, r.end_time
      from cron.job_run_details r join jobs j on j.jobid=r.jobid
      order by r.start_time desc nulls last, r.runid desc limit 1
    ),
    completed as (
      select r.runid, r.status, r.start_time, r.end_time
      from cron.job_run_details r join jobs j on j.jobid=r.jobid
      where r.end_time is not null
      order by r.end_time desc, r.runid desc limit 1
    )
    select jsonb_build_object(
      'summary',jsonb_build_object(
        'job_count',(select count(*) from jobs),
        'latest_run',(select to_jsonb(l) from latest l),
        'latest_completed_run',(select to_jsonb(c) from completed c)),
      'checks',jsonb_build_array(
        jsonb_build_object('check','scheduler_configuration',
          'status',case when (select count(*) from jobs)=1 and
            (select count(*) from jobs where active and schedule='* * * * *')=1 then 'PASS' else 'FAIL' end,
          'note','Exactly one active, every-minute adbattle-wallet-settlement job is expected; command and secrets are not inspected.'),
        jsonb_build_object('check','scheduler_recent_dispatch',
          'status',case when not exists(select 1 from latest) then 'INCOMPLETE'
            when exists(select 1 from latest where start_time >= now()-interval '3 minutes'
              and start_time <= now() and
                ((status='succeeded' and end_time between start_time and now())
                  or (status in ('starting','running','connecting','sending') and end_time is null)))
              then 'PASS' else 'FAIL' end,
          'note','Latest dispatch must be within three minutes; missing history is not proof of success.'),
        jsonb_build_object('check','scheduler_last_completion',
          'status',case when not exists(select 1 from completed) then 'INCOMPLETE'
            when exists(select 1 from completed where status='succeeded'
              and start_time >= now()-interval '3 minutes' and start_time <= end_time and end_time <= now())
              then 'PASS' else 'FAIL' end,
          'note','Cron success proves SQL dispatch only, not Edge Function authorization, HTTP success, or a Stripe transfer.')
      )
    ) as payload
  $scheduler$)
),
readiness as (
  select source, bool_and(state='READY') as ready from access group by source
),
snapshots as materialized (
  select s.source, r.ready, x.payload::jsonb as data
  from sources s join readiness r using (source)
  cross join lateral xmltable('/table/row' passing pg_catalog.query_to_xml(
    case when r.ready then s.sql_text else 'select null::jsonb as payload' end,
    false, false, '') columns payload text path 'payload') x
),
checks as (
  select jsonb_build_object('check',a.relation_name || ':read_access',
    'status',case when a.state='READY' then 'PASS' else 'INCOMPLETE' end,
    'source',a.source,'note',a.state) as item from access a
  union all
  select item from snapshots s cross join lateral jsonb_array_elements(s.data->'checks') item
)
select
  1 as report_version,
  now() as checked_at,
  case when exists(select 1 from checks where item->>'status'='INCOMPLETE') then 'INCOMPLETE'
    when exists(select 1 from checks where item->>'status' in ('WARN','FAIL')) then 'ATTENTION'
    else 'HEALTHY' end as health_status,
  'Database accounting, holds, settlement queues, and cron dispatch only; no Stripe balance, HTTP delivery, repair, or live-payment approval.' as scope,
  (select data->'summary' from snapshots where source='wallet') as wallet_summary,
  (select data->'summary' from snapshots where source='scheduler') as scheduler_summary,
  (select count(*) from checks) as checks_total,
  (select count(*) from checks where item->>'status'<>'PASS') as nonpassing_checks,
  (select jsonb_agg(item order by item->>'check') from checks) as checks;
