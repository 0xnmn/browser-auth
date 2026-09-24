# Browser Auth

Human-supervised sign-in for an **existing Chromium browser**. A TypeScript SDK, CLI, and optional React renderer share one controller. The agent observes the page and proposes constrained actions; the controller handles credentials, destination consent, interaction validation, and storage.

**Experimental, pre-release.** Package names are provisional and not published. Deterministic local-browser tests do not establish arbitrary-website or real-model reliability. This is not a credential vault or a hosted authentication service.

## What works

- Mid-workflow reauthentication in the caller's Playwright `Page`, or attachment via a CDP endpoint and website URL. Existing cookies, tabs, and context are preserved.
- Partial initial username/email/phone/password/custom fields; prompt only for missing or previously attempted values. No credential values in agent proposals.
- Multiple saved logins per website, automatic account discovery, exact-origin credential associations, and user-selected native account switching.
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

Use the built package from a workspace or install its locally packed tarball. Choose an AI SDK-compatible model/provider yourself; the core does not hardcode a provider or read provider credentials.

```ts
import { createAuth, InMemoryStore } from "@browser-auth/core";
import type { AuthResponse } from "@browser-auth/core";

const store = new InMemoryStore();
const auth = createAuth({ model, store }); // `model` is your AI SDK LanguageModel
const cancellation = new AbortController();
const flow = auth.login({
  page, // Your existing Playwright Page, not a CDP page ID
  credentials: { email: "person@example.com" }, // Partial inputs are fine
  save: "ask",
  label: "Personal",
  signal: cancellation.signal,
});

// Forward updates to your UI; send its answers back with flow.respond(response).
// Do not await the result before arranging an interaction consumer.
for await (const snapshot of flow.updates()) {
  // Render synchronously; replace the previous prompt when snapshots change.
  yourUi.render(snapshot, {
    onRespond: (response: AuthResponse) => flow.respond(response),
    onCancel: () => cancellation.abort(),
  }); // Do not log responses: they can contain secrets.
}
const result = await flow.result;
```

The `model`, `page`, and `yourUi` variables above belong to the host application. For external challenges, keep consuming updates while a prompt is open: it can expire or be replaced. Cancel/clear the old UI on replacement and never replay responses. The bundled CLI and React panel handle this lifecycle; `useAuthFlow` connects the panel to a host-supplied transport.

Instead of a borrowed Page:

```ts
auth.login({ cdpUrl, url: "https://service.example", save: "never" });
auth.switchAccount({ page, accountId });
auth.logout({ page });
auth.logout({ page, accountId, forgetCredentials: true });
await auth.accounts.list({ serviceOrigin: "https://service.example" });
await auth.accounts.remove(accountId);
```

These operations return flows that also require interaction consumers. A CDP target optionally accepts `cdpHeaders`. Target selection prefers an exact URL, then a unique same-origin tab, then asks on ambiguity (titles shown). If there is no match, it opens a tab in the **existing default context**. Identically titled tabs remain ambiguous: pass the caller's Page for precise targeting. We disconnect attachments we create, but never close borrowed pages, contexts, or browsers. Tabs opened by the workflow remain available. Do not mutate the same page from two controllers concurrently. One auth client allows one active flow.

### Results and account identity

`flow.result` resolves to `authenticated`, `signed-out`, `unknown`, `cancelled`, or `failed`. Invalid construction/arguments and invalid responses reject/throw immediately. Runtime browser/model/store failures use fixed codes and safe messages rather than raw exceptions. The agent proposes completion, but **the human confirms the browser's actual outcome**. When a saved account is selected, the confirmation identifies its label; `accountId` is associated only with that attestation or a newly saved record. This is not server-side identity verification. Use meaningful account labels.

Saving is separate from login: a successful login can return `save.status: "failed"`. Logout deletion is also independent. **`forgetCredentials: true` attempts deletion even if logout fails or is unconfirmed**, unless cancelled before a browser action. Forgetting credentials does not revoke cookies or sessions. Cancellation after a browser write may yield `unknown`; inspect the session before retrying. Already confirmed authentication remains successful if only the later save-consent prompt is cancelled. Store writes already started are awaited to report their actual outcome.

## Credential storage and cross-domain login

Only `InMemoryStore` is bundled. It stores plaintext in process memory and defensively copies records. It is not encrypted persistence and does not securely erase the JavaScript heap. A custom `CredentialStore` implements `list`, `get`, `save`, and `delete`. `list` returns metadata only; **`get` and `save` receive raw credentials**. The application owns encryption, tenant scoping, access controls, and retention. Hold your store reference if you need raw access; results never include credentials.

