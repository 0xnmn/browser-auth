# Controller-owned browser authentication redesign

## Status and intent

- This document records the implemented redesign and its review rationale.
- The SDK automates authentication in a caller-owned Chromium context.
- It is a bounded authentication controller, not a general browser agent.
- It does not target full `agent-browser` action, observation, or recovery parity.
- Public contracts stay package-owned and independent of AI SDK, Playwright, and Zod.

## Trust boundaries

- The host process, controller, credential store, model provider, browser, and UI host are trusted.
- Page observations and page-authored labels are untrusted input.
- The model proposes actions; it never receives browser handles or private values.
- The controller owns consent, credential lookup, private field filling, writes, and completion.
- Exact origins authorize credential destinations; service association is not authorization.
- Interaction IDs are single-use and browser writes are not retried after uncertain outcomes.
- Model-visible data can include authenticated page text and pre-existing account identifiers.
- A hostile destination page can read and transform credentials after receiving them.
- Redaction mitigates accidental disclosure and does not establish perfect secrecy.

## Model proposal boundary

- `proposal-schema.ts` is the single private schema for model actions.
- Each schema branch becomes a named AI SDK tool.
- Tool names include bounded browser actions, `ask_user`, observation controls, scoped tab/frame context tools, and `done`.
- Tool definitions intentionally have schemas and descriptions but no execute callbacks.
- The AI SDK call uses `toolChoice: "required"` and accepts exactly one tool call.
- The selected tool name and input are reconstructed and validated against the union.
- Invalid names, inputs, missing output, and multiple calls become safe model failures.
- AI SDK telemetry is disabled and automatic model retries are disabled.
- The model cannot request arbitrary JavaScript evaluation.
- No proposal tool exposes cookies, web storage, request headers, or network interception.
- No proposal argument carries a password, code, or other private field value.

## One user-request proposal

- `ask_user` replaces private form/session/external proposal variants.
- It contains a message, field descriptors, choice descriptors, and `external` boolean.
- A field binds an observed element reference to a host credential key and display metadata.
- A field descriptor never contains the field value.
- An optional submit element is valid only with fields.
- Choices bind observed references to labels and controlled intents.
- Native intents are `switch`, `add`, `logout`, and `finish`.
- `continue` and `back` cover ordinary authentication decisions.
- Native choices cannot be mixed with credential fields.
- `external` is reserved for human work such as passkeys, CAPTCHA, or device approval.
- The controller turns `external` into polling rather than exposing a public subtype.

## Generic public interaction

- Every waiting snapshot exposes `{ id, message, fields, choices, confirmation?, pollAfterMs? }`.
- There is no public form/session/external discriminator.
- Fields contain only id, label, type, and required metadata.
- Choices contain id, label, and optional presentation/intent `kind`.
- Controller-created confirmation metadata covers destination use and credential saving.
- `pollAfterMs` indicates that the current prompt can be replaced after polling.
- Consumers render the data present instead of branching on an interaction variant.
- Submit responses remain `{ kind: "submit", interactionId, values }`.
- Choice responses remain `{ kind: "choose", interactionId, choiceId }`.
- Parsers validate unknown wire data and return fixed errors without echoing input.

## Observation and action boundary

- Observation walks visible DOM content in a bounded set of frames.
- It emits a bounded hierarchy that preserves DOM parent/child structure.
- Interactive nodes receive SDK-owned random references.
- Those references point to captured element handles retained by the controller.
- Playwright AI refs and model-authored selectors are not used.
- Private input descendants and values are omitted from tree text.
- Text, labels, types, and autocomplete metadata pass through known-value redaction.
- Before writes, the controller checks captured identity, connectivity, origin, and freshness.
- Session decisions additionally validate the observed documents and visible text.
- Routine bounded actions include click, keyboard, scroll, selection, navigation, and inspect.
- Tab tools expose only the initially selected page, its observed popups, and flow-created pages. Metadata is limited to opaque IDs, origins, ownership, and opener provenance. Only flow-created pages may be closed.
- Frame listing reflects the same bounded set of up to ten frames used for observation; it does not change the active frame.
- Native JavaScript dialogs are unsupported: the controller dismisses them, stops the flow with `unknown`, and never accepts them or supplies private values. Dialog control tools are intentionally omitted until an identity-bound, suspended-write lifecycle is implemented.
- Controller field filling and native choice clicks do not run inside model code.

