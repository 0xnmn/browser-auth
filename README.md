# Browser Auth

Human-supervised sign-in for an **existing Chromium browser**. A TypeScript SDK, CLI, and optional React renderer share one controller. The agent observes the page and proposes constrained actions; the controller handles credentials, destination consent, interaction validation, and storage.

**Experimental, pre-release.** Package names are provisional and not published. Deterministic local-browser tests do not establish arbitrary-website or real-model reliability. This is not a credential vault or a hosted authentication service.

## What works

- Mid-workflow reauthentication via a CDP endpoint and website URL, with an optional standard CDP target ID for precise tab selection. Existing cookies, tabs, and context are preserved.
- Partial initial username/email/phone/password/custom fields; prompt only for missing or previously attempted values. No credential values in agent proposals.
- Multiple saved logins per website, automatic account discovery, exact-origin credential associations, and native account selection that offers discovered existing accounts and add-account choices together.
- Multi-step forms, website Back/SSO choices, manually entered verification codes, and external waits for a human to complete passkeys, magic links, or CAPTCHAs **in the browser**. These are not automatic challenge solvers.
- Logout, independent credential deletion, `save: "yes" | "ask" | "never"`, single-use responses, abort signals, safe errors, and opt-in OTLP traces.

## Build and verify

Node 22.18+ or 24+, pnpm 12. After cloning:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright-core install chromium
pnpm check
pnpm test
pnpm test:integration
pnpm eval:smoke
pnpm test:package
pnpm preview
```

On Linux CI, install Chromium OS dependencies with `pnpm exec playwright-core install --with-deps chromium`. Build precedes typechecking because React consumes the core package's exported declarations. `pnpm preview` is a synthetic, interactive component gallery; it does not expose authentication over HTTP. Real-model evaluations are opt-in: see [evals](evals/README.md).

## SDK

Use the built package from a workspace or install its locally packed tarball. The public API uses package-owned types and plain data: no Playwright Page, AI SDK model, OpenTelemetry tracer, or Zod schema objects. Internal libraries can change without changing the application contract.

```ts
import { createAuth, InMemoryStore } from "@browser-auth/core";
import type { AuthResponse } from "@browser-auth/core";

const store = new InMemoryStore();
const auth = createAuth({
  model: { provider: "openai", model: "your-model-name" },
  store,
});
const cancellation = new AbortController();
const flow = auth.login({
  cdpUrl, // Your existing browser's private CDP endpoint
  url: "https://service.example",
  credentials: { email: "person@example.com" }, // Partial inputs are fine
  save: "ask",
  label: "Personal",
  signal: cancellation.signal,
});

