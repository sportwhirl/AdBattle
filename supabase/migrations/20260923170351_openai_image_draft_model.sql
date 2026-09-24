-- Keep already recorded Gemini draft provenance intact. New reservations use
-- the staging image provider selected after the general-audience review.
alter table public.ai_image_draft_requests
  alter column model set default 'gpt-image-2.5-flare';
