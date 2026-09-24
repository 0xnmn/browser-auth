export interface Credentials {
  username?: string;
  email?: string;
  phone?: string;
  password?: string;
  fields?: Record<string, string>;
}

export interface SavedLoginSummary {
  id: string;
  label: string;
  identifierHint?: string;
  serviceOrigins: string[];
  credentialOrigins: string[];
}

export interface SavedLogin extends SavedLoginSummary {
  credentials: Array<{ origin: string; values: Credentials }>;
}

export interface StoreQuery {
  serviceOrigin?: string;
  credentialOrigin?: string;
}

/** Trusted application boundary: get/save carry plaintext values. */
export interface CredentialStore {
  list(query?: StoreQuery): Promise<SavedLoginSummary[]>;
  get(id: string): Promise<SavedLogin | null>;
  save(login: SavedLogin): Promise<void>;
  delete(id: string): Promise<void>;
}

export function credentialValues(
  credentials: Credentials,
): Record<string, string> {
  const values = { ...credentials.fields };
  for (const key of ["username", "email", "phone", "password"] as const) {
    if (credentials[key] !== undefined) values[key] = credentials[key];
  }
  return values;
}

export function toCredentials(values: Record<string, string>): Credentials {
  const result: Credentials = {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      key === "username" ||
      key === "email" ||
      key === "phone" ||
      key === "password"
    )
      result[key] = value;
    else fields[key] = value;
  }
  if (Object.keys(fields).length) result.fields = fields;
  return result;
}
