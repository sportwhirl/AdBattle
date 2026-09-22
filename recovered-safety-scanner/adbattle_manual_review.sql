-- ============================================================
-- AdBattle manual moderation helper
-- Run from Supabase SQL Editor only.
-- ============================================================

-- See ads waiting for a human:
select
  id,
  user_id,
  title,
  moderation_status,
  moderation_reason,
  moderation_risk_score,
  moderation_scan_version,
  moderation_attempts,
  moderation_last_error,
  created_at
from public.ads
where moderation_status in (
  'pending_scan',
  'manual_review'
)
order by created_at asc;


-- See the full scanner audit trail for ONE ad:
-- Replace YOUR_AD_ID.
select
  stage,
  outcome,
  reason,
  details,
  created_at
from public.moderation_events
where ad_id = YOUR_AD_ID
order by created_at asc;


-- HUMAN APPROVE
-- Only do this after reviewing the image/text.
--
-- update public.ads
-- set
--   moderation_status = 'approved',
--   moderation_reason = 'Approved by human moderator.',
--   moderated_at = now(),
--   moderation_last_error = null,
--   promotion_stopped_at = null
-- where id = YOUR_AD_ID
--   and moderation_status in ('pending_scan', 'manual_review');


-- HUMAN REJECT
--
-- update public.ads
-- set
--   moderation_status = 'rejected',
--   moderation_reason = 'Human moderator: REASON HERE',
--   moderated_at = now(),
--   promotion_stopped_at = now()
-- where id = YOUR_AD_ID
--   and moderation_status in ('pending_scan', 'manual_review');


-- EMERGENCY REMOVE AFTER APPROVAL
-- This hides the ad and blocks future support/promotion.
-- Already-spent external ad money is not reversed.
--
-- update public.ads
-- set
--   moderation_status = 'removed',
--   moderation_reason = 'Human moderator: REASON HERE',
--   moderated_at = now(),
--   promotion_stopped_at = now()
-- where id = YOUR_AD_ID;