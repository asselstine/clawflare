import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  content: string;
  frontmatter: Record<string, string | boolean>;
  disableModelInvocation: boolean;
}

export function loadSkills(cwd = process.cwd()): AgentSkill[] {
  const roots = skillRoots(cwd);
  const skills = new Map<string, AgentSkill>();

  for (const root of roots) {
    for (const skill of loadSkillsFromDir(root)) {
      if (skills.has(skill.name)) {
        console.warn(`Duplicate skill name "${skill.name}" at ${skill.path}; keeping first`);
        continue;
      }
      skills.set(skill.name, skill);
    }
  }

  return Array.from(skills.values());
}

export function loadSkillsFromDir(root: string): AgentSkill[] {
  if (!existsSync(root)) return [];

  const skills: AgentSkill[] = [];
  const visit = (dir: string): void => {
    const skillFile = join(dir, "SKILL.md");
    if (existsSync(skillFile)) {
      const skill = parseSkill(skillFile);
      if (skill) skills.push(skill);
      return;
    }

    for (const entry of safeReaddir(dir)) {
      const fullPath = join(dir, entry);
      if (safeStat(fullPath)?.isDirectory()) visit(fullPath);
    }
  };

  visit(root);
  return skills;
}

export function formatSkillsForPrompt(skills: AgentSkill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = ["<available_agent_skills>"];
  for (const skill of visible) {
    lines.push(`  <skill name="${escapeXml(skill.name)}">`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_agent_skills>");
  return lines.join("\n");
}

export function expandSkill(skill: AgentSkill, args: string): string {
  return `<agent_skill name="${escapeXml(skill.name)}" path="${escapeXml(skill.path)}">
${skill.content}
</agent_skill>

Skill arguments: ${args || "(none)"}`;
}

function skillRoots(cwd: string): string[] {
  const roots = [join(homedir(), ".agents", "skills")];
  for (const dir of projectDirs(cwd)) {
    roots.push(join(dir, ".agents", "skills"));
  }
  return roots;
}

function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);

  while (true) {
    dirs.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

function parseSkill(path: string): AgentSkill | null {
  const content = readFileSync(path, "utf8");
  const { frontmatter } = splitFrontmatter(content);
  const name = frontmatter.name || deriveName(dirname(path));
  const description = frontmatter.description;

  if (!description || typeof description !== "string") {
    console.warn(`Skipping skill at ${path}: missing description`);
    return null;
  }

  return {
    name: String(name),
    description,
    path,
    content,
    frontmatter,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

function splitFrontmatter(content: string): { frontmatter: Record<string, string | boolean> } {
  if (!content.startsWith("---\n")) return { frontmatter: {} };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {} };

  const raw = content.slice(4, end).trim();
  const frontmatter: Record<string, string | boolean> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    frontmatter[key] = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
  }
  return { frontmatter };
}

function deriveName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) || "skill";
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
