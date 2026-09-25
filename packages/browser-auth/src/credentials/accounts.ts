import { randomUUID } from "node:crypto";
import type { CredentialPlan } from "../agent/proposals.js";
import type { BrowserSurface } from "../browser/observation.js";
import type { FlowChannel } from "../flow/interaction.js";
import type { AuthConfirmation, AuthResult } from "../protocol.js";
import { AuthFailure, abortable, actionTimeout } from "../errors.js";
import type { Redactor } from "../security/redaction.js";
import { credentialValues, toCredentials } from "./store.js";
import type { CredentialStore, SavedLogin, Credentials } from "./store.js";

export async function confirm(
  flow: FlowChannel,
  confirmation: AuthConfirmation,
  signal: AbortSignal,
): Promise<boolean> {
  const answer = await flow.ask(
    {
      message:
        confirmation.kind === "use-credentials"
          ? "Approve credential destination"
          : "Save credentials?",
      fields: [],
      confirmation,
      choices: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
    signal,
  );
  signal.throwIfAborted();
  return answer?.kind === "choose" && answer.choiceId === "yes";
}

/** One credential attempt. Discard when returning to native session selection. */
export class AccountSession {
  selected: SavedLogin | undefined;
  private readonly supplied: Record<string, string>;
  private readonly approved = new Set<string>();
  private readonly offeredOrigins = new Set<string>();
  private readonly attempted = new Set<string>();
  private readonly submitted = new Map<string, Record<string, string>>();
  private newAccount = false;
  private usedSavedRecord = false;

  constructor(
    private readonly store: CredentialStore,
    private readonly flow: FlowChannel,
    private readonly redactor: Redactor,
    private readonly signal: AbortSignal,
    private readonly serviceOrigin: string,
    credentials: Credentials = {},
  ) {
    this.supplied = credentialValues(credentials);
    for (const value of Object.values(this.supplied)) redactor.add(value);
  }

  async initialize(accountId?: string): Promise<void> {
    if (accountId) await this.select(accountId);
    else await this.offer({ serviceOrigin: this.serviceOrigin });
  }

  private async select(id: string): Promise<void> {
    const account = await abortable(this.store.get(id), this.signal);
    if (!account)
      throw new AuthFailure(
        "account_not_found",
        "The selected saved account no longer exists",
      );
    this.selected = account;
    for (const entry of account.credentials)
      for (const value of Object.values(credentialValues(entry.values)))
        this.redactor.add(value);
  }

  private async offer(query: {
    serviceOrigin?: string;
    credentialOrigin?: string;
  }): Promise<void> {
    const accounts = await abortable(this.store.list(query), this.signal);
    if (!accounts.length) return;
    const answer = await this.flow.ask(
      {
        message: "Choose a saved login",
        fields: [],
        choices: [
          ...accounts.map((account, index) => ({
            id: String(index),
            label: account.label,
          })),
          { id: "new", label: "Use another account" },
        ],
      },
      this.signal,
    );
    this.signal.throwIfAborted();
    if (answer?.kind !== "choose") return;
    if (answer.choiceId === "new") this.newAccount = true;
    else await this.select(accounts[Number(answer.choiceId)]!.id);
  }

  keys(): string[] {
    return [
      ...new Set([
        ...Object.keys(this.supplied),
        ...(this.selected?.credentials.flatMap((entry) =>
          Object.keys(credentialValues(entry.values)),
        ) ?? []),
      ]),
    ];
  }

  async fill(
    proposal: CredentialPlan,
    surface: BrowserSurface,
  ): Promise<{ message: string; back: boolean; progressed: boolean }> {
    if (
      new Set(proposal.fields.map((field) => field.elementId)).size !==
      proposal.fields.length
    )
      throw new AuthFailure(
        "invalid_proposal",
        "The agent returned duplicate fields",
      );
    const bindings = [];
    for (const field of proposal.fields) {
      const ref = await surface.validate(field.elementId, this.signal);
      if (
        !this.selected &&
        !this.newAccount &&
        !this.offeredOrigins.has(ref.origin)
      ) {
        this.offeredOrigins.add(ref.origin);
        await this.offer({ credentialOrigin: ref.origin });
      }
      const stored = this.selected?.credentials.find(
        (entry) => entry.origin === ref.origin,
      );
      const values = {
        ...(stored ? credentialValues(stored.values) : {}),
        ...this.supplied,
      };
      const previousAttempt = this.attempted.has(`${ref.origin}:${field.key}`);
      const value =
        field.rejected || previousAttempt || field.type === "code"
          ? undefined
          : values[field.key];
      bindings.push({
        field,
        origin: ref.origin,
        value,
        stored: !!stored,
        storedValue: stored
          ? credentialValues(stored.values)[field.key]
          : undefined,
      });
    }
    const missing = bindings.filter((binding) => binding.value === undefined);
    const choices = proposal.choices.map((choice) => ({
      id: choice.elementId,
      label: this.redactor.text(choice.label),
      ...(choice.intent === "back" ? { kind: "back" as const } : {}),
    }));
    // Known credentials must not leave a choices-only screen with no way to submit.
    if (!missing.length && bindings.length && choices.length)
      choices.unshift({
        id: "use-credentials",
        label: "Continue with provided credentials",
      });
    if (missing.length || choices.length) {
      const answer = await this.flow.ask(
        {
          message: this.redactor.text(proposal.message),
          fields: missing.map(({ field }) => ({
            id: field.elementId,
            label: this.redactor.text(field.label),
            type: field.type,
            required: true,
          })),
          choices,
        },
        this.signal,
      );
      this.signal.throwIfAborted();
      if (answer?.kind === "choose" && answer.choiceId !== "use-credentials") {
        await surface.click(answer.choiceId, this.signal);
        const choice = choices.find((choice) => choice.id === answer.choiceId)!;
        return {
          message: `Selected ${choice.label}`,
          back: choice.kind === "back",
          progressed: true,
        };
      }
      if (missing.length && answer?.kind !== "submit")
        throw new AuthFailure(
          "invalid_response",
          "No field response was received",
        );
      if (answer?.kind === "submit")
        for (const binding of missing) {
          binding.value = answer.values[binding.field.elementId]!;
          this.redactor.add(binding.value);
        }
    }
    if (
      proposal.submitElementId &&
      !(await surface.isFormSubmit(
        bindings.map(({ field }) => field.elementId),
        proposal.submitElementId,
        this.signal,
      ))
    ) {
      throw new AuthFailure(
        "invalid_submit",
        "The submit control does not belong to the credential form; use an explicit website action instead",
      );
    }
    for (const binding of bindings) {
      if (!binding.stored && !this.approved.has(binding.origin)) {
        if (
          !(await confirm(
            this.flow,
            { kind: "use-credentials", origin: binding.origin },
            this.signal,
          ))
        )
          throw new AuthFailure(
            "permission_denied",
            "Credential use was declined",
          );
        this.approved.add(binding.origin);
      }
    }
    // Validate the complete batch before any write. Revalidate each field again at fill time.
    for (const binding of bindings)
      await surface.validate(binding.field.elementId, this.signal);
    if (proposal.submitElementId)
      await surface.validate(proposal.submitElementId, this.signal);
    let filledAny = false;
    try {
      for (const { field, origin, value, storedValue } of bindings) {
        this.attempted.add(`${origin}:${field.key}`);
        await surface.fill(field.elementId, value!, origin, this.signal);
        filledAny = true;
        if (value !== undefined && value === storedValue)
          this.usedSavedRecord = true;
        // Conservatively persist only known durable fields, never arbitrary model-labeled text.
        if (
          field.type !== "code" &&
          ["username", "email", "phone", "password"].includes(field.key)
        ) {
          const values = this.submitted.get(origin) ?? {};
          values[field.key] = value!;
          this.submitted.set(origin, values);
        }
      }
      if (proposal.submitElementId)
        await surface.click(proposal.submitElementId, this.signal);
    } catch (error) {
      if (filledAny)
        throw new AuthFailure(
          "partial_write",
          "Credential entry was interrupted after a browser write; do not replay the attempt",
          actionTimeout(error),
        );
      throw error;
    }
    return {
      message: bindings.length
        ? "Entered credentials in an observed form"
        : "No form action performed",
      back: false,
      progressed: bindings.length > 0,
    };
  }

  async save(
    mode: "yes" | "ask" | "never",
    label?: string,
  ): Promise<Extract<AuthResult, { status: "authenticated" }>> {
    const result: Extract<AuthResult, { status: "authenticated" }> = {
      status: "authenticated",
      save: { status: "not-saved" },
      ...(this.usedSavedRecord && this.selected
        ? { accountId: this.selected.id }
        : {}),
    };
    if (mode === "never" || this.submitted.size === 0) return result;
    if (
      mode === "ask" &&
      !(await confirm(this.flow, { kind: "save-credentials" }, this.signal))
    )
      return result;
    this.signal.throwIfAborted();
    const id = this.selected?.id ?? randomUUID();
    const entries = new Map(
      this.selected?.credentials.map((entry) => [
        entry.origin,
        credentialValues(entry.values),
      ]),
    );
    for (const [origin, values] of this.submitted)
      entries.set(origin, { ...entries.get(origin), ...values });
    const record: SavedLogin = {
      id,
      label: label ?? this.selected?.label ?? `Account ${id.slice(0, 8)}`,
      serviceOrigins: [
        ...new Set([
          ...(this.selected?.serviceOrigins ?? []),
          this.serviceOrigin,
        ]),
      ],
      credentialOrigins: [...entries.keys()],
      credentials: [...entries].map(([origin, values]) => ({
        origin,
        values: toCredentials(values),
      })),
    };
    try {
      // Do not abandon a write on abort: observe its actual outcome before settling.
      await this.store.save(record);
      return {
        status: "authenticated",
        accountId: id,
        save: { status: "saved" },
      };
    } catch {
      return {
        ...result,
        save: {
          status: "failed",
          error: {
            code: "store_save_failed",
            message: "Signed in, but saving credentials failed",
          },
        },
      };
    }
  }
}
