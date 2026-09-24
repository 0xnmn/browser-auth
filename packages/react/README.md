# @browser-auth/react

Optional React 19 renderer for `@browser-auth/core` flows. Import `AuthPanel`, or subscribe to a host-supplied transport with `useAuthFlow`. Import `@browser-auth/react/styles.css` separately.

```tsx
<AuthPanel
  snapshot={snapshot}
  onRespond={(response) => transport.respond(response)}
  onCancel={() => cancellation.abort()}
/>
```

The host owns the transport and cancellation. Never send a live Playwright Page or a credential store to the frontend. When using HTTP/WebSockets, authenticate and authorize flow ownership, protect against CSRF, and keep responses out of logs. There is no built-in network authentication server.

`useAuthFlow` treats subscription errors and stream completion before a terminal snapshot as an `unknown` interruption. A received terminal result is preserved. Transport replacement and unmount ignore late updates and perform best-effort iterator teardown; the host still owns cancellation of the underlying authentication operation.

The panel renders the generic interaction contract: `{ id, message, fields, choices, confirmation?, pollAfterMs? }`. It does not switch on form/session/external interaction discriminators and does not evaluate agent-generated markup or scripts. Fields submit a `{ kind: "submit", interactionId, values }` response; buttons send `{ kind: "choose", interactionId, choiceId }`. A polling-only interaction renders as waiting and may be replaced, so hosts must continue consuming updates. Credentials are cleared on submission, choice, or interaction replacement.

Each `login(options)` call starts one flow. The panel renders every supplied choice generically; optional choice `kind` metadata affects presentation only, and it does not finish automatically. `confirmation` is controller-authored credential-use or save consent, not confirmation of model-inferred login/logout/account outcomes. Any returned `accountId` names a saved credential record rather than verified browser identity. Read the source repository's README and SECURITY.md before using real credentials.
