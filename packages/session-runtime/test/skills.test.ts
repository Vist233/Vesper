import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frontMatter, listSkills, SKILLS_LISTED, skillsText } from "../src/skills.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(skills: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
  }
  return dir;
}

describe("skills in the shared folder", () => {
  it("reads name and description from the front matter", () => {
    expect(frontMatter('---\nname: cut-video\ndescription: "Cut and title a clip with ffmpeg"\n---\n# Body')).toEqual({
      name: "cut-video",
      description: "Cut and title a clip with ffmpeg",
    });
    expect(frontMatter("# no front matter")).toBeNull();
  });

  it("lists every folder with a SKILL.md, sorted, and names one without front matter by its folder", () => {
    const dir = folder({
      "publish-blog": "---\nname: publish-blog\ndescription: Publish a post on a blog where the person is signed in\n---\n",
      "a-raw": "# just text",
    });
    mkdirSync(join(dir, "empty"));
    expect(listSkills(dir)).toEqual([
      { name: "a-raw", description: "", path: "skills/a-raw/SKILL.md" },
      { name: "publish-blog", description: "Publish a post on a blog where the person is signed in", path: "skills/publish-blog/SKILL.md" },
    ]);
    expect(listSkills(join(dir, "missing"))).toEqual([]);
  });

  it("shows at most the limit in the prompt and says how many more there are", () => {
    const many = Array.from({ length: SKILLS_LISTED + 2 }, (_, i) => ({ name: `s${i}`, description: "d", path: `skills/s${i}/SKILL.md` }));
    const text = skillsText(many);
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(SKILLS_LISTED);
    expect(text).toContain("2 more in skills/");
    expect(skillsText([])).toBe("");
  });
});
