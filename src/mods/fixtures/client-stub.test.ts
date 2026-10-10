import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("fixtures Client factices", () => {
  it("client-module.json embarque exactement les sources de client-stub/", () => {
    const bundle = JSON.parse(read("./client-module.json")).response.response;
    const source = (key: string) => bundle.files.find((f: { key: string }) => f.key === key)?.source;
    expect(source("claude:surface-runtime")).toBe(read("./client-stub/runtime.js"));
    expect(source("surface:///hooks/rows.tsx")).toBe(read("./client-stub/module.js"));
  });

  it("le rendu anonymisé annonce le hash du bundle factice", () => {
    const line = JSON.parse(read("./client-render.ndjson").split("\n")[0]).response.response;
    const bundle = JSON.parse(read("./client-module.json")).response.response;
    expect(line.client_modules).toEqual({ [bundle.plugin]: bundle.hash });
  });
});
