/** Reduces accidental reflection; it cannot sanitize a malicious website completely. */
export class Redactor {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (value) this.values.add(value);
  }

  text(value: string): string {
    let result = value;
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) {
      const encoded = encodeURIComponent(secret);
      for (const representation of new Set([
        secret,
        encoded,
        encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
        encoded.replaceAll("%20", "+"),
      ])) {
        result = result.split(representation).join("[redacted]");
      }
    }
    return result;
  }

  clear(): void {
    this.values.clear();
  }
}
