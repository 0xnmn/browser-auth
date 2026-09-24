# @browser-auth/core

Experimental TypeScript SDK and `browser-auth` CLI for human-supervised authentication in an existing Chromium browser. Requires Node 22.18+ or 24+.

The SDK exports `createAuth`, `InMemoryStore`, public option/result types, and the custom-agent/store contracts. `@browser-auth/core/protocol` provides Zod schemas for UI transports; `@browser-auth/core/tracing` provides opt-in OTLP export.

Configure exactly one AI SDK-compatible `model` or custom `agent`. Call `login`, `switchAccount`, or `logout` with a borrowed Playwright `page` or `{ cdpUrl, url }`. Consume the returned flow's `updates()`, collect human responses, and pass them to `respond()`; `result` settles after completion. Never log responses or CDP endpoints. Use `browser-auth --help` for terminal usage; the CLI accepts a trusted module exporting the same options through `--config`.

Only process-local plaintext storage is bundled. Custom stores implement `list/get/save/delete` and own encryption and access control. Model output does not prove session identity; the human confirms the outcome. Passkeys, CAPTCHAs, and similar external challenges are completed in the original browser, not bypassed. This package is not a vault or a guarantee of universal website compatibility.

Read the root README, SECURITY.md, and AGENTS.md in the source repository for the full lifecycle, threat model, tests, and contribution instructions.
