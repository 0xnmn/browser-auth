# @browser-auth/core

Experimental TypeScript SDK and `browser-auth` CLI for human-supervised authentication in an existing Chromium browser. Requires Node 22.18+ or 24+.

The SDK exports `createAuth`, `InMemoryStore`, package-owned option/result types, and a credential-store contract. `@browser-auth/core/protocol` provides plain parser functions for UI transports; `@browser-auth/core/tracing` provides opt-in OTLP export behind package-owned tracing interfaces. Internal library types and agent contracts are not part of the public API.

Configure a plain `model: { provider, model, apiKey?, baseURL?, headers? }`; the SDK owns the agent loop. Supported providers are `openai`, `anthropic`, `openai-compatible` (requires `baseURL`), and `gateway`. OpenAI supports `api: "responses" | "chat"`; compatible endpoints support `name`, `queryParams`, and `supportsStructuredOutputs`. Gateway supports `providerOptions.gateway: { order?, only?, models? }` for provider routing and fallback models, following AI SDK field names without exporting its types. Call `login`, `switchAccount`, or `logout` with `{ cdpUrl, url, cdpHeaders?, targetId? }`. Consume the flow's `updates()`, collect human responses, and pass them to `respond()`; `result` settles after completion. Never log responses or CDP endpoints. The CLI accepts the same configuration through `--config`, operation data through private `--input` JSON files, and exposes `accounts list/remove`. Its `--json` mode emits snapshots and accepts responses or cancellation over JSON lines.

Only process-local plaintext storage is bundled. Custom stores implement `list/get/save/delete` and own encryption and access control. Model output does not prove session identity; the human confirms the outcome. Passkeys, CAPTCHAs, and similar external challenges are completed in the original browser, not bypassed. This package is not a vault or a guarantee of universal website compatibility.

Read the root README, SECURITY.md, and AGENTS.md in the source repository for the full lifecycle, threat model, tests, and contribution instructions.
