# Export verification — 2026-10-19

Verified against the sanitized export, with no real `.env` or market-data cache.

- `npm run bootstrap`: clean locked installation succeeded for all three dependency trees (lifecycle scripts disabled).
- `npm run test:all`: **1,834 passed**, zero failures (shared/new-market workspace 1,140; Stocks 302; Crypto 392).
- `npm run check`: all configured syntax checks passed, including 352 shared-workspace JavaScript files and eight Crypto hosting files.
- All six repository wrappers passed syntax checks and `npm run info` selected the correct primary application. Crypto uses its independent `standalone.js` entry point.
- All six exports match the same 721-file source manifest by SHA-256. The complete test/syntax run was performed once on that identical integration bundle in the Stocks export; it was not redundantly run six times.
- Pre-export checks compared content against configured credential values and common GitHub/Discord/private-key/access-key patterns. Three intentionally invalid credential-URL test cases use reserved example domains. No configured credentials were included.
- Git publication uses an explicit source-file allowlist. Local credentials, runtime caches, ledgers, logs, private hosting configuration, dependencies and archives are not included.

No Discord bot was started, command registration was not run, and no paper/live trade was placed by these export checks. This validates packaging and existing automated tests, not current market-data coverage, provider entitlements, deployment state or profitable performance.

Each repository contains one primary application plus the preserved shared integration bundle. Cross-checkout paper coordination requires explicit common absolute ledger/research paths on the same filesystem; default paths are separate.
