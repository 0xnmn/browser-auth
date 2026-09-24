import { expect, it } from "vitest";
import { Redactor } from "./redaction.js";

it("removes known plaintext and URL encoded reflections", () => {
  const redactor = new Redactor();
  redactor.add("s3cr&et");
  expect(redactor.text("s3cr&et s3cr%26et")).toBe("[redacted] [redacted]");
  redactor.add("a b");
  redactor.add("é");
  expect(redactor.text("a+b %c3%a9")).toBe("[redacted] [redacted]");
});
