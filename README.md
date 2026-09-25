# Browser Auth

Human-supervised sign-in for an **existing Chromium browser**. A TypeScript SDK, CLI, and optional React renderer share one controller. The agent observes the page and proposes constrained actions; the controller handles credentials, destination consent, interaction validation, and storage.

**Experimental, pre-release.** Package names are provisional and not published. Deterministic local-browser tests do not establish arbitrary-website or real-model reliability. This is not a credential vault or a hosted authentication service.

## What works

- Mid-workflow reauthentication via a CDP endpoint and website URL, with an optional standard CDP target ID for precise tab selection. Existing cookies, tabs, and context are preserved.
- Partial initial username/email/phone/password/custom fields; prompt only for missing or previously attempted values. No credential values in agent proposals.
- Multiple saved logins per website, exact-origin credential associations, and controller-validated native account choices such as switch, add, logout, and finish.
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

// Forward every generic interaction to your UI; send its answer back with
// flow.respond(response). Do not await result before consuming interactions.
for await (const snapshot of flow.updates()) {
  // Render synchronously; replace the previous prompt when snapshots change.
  yourUi.render(snapshot, {
    onRespond: (response: AuthResponse) => flow.respond(response),
    onCancel: () => cancellation.abort(),
  }); // Do not log responses: they can contain secrets.
}
const result = await flow.result;
```

The `cdpUrl` and `yourUi` variables above belong to the host application. Replace `your-model-name` with a model supported by your provider. A waiting snapshot always has the same public shape: `{ id, message, fields, choices, confirmation?, pollAfterMs? }`. Submit fields with `{ kind: "submit", interactionId, values }` or select a choice with `{ kind: "choose", interactionId, choiceId }`. `pollAfterMs` means the controller may replace the interaction after polling; it is not a separate external-interaction type. Keep consuming updates while any prompt is open, clear replaced UI, and never replay responses. The bundled CLI and React panel handle this lifecycle; `useAuthFlow` connects the panel to a host-supplied transport.

Every call to `login` starts one flow. The agent is instructed to explore native account menus before offering account actions; account/provider/method decisions become ordinary public `choices`. Choice `kind` is optional metadata such as `finish`, `logout`, `switch`, `add`, or `back`; render unknown or absent kinds generically. The controller validates captured controls before acting and never selects an account or logs out as a fallback. Confirmations use the same interaction shape and are controller-authored only for credential destination and saving consent.

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

### Live diagnostic transcript

Every flow exposes `transcript(): AsyncIterable<AuthTranscriptEvent>` alongside `updates()`, `respond()`, and `result`. No enable flag, callback, or screenshot option is needed. Subscribe immediately after `login()` to receive the initial `start` event, even if the flow fails immediately:

```ts
const flow = auth.login({ cdpUrl, url: "https://service.example" });
const transcript = flow.transcript(); // Subscribes now, not on the first next().
const recording = (async () => {
  for await (const event of transcript) {
    await writePrivateEvent(event); // Your private diagnostic sink; handle gaps.
  }
})();
await renderFlow(flow); // Your existing updates()/respond() consumer runs concurrently.
await recording;
const result = await flow.result;
```

Events have a flow-local `sequence` and epoch-millisecond `timestamp`. The discriminated `type` includes `start`, `observation` (the agent input), `proposal` (schema-validated tool kind and arguments), `execution` (completed/rejected/failed controller processing), `interaction`, value-free `response`, sanitized `error`, and final `result`. Observation/proposal/execution events share a one-based model `step`. `execution.writeAttempted` concerns that proposal; error events distinguish cumulative `writeAttempted` from `actionWriteAttempted`, and preserve `deadline`, `caller_cancelled`, and `action_timeout` reasons. A completed execution is not proof of successful website authentication. Invalid proposals are not recorded verbatim. Raw provider messages/errors and hidden model reasoning are never included.

This is a live stream, not a replay log: events emitted without subscribers are not retained, later subscribers do not receive history, and subscriptions after completion end immediately. Each subscriber independently buffers at most 64 events and 8 MiB of serialized event data. Slow consumers receive `gap` events with discarded sequence ranges instead of blocking authentication. Oversized individual events can also be discarded; diagnostic serialization failures produce a `recording_failed` gap. Streams drain and close on completion; breaking iteration or calling the iterator's `return()` unsubscribes. Events are isolated copies, not mutable controller state.

**Transcripts contain sensitive website/account content and are separate from metadata-only OTLP tracing.** Screenshots are included automatically only when already captured under the browser observation policy: editable controls are masked, and screenshots are withheld once any credential value is known. No extra captures occur. Submitted responses contain field IDs, never values. Known reflected values are redacted structurally from observations, proposals, interactions, and results; a matching content string is replaced entirely to avoid partially filtered embedded JSON. This is not hostile-site confidentiality or general DLP: unknown/pre-existing browser content may be sensitive, and earlier events/images are not retroactively sanitized when a value becomes known. Protect storage, access, and retention; do not publish real-account transcripts.

## Credential storage and cross-domain login

Only `InMemoryStore` is bundled. It stores plaintext in process memory and defensively copies records. It is not encrypted persistence and does not securely erase the JavaScript heap. A custom `CredentialStore` implements `list`, `get`, `save`, and `delete`. `list` returns metadata only; **`get` and `save` receive raw credentials**. The application owns encryption, tenant scoping, access controls, and retention. Hold your store reference if you need raw access; results never include credentials.

Records distinguish `serviceOrigins` (where the account is useful) from credential entries with exact `origin` values (where credentials may be entered). A login for a mail service may discover credentials at its identity provider. The identity provider's origin is approved explicitly, then associated with the original service after inferred login success and saving. No model-inferred `google.com` suffix trust, wildcard origin grants, or cookie export is used. Ports and schemes matter. HTTPS is required except loopback HTTP for development. Existing stored exact-origin entries authorize reuse; supplied/new values require consent unless used at an already authorized stored destination.

Supplied fields override stored values for the current attempt. Choose “Use another account” to save a new record instead of updating the selected one. First version persistence is conservative: only `username`, `email`, `phone`, and `password` are saved. Fields classified as `code` and arbitrary custom fields are not saved. This relies on correct agent field classification; it is not a universal detector of one-time secrets.

Website Back preserves a multi-step credential attempt. Returning to a native session chooser abandons its credential-save candidates, so a later native switch cannot save earlier inputs. Selecting an existing browser account can continue through password/OTP reauthentication without logging out as a fallback. `accountId` is returned when a saved record actually supplied a filled value in the completed attempt, even with `save: "never"` or declined saving; merely selecting a record does not attach its ID.

`accounts.list()` and `accounts.remove()` reject with fixed `Error` messages and a `code` property (`account_list_failed` / `account_remove_failed`); raw store errors and their causes are not exposed.

## Models and limits

```ts
const auth = createAuth({
  model: { provider: "openai", model: "your-model-name" },
  limits: { maxSteps: 30, timeoutMs: 180_000, actionTimeoutMs: 10_000 },
});
```

The SDK owns the agent loop, observations, and action validation; custom agents and proposal parsers are not public APIs. The internal model adapter exposes named AI SDK tools generated from the private proposal schema, requires exactly one tool call, and disables AI SDK telemetry and adapter retries. The controller retries transient model connection/server failures at most twice consecutively after fresh observation, without replaying browser actions. Unknown element references receive corrective feedback before any effect, with a three-consecutive-failure limit. The tools have schemas but no execute callbacks: the controller interprets accepted proposals. Alongside bounded page actions, tools can list/switch/create/close flow-scoped tabs and list observed frames. Tab and frame metadata contains opaque IDs, origins, and provenance—not URLs or titles; only tabs created by the flow can be closed. There is one `ask_user` proposal with field bindings, native choices, a submit reference, and an `external` boolean; these private proposal details are normalized to the generic public interaction above. Field observations expose only whether an input is filled, never its value. Configuration modules are trusted same-process code, not sandboxed plugins. Longer human challenges may need larger timeouts. Unchanged external challenges without choices are polled without model calls or model-step consumption.

Model configuration is a discriminated union with common `{ model, apiKey?, baseURL?, headers? }` fields. It mirrors a focused subset of AI SDK provider settings with package-owned types; no provider-library imports are needed.

| `provider`          | Endpoint and routing controls                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `openai`            | `api?: "responses" \| "chat"`; defaults to Responses. `baseURL` overrides the API root, not the API mode. |
| `anthropic`         | Messages API; optional `baseURL` override.                                                                |
| `openai-compatible` | Chat Completions; requires `baseURL`. Optional `name`, `queryParams`, and `supportsStructuredOutputs`.    |
| `gateway`           | Vercel AI Gateway; optional `baseURL` override and `providerOptions.gateway: { order?, only?, models? }`. |

`baseURL` is the HTTP(S) API root, **not** the full operation URL: e.g. `https://proxy.example/v1`, to which the adapter appends `/responses`, `/chat/completions`, or `/messages`. Gateway uses its own AI SDK protocol, not Chat Completions; use `openai-compatible` for a chat-compatible proxy. Keep endpoint configuration server-side and trusted: the selected endpoint and upstream providers receive page observations. Never put private keys in frontend code or logs.

