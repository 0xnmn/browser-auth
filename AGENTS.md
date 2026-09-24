# Browser Auth contributor guidance

## Scope and architecture

- TypeScript, strict mode, ESM, Node 22.18+ or 24+. The SDK is the implementation; the CLI and React package are renderers/adapters.
- Keep public exports explicit. Use Zod schemas for agent proposals and interactive protocol data; derive their TypeScript types.
- The controller owns consent, credential access, lifecycle, and completion. Agents receive observations and propose actions, never secrets or browser handles.
- Use the caller's shared browser context. Never close a borrowed page, context, or browser. Disconnect only connections we create.
- Prefer small direct functions over registries, abstract base classes, and speculative adapters.

## Security and errors

- Treat CDP URLs, credentials, account identifiers, page content, and model configuration as sensitive.
- Never include secrets, browser content, URLs, headers, or raw exceptions in telemetry. Tracing is opt-in and metadata-only.
- Exact URL origins authorize credential destinations; service associations do not. Do not use suffix matching or infer consent from model output.
- Interaction IDs are single-use. Never retry a browser write after an uncertain outcome.
- Saving and website authentication are independent effects. Surface storage failures without repeating login.
- Do not promise protection from hostile websites, same-process plugins, or other browser-level CDP clients.

## Workflow

- Read relevant files before editing. Keep tests beside pure logic, browser scenarios under tests/, and real-model evaluations under evals/.
- Run `pnpm check`, `pnpm test`, and `pnpm test:integration` for cross-module changes. Use synthetic credentials only.
- Add a regression test for each fixed failure. Tests should assert outcomes and unauthorized side effects, not just lack of exceptions.
- Inspect rendered UI changes. No live website accounts or paid model calls in ordinary tests.
- Review package output with `pnpm build` and packed-package smoke tests before release. Do not publish or deploy without explicit authorization.
