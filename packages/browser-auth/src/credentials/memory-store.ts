import type {
  CredentialStore,
  SavedLogin,
  SavedLoginSummary,
  StoreQuery,
} from "./store.js";

/** Process-local plaintext storage. Every read and write is defensively copied. */
export class InMemoryStore implements CredentialStore {
  private readonly records = new Map<string, SavedLogin>();

  async list(query: StoreQuery = {}): Promise<SavedLoginSummary[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          (query.serviceOrigin === undefined ||
            record.serviceOrigins.includes(query.serviceOrigin)) &&
          (query.credentialOrigin === undefined ||
            record.credentialOrigins.includes(query.credentialOrigin)),
      )
      .map(({ credentials: _, ...summary }) => structuredClone(summary));
  }

  async get(id: string): Promise<SavedLogin | null> {
    return structuredClone(this.records.get(id) ?? null);
  }

  async save(login: SavedLogin): Promise<void> {
    this.records.set(login.id, structuredClone(login));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}
