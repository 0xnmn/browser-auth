# Security boundaries

This is experimental human-supervised browser automation, not a hardened secret vault. Do not use production credentials until you have reviewed the threat model and host integration.

## Trusted components

The Node process, caller, credential store, AI SDK provider implementation, UI host, and CDP browser are trusted. CLI configuration modules are executable code with the host's privileges; custom agents are not a public extension point. A CDP endpoint grants broad browser control; keep it private and authenticated. Use explicit tenant-scoped stores and flows. Origin consent is not a substitute for authorization between users of your application.

## Implemented controls

- Model inputs omit input values and known credential values are redacted from observed text/metadata. This is best-effort known-value filtering, **not a general DLP boundary**. Authenticated page text and identifiers can still reach the configured model/provider.
- Models return schema-validated proposals rather than JavaScript, selectors, cookies, or network tools. Non-form clicks require user interaction. Native form submission must be associated with the observed fields.
- Credential destination consent uses exact HTTP(S) origins; non-loopback HTTP and URL userinfo are rejected. Saved service associations do not grant new credential-origin permission.
- Captured element handles are revalidated before writes; stale navigation/control references fail instead of being rematched. This narrows races but cannot make a hostile, mutating DOM atomic.
- Responses bind to a single-use interaction ID. Old responses are rejected. The only confirmations are controller-authored credential-use destination consent and credential-save consent. Page-provided text is still untrusted and can be socially misleading.
- No raw exception serialization in flow output. Opt-in traces use fixed names and metadata. Model-adapter telemetry is disabled. UI responses, store calls, CDP endpoints, and page content must never be logged by the host.
- Storage errors remain separate from website outcomes. Uncertain/cancelled writes are not automatically retried.
- Credential save candidates belong to one attempt. Returning to a native session chooser discards abandoned candidates; Back within the credential sequence preserves them. Native account selection may request reauthentication but does not authorize a logout fallback.

## Not protected

A website receiving a credential can read it, forward it, change form destinations, encode it, or reflect it in unrecognized forms. The library cannot isolate credentials from other CDP clients, extensions, browser instrumentation, same-process code, heap dumps, or provider instrumentation installed by the caller. Do not use an untrusted page just because its origin was displayed. Login, logout, and account-change outcomes are inferred by the model from the page, not independently verified identity or session proof. A returned `accountId` identifies a saved credential record, not the browser's current account.

Only an in-memory plaintext store ships. Custom stores receive raw values and must implement encryption, durable writes, authorization, secret rotation, and deletion policy as appropriate. Clearing references is not cryptographic erasure. Account labels, hints, and origins are sensitive metadata even though not passwords.

No network authentication API ships. If you add one, enforce authenticated flow ownership, CSRF protection, origin checks, transport encryption, one-time response semantics, request limits, and secret-safe logging. Do not expose a public endpoint that accepts arbitrary CDP URLs.

## Reporting

Do not put credentials, tokens, private CDP URLs, or production captures in public issues. Contact the repository maintainer privately before disclosing a vulnerability. Use synthetic repro fixtures and describe affected invariants. There is no security audit claim or production support guarantee for this pre-release.
