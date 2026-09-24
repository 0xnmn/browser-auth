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