// Forward updates to your UI; send its answers back with flow.respond(response).
// Do not await the result before arranging an interaction consumer.
for await (const snapshot of flow.updates()) {
  // This example explicitly keeps an existing session. Applications may instead
  // render every session choice so the user can log out or change accounts.
  if (
    snapshot.status === "waiting" &&
    snapshot.interaction.kind === "session"
  ) {
    const finish = snapshot.interaction.choices.find(
      (choice) => choice.kind === "finish",
    );
    if (finish) {
      await flow.respond({
        kind: "choose",
        interactionId: snapshot.interaction.id,
        choiceId: finish.id,
      });
      continue;
    }
  }
  // Render synchronously; replace the previous prompt when snapshots change.
  yourUi.render(snapshot, {
    onRespond: (response: AuthResponse) => flow.respond(response),
    onCancel: () => cancellation.abort(),
  }); // Do not log responses: they can contain secrets.
}
const result = await flow.result;
```

The `cdpUrl` and `yourUi` variables above belong to the host application. Replace `your-model-name` with a model supported by your provider. For external challenges, keep consuming updates while a prompt is open: it can expire or be replaced. Cancel/clear the old UI on replacement and never replay responses. The bundled CLI and React panel handle this lifecycle; `useAuthFlow` connects the panel to a host-supplied transport.

Every call to `login` starts one flow. If the browser already has a signed-in session, the flow emits a `session` interaction whose choices are generated from observed native controls. The controller always appends a `finish` choice; other possible choice kinds are `logout`, `switch`, `add`, and `accounts`. `accounts` opens the site's native account menu so another observation can discover its entries—it does not imply that multiple accounts exist. Respond with the usual `{ kind: "choose", interactionId, choiceId }` to continue the same flow.

```ts
const target = { cdpUrl, url: "https://service.example" };
auth.login({ ...target, save: "never" });
auth.login({ ...target, accountId });
auth.login({ ...target, accountId, forgetCredentials: true });
await auth.accounts.list({ serviceOrigin: "https://service.example" });
await auth.accounts.remove(accountId);
```

`accountId` selects a saved credential record only if the flow needs a credential form. It does not select or identify an account already known to the browser. `forgetCredentials: true` requires `accountId` and deletes that saved record only if the user selects a logout choice—not when they finish the existing session or complete a login/account change. Account switching and adding use only offered native controls and never fall back to logout.

Browser operations return flows that require interaction consumers. A CDP target optionally accepts `cdpHeaders` and `targetId`. `targetId` is Chromium's standard `TargetID`, available from `Target.getTargets` or `Target.getTargetInfo` through any CDP client—not a library-specific page object. If supplied, it must identify an existing tab in the default context whose current origin matches `url`; a missing/mismatched target fails without opening another tab. Without it, selection prefers an exact URL, then a unique same-origin tab, then asks on ambiguity (titles shown). If there is no match, it opens a tab in the **existing default context**. We disconnect attachments we create, but never close the caller's tabs, context, or browser. Tabs opened by the workflow remain available. Do not mutate the same page from two controllers concurrently. One auth client allows one active flow.

### Results and account identity

`flow.result` resolves to `already-signed-in`, `authenticated`, `signed-out`, `unknown`, `cancelled`, or `failed`. Invalid construction/arguments and invalid responses reject/throw immediately. Runtime browser/model/store failures use fixed codes and safe messages rather than raw exceptions. Selecting `finish` returns `already-signed-in`; selecting logout returns `signed-out` when the model observes completion; credential login or a completed account change returns `authenticated`. There is no outcome-confirmation prompt. These outcomes are inferred from the page by the model, not identity attestation or server-side session verification. Human confirmations are used only before credentials are sent to a new exact origin and before credentials are saved. A returned `accountId` identifies only the saved credential record used or created by the flow, not a verified browser identity. Use meaningful account labels.

Saving is separate from login: a successful login can return `save.status: "failed"`. Logout deletion is also independent. **`forgetCredentials: true` attempts deletion even if logout fails or its outcome is unknown**, unless cancelled before a browser action. Forgetting credentials does not revoke cookies or sessions. Cancellation after a browser write may yield `unknown`; inspect the session before retrying. Model-inferred authentication remains successful if only the later save-consent prompt is cancelled. Store writes already started are awaited to report their actual outcome.

## Credential storage and cross-domain login

Only `InMemoryStore` is bundled. It stores plaintext in process memory and defensively copies records. It is not encrypted persistence and does not securely erase the JavaScript heap. A custom `CredentialStore` implements `list`, `get`, `save`, and `delete`. `list` returns metadata only; **`get` and `save` receive raw credentials**. The application owns encryption, tenant scoping, access controls, and retention. Hold your store reference if you need raw access; results never include credentials.

Records distinguish `serviceOrigins` (where the account is useful) from credential entries with exact `origin` values (where credentials may be entered). A login for a mail service may discover credentials at its identity provider. The identity provider's origin is approved explicitly, then associated with the original service after inferred login success and saving. No model-inferred `google.com` suffix trust, wildcard origin grants, or cookie export is used. Ports and schemes matter. HTTPS is required except loopback HTTP for development. Existing stored exact-origin entries authorize reuse; supplied/new values require consent unless used at an already authorized stored destination.

Supplied fields override stored values for the current attempt. Choose “Use another account” to save a new record instead of updating the selected one. First version persistence is conservative: only `username`, `email`, `phone`, and `password` are saved. Fields classified as `code` and arbitrary custom fields are not saved. This relies on correct agent field classification; it is not a universal detector of one-time secrets.

## Models and limits

```ts
const auth = createAuth({
  model: { provider: "openai", model: "your-model-name" },
  limits: { maxSteps: 30, timeoutMs: 180_000, actionTimeoutMs: 10_000 },
});
```

The SDK owns the agent loop, observations, and action validation; custom agents and proposal parsers are not public APIs. The internal model adapter uses structured output, no automatic model retries, and disables its telemetry. Configuration modules are trusted same-process code, not sandboxed plugins. Longer external challenges may need larger limits; polling consumes steps.

Model configuration is a discriminated union with common `{ model, apiKey?, baseURL?, headers? }` fields. It mirrors a focused subset of AI SDK provider settings with package-owned types; no provider-library imports are needed.

| `provider`          | Endpoint and routing controls                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `openai`            | `api?: "responses" \| "chat"`; defaults to Responses. `baseURL` overrides the API root, not the API mode. |
| `anthropic`         | Messages API; optional `baseURL` override.                                                                |
| `openai-compatible` | Chat Completions; requires `baseURL`. Optional `name`, `queryParams`, and `supportsStructuredOutputs`.    |
| `gateway`           | Vercel AI Gateway; optional `baseURL` override and `providerOptions.gateway: { order?, only?, models? }`. |

`baseURL` is the HTTP(S) API root, **not** the full operation URL: e.g. `https://proxy.example/v1`, to which the adapter appends `/responses`, `/chat/completions`, or `/messages`. Gateway uses its own AI SDK protocol, not Chat Completions; use `openai-compatible` for a chat-compatible proxy. Keep endpoint configuration server-side and trusted: the selected endpoint and upstream providers receive page observations. Never put private keys in frontend code or logs.

