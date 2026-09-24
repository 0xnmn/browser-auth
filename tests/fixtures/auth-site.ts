import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const fixturePassword = "fixture-password-only-73";
export const fixtureCode = "618204";

/** Disposable local website, never a real account or authentication service. */
export async function startAuthSite() {
  const submissions: Array<{ username: string; password: string }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? "")
        .split("; ")
        .filter(Boolean)
        .map((part) => part.split("=")),
    );
    const html = (body: string) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><head><title>Auth fixture</title></head><body>${body}</body></html>`,
      );
    };
    const redirect = (location: string) => {
      res.writeHead(303, { location });
      res.end();
    };
    const dashboard = (switched = false) =>
      html(
        `<h1>${switched ? "Switched" : "Dashboard"}</h1><p>Signed in as ${cookies.account ?? "alice"}</p><a href="/logout">Sign out</a><a href="/accounts">Switch account</a>`,
      );
    if (url.pathname === "/logout") {
      res.setHeader("set-cookie", "account=; Max-Age=0; Path=/; HttpOnly");
      html("<h1>Signed out</h1><a href='/'>Sign in</a>");
    } else if (url.pathname === "/accounts") {
      html(
        "<h1>Choose account</h1><a href='/switch?to=alice'>Personal Alice</a><a href='/switch?to=bob'>Work Bob</a>",
      );
    } else if (url.pathname === "/switch") {
      const account = url.searchParams.get("to") === "bob" ? "bob" : "alice";
      res.setHeader("set-cookie", `account=${account}; Path=/; HttpOnly`);
      redirect("/switched");
    } else if (url.pathname === "/switched") dashboard(true);
    else if (url.pathname === "/frame") {
      const origin = url.searchParams.get("origin");
      html(
        `<h1>Service sign in</h1><iframe title="Identity provider" src="${origin}" width="500" height="500"></iframe>`,
      );
    } else if (url.pathname === "/multi") {
      html(
        "<h1>Sign in</h1><form action='/password'><label>Phone<input name='phone' type='tel'></label><button type='submit'>Continue</button></form>",
      );
    } else if (url.pathname === "/password") {
      html(
        "<h1>Enter password</h1><form method='post' action='/session'><label>Password<input name='password' type='password' autocomplete='current-password'></label><button type='submit'>Sign in</button></form><a href='/multi'>Back</a>",
      );
    } else if (url.pathname === "/otp") {
      html(
        "<h1>Verification</h1><form method='post' action='/verify'><label>Code<input name='code' autocomplete='one-time-code'></label><button type='submit'>Verify</button></form>",
      );
    } else if (url.pathname === "/verify" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (new URLSearchParams(body).get("code") !== fixtureCode)
        return html("<h1>Rejected code</h1>");
      res.setHeader("set-cookie", "account=alice; Path=/; HttpOnly");
      redirect("/");
    } else if (url.pathname === "/session" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const fields = new URLSearchParams(body);
      const username = fields.get("username") ?? "alice";
      const password = fields.get("password") ?? "";
      submissions.push({ username, password });
      if (password !== fixturePassword)
        return html("<h1>Rejected credentials</h1>");
      res.setHeader(
        "set-cookie",
        `account=${username === "bob" ? "bob" : "alice"}; Path=/; HttpOnly`,
      );
      redirect("/");
    } else if (cookies.account) dashboard();
    else
      html(
        "<h1>Sign in</h1><form method='post' action='/session'><label>Username<input name='username' autocomplete='username'></label><label>Password<input name='password' type='password' autocomplete='current-password'></label><button type='submit'>Sign in</button></form>",
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
