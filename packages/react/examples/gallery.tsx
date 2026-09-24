import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthPanel } from "../src/AuthPanel.js";
import type { AuthSnapshot } from "@browser-auth/core/protocol";
import "../src/styles.css";

const scenarios: Array<{ name: string; snapshot: AuthSnapshot }> = [
  {
    name: "Credentials and Back",
    snapshot: {
      status: "waiting",
      interaction: {
        id: "credentials",
        kind: "form",
        message: "Continue signing in to your existing browser.",
        fields: [
          { id: "email", label: "Email", type: "email", required: true },
          {
            id: "password",
            label: "Password",
            type: "password",
            required: true,
          },
        ],
        choices: [{ id: "back", label: "Back", kind: "back" }],
      },
    },
  },
  {
    name: "Saved accounts",
    snapshot: {
      status: "waiting",
      interaction: {
        id: "accounts",
        kind: "form",
        message: "Choose a saved login",
        fields: [],
        choices: [
          { id: "personal", label: "Personal account" },
          { id: "work", label: "Work account" },
          { id: "new", label: "Use another account" },
        ],
      },
    },
  },
  {
    name: "Destination consent",
    snapshot: {
      status: "waiting",
      interaction: {
        id: "consent",
        kind: "confirm",
        confirmation: {
          kind: "use-credentials",
          origin: "https://accounts.example.com",
        },
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    },
  },
  {
    name: "Account confirmation",
    snapshot: {
      status: "waiting",
      interaction: {
        id: "identity",
        kind: "confirm",
        confirmation: {
          kind: "confirm-account-switch",
          accountLabel: "Work account",
        },
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    },
  },
  {
    name: "External approval",
    snapshot: {
      status: "waiting",
      interaction: {
        id: "external",
        kind: "external",
        message:
          "Complete the passkey or approval prompt in the existing browser. This flow will check again.",
        choices: [],
      },
    },
  },
  {
    name: "Independent storage error",
    snapshot: {
      status: "done",
      result: {
        status: "authenticated",
        save: {
          status: "failed",
          error: {
            code: "store_save_failed",
            message: "Credentials could not be saved.",
          },
        },
      },
    },
  },
];

function Example({ name, snapshot }: (typeof scenarios)[number]) {
  const [responses, setResponses] = useState(0);
  return (
    <article aria-label={name}>
      <h2 className="example-label">{name}</h2>
      <AuthPanel
        snapshot={snapshot}
        onRespond={async () => {
          setResponses((count) => count + 1);
        }}
      />
      <output aria-label="Response count">{responses} responses</output>
    </article>
  );
}

function Gallery() {
  return (
    <main>
      <header>
        <p>Browser Auth · Component preview</p>
        <h1>One flow. Your browser.</h1>
        <p>
          Synthetic UI states only. No live browser connection or credentials
          are stored.
        </p>
      </header>
      <div className="gallery">
        {scenarios.map((scenario) => (
          <Example key={scenario.name} {...scenario} />
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
