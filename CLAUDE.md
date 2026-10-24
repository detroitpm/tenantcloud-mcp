# Project instructions

## Privacy / PII

Never put real customer data into commits, code, tests, docs, or commit messages.
This includes real lead/tenant/owner names, emails, phone numbers, and addresses
seen while probing the live TenantCloud API. Use synthetic placeholders instead
(e.g. "Jane Doe", "j@example.com"). When verifying API behavior against live data,
keep the real values in the conversation only - never persist them to the repo.

## Shipping changes

The owner has authorized pushing to production without asking. When a change
is done and typecheck + tests pass: push the branch, open a PR to `main`, and
merge it. Merging to `main` is the production deploy (Railway). Still confirm
first for anything that deletes data or messages tenants/owners.
