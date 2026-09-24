-- Generated image drafts are server-owned. Restrictive policies are ANDed
-- with every applicable permissive policy, so a legacy or future broad grant
-- cannot expose this bucket to a browser role. The service_role keeps access
-- through its PostgreSQL BYPASSRLS attribute.
begin;

do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'ai-image-drafts' and public is false
  ) then
    raise exception 'AI_DRAFT_BUCKET_MUST_BE_PRIVATE';
  end if;
end $$;

create policy ai_draft_server_only_select on storage.objects as restrictive
  for select to public
  using (bucket_id <> 'ai-image-drafts');

create policy ai_draft_server_only_insert on storage.objects as restrictive
  for insert to public
  with check (bucket_id <> 'ai-image-drafts');

create policy ai_draft_server_only_update on storage.objects as restrictive
  for update to public
  using (bucket_id <> 'ai-image-drafts')
  with check (bucket_id <> 'ai-image-drafts');

create policy ai_draft_server_only_delete on storage.objects as restrictive
  for delete to public
  using (bucket_id <> 'ai-image-drafts');

commit;
