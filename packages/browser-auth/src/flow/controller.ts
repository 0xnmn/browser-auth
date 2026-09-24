import { setTimeout as delay } from "node:timers/promises";
import { AccountSession } from "../credentials/accounts.js";
import type { CredentialStore } from "../credentials/store.js";
import { BrowserSurface, type BrowserAction } from "../browser/observation.js";
import { connectTarget } from "../browser/connection.js";
import type { BrowserConnection } from "../browser/connection.js";
import { BrowserSession } from "../browser/session.js";
import { AuthFailure, abortable } from "../errors.js";
import { Redactor } from "../security/redaction.js";
import { proposalSchema } from "../agent/proposal-schema.js";
import type { AuthAgent, AuthProposal } from "../agent/proposals.js";
import type { AuthOptions, LoginOptions } from "../types.js";
import type { AuthResult } from "../protocol.js";
import { FlowChannel } from "./interaction.js";

const browserActions = new Set<BrowserAction["kind"]>([
  "click",
  "doubleClick",
  "hover",
  "focus",
  "press",
  "scroll",
  "check",
  "select",
  "drag",
  "navigate",
  "back",
  "forward",
  "reload",
  "wait",
  "inspect",
]);

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
  let browserSession: BrowserSession | undefined;
  let currentPage = undefined as BrowserSurface["page"] | undefined;
  let contextResult: string | undefined;
  let result: AuthResult;
  let phase = "browser_connect";
  let writeAttempted = false;
  let authProgress = false;
  let accountAction: "switch" | "add" | undefined;
  let afterBack = false;
  const history: string[] = [];
  let accountsInitialized = false;
  let completedLogin:
    Extract<AuthResult, { status: "authenticated" }> | undefined;

  try {
    connection = await connectTarget(input, flow, signal, timeout);
    currentPage = connection.page;
    browserSession = new BrowserSession(connection.context, connection.page);
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
      if (browserSession.nativeDialogSeen)
        throw new AuthFailure(
          "native_dialog_unsupported",
          "Native browser dialogs are not supported",
        );
      span?.step(step);
      const page = browserSession.current();
      if (!surface || currentPage !== page) {
        await surface?.clear();
        currentPage = page;
        surface = new BrowserSurface(page, timeout, () => {
          if (browserSession?.nativeDialogSeen)
            throw new AuthFailure(
              "native_dialog_unsupported",
              "Native browser dialogs are not supported",
            );
          writeAttempted = true;
        });
      }
      flow.publish({
        status: "running",
        message: "Inspecting authentication page",
      });
      phase = "browser_observe";
      const observation = await abortable(surface.observe(redactor), signal);
      const opener =
        page !== connection.page
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
            ...(contextResult ? { context: contextResult } : {}),
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
      const proposal = parsed.data as AuthProposal;
      contextResult = undefined;
      span?.action(proposal.kind);
      signal.throwIfAborted();
      if (browserSession.nativeDialogSeen)
        throw new AuthFailure(
          "native_dialog_unsupported",
          "Native browser dialogs are not supported",
        );

      if (proposal.kind === "opener") {
        if (page === connection.page)
          throw new AuthFailure(
            "invalid_proposal",
            "There is no authentication popup to leave",
          );
        const initial = browserSession.list().find((entry) => !entry.openerId);
        if (!initial)
          throw new AuthFailure(
            "target_closed",
            "The selected browser tab was closed",
          );
        browserSession.switch(initial.id);
        history.push("Action: opener");
        continue;
      }

      if (proposal.kind === "tabs_list") {
        contextResult = JSON.stringify({ tabs: browserSession.list() });
        continue;
      }
      if (proposal.kind === "tab_switch") {
        browserSession.switch(proposal.pageId);
        history.push("Action: tab_switch");
        continue;
      }
      if (proposal.kind === "tab_new") {
        phase = "browser_action";
        writeAttempted = true;
        contextResult = JSON.stringify({
          pageId: await browserSession.create(),
        });
        history.push("Action: tab_new");
        continue;
      }
      if (proposal.kind === "tab_close") {
        phase = "browser_action";
        writeAttempted = true;
        await browserSession.close(proposal.pageId);
        history.push("Action: tab_close");
        continue;
      }
      if (proposal.kind === "frames_list") {
        contextResult = JSON.stringify({ frames: browserSession.frames() });
        continue;
      }
      if (proposal.kind === "observe" || proposal.kind === "screenshot") {
        history.push(`Action: ${proposal.kind}`);
        continue;
      }

      if (proposal.kind === "done") {
        if (
          proposal.outcome === "authenticated" &&
          operation === "login" &&
          !authProgress
        ) {
          const answer = await flow.ask(
            {
              message: "A signed-in session is already active",
              fields: [],
              choices: [
                {
                  id: "finish",
                  label: "Keep this session and finish",
                  kind: "finish",
                },
              ],
            },
            signal,
          );
          signal.throwIfAborted();
          if (answer?.kind !== "choose" || answer.choiceId !== "finish")
            throw new AuthFailure(
              "invalid_response",
              "No session choice was received",
            );
          await surface.validateSession(signal);
          if (browserSession.nativeDialogSeen)
            throw new AuthFailure(
              "native_dialog_unsupported",
              "Native browser dialogs are not supported",
            );
          result = { status: "already-signed-in" };
          break;
        }
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
        if (proposal.outcome === "account-changed" && !accountAction) {
          result = {
            status: "unknown",
            message: "The requested account change was not observed",
          };
          break;
        }
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
        try {
          await surface.validateSession(signal);
        } catch (error) {
          if (!(error instanceof AuthFailure) || error.code !== "stale_page")
            throw error;
          history.push("Action: stale-completion; observe again");
          continue;
        }
        if (browserSession.nativeDialogSeen)
          throw new AuthFailure(
            "native_dialog_unsupported",
            "Native browser dialogs are not supported",
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

      if (proposal.kind === "ask_user") {
        phase = "browser_action";
        if (!proposal.fields.length && proposal.submitElementId)
          throw new AuthFailure(
            "invalid_submit",
            "A submit control requires credential fields",
          );
        const native = proposal.choices.some((choice) =>
          ["finish", "switch", "add", "logout"].includes(choice.intent),
        );
        if (proposal.fields.length && native)
          throw new AuthFailure(
            "invalid_proposal",
            "Session decisions cannot be mixed with credential fields",
          );
        if (
          proposal.fields.length &&
          (operation === "logout" ||
            (operation === "choose-account" && !accountAction))
        )
          throw new AuthFailure(
            "unsupported",
            "Choose a native account or add-account flow before entering credentials; logout cannot fall back to login",
          );
        if (native) {
          accounts = newAttempt();
          accountsInitialized = false;
          accountAction = undefined;
          afterBack = false;
          authProgress = false;
        }
        if (proposal.fields.length) {
          for (const field of proposal.fields)
            await surface.validate(field.elementId, signal);
          if (!accountsInitialized) {
            phase = "store_load";
            await accounts.initialize(input.accountId);
            accountsInitialized = true;
            phase = "browser_action";
          }
          const filled = await accounts.fill(proposal, surface);
          history.push(filled.message);
          if (filled.progressed) {
            afterBack = filled.back;
            if (!filled.back) {
              authProgress = true;
              for (const field of proposal.fields)
                history.push(`Field receipt: ${field.key} (${field.type})`);
            }
          }
        } else if (proposal.choices.length || proposal.external) {
          const ids = proposal.choices.map((choice) => choice.elementId);
          if (new Set(ids).size !== ids.length)
            throw new AuthFailure(
              "invalid_proposal",
              "The agent returned duplicate choices",
            );
          for (const choice of proposal.choices)
            if (choice.intent !== "finish")
              await surface.validate(choice.elementId, signal);
          const answer = await flow.ask(
            {
              message: redactor.text(proposal.message),
              fields: [],
              choices: proposal.choices.map((choice) => ({
                id: choice.elementId,
                label: redactor.text(choice.label),
                ...(choice.intent === "continue"
                  ? {}
                  : { kind: choice.intent }),
              })),
            },
            signal,
            proposal.external ? 1500 : undefined,
          );
          signal.throwIfAborted();
          if (proposal.external && operation === "login") authProgress = true;
          if (answer?.kind === "choose") {
            const choice = proposal.choices.find(
              (entry) => entry.elementId === answer.choiceId,
            )!;
            const previousOperation: "login" | "logout" | "choose-account" =
              operation;
            const previousAccountAction = accountAction;
            try {
              await surface.validateSession(signal);
              if (browserSession.nativeDialogSeen)
                throw new AuthFailure(
                  "native_dialog_unsupported",
                  "Native browser dialogs are not supported",
                );
              if (choice.intent === "finish") {
                result = { status: "already-signed-in" };
                break;
              }
              await surface.validate(choice.elementId, signal);
              if (choice.intent === "logout") operation = "logout";
              else if (choice.intent === "switch" || choice.intent === "add") {
                operation = "choose-account";
                accountAction = choice.intent;
              }
              await surface.click(choice.elementId, signal);
              afterBack = choice.intent === "back";
              if (choice.intent === "continue") authProgress = true;
              history.push(`Action: ${choice.intent}`);
            } catch (error) {
              if (
                !(error instanceof AuthFailure) ||
                error.code !== "stale_page"
              )
                throw error;
              operation = previousOperation;
              accountAction = previousAccountAction;
              history.push("Action: stale-choice");
              continue;
            }
          }
        } else {
          history.push("Action: no-op");
        }
        await delay(150, undefined, { signal });
        continue;
      }

      if (browserActions.has(proposal.kind as BrowserAction["kind"])) {
        phase = "browser_action";
        const action = proposal as BrowserAction;
        const executed = await surface.execute(action, signal);
        if (action.kind === "click" && afterBack && accountAction === "add")
          afterBack = false;
        if (executed.kind === "inspection")
          history.push(
            `Action: inspect; ${redactor.text(JSON.stringify(executed))}`,
          );
        else history.push(`Action: ${action.kind}`);
        await delay(150, undefined, { signal });
      }
    }
    result ??= {
      status: "unknown",
      message: "The authentication step limit was reached",
    };
  } catch (error) {
    if (completedLogin) result = completedLogin;
    else if (browserSession?.nativeDialogSeen)
      result = {
        status: "unknown",
        message:
          "A native browser dialog was dismissed because this flow does not support it; inspect the session before retrying",
      };
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
        (!(error instanceof AuthFailure) ||
          error.code === "browser_action_failed" ||
          error.code === "partial_write"))
    )
      result = {
        status: "unknown",
        message:
          "The operation was interrupted; inspect the browser before retrying",
      };
    else
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
  browserSession?.clear();
  await surface?.clear().catch(() => {});
  await openerSurface?.clear().catch(() => {});
  await connection?.disconnect().catch(() => {});
  redactor.clear();
  span?.end(result.status);
  flow.finish(result);
}
