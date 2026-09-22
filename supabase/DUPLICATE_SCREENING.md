# Duplicate-image screening

The starting branch contained `pending_scan` moderation fields and a staging
comment saying that no scanner trigger was installed. It did not contain the
previously described SHA-256 scanner. This change extends that moderation row
rather than creating a second publication state.

## Checks and decisions

`scan-ad` downloads the untouched object from the private storage path, limits
it to 10 MiB, computes SHA-256 over the original bytes, then decodes a working
copy and resizes it to 9×8 for a 64-bit luminance difference hash (dHash).
On-site/source objects are never rendered, stamped, or overwritten.

The database serializes comparison decisions and checks all indexed images:

- same owner + same SHA-256: `duplicate_same_creator`, linked to the first ad;
- another owner + same SHA-256: `review_identical`;
- dHash Hamming distance 0–8: `review_similar` for side-by-side review;
- no match: duplicate status `passed` (not a claim of originality); and
- download, decode, or persistence failure: remains `pending`.

Safety and duplicate statuses are independent. The database publication gate
only derives `approved` after both are `passed`; neither pass overrides the
other check's pending, held, or failed result.

## Existing-image backfill

Applying the migration does **not** approve or scan anything. Already-approved
rows are conservatively initialized as having passed the legacy checks so a
schema migration does not unpublish them. Other existing rows remain pending.
After storage access is deliberately enabled in a reviewed staging deployment,
an operator should invoke `scan-ad` once per pending existing ad that has an
`image_storage_path`. Rows whose legacy data has only `image_url` must first be
mapped to their verified bucket path; do not infer paths from arbitrary URLs.
`ad_image_index_state.ready` defaults to false, so normal submissions fail
closed until an operator verifies this backfill and marks it ready with the
service role. This prevents the new scanner from silently ignoring old images.

## Limitations

dHash is small, explainable, and insensitive to modest resizing/compression,
but it is not authorship evidence. The threshold of 8 is an initial review
threshold, not an automatic-rejection threshold. Crops, screenshots with UI,
large borders, overlays, and changed text can evade it; visually simple shared
templates can collide and create review false positives. The controlled tests
cover representative pixel fixtures, not the variety of real-world artwork.
Reviewers must compare images and may clear matches caused by permission,
common templates, shared source material, or genuinely different ads.

Staging image uploads remain disabled by `frontend-config.js`. No hosted
backfill or end-to-end storage scan is performed by this repository change.
