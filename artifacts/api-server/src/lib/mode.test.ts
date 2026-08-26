import { describe, expect, it } from "vitest";
import { isRequestOriginAllowed } from "./auth/csrf";
import { missingSaasEnv, resolveMode } from "./mode";

describe("resolveMode", () => {
  it("defaults to selfhosted for anything that is not exactly saas", () => {
    for (const raw of [undefined, "", "  ", "selfhosted", "SaaS-beta", "sass", "production"]) {
      expect(resolveMode(raw)).toBe("selfhosted");
    }
  });

  it("resolves saas, case- and whitespace-insensitively", () => {
    for (const raw of ["saas", "SAAS", " SaaS "]) {
      expect(resolveMode(raw)).toBe("saas");
    }
  });
});

describe("missingSaasEnv", () => {
  it("requires nothing in selfhosted", () => {
    expect(missingSaasEnv("selfhosted", {})).toEqual([]);
  });

  it("names what saas is missing", () => {
    expect(missingSaasEnv("saas", {})).toEqual(["APP_ORIGIN"]);
    expect(missingSaasEnv("saas", { APP_ORIGIN: "   " })).toEqual(["APP_ORIGIN"]);
    expect(missingSaasEnv("saas", { APP_ORIGIN: "https://example.test" })).toEqual([]);
  });
});

describe("isRequestOriginAllowed", () => {
  const APP = "https://app.example.test";

  it.each([
    ["GET", null, null, APP, true],
    ["HEAD", null, null, APP, true],
    ["OPTIONS", null, null, APP, true],
    ["POST", APP, null, APP, true],
    ["POST", `${APP}/`, null, APP, true],
    ["POST", null, "same-origin", APP, true],
    ["POST", null, null, APP, false],
    ["POST", "https://evil.test", null, APP, false],
    ["POST", null, "cross-site", APP, false],
    ["DELETE", APP, null, APP, true],
    ["PATCH", "https://evil.test", "cross-site", APP, false],
    // Nothing to compare against: refuse rather than wave it through.
    ["POST", APP, "same-origin", null, false],
  ] as const)(
    "%s from %s (sec-fetch-site %s) against %s -> %s",
    (method, origin, secFetchSite, appOrigin, expected) => {
      expect(isRequestOriginAllowed(method, origin, secFetchSite, appOrigin)).toBe(expected);
    },
  );
});