OpenAI/Anthropic use their standard endpoints and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` if `apiKey` is omitted; Gateway supports `AI_GATEWAY_API_KEY`. Compatible endpoints must support AI SDK tool calls; set `supportsStructuredOutputs: true` only when they support JSON Schema response formats. Every returned tool input is validated locally against the proposal schema.

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

The only browser command is `login`; there is no `--action` option. Interactive and JSON modes expose the same generic interaction and wait for an explicit response. The CLI does not silently select `finish`. JSON clients continue the flow with the unchanged submit or choose response shapes.

All operation options are accepted through `--input /private/options.json`: `cdpUrl`, `url`, `cdpHeaders`, `targetId`, partial `credentials`, `accountId`, and the operation's save/label/forget options. Only fields valid for that operation are accepted. Keep secret files out of Git and readable only by the owner; this is input transport, not a credential file store. Explicit flags override file fields. CDP precedence is `--cdp` → input-file `cdpUrl` → `BROWSER_AUTH_CDP_URL` → `http://127.0.0.1:9222`. `--target-id` selects a specific tab. Model configuration, stores, limits, and tracing work through the same `AuthOptions` configuration as the SDK.

**Automation:** `browser-auth login --config ./auth.config.mjs --input /private/options.json --json` emits one `AuthSnapshot` JSON object per stdout line, including the final `done` result. Write one plain `AuthResponse` per stdin line, or `{"kind":"cancel"}`. Keep stdin open while the flow runs; EOF cancels it. Stale responses are rejected with a fixed stderr message; malformed/oversized input cancels rather than replaying a browser write. Input files and response lines are limited to 256 KiB, with individual response values limited to 8,192 characters. `--input -` is deliberately rejected: stdin is reserved for flow responses. Responses contain secrets—never capture stdin in logs. Stdout carries snapshots, not credentials or echoed responses, and stderr carries safe diagnostics.