OpenAI/Anthropic use their standard endpoints and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` if `apiKey` is omitted; Gateway supports `AI_GATEWAY_API_KEY`. Compatible endpoints must support JSON output; set `supportsStructuredOutputs: true` only when they support JSON Schema response formats. It defaults to JSON-object output, with local proposal validation in either mode.

Gateway routing uses the AI SDK field names: `order` is provider preference, `only` restricts eligible providers, and `models` lists fallback **model IDs**, not providers. Omit unused lists; supplied lists must be nonempty. Routing is performed by Gateway, not by retrying authentication or browser actions. Direct providers do not accept Gateway routing options.

```ts
const auth = createAuth({
  model: {
    provider: "gateway",
    model: "anthropic/claude-sonnet-4.5",
    providerOptions: {
      gateway: {
        order: ["vertex", "anthropic"],
        only: ["vertex", "anthropic"],
        models: ["anthropic/claude-haiku-4.5"],
      },
    },
  },
});
```

This same configuration works in the CLI's `--config` module. See AI SDK's [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers), and [Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway) documentation for upstream semantics. Arbitrary provider hooks, model instances, and the full set of generation options are deliberately not public configuration.

## CLI

With `OPENAI_API_KEY` set and Chrome listening on local port 9222, run `pnpm cli login https://service.example`. No config file is required: the CLI defaults to OpenAI `gpt-6-luna` using the Responses API and reads `OPENAI_API_KEY` from the environment. It does not automatically load `.env` files.

To override those defaults, use `--config` with a trusted `.mjs` module exporting the same `AuthOptions` you would pass to `createAuth` (configured `model`, optional shared persistent store/tracer). The module replaces the default configuration. Do not put credentials in command-line arguments or commit provider keys. These defaults are CLI-only; SDK callers still supply model configuration explicitly.

```sh
export BROWSER_AUTH_CDP_URL='your-private-cdp-endpoint'
browser-auth login https://service.example --config ./auth.config.mjs --save ask
browser-auth login https://service.example --config ./auth.config.mjs --account-id ACCOUNT
browser-auth login https://service.example --config ./auth.config.mjs --account-id ACCOUNT --forget
browser-auth accounts list --config ./auth.config.mjs --service-origin https://service.example --json
browser-auth accounts remove --id ACCOUNT --config ./auth.config.mjs
```

From this checkout: `pnpm cli --help` or `pnpm cli login https://service.example --config ./auth.config.mjs` (no build required). The CLI defaults to CDP at `http://127.0.0.1:9222`; start Chrome with remote debugging enabled and a separate profile first. It does not launch a browser or scan ports. Saving defaults to `ask`. The SDK still requires an explicit `cdpUrl`. Passwords/codes are masked. Ctrl+C cancels. Exit codes: 0 success, 1 runtime/configuration/input failure or unknown outcome or save/delete failure, 2 invalid command syntax, 130 cancellation before browser mutation. By default, saved credentials disappear when the CLI process exits; cross-invocation reuse requires a host-provided persistent store. Account commands do not require CDP; listing also supports `--credential-origin` and returns metadata only.

The only browser command is `login`; there is no `--action` option. Both interactive and JSON modes expose the same `session` interaction and wait for an explicit choice. The CLI does not silently select `finish`. JSON clients continue the flow by writing a normal choose response to stdin.

All operation options are accepted through `--input /private/options.json`: `cdpUrl`, `url`, `cdpHeaders`, `targetId`, partial `credentials`, `accountId`, and the operation's save/label/forget options. Only fields valid for that operation are accepted. Keep secret files out of Git and readable only by the owner; this is input transport, not a credential file store. Explicit flags override file fields. CDP precedence is `--cdp` → input-file `cdpUrl` → `BROWSER_AUTH_CDP_URL` → `http://127.0.0.1:9222`. `--target-id` selects a specific tab. Model configuration, stores, limits, and tracing work through the same `AuthOptions` configuration as the SDK.

