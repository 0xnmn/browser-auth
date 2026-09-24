import { z } from "zod";

const reference = z.string().min(1).max(100);
const element = {
  elementId: reference.describe(
    "Copy the exact current observation elements[].id (full UUID), not an HTML id, field name, label, or selector.",
  ),
};
export const proposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ask_user"),
      message: z.string().max(500),
      fields: z
        .array(
          z
            .object({
              ...element,
              key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
              label: z.string().max(160),
              type: z.enum(["text", "email", "phone", "password", "code"]),
              rejected: z.boolean(),
            })
            .strict(),
        )
        .max(20),
      choices: z
        .array(
          z
            .object({
              ...element,
              label: z.string().max(160),
              intent: z.enum([
                "continue",
                "back",
                "switch",
                "add",
                "logout",
                "finish",
              ]),
            })
            .strict(),
        )
        .max(20),
      submitElementId: reference
        .nullable()
        .describe(
          "Exact observed id of a native form submit control, or null. For non-submit Next/Continue buttons, fill first and use click in a later turn.",
        ),
      external: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("click"), ...element }).strict(),
  z.object({ kind: z.literal("doubleClick"), ...element }).strict(),
  z.object({ kind: z.literal("hover"), ...element }).strict(),
  z.object({ kind: z.literal("focus"), ...element }).strict(),
  z
    .object({
      kind: z.literal("press"),
      ...element,
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      elementId: reference.optional(),
      deltaX: z.number().min(-2000).max(2000).optional(),
      deltaY: z.number().min(-2000).max(2000),
    })
    .strict(),
  z
    .object({ kind: z.literal("check"), ...element, checked: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal("select"),
      ...element,
      indices: z.array(z.number().int().min(0)).min(1).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drag"),
      sourceElementId: reference,
      targetElementId: reference,
    })
    .strict(),
  z.object({ kind: z.literal("navigate"), url: z.string().max(2048) }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z.object({ kind: z.literal("forward") }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
  z
    .object({
      kind: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(5000),
    })
    .strict(),
  z.object({ kind: z.literal("inspect"), ...element }).strict(),
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("screenshot") }).strict(),
  z.object({ kind: z.literal("opener") }).strict(),
  z.object({ kind: z.literal("tabs_list") }).strict(),
  z.object({ kind: z.literal("tab_switch"), pageId: reference }).strict(),
  z.object({ kind: z.literal("tab_new") }).strict(),
  z.object({ kind: z.literal("tab_close"), pageId: reference }).strict(),
  z.object({ kind: z.literal("frames_list") }).strict(),
  z
    .object({
      kind: z.literal("done"),
      outcome: z.enum([
        "authenticated",
        "signed-out",
        "account-changed",
        "unsupported",
        "not-signed-in",
        "rejected",
      ]),
    })
    .strict(),
]);
