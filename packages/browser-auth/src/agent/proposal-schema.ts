import { z } from "zod";

const reference = z.string().min(1).max(100);
const proposedChoice = z
  .object({
    elementId: reference,
    label: z.string().max(160),
    back: z.boolean(),
  })
  .strict();

export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), elementId: reference }).strict(),
  z
    .object({
      kind: z.literal("form"),
      fields: z
        .array(
          z
            .object({
              elementId: reference,
              key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
              label: z.string().max(160),
              type: z.enum(["text", "email", "phone", "password", "code"]),
              rejected: z.boolean(),
            })
            .strict(),
        )
        .max(20),
      choices: z.array(proposedChoice).max(20),
      submitElementId: reference.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      message: z.string().max(500),
      choices: z.array(proposedChoice).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("done"),
      outcome: z.enum([
        "authenticated",
        "signed-out",
        "unsupported",
        "rejected",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("wait") }).strict(),
]);
