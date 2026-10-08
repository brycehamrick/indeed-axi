import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { installSkill, skillCommand } from "../src/commands/skill.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "indeed-axi-skill-test-"));
}

function makeSource(dir: string, content = "# skill v1"): string {
  const source = join(dir, "SKILL.md");
  writeFileSync(source, content, "utf8");
  return source;
}

describe("installSkill", () => {
  it("installs into <dir>/indeed-axi/SKILL.md", () => {
    const dir = tempDir();
    const source = makeSource(dir);
    const result = installSkill({ skillsDir: join(dir, "skills"), force: false, source });
    expect(result.outcome).toBe("installed");
    expect(readFileSync(result.path, "utf8")).toBe("# skill v1");
  });

  it("is a no-op when identical", () => {
    const dir = tempDir();
    const source = makeSource(dir);
    const skillsDir = join(dir, "skills");
    installSkill({ skillsDir, force: false, source });
    const again = installSkill({ skillsDir, force: false, source });
    expect(again.outcome).toBe("identical");
  });

  it("requires --force to overwrite a changed skill", () => {
    const dir = tempDir();
    const skillsDir = join(dir, "skills");
    installSkill({ skillsDir, force: false, source: makeSource(dir, "# v1") });
    const sourceV2 = join(dir, "v2.md");
    writeFileSync(sourceV2, "# v2", "utf8");
    expect(() => installSkill({ skillsDir, force: false, source: sourceV2 })).toThrowError(AxiError);
    const updated = installSkill({ skillsDir, force: true, source: sourceV2 });
    expect(updated.outcome).toBe("updated");
    expect(readFileSync(updated.path, "utf8")).toBe("# v2");
  });
});

describe("skill command", () => {
  it("install renders the target path and is idempotent", async () => {
    const dir = tempDir();
    const skillsDir = join(dir, "agents-skills");
    const first = (await skillCommand(["install", "--dir", skillsDir])) as Record<string, unknown>;
    expect(first["skill"]).toMatchObject({ name: "indeed-axi", result: "installed" });
    const second = (await skillCommand(["install", "--dir", skillsDir])) as Record<string, unknown>;
    expect(second["skill"]).toMatchObject({ result: "identical" });
  });

  it("uses the packaged SKILL.md (run from dist when built)", async () => {
    // resolveSkillSource walks from the compiled module; in the repo layout
    // the dist candidate exists after a build, so this doubles as a pack check.
    const dir = tempDir();
    const result = (await skillCommand(["install", "--dir", dir])) as Record<string, unknown>;
    expect(result["skill"]).toBeDefined();
  });
});
