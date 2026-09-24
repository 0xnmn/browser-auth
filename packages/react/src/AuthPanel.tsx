import { useRef, useState, type FormEvent } from "react";
import type {
  AuthInteraction,
  AuthResponse,
  AuthResult,
  AuthSnapshot,
} from "@browser-auth/core/protocol";

export interface AuthPanelProps {
  snapshot: AuthSnapshot;
  onRespond: (response: AuthResponse) => Promise<void>;
  onCancel?: () => void;
}

const inputType = (type: "text" | "email" | "phone" | "password" | "code") =>
  type === "phone" ? "tel" : type === "code" ? "text" : type;

function Result({ result }: { result: AuthResult }) {
  if (result.status === "already-signed-in")
    return (
      <>
        <h2>Already signed in</h2>
        <p>The browser has an existing signed-in session.</p>
      </>
    );
  if (result.status === "authenticated") {
    const save =
      result.save.status === "saved"
        ? "Credentials saved."
        : result.save.status === "not-saved"
          ? "Credentials were not saved."
          : `Signed in, but saving failed: ${result.save.error.message}`;
    return (
      <>
        <h2>Signed in</h2>
        {result.accountId && <p>Account: {result.accountId}</p>}
        <p>{save}</p>
      </>
    );
  }
  if (result.status === "signed-out") {
    const deletion =
      result.deletion === "deleted"
        ? "Saved credentials deleted."
        : result.deletion === "failed"
          ? "Signed out, but deleting saved credentials failed."
          : undefined;
    return (
      <>
        <h2>Signed out</h2>
        {deletion && <p>{deletion}</p>}
        {result.error && <p>{result.error.message}</p>}
      </>
    );
  }
  if (result.status === "cancelled")
    return (
      <>
        <h2>Cancelled</h2>
        <p>The authentication flow was cancelled.</p>
      </>
    );
  if (result.status === "unknown")
    return (
      <>
        <h2>Result unknown</h2>
        <p>{result.message}</p>
        {result.deletion === "failed" && (
          <p>Deleting saved credentials failed.</p>
        )}
        {result.deletion === "deleted" && <p>Saved credentials deleted.</p>}
      </>
    );
  return (
    <>
      <h2>Authentication failed</h2>
      <p>{result.error.message}</p>
      {result.deletion === "failed" && (
        <p>Deleting saved credentials also failed.</p>
      )}
      {result.deletion === "deleted" && <p>Saved credentials deleted.</p>}
    </>
  );
}

function Confirmation({
  interaction,
}: {
  interaction: AuthInteraction & {
    confirmation: NonNullable<AuthInteraction["confirmation"]>;
  };
}) {
  const confirmation = interaction.confirmation;
  if (confirmation.kind === "use-credentials")
    return (
      <p>
        Allow credentials to be used at{" "}
        <strong className="browser-auth__origin">{confirmation.origin}</strong>?
      </p>
    );
  return <p>Save these credentials for later?</p>;
}

function Interaction({
  interaction,
  onRespond,
}: {
  interaction: AuthInteraction;
  onRespond: AuthPanelProps["onRespond"];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const send = async (response: AuthResponse) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(false);
    try {
      await onRespond(response);
    } catch {
      pendingRef.current = false;
      setError(true);
      setPending(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    const values: Record<string, string> = {};
    const data = new FormData(event.currentTarget);
    for (const field of interaction.fields)
      values[field.id] = String(data.get(field.id) ?? "");
    event.currentTarget.reset();
    void send({ kind: "submit", interactionId: interaction.id, values });
  };

  const choices = interaction.choices.map((choice) => (
    <button
      className={
        choice.kind === "back"
          ? "browser-auth__button browser-auth__button--secondary"
          : "browser-auth__button"
      }
      disabled={pending}
      key={choice.id}
      type="button"
      onClick={() => {
        formRef.current?.reset();
        void send({
          kind: "choose",
          interactionId: interaction.id,
          choiceId: choice.id,
        });
      }}
    >
      {choice.label}
    </button>
  ));

  return (
    <>
      {interaction.confirmation && (
        <>
          <h2>Confirm action</h2>
          <Confirmation
            interaction={
              interaction as AuthInteraction & {
                confirmation: NonNullable<AuthInteraction["confirmation"]>;
              }
            }
          />
        </>
      )}
      {!interaction.confirmation && (
        <form ref={formRef} onSubmit={submit} autoComplete="on">
          <h2>
            {interaction.fields.length
              ? "Enter details"
              : interaction.choices.length
                ? "Choose an action"
                : "Waiting"}
          </h2>
          <p>{interaction.message}</p>
          {interaction.fields.map((field) => (
            <label className="browser-auth__field" key={field.id}>
              {field.label}
              <input
                name={field.id}
                type={inputType(field.type)}
                required={field.required}
                autoComplete={
                  field.type === "password"
                    ? "current-password"
                    : field.type === "code"
                      ? "one-time-code"
                      : undefined
                }
              />
            </label>
          ))}
          <div className="browser-auth__actions">
            {interaction.fields.length > 0 && (
              <button
                className="browser-auth__button"
                disabled={pending}
                type="submit"
              >
                Continue
              </button>
            )}
            {choices}
          </div>
        </form>
      )}
      {interaction.confirmation && (
        <div className="browser-auth__actions">{choices}</div>
      )}
      {pending && <p role="status">Submitting…</p>}
      {error && (
        <p className="browser-auth__error" role="alert">
          The response could not be accepted. Check the current prompt and try
          again.
        </p>
      )}
    </>
  );
}

export function AuthPanel({ snapshot, onRespond, onCancel }: AuthPanelProps) {
  return (
    <section
      className="browser-auth"
      aria-live="polite"
      aria-busy={snapshot.status === "running"}
    >
      {snapshot.status === "running" && (
        <>
          <h2>Authentication in progress</h2>
          <p>{snapshot.message}</p>
        </>
      )}
      {snapshot.status === "waiting" && (
        <Interaction
          key={snapshot.interaction.id}
          interaction={snapshot.interaction}
          onRespond={onRespond}
        />
      )}
      {snapshot.status === "done" && <Result result={snapshot.result} />}
      {onCancel && snapshot.status !== "done" && (
        <button
          className="browser-auth__cancel"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
      )}
    </section>
  );
}
