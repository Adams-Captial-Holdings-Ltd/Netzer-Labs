# Force a CloudFront invalidation

CloudFront serves `/dashboard` and `/dashboard/*` through the managed **CachingOptimized** policy (default edge TTL 24h, max 1 year), and the actual cache duration follows the origin's `Cache-Control` headers — hashed SPA bundles are served `immutable`, so the edge can hold an old version well past a deploy. If you ship new SPA bundle bytes and want the edge to forget the old version immediately, invalidate.

## Symptom

- You changed `src/adapters/dashboard/public/...` and deployed, but the browser still shows the old SPA after a hard reload
- Stale CSS / JS at the edge

## Verify

```bash
# Compare the bytes at origin vs at edge
curl -sS https://origin.claudeclaw-enterprise.com/dashboard/app.js | shasum
curl -sS https://claudeclaw-enterprise.com/dashboard/app.js | shasum
# Different sums → CloudFront is caching the old version
```

## Fix

```bash
DIST_ID=$(aws cloudformation describe-stacks --stack-name CCE-Security \
  --no-cli-pager --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistId'].OutputValue" \
  --output text)

aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/dashboard*" "/dashboard/*" --no-cli-pager \
  --query 'Invalidation.{Id:Id, Status:Status}'

# Wait until the invalidation completes (~1–5 min)
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" \
  --id "<id from the previous output>"
```

## Verify after

```bash
curl -sS https://claudeclaw-enterprise.com/dashboard/app.js | shasum
# expect: matches the origin hash
```

## Cost note

The first 1,000 paths invalidated per month are free. After that it's $0.005/path. Practical impact: invalidating `/dashboard*` + `/dashboard/*` counts as 2 paths each invocation, so you can do this ~500 times per month for free.

## Why this isn't automatic

A future improvement (D4 follow-up): the dashboard deploy could checksum bundle assets and only force invalidation when the hashes change. For now the manual step is the workflow.
