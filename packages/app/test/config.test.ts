import { CORE_TOOL_NAMES } from "@vesper/contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALWAYS_DECLARED_TOOLS,
  checkReferences,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_NAME,
  FIRST_PARTY_PLUGINS,
  loadModelConfig,
  loadProfileConfig,
  withoutUnusableProfiles,
} from "../src/config.ts";
import { parseEnvironment } from "../src/environment.ts";

const dirs: string[] = [];
const envFor = (extra: Record<string, string> = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "ogb-appcfg-"));
  dirs.push(dataDir);
  return { dataDir, env: parseEnvironment({ OGB_DATA_DIR: dataDir, ...extra }) };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const writeConfig = (dataDir: string, name: string, content: string) => {
  mkdirSync(join(dataDir, "config"), { recursive: true });
  writeFileSync(join(dataDir, "config", name), content);
};

describe("model configuration", () => {
  it("defaults to one model from the environment: the Command Code provider, the key by reference only", () => {
    const { env } = envFor();
    const config = loadModelConfig(env);
    expect(config.default).toBe(DEFAULT_MODEL_NAME);
    expect(config.models[DEFAULT_MODEL_NAME]).toEqual({
      baseUrl: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
      contextWindow: 1_000_000,
      apiKey: "env:COMMANDCODE_API_KEY",
      compat: "deepseek",
      images: true,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("uses models.json when it exists, validated, and refuses a literal key in it without echoing it", () => {
    const { dataDir, env } = envFor();
    writeConfig(
      dataDir,
      "models.json",
      JSON.stringify({ models: { other: { baseUrl: "https://x.test/v1", model: "m", contextWindow: 1000, apiKey: "env:COMMANDCODE_API_KEY" } } }),
    );
    expect(Object.keys(loadModelConfig(env).models)).toEqual(["other"]);
    const literalKey = ["sk", "literal", "key", "abcdefghijklmnop"].join("-"); // built at run time: no key-looking text sits in this file
    writeConfig(
      dataDir,
      "models.json",
      JSON.stringify({ models: { other: { baseUrl: "https://x.test/v1", model: "m", contextWindow: 1000, apiKey: literalKey } } }),
    );
    expect(() => loadModelConfig(env)).toThrow(/must be a secret reference/);
    try {
      loadModelConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain(literalKey);
    }
    writeConfig(dataDir, "models.json", "{not json");
    expect(() => loadModelConfig(env)).toThrow(/models.json is not valid JSON/);
  });
});

describe("profile configuration", () => {
  it("defaults to two profiles with the safety floor on, naming only first-party plugins and the default model", () => {
    const { env } = envFor();
    const config = loadProfileConfig(env);
    expect(config.safetyFloor).toEqual({ review: true, redaction: true });
    expect(Object.keys(config.profiles)).toEqual(["general", "general-mail"]);
    for (const profile of Object.values(config.profiles)) {
      expect(profile.model).toBe(DEFAULT_MODEL_NAME);
      for (const plugin of profile.plugins) expect(FIRST_PARTY_PLUGINS).toContain(plugin);
    }
    expect(config.profiles["general-mail"]?.plugins).toContain("mail-sim");
    for (const name of ALWAYS_DECLARED_TOOLS.filter((n) => n !== "browser")) expect(Object.values(CORE_TOOL_NAMES).flat()).toContain(name); // no typo in a core name
    for (const profile of Object.values(config.profiles)) expect(profile.alwaysDeclaredTools).toEqual([...ALWAYS_DECLARED_TOOLS]); // ask, speak and browse need no search first
    expect(config.profiles.general?.plugins).not.toContain("mail-sim");
  });

  it("takes profiles.json from the box, the only place that can lower the floor", () => {
    const { dataDir, env } = envFor();
    writeConfig(dataDir, "profiles.json", JSON.stringify({ safetyFloor: { review: false }, profiles: { bare: { plugins: [] } } }));
    expect(loadProfileConfig(env).safetyFloor).toEqual({ review: false, redaction: true });
  });
});

describe("checkReferences", () => {
  it("finds a profile that names a model or a plugin that does not exist", () => {
    const { env } = envFor();
    const models = loadModelConfig(env);
    const profiles = loadProfileConfig(env);
    expect(checkReferences(models, profiles, [...FIRST_PARTY_PLUGINS])).toEqual([]);
    const problems = checkReferences(models, profiles, ["handoff"]);
    expect(problems).toContain("profile 'general' needs the plugin 'browser', which is not installed");
    expect(checkReferences({ ...models, models: {} }, profiles, [...FIRST_PARTY_PLUGINS])[0]).toContain(
      "names the model 'main', which is not in the model config",
    );
  });
});

describe("withoutUnusableProfiles", () => {
  it("drops a profile whose plugin is missing and moves the default to the first one left", () => {
    const { env } = envFor();
    const profiles = loadProfileConfig(env);
    const left = withoutUnusableProfiles(profiles, ["handoff", "browser", "computer"]);
    expect(Object.keys(left.profiles)).toEqual(["general"]);
    expect(left.default).toBe("general");
    const onlyMail = withoutUnusableProfiles({ ...profiles, default: "general-mail" }, ["handoff", "browser", "computer"]);
    expect(onlyMail.default).toBe("general");
    expect(withoutUnusableProfiles(profiles, []).default).toBe("");
  });
});
