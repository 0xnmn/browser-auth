import { z } from "zod";
import { originOf } from "./security/origins.js";

const headers = z.record(z.string(), z.string());
const target = {
  cdpUrl: z.string().min(1),
  url: z.string().min(1),
  cdpHeaders: headers.optional(),
  targetId: z.string().min(1).optional(),
  signal: z
    .custom<AbortSignal>(
      (value) =>
        typeof AbortSignal !== "undefined" && value instanceof AbortSignal,
    )
    .optional(),
};
const credentials = z
  .object({
    username: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    password: z.string().optional(),
    fields: headers.optional(),
  })
  .strict();
const schema = z
  .object({
    ...target,
    credentials: credentials.optional(),
    accountId: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    save: z.enum(["yes", "ask", "never"]).optional(),
    forgetCredentials: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.forgetCredentials || Boolean(value.accountId));

/** Validate public operation input without exposing the runtime schemas. */
export function validateOperationOptions(value: unknown): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("invalid_login_options");
  try {
    originOf(parsed.data.url);
  } catch {
    throw new Error("invalid_auth_url");
  }
}