Records distinguish `serviceOrigins` (where the account is useful) from credential entries with exact `origin` values (where credentials may be entered). A login for a mail service may discover credentials at its identity provider. The identity provider's origin is approved explicitly, then associated with the original service after confirmed login/save. No model-inferred `google.com` suffix trust, wildcard origin grants, or cookie export is used. Ports and schemes matter. HTTPS is required except loopback HTTP for development. Existing stored exact-origin entries authorize reuse; supplied/new values require consent unless used at an already authorized stored destination.

Supplied fields override stored values for the current attempt. Choose “Use another account” to save a new record instead of updating the selected one. First version persistence is conservative: only `username`, `email`, `phone`, and `password` are saved. Fields classified as `code` and arbitrary custom fields are not saved. This relies on correct agent field classification; it is not a universal detector of one-time secrets.

## Agents and limits

```ts
const auth = createAuth({
  agent: {
    async next(observation, { signal }) {
      // Return an AuthProposal. No Page, CDP endpoint, or credential values provided.
      return { kind: "wait" };
    },
  },
  limits: { maxSteps: 30, timeoutMs: 180_000, actionTimeoutMs: 10_000 },
});
```

Provide exactly one `model` or `agent`. Proposals are validated with Zod: `form`, `click`, `external`, `wait`, or `done`. Element IDs are ephemeral, tied to captured handles and page/frame URLs. The default AI SDK adapter uses structured output, no automatic model retries, and disables its telemetry. Custom agents/configuration modules are trusted same-process code, not sandboxed plugins. Longer external challenges may need larger limits; polling consumes steps.

## CLI

Use a trusted `.mjs` module exporting the same `AuthOptions` you would pass to `createAuth` (configured `model` or `agent`, optional shared persistent store/tracer). Do not put credentials in command-line arguments or commit provider keys.

```sh
export BROWSER_AUTH_CDP_URL='your-private-cdp-endpoint'
browser-auth login https://service.example --config ./auth.config.mjs --save ask
browser-auth switch https://service.example --config ./auth.config.mjs --account-id ACCOUNT
browser-auth logout https://service.example --config ./auth.config.mjs --account-id ACCOUNT --forget
```

From this checkout: `node packages/browser-auth/dist/cli/main.js --help`. Passwords/codes are masked. Ctrl+C cancels. Exit codes: 0 confirmed success, 1 failed/unknown or save/delete failure, 2 invalid invocation, 130 cancellation before browser mutation. By default, saved credentials disappear when the CLI process exits; cross-invocation reuse requires a host-provided persistent store. No JSON-over-stdio credential transport is exposed.

## Optional React and tracing

`@browser-auth/react` exports `AuthPanel` and `useAuthFlow`. Import `@browser-auth/react/styles.css` separately. Pass a snapshot, an async `onRespond`, and optional `onCancel`; or subscribe using a transport with `updates()` and `respond()`. Secret inputs are uncontrolled and cleared on submission or interaction replacement. The package does not ship a network server. Your host must authenticate/authorize the transport, prevent CSRF/replay, bound request sizes, and keep credentials out of request logs. Parse wire data using `snapshotSchema` and `responseSchema` from `@browser-auth/core/protocol`.

```ts
import { createOtlpTracing } from "@browser-auth/core/tracing";
const tracing = await createOtlpTracing({ url: collectorTraceEndpoint });
const auth = createAuth({ model, tracer: tracing.tracer });
// Run and consume flows, then flush before exiting:
await tracing.shutdown();
```

Tracing is off by default. The helper creates a private provider and does not register a global tracer. It exports operation/result, step counts, and action kinds—not page text, URLs, headers, credentials, or raw exceptions. A host tracer can also be supplied directly. Do not add host instrumentation that records prompt or credential payloads.

## Boundaries and current limitations

See [SECURITY.md](SECURITY.md). There is no guarantee of support for every website. SPA controls not associated with an actual HTML form need a fill-only proposal followed by an explicit user-confirmed click; the default agent can still misclassify them. Native switching never falls back to logout/login. Popup and iframe handling is bounded and best-effort. External challenges require access to the original browser; there is no remote-desktop stream. Recovery/enrollment, automatic TOTP, credential imports, password managers, encrypted file stores, and session revocation across devices are outside v1.

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
