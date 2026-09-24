import { z } from "zod";

export const authErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type AuthError = z.infer<typeof authErrorSchema>;

export const saveOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved") }),
  z.object({ status: z.literal("not-saved") }),
  z.object({ status: z.literal("failed"), error: authErrorSchema }),
]);

export const authResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authenticated"),
    accountId: z.string().optional(),
    save: saveOutcomeSchema,
  }),
  z.object({
    status: z.literal("signed-out"),
    deletion: z.enum(["not-requested", "deleted", "failed"]),
    error: authErrorSchema.optional(),
  }),
  z.object({
    status: z.literal("unknown"),
    message: z.string(),
    deletion: z.enum(["deleted", "failed"]).optional(),
  }),
  z.object({ status: z.literal("cancelled") }),
  z.object({
    status: z.literal("failed"),
    error: authErrorSchema,
    deletion: z.enum(["deleted", "failed"]).optional(),
  }),
]);
export type AuthResult = z.infer<typeof authResultSchema>;

export const choiceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.literal("back").optional(),
  })
  .strict();

export const fieldSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    type: z.enum(["text", "email", "phone", "password", "code"]),
    required: z.boolean(),
  })
  .strict();

export const interactionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string(),
      kind: z.literal("form"),
      message: z.string().optional(),
      fields: z.array(fieldSchema),
      choices: z.array(choiceSchema),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal("external"),
      message: z.string(),
      choices: z.array(choiceSchema),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal("confirm"),
      confirmation: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("use-credentials"), origin: z.string() })
          .strict(),
        z.object({ kind: z.literal("save-credentials") }).strict(),
        z
          .object({
            kind: z.literal("confirm-sign-in"),
            accountLabel: z.string().optional(),
          })
          .strict(),
        z.object({ kind: z.literal("confirm-sign-out") }).strict(),
        z
          .object({
            kind: z.literal("confirm-account-switch"),
            accountLabel: z.string().optional(),
          })
          .strict(),
      ]),
      choices: z.array(choiceSchema),
    })
    .strict(),
]);
export type AuthInteraction = z.infer<typeof interactionSchema>;

export const responseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("submit"),
      interactionId: z.string(),
      values: z.record(z.string(), z.string().max(8192)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("choose"),
      interactionId: z.string(),
      choiceId: z.string(),
    })
    .strict(),
]);
export type AuthResponse = z.infer<typeof responseSchema>;

export const snapshotSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), message: z.string() }).strict(),
  z
    .object({ status: z.literal("waiting"), interaction: interactionSchema })
    .strict(),
  z.object({ status: z.literal("done"), result: authResultSchema }).strict(),
]);
export type AuthSnapshot = z.infer<typeof snapshotSchema>;
