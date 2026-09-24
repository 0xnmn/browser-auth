import { z } from "zod";

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
const schemas = {
  login: z
    .object({
      ...target,
      credentials: credentials.optional(),
      accountId: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      save: z.enum(["yes", "ask", "never"]).optional(),
    })
    .strict(),
  switch: z.object({ ...target, accountId: z.string().min(1) }).strict(),
  logout: z
    .object({
      ...target,
      accountId: z.string().min(1).optional(),
      forgetCredentials: z.boolean().optional(),
    })
    .strict()
    .refine((value) => !value.forgetCredentials || Boolean(value.accountId)),
};

/** Validate public operation input without exposing the runtime schemas. */
export function validateOperationOptions(
  operation: "login" | "logout" | "switch",
  value: unknown,
): void {
  if (!schemas[operation].safeParse(value).success)
    throw new Error(`invalid_${operation}_options`);
}
