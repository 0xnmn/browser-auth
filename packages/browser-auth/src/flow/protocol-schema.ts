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
  z.object({ status: z.literal("already-signed-in") }),
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
    id: z.string().min(1).max(256),
    label: z.string().min(1),
    kind: z.enum(["back", "finish", "logout", "switch", "add"]).optional(),
  })
  .strict();

export const fieldSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(500),
    type: z.enum(["text", "email", "phone", "password", "code"]),
    required: z.boolean(),
  })
  .strict();

export const interactionSchema = z
  .object({
    id: z.string().min(1).max(256),
    message: z.string().min(1).max(2000),
    fields: z.array(fieldSchema).max(32),
    choices: z.array(choiceSchema),
    confirmation: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("use-credentials"),
            origin: z.string().min(1).max(2048),
          })
          .strict(),
        z.object({ kind: z.literal("save-credentials") }).strict(),
      ])
      .optional(),
    pollAfterMs: z.number().int().min(1).max(300_000).optional(),
  })
  .strict()
  .superRefine((interaction, context) => {
    if (
      interaction.confirmation &&
      (interaction.fields.length !== 0 ||
        interaction.pollAfterMs !== undefined ||
        interaction.choices.length !== 2 ||
        interaction.choices[0]?.id !== "yes" ||
        interaction.choices[1]?.id !== "no")
    )
      context.addIssue({ code: "custom", message: "invalid confirmation" });
    const ids = [
      ...interaction.fields.map((field) => field.id),
      ...interaction.choices.map((choice) => choice.id),
    ];
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "duplicate ids" });
    if (
      interaction.fields.length === 0 &&
      interaction.choices.length === 0 &&
      interaction.pollAfterMs === undefined
    )
      context.addIssue({
        code: "custom",
        message: "interaction cannot answer",
      });
  });
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
