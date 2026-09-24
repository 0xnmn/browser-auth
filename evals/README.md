# Agent evaluations

`pnpm eval:smoke` validates the harness with a deterministic fixture agent, no API key and no model call. **It is not evidence of LLM reliability.**

`pnpm eval --config ./auth.config.mjs` loads a trusted module exporting `AuthOptions` with a plain model configuration. This can incur provider charges. Only disposable local fixture pages and synthetic credentials are used. Credentials and private provider errors are not printed. The harness runs password, multi-step, and OTP scenarios, checks the actual fixture session before confirming success, and reports outcome, leak checks, and latency. Scripted smoke evaluations use an internal test entry point, not a public custom-agent option.

Future evaluation sets should add popup SSO, recovery from rejected inputs, SPA/shadow-DOM forms, external challenges, prompt injection, identity mismatch, and site drift. Separate functional success from security invariants. Run each provider/model combination repeatedly; record model/version, pass rate, latency, and cost without prompts or secret payloads. Real websites require explicitly authorized disposable accounts and a separate, opt-in job. They do not belong in ordinary CI.
