import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "sakura-agent";

/** At most this many skills are listed in the prompt (name and description only; the agent reads a SKILL.md when it needs it). */
export const SKILLS_LISTED = 60;
const DESCRIPTION_MAX = 300;

export interface SkillEntry {
  name: string;
  description: string;
  /** The SKILL.md, relative to the files directory. */
  path: string;
}

/** Reads `name:` and `description:` from the front matter of a SKILL.md; null when it has none. */
export function frontMatter(text: string): { name?: string; description?: string } | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return null;
  const field = (key: string) => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block[1] as string);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
  };
  const name = field("name");
  const description = field("description");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/** The skills in the shared folder (`skills/<folder>/SKILL.md`), sorted by name. A folder without front matter is still listed by its name. */
export function listSkills(directory: string, shownAs = "skills"): SkillEntry[] {
  let folders: string[];
  try {
    folders = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const skills: SkillEntry[] = [];
  for (const folder of folders) {
    let text: string;
    try {
      text = readFileSync(join(directory, folder, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const meta = frontMatter(text) ?? {};
    const description = (meta.description ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_MAX);
    skills.push({ name: meta.name ?? folder, description, path: `${shownAs}/${folder}/SKILL.md` });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** The list as prompt text, or "" when there are none. */
export function skillsText(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "";
  const shown = skills.slice(0, SKILLS_LISTED);
  const more = skills.length > shown.length ? `\n(${skills.length - shown.length} more in skills/; list the folder to see them.)` : "";
  return `# Skills available (read the SKILL.md when a task matches)\n${shown.map((s) => `- ${s.name}: ${s.description || "(no description)"} (${s.path})`).join("\n")}${more}`;
}

/** Puts the skills of the shared folder, as they were when the run started, at the end of the system prompt. */
export function skillsPlugin(directory: string): Plugin {
  let snapshot = "";
  return {
    name: "skills-list",
    setup(api) {
      api.on("request", (request) => (snapshot === "" ? undefined : { ...request, system: `${request.system}\n\n${snapshot}` }));
    },
    async prepare() {
      snapshot = skillsText(listSkills(directory));
    },
  };
}
