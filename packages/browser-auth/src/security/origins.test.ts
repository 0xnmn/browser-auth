import { expect, it } from "vitest";
import { originOf } from "./origins.js";

it("uses exact canonical origins, not registrable domains", () => {
  expect(originOf("https://LOGIN.Example.com:443/path?q=x")).toBe(
    "https://login.example.com",
  );
  expect(originOf("https://login.example.com.evil.test")).not.toBe(
    "https://login.example.com",
  );
  expect(originOf("https://login.example.com:444")).not.toBe(
    "https://login.example.com",
  );
  expect(() => originOf("https://example.com@evil.test")).toThrow();
  expect(() => originOf("javascript:alert(1)")).toThrow();
  expect(() => originOf("http://example.com")).toThrow();
  expect(originOf("http://127.0.0.1:1234/login")).toBe("http://127.0.0.1:1234");
});