## Screenshot policy

- Before any private value is known, screenshots may accompany text observations.
- Editable controls in every frame are masked before capture.
- If masking or capture fails, the screenshot is omitted.
- Once `Redactor.hasValues` is true, screenshots are withheld entirely.
- This prevents a common reflection path after credentials enter controller memory.
- It does not sanitize unrelated pre-existing private data visible elsewhere on the page.
- It cannot stop a hostile site from encoding or indirectly describing a received secret.
- Known-value text replacement covers literal and common URL-encoded representations only.

## Controller sequence

1. Attach to the caller's existing browser context and select the requested target.
2. Observe visible text, bounded DOM hierarchy, captured controls, and an allowed screenshot.
3. Add operation, history, opener evidence, and available credential keys for the model.
4. Ask the model for exactly one named proposal tool call.
5. Validate the proposal and reject invented, duplicate, stale, or incompatible references.
6. Execute unambiguous bounded navigation actions directly, then observe again.
7. For private fields, initialize the selected credential attempt in host memory.
8. Ask only for missing or rejected values through the generic interaction.
9. Obtain exact-origin consent when the destination is not already authorized.
10. Fill captured controls privately and submit only the associated native form/control.
11. For meaningful choices, publish generic choices and await a single-use response.
12. Revalidate the page and captured element before dispatching the chosen native action.
13. For external work, publish a polling interaction while the human uses the browser.
14. Accept completion only from fresh visible evidence matching the requested operation.
15. Handle save consent and storage independently from website authentication success.
16. Disconnect only connections created by the SDK; never close borrowed browser objects.

## Review rationale

- Named tools align model output with explicit capabilities and improve provider compatibility.
- Schema generation avoids drift between tool declarations and proposal validation.
- Missing execute callbacks keep all effects under controller policy and lifecycle checks.
- A single `ask_user` reduces internal branches without weakening controller validation.
- A generic public interaction keeps CLI, React, and custom transports forward-compatible.
- Optional choice kinds are hints; IDs and current interaction ownership authorize responses.
- Own element references support stale-handle rejection better than selector rematching.
- Hierarchical observations retain useful context without granting DOM query capabilities.
- Screenshot withholding favors secret containment after controller access over visual context.
- Separate login and storage effects avoid repeating a successful browser write on save failure.

## Verification strategy

- Unit-test proposal tools for real AI SDK tool shape and absence of execute callbacks.
- Reject unknown tools, malformed input, multiple calls, and secret-bearing invalid output safely.
- Test DOM hierarchy, own refs, private-value omission, screenshot masks, and withholding.
- Test stale element replacement fails before any browser write.
- Test exact-origin consent before filling and no unauthorized destination side effect.
- Test missing fields, rejected values, native choices, Back, and external polling.
- Test interaction replacement and rejection of stale or duplicate responses.
- Test submit and choose wire parsers, limits, and built declaration output.
- Test React clears uncontrolled secret inputs on submit, choice, and replacement.
- Test CLI and React consume the same generic interaction and preserve response shapes.
- Integration-test multi-step login, account change, logout, cancellation, and save failure.
- Assert outcomes and forbidden side effects, not merely absence of exceptions.

## Deliberate omissions

- No arbitrary page JavaScript, cookie API, storage API, or network inspection for the agent.
- No general download, upload, unrelated-tab discovery, or full browser automation surface.
- No automatic CAPTCHA, passkey, magic-link, recovery, enrollment, or TOTP completion.
- No identity attestation: outcomes remain model inference from visible page evidence.
- No encrypted persistent store, remote desktop, credential import, or session revocation.
- Popup, tab, and iframe handling remains bounded to flow scope.
- No native JavaScript dialog authentication; dismissal does not establish whether the website changed state.
- Site/model reliability and security require broader evaluation and independent audit.
