import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import { SpanStatusCode } from "@opentelemetry/api";
import { AccountSession, confirm } from "../credentials/accounts.js";
import type { CredentialStore } from "../credentials/store.js";
import { BrowserSurface } from "../browser/observation.js";
import { connectTarget } from "../browser/connection.js";
import type { BrowserConnection } from "../browser/connection.js";
import { AuthFailure, abortable } from "../errors.js";
import { Redactor } from "../security/redaction.js";
import { proposalSchema } from "../agent/proposals.js";
import type { AuthAgent } from "../agent/proposals.js";
import type {
  AuthOptions,
  LoginOptions,
  LogoutOptions,
  SwitchOptions,
} from "../types.js";
import type { AuthInteraction, AuthResult } from "../protocol.js";
import { FlowChannel } from "./interaction.js";

export async function runFlow(
  operation: "login" | "logout" | "switch",
  input: LoginOptions | LogoutOptions | SwitchOptions,
  options: AuthOptions,
  agent: AuthAgent,
  store: CredentialStore,
  flow: FlowChannel,
): Promise<void> {
  const deadline = AbortSignal.timeout(options.limits?.timeoutMs ?? 180_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  const timeout = options.limits?.actionTimeoutMs ?? 10_000;
  const span = options.tracer?.startSpan("browser_auth.flow", {
    attributes: { "auth.operation": operation },
  });
  const redactor = new Redactor();
  let connection: BrowserConnection | undefined;
  let surface: BrowserSurface | undefined;
  let currentPage: Page | undefined;
  const watched = new Set<Page>();
  const popups: Page[] = [];
  const onPopup = (page: Page) => {
    popups.push(page);
    watch(page);
  };
  const watch = (page: Page) => {
    if (!watched.has(page)) {
      watched.add(page);
      page.on("popup", onPopup);
    }
  };
  let result: AuthResult;
  let phase = "browser_connect";
  let writeAttempted = false;
  let confirmedLogin:
    Extract<AuthResult, { status: "authenticated" }> | undefined;
  try {
    connection = await connectTarget(input, flow, signal, timeout);
    currentPage = connection.page;
    watch(currentPage);
    const login = input as LoginOptions;
    const accounts = new AccountSession(
      store,
      flow,
      redactor,
      signal,
      connection.serviceOrigin,
      login.credentials,
    );
    phase = "store_load";
    if (operation !== "logout") await accounts.initialize(input.accountId);
    for (let step = 0; step < (options.limits?.maxSteps ?? 30); step++) {
      signal.throwIfAborted();
      span?.addEvent("step", { "auth.step": step });
      const popup = [...popups].reverse().find((page) => !page.isClosed());
      const page = popup ?? connection.page;
      if (!surface || currentPage !== page) {
        await surface?.clear();
        currentPage = page;
        surface = new BrowserSurface(page, timeout, () => {
          writeAttempted = true;
        });
      }
      flow.publish({
        status: "running",
        message: "Inspecting authentication page",
      });
      phase = "browser_observe";
      const observation = await abortable(surface.observe(redactor), signal);
      phase = "agent";
      const proposed = await abortable(
        agent.next(
          {
            ...observation,
            operation,
            availableCredentialKeys: accounts.keys(),
          },
          { signal },
        ),
        signal,
      );
      const parsed = proposalSchema.safeParse(proposed);
      if (!parsed.success)
        throw new AuthFailure(
          "invalid_proposal",
          "The agent returned an invalid action",
        );
      const proposal = parsed.data;
      span?.addEvent("proposal", { "auth.action": proposal.kind });
      signal.throwIfAborted();
      if (proposal.kind === "done") {
        if (
          proposal.outcome === "unsupported" ||
          proposal.outcome === "rejected"
        )
          throw new AuthFailure(
            proposal.outcome,
            proposal.outcome === "unsupported"
              ? "This authentication action is not supported by the current website flow"
              : "The website rejected authentication",
          );
        const expected =
          operation === "logout" ? "signed-out" : "authenticated";
        if (proposal.outcome !== expected)
          throw new AuthFailure(
            "invalid_outcome",
            "The agent returned an outcome for a different operation",
          );
        const kind =
          operation === "logout"
            ? "confirm-sign-out"
            : operation === "switch"
              ? "confirm-account-switch"
              : "confirm-sign-in";
        const confirmation: Extract<
          AuthInteraction,
          { kind: "confirm" }
        >["confirmation"] =
          kind === "confirm-sign-out"
            ? { kind }
            : {
                kind,
                ...(accounts.selected
                  ? { accountLabel: accounts.selected.label }
                  : {}),
              };
        if (!(await confirm(flow, confirmation, signal))) {
          result = {
            status: "unknown",
            message: "Authentication outcome was not confirmed",
          };
        } else if (operation === "logout")
          result = { status: "signed-out", deletion: "not-requested" };
        else {
          confirmedLogin = {
            status: "authenticated",
            save: { status: "not-saved" },
            ...(accounts.selected ? { accountId: accounts.selected.id } : {}),
          };
          phase = "store_save";
          result = await accounts.save(
            operation === "login" ? (login.save ?? "ask") : "never",
            login.label,
          );
        }
        break;
      }
      phase = "browser_action";
      if (proposal.kind === "form") {
        if (operation !== "login" && proposal.fields.length)
          throw new AuthFailure(
            "unsupported",
            "Account switching and logout cannot fall back to credential login",
          );
        await accounts.fill(proposal, surface);
      } else if (proposal.kind === "click") {
        const element = observation.elements.find(
          (entry) => entry.id === proposal.elementId,
        );
        if (!element)
          throw new AuthFailure(
            "invalid_reference",
            "The agent selected an unknown control",
          );
        const answer = await flow.ask(
          {
            kind: "form",
            message: "Continue with this website action?",
            fields: [],
            choices: [{ id: element.id, label: element.label || "Continue" }],
          },
          signal,
        );
        signal.throwIfAborted();
        if (answer?.kind === "choose")
          await surface.click(answer.choiceId, signal);
      } else if (proposal.kind === "external") {
        const answer = await flow.ask(
          {
            kind: "external",
            message: redactor.text(proposal.message),
            choices: proposal.choices.map((choice) => ({
              id: choice.elementId,
              label: redactor.text(choice.label),
              ...(choice.back ? { kind: "back" as const } : {}),
            })),
          },
          signal,
          1500,
        );
        signal.throwIfAborted();
        if (answer?.kind === "choose")
          await surface.click(answer.choiceId, signal);
      }
      await delay(150, undefined, { signal });
    }
    result ??= {
      status: "unknown",
      message: "The authentication step limit was reached",
    };
  } catch (error) {
    if (confirmedLogin) result = confirmedLogin;
    else if (input.signal?.aborted && !writeAttempted)
      result = { status: "cancelled" };
    else if (input.signal?.aborted)
      result = {
        status: "unknown",
        message:
          "Cancelled after a browser action; inspect the session before retrying",
      };
    else if (
      deadline.aborted ||
      (phase === "browser_action" &&
        writeAttempted &&
        !(error instanceof AuthFailure))
    ) {
      result = {
        status: "unknown",
        message:
          "The operation was interrupted; inspect the browser before retrying",
      };
    } else {
      result = {
        status: "failed",
        error:
          error instanceof AuthFailure
            ? { code: error.code, message: error.message }
            : {
                code: `${phase}_failed`,
                message: `Authentication could not complete the ${phase.replaceAll("_", " ")} step`,
              },
      };
    }
    span?.setStatus({ code: SpanStatusCode.ERROR });
  }
  if (
    operation === "logout" &&
    "forgetCredentials" in input &&
    input.forgetCredentials &&
    result.status !== "cancelled" &&
    result.status !== "authenticated"
  ) {
    try {
      await store.delete(input.accountId);
      result = { ...result, deletion: "deleted" };
    } catch {
      result = { ...result, deletion: "failed" };
    }
  }
  for (const page of watched) page.off("popup", onPopup);
  await surface?.clear().catch(() => {});
  await connection?.disconnect().catch(() => {});
  redactor.clear();
  span?.setAttribute("auth.result", result.status);
  span?.end();
  flow.finish(result);
}
