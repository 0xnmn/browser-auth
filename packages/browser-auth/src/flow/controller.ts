import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import { AccountSession } from "../credentials/accounts.js";
import type { CredentialStore } from "../credentials/store.js";
import { BrowserSurface } from "../browser/observation.js";
import { connectTarget } from "../browser/connection.js";
import type { BrowserConnection } from "../browser/connection.js";
import { AuthFailure, abortable } from "../errors.js";
import { Redactor } from "../security/redaction.js";
import { proposalSchema } from "../agent/proposal-schema.js";
import type { AuthAgent, AuthProposal } from "../agent/proposals.js";
import type { AuthOptions, LoginOptions } from "../types.js";
import type { AuthResult } from "../protocol.js";
import { FlowChannel } from "./interaction.js";

export async function runFlow(
  input: LoginOptions,
  options: Omit<AuthOptions, "model">,
  agent: AuthAgent,
  store: CredentialStore,
  flow: FlowChannel,
): Promise<void> {
  let operation: "login" | "logout" | "choose-account" = "login";
  const deadline = AbortSignal.timeout(options.limits?.timeoutMs ?? 180_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  const timeout = options.limits?.actionTimeoutMs ?? 10_000;
  const span = options.tracer?.startFlow(operation);
  const redactor = new Redactor();
  let connection: BrowserConnection | undefined;
  let surface: BrowserSurface | undefined;
  let openerSurface: BrowserSurface | undefined;
  const completedPopups = new Set<Page>();
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
  let accountAction: "switch" | "add" | undefined;
  let afterBack = false;
  const history: string[] = [];
  let accountsInitialized = false;
  let completedLogin:
    Extract<AuthResult, { status: "authenticated" }> | undefined;
  try {
    connection = await connectTarget(input, flow, signal, timeout);
    currentPage = connection.page;
    watch(currentPage);
    const serviceOrigin = connection.serviceOrigin;
    openerSurface = new BrowserSurface(connection.page, timeout);
    const newAttempt = () =>
      new AccountSession(
        store,
        flow,
        redactor,
        signal,
        serviceOrigin,
        input.credentials,
      );
    let accounts = newAttempt();
    for (let step = 0; step < (options.limits?.maxSteps ?? 30); step++) {
      signal.throwIfAborted();
      span?.step(step);
      const popup = [...popups]
        .reverse()
        .find((page) => !page.isClosed() && !completedPopups.has(page));
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
      const opener = popup
        ? await abortable(openerSurface.observe(redactor), signal)
        : undefined;
      phase = "agent";
      const proposed = await abortable(
        agent.next(
          {
            ...observation,
            operation,
            history,
            ...(opener
              ? { opener: { origin: opener.origin, text: opener.text } }
              : {}),
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
      const proposal: AuthProposal =
        parsed.data.kind === "done" &&
        parsed.data.outcome === "authenticated" &&
        operation === "login" &&
        !writeAttempted
          ? { kind: "session" as const, choices: [] }
          : parsed.data;
      span?.action(proposal.kind);
      signal.throwIfAborted();
      if (proposal.kind === "opener") {
        if (!popup)
          throw new AuthFailure(
            "invalid_proposal",
            "There is no authentication popup to leave",
          );
        completedPopups.add(popup);
        history.push(
          "Returned from authentication popup to inspect the service page",
        );
        continue;
      }
      if (proposal.kind === "session") {
        // Native session selection ends the previous credential attempt, even
        // when the user subsequently chooses a different existing account.
        accounts = newAttempt();
        accountsInitialized = false;
        accountAction = undefined;
        afterBack = false;
        const ids = proposal.choices.map((choice) => choice.elementId);
        if (new Set(ids).size !== ids.length || ids.includes("finish"))
          throw new AuthFailure(
            "invalid_proposal",
            "The agent returned duplicate session choices",
          );
        for (const choice of proposal.choices)
          await surface.validate(choice.elementId, signal);
        const answer = await flow.ask(
          {
            kind: "session",
            choices: [
              {
                id: "finish",
                label: "Keep this session and finish",
                kind: "finish",
              },
              ...proposal.choices.map((choice) => ({
                id: choice.elementId,
                label: redactor.text(choice.label),
                kind: choice.kind,
              })),
            ],
          },
          signal,
        );
        signal.throwIfAborted();
        if (answer?.kind !== "choose")
          throw new AuthFailure(
            "invalid_response",
            "No session choice was received",
          );
        const previousOperation: "login" | "logout" | "choose-account" =
          operation;
        try {
          await surface.validateSession(signal);
          if (answer.choiceId === "finish") {
            result = { status: "already-signed-in" };
            break;
          }
          const choice: Extract<
            AuthProposal,
            { kind: "session" }
          >["choices"][number] = proposal.choices.find(
            (entry) => entry.elementId === answer.choiceId,
          )!;
          operation = choice.kind === "logout" ? "logout" : "choose-account";
          accountAction =
            choice.kind === "switch" || choice.kind === "add"
              ? choice.kind
              : undefined;
          phase = "browser_action";
          await surface.click(choice.elementId, signal);
          history.push(
            `Selected ${choice.kind}: ${redactor.text(choice.label)}`,
          );
        } catch (error) {
          // BrowserSurface emits stale_page only before attempting a write.
          // Playwright write failures must never enter this refresh path.
          if (!(error instanceof AuthFailure) || error.code !== "stale_page")
            throw error;
          operation = previousOperation;
          accountAction = undefined;
          history.push(
            "Session changed before the choice was executed; inspect and offer fresh choices",
          );
          continue;
        }
        await delay(150, undefined, { signal });
        continue;
      }
      if (proposal.kind === "done") {
        if (
          proposal.outcome === "unsupported" ||
          proposal.outcome === "rejected" ||
          proposal.outcome === "not-signed-in"
        )
          throw new AuthFailure(
            proposal.outcome,
            proposal.outcome === "unsupported"
              ? "This authentication action is not supported by the current website flow"
              : proposal.outcome === "not-signed-in"
                ? "A signed-in session is required to choose another account. Log in first."
                : "The website rejected authentication",
          );
        const expected =
          operation === "logout"
            ? "signed-out"
            : operation === "choose-account"
              ? "account-changed"
              : "authenticated";
        if (
          operation === "choose-account" &&
          (!accountAction || afterBack || proposal.outcome === "authenticated")
        ) {
          result = {
            status: "unknown",
            message: "The requested account change was not observed",
          };
          break;
        }
        if (proposal.outcome !== expected)
          throw new AuthFailure(
            "invalid_outcome",
            "The agent returned an outcome for a different operation",
          );
        if (operation === "logout")
          result = { status: "signed-out", deletion: "not-requested" };
        else {
          completedLogin = await accounts.save("never");
          phase = "store_save";
          result = await accounts.save(input.save ?? "ask", input.label);
        }
        break;
      }
      phase = "browser_action";
      if (proposal.kind === "form") {
        if (
          proposal.fields.length &&
          (operation === "logout" ||
            (operation === "choose-account" && !accountAction))
        )
          throw new AuthFailure(
            "unsupported",
            "Choose a native account or add-account flow before entering credentials; logout cannot fall back to login",
          );
        if (proposal.fields.length && !accountsInitialized) {
          phase = "store_load";
          await accounts.initialize(input.accountId);
          accountsInitialized = true;
          phase = "browser_action";
        }
        const filled = await accounts.fill(proposal, surface);
        history.push(filled.message);
        if (filled.progressed) afterBack = filled.back;
      } else if (proposal.kind === "click") {
        const element = observation.elements.find(
          (entry) => entry.id === proposal.elementId,
        );
        if (!element)
          throw new AuthFailure(
            "invalid_reference",
            "The agent selected an unknown control",
          );
        await surface.click(element.id, signal);
        afterBack = false;
        history.push(`Clicked ${redactor.text(element.label)}`);
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
        if (answer?.kind === "choose") {
          await surface.click(answer.choiceId, signal);
          afterBack = Boolean(
            proposal.choices.find(
              (choice) => choice.elementId === answer.choiceId,
            )?.back,
          );
          history.push("Selected an external-flow choice");
        }
      }
      await delay(150, undefined, { signal });
    }
    result ??= {
      status: "unknown",
      message: "The authentication step limit was reached",
    };
  } catch (error) {
    if (completedLogin) result = completedLogin;
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
  }
  if (
    operation === "logout" &&
    "forgetCredentials" in input &&
    input.forgetCredentials &&
    result.status !== "cancelled" &&
    result.status !== "authenticated" &&
    result.status !== "already-signed-in"
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
  await openerSurface?.clear().catch(() => {});
  await connection?.disconnect().catch(() => {});
  redactor.clear();
  span?.end(result.status);
  flow.finish(result);
}