**Transcript recording:** Add `--transcript /private/new-session.jsonl` in either interactive or JSON mode. The CLI consumes the same flow stream concurrently and writes JSONL separately; stdout's snapshot protocol is unchanged. It creates a new file with exclusive `wx` access and mode `0600` before starting login, refuses to overwrite existing files, and flushes/closes before returning. Open failures prevent login. Write/flush/close failures or stream gaps print a safe stderr diagnostic and exit 1 while preserving the actual authentication result; they never cancel or retry login. Partial transcript files are retained. There are no transcript or screenshot configuration knobs in the SDK/login options.

| SDK capability                     | CLI equivalent                                             |
| ---------------------------------- | ---------------------------------------------------------- |
| `login(options)`                   | `login`                                                    |
| All target and operation options   | `--input` plus explicit flags                              |
| `accounts.list`, `accounts.remove` | `accounts list`, `accounts remove`                         |
| `updates()`, `respond()`, `result` | `--json` stdout snapshots / stdin responses / final `done` |
| `transcript()`                     | `--transcript <new-file>` JSONL, separate from stdout      |
| `AbortSignal`                      | Ctrl+C, JSON cancel, or stdin EOF                          |
| Model, store, limits, tracing      | Shared `--config` module                                   |

In `--json` mode, command-syntax, configuration, input, and account-operation errors also emit a `done` / `failed` snapshot with a stable code. Invalid syntax exits 2; runtime/startup failures exit 1. A broken stdout cancels an active flow and exits 1 without retrying the browser action or promising a deliverable JSON result. Interactive mode prints the explanation for `unknown`, not just its status.

