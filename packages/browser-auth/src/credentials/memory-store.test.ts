import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./memory-store.js";
import type { SavedLogin } from "./store.js";

const record: SavedLogin = {
  id: "a",
  label: "Personal",
  serviceOrigins: ["https://mail.example.com"],
  credentialOrigins: ["https://identity.example.com"],
  credentials: [
    {
      origin: "https://identity.example.com",
      values: { password: "canary-secret" },
    },
  ],
};

describe("InMemoryStore", () => {
  it("queries both associations without returning secrets", async () => {
    const store = new InMemoryStore();
    await store.save(record);
    expect(
      await store.list({ serviceOrigin: "https://mail.example.com" }),
    ).toHaveLength(1);
    expect(
      await store.list({ credentialOrigin: "https://identity.example.com" }),
    ).toHaveLength(1);
    expect(await store.list({ serviceOrigin: "" })).toEqual([]);
    expect(
      await store.list({
        serviceOrigin: "https://wrong.example.com",
        credentialOrigin: "https://identity.example.com",
      }),
    ).toEqual([]);
    expect(JSON.stringify(await store.list())).not.toContain("canary-secret");
  });

  it("copies records on both sides and supports replace/delete", async () => {
    const store = new InMemoryStore();
    const input = structuredClone(record);
    await store.save(input);
    input.label = "mutated";
    const loaded = (await store.get("a"))!;
    loaded.credentials[0]!.values.password = "changed";
    expect((await store.get("a"))!.credentials[0]!.values.password).toBe(
      "canary-secret",
    );
    expect((await store.list())[0]!.label).toBe("Personal");
    await store.save({ ...record, label: "Updated" });
    expect((await store.list())[0]!.label).toBe("Updated");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });
});
