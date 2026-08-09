## Summary

<!-- What changed? Keep this focused on one logical change. -->

## Why this change

<!-- What problem or requirement does this address? -->

## Risk and rollback

<!-- Name the primary risk, stop condition, and safe rollback path. -->

## Validation evidence

<!-- Paste command names and pass/fail summaries only. Do not paste credentials, tokens, or raw AWS posture output. -->

## Deployment impact

<!-- Choose one: none / staging only / production. State whether an operator action is required. -->

## Compatibility identifiers

<!-- List any intentionally retained CCE_*, claudeclaw, AWS, domain, OAuth, browser-storage, or release identifiers. -->

## Promotion source and target

- Source branch:
- Target branch:
- Promotion type: feature / fix / chore / development-to-qa / qa-to-staging / staging-to-production / hotfix / backport

## Checklist

- [ ] I declared the source and target branches above, and they follow the documented promotion path.
- [ ] The full root unit suite passes (`npm test`), or I documented an existing platform-only limitation with equivalent Ubuntu evidence.
- [ ] Root type-check and build pass (`npm run typecheck` and `npm run build`).
- [ ] Dashboard type-check and production build pass (`npm --prefix web run typecheck` and `npm --prefix web run build`).
- [ ] I updated and validated documentation when behavior, operations, architecture, or compatibility changed.
- [ ] This pull request contains no passwords, tokens, keys, credentials, private URLs, or other secret values.
- [ ] I did not rename existing `CCE_*`, `claudeclaw`, AWS resource, domain, browser-storage, or release identifiers unless an approved compatibility migration requires it.
- [ ] I documented deployment impact, rollback, and any required operator action.
- [ ] I did not disable checks, rewrite history, delete a long-lived branch, or use a force push.