## Optional React and tracing

`@browser-auth/react` exports `AuthPanel` and `useAuthFlow`. Import `@browser-auth/react/styles.css` separately. Pass a snapshot, an async `onRespond`, and optional `onCancel`; or subscribe using a transport with `updates()` and `respond()`. The panel renders the generic `fields`, `choices`, `confirmation`, and polling states rather than branching on interaction kinds. Secret inputs are uncontrolled and cleared on submission or interaction replacement. The package does not ship a network server. Your host must authenticate/authorize the transport, prevent CSRF/replay, bound request sizes, and keep credentials out of request logs. Validate wire data with `parseSnapshot`, `parseResponse`, `parseInteraction`, or `parseResult` from `@browser-auth/core/protocol`. They accept `unknown` and return package-owned types, throwing fixed errors on invalid data. No schema-library objects are public.

```ts
import { createOtlpTracing } from "@browser-auth/core/tracing";
const tracing = await createOtlpTracing({ url: collectorTraceEndpoint });
const auth = createAuth({ model, tracer: tracing.tracer });
// Run and consume flows, then flush before exiting:
await tracing.shutdown();
```

Tracing is off by default. The helper creates a private provider and does not register a global tracer. It exports operation/result, step counts, and action kinds—not page text, URLs, headers, credentials, or raw exceptions. Its returned tracer implements the package-owned `AuthTracer.startFlow(operation)` contract, producing an `AuthTrace` with `step(index)`, `action(kind)`, and `end(resultStatus)`. Custom recorders implement these small interfaces, not OpenTelemetry types. In CLI config, register `tracing.shutdown()` with a `beforeExit` handler to flush before the process exits. Do not add host instrumentation that records prompt or credential payloads.

## Boundaries and current limitations

Stale choices are consumed and refreshed within the same flow, never replayed. Freshness is a conservative document/text and captured-handle check, not server-side verification. The model receives a bounded DOM-hierarchy observation with SDK-owned element references. Screenshots mask editable controls before any private value is known and are withheld once `Redactor.hasValues` is true. This reduces accidental exposure; it is not perfect secrecy. SSO popups can return observation to the service page even if they remain open; no popup is closed by the SDK. Outcomes still depend on model interpretation.

See [SECURITY.md](SECURITY.md) and the [design plan](docs/design.md). There is no guarantee of support for every website. The model has no cookie, storage, network, arbitrary-JavaScript, or direct secret tool; private field filling and native-choice dispatch remain controller operations. That does not protect pre-existing browser data from observation or credentials from a hostile destination page. Routine sign-in navigation and continuation clicks run without confirmation; provider, account and authentication-method decisions remain user choices. This is a bounded authentication controller, not full agent-browser parity. Popup, tab, and iframe handling is bounded to the initially selected page, observed descendant popups, and flow-created pages; unrelated caller tabs are never listed. Native JavaScript dialogs are unsupported: they are dismissed without accepting or providing values, and the flow stops with `unknown`; inspect the session before retrying. Human challenges require access to the original browser; there is no remote-desktop stream. Recovery/enrollment, automatic TOTP, credential imports, password managers, encrypted file stores, and session revocation across devices are outside v1.

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
