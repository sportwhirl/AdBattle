-- Keep production ad creation limited to the five browser-supplied columns,
-- and let a signed-in user clean up only their own failed image upload.

begin;

grant insert (user_id, title, caption, image_url, promotion_allocation)
  on table public.ads
  to authenticated;

drop policy if exists "Authenticated users can delete own ad images"
  on storage.objects;

create policy "Authenticated users can delete own ad images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'ad-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

commit;
