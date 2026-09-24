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

The panel renders only the constrained protocol: input fields, choices, destination consent, external waits, and results. It does not evaluate agent-generated markup or scripts. Credentials are cleared on submission or interaction replacement. Read the source repository's README and SECURITY.md before using real credentials.

Each `login(options)` call starts one flow. For an existing session the panel renders dynamically discovered native choices plus the controller-added finish choice and sends the usual choose response; it does not finish automatically. The panel confirms only credential use and saving, not model-inferred login/logout/account outcomes. Any returned `accountId` names a saved credential record rather than verified browser identity.