**Automation:** `browser-auth login --config ./auth.config.mjs --input /private/options.json --json` emits one `AuthSnapshot` JSON object per stdout line, including the final `done` result. Write one plain `AuthResponse` per stdin line, or `{"kind":"cancel"}`. Keep stdin open while the flow runs; EOF cancels it. Stale responses are rejected with a fixed stderr message; malformed/oversized input cancels rather than replaying a browser write. Input files and response lines are limited to 256 KiB, with individual response values limited to 8,192 characters. `--input -` is deliberately rejected: stdin is reserved for flow responses. Responses contain secrets—never capture stdin in logs. Stdout carries snapshots, not credentials or echoed responses, and stderr carries safe diagnostics.

| SDK capability                       | CLI equivalent                                             |
| ------------------------------------ | ---------------------------------------------------------- |
| `login(options)`                     | `login`                                                    |
| All target and operation options     | `--input` plus explicit flags                              |
| `accounts.list`, `accounts.remove`   | `accounts list`, `accounts remove`                         |
| `updates()`, `respond()`, `result`   | `--json` stdout snapshots / stdin responses / final `done` |
| `AbortSignal`                        | Ctrl+C, JSON cancel, or stdin EOF                          |
| Agent, model, store, limits, tracing | Shared `--config` module                                   |

## Optional React and tracing

`@browser-auth/react` exports `AuthPanel` and `useAuthFlow`. Import `@browser-auth/react/styles.css` separately. Pass a snapshot, an async `onRespond`, and optional `onCancel`; or subscribe using a transport with `updates()` and `respond()`. Secret inputs are uncontrolled and cleared on submission or interaction replacement. The package does not ship a network server. Your host must authenticate/authorize the transport, prevent CSRF/replay, bound request sizes, and keep credentials out of request logs. Validate wire data with `parseSnapshot`, `parseResponse`, `parseInteraction`, or `parseResult` from `@browser-auth/core/protocol`. They accept `unknown` and return package-owned types, throwing fixed errors on invalid data. No schema-library objects are public.

```ts
import { createOtlpTracing } from "@browser-auth/core/tracing";
const tracing = await createOtlpTracing({ url: collectorTraceEndpoint });
const auth = createAuth({ model, tracer: tracing.tracer });
// Run and consume flows, then flush before exiting:
await tracing.shutdown();
```

Tracing is off by default. The helper creates a private provider and does not register a global tracer. It exports operation/result, step counts, and action kinds—not page text, URLs, headers, credentials, or raw exceptions. Its returned tracer implements the package-owned `AuthTracer.startFlow(operation)` contract, producing an `AuthTrace` with `step(index)`, `action(kind)`, and `end(resultStatus)`. Custom recorders implement these small interfaces, not OpenTelemetry types. In CLI config, register `tracing.shutdown()` with a `beforeExit` handler to flush before the process exits. Do not add host instrumentation that records prompt or credential payloads.

## Boundaries and current limitations

See [SECURITY.md](SECURITY.md). There is no guarantee of support for every website. SPA controls not associated with an actual HTML form need a fill-only proposal followed by an explicit user-confirmed click; the default agent can still misclassify them. Native switching/adding never falls back to logout. Popup and iframe handling is bounded and best-effort. External challenges require access to the original browser; there is no remote-desktop stream. Recovery/enrollment, automatic TOTP, credential imports, password managers, encrypted file stores, and session revocation across devices are outside v1.

## Layout and contributing

```text
packages/browser-auth/src/
  auth.ts, types.ts, protocol.ts   public SDK and wire contract
  flow/                           controller and interaction lifecycle
  browser/                        shared CDP attachment, observations/actions
  credentials/                    store contract, memory store, per-flow secrets
  agent/                          constrained proposals and AI SDK adapter
  security/                       origins and known-value redaction
  cli/                            terminal adapter over the SDK
  tracing.ts                      opt-in private OTLP provider
packages/react/                   optional renderer and component examples
tests/fixtures, helpers, integration/
evals/                            opt-in agent evaluations
examples/                         synthetic preview server
```

Read [AGENTS.md](AGENTS.md) before changing code. Keep tests alongside pure logic and browser scenarios under `tests/`. Run all checks above plus `pnpm format:check` before submitting changes. No paid model calls or real accounts in ordinary tests. Public API is experimental until model/site evaluations and an independent security audit establish a stronger release baseline.
