export function originOf(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !["https:", "http:"].includes(url.protocol)
  ) {
    throw new Error("Unsupported authentication URL");
  }
  // HTTP is permitted only for local development fixtures.
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Authentication requires HTTPS outside loopback");
  }
  return url.origin;
}
