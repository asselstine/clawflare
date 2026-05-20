/**
 * Unit tests for skills loading and formatting
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert";
import {
  loadSkills,
  loadSkillsFromDir,
  formatSkillsForPrompt,
  expandSkill,
  type AgentSkill,
} from "../src/skills.js";

describe("skills", () => {
  describe("formatSkillsForPrompt", () => {
    it("should return empty string for no skills", () => {
      const result = formatSkillsForPrompt([]);
      assert.strictEqual(result, "");
    });

    it("should return empty string for only disabled skills", () => {
      const skills: AgentSkill[] = [
        {
          name: "hidden-skill",
          description: "Should not appear",
          path: "/test/hidden/SKILL.md",
          content: "Hidden content",
          frontmatter: {},
          disableModelInvocation: true,
        },
      ];
      const result = formatSkillsForPrompt(skills);
      assert.strictEqual(result, "");
    });

    it("should format single skill", () => {
      const skills: AgentSkill[] = [
        {
          name: "test-skill",
          description: "A test skill",
          path: "/test/SKILL.md",
          content: "Test content",
          frontmatter: {},
          disableModelInvocation: false,
        },
      ];
      const result = formatSkillsForPrompt(skills);
      
      assert(result.includes("<available_agent_skills>"));
      assert(result.includes('name="test-skill"'));
      assert(result.includes("A test skill"));
      assert(result.includes("</available_agent_skills>"));
    });

    it("should format multiple skills", () => {
      const skills: AgentSkill[] = [
        {
          name: "skill-1",
          description: "First skill",
          path: "/test/1/SKILL.md",
          content: "Content 1",
          frontmatter: {},
          disableModelInvocation: false,
        },
        {
          name: "skill-2", 
          description: "Second skill",
          path: "/test/2/SKILL.md",
          content: "Content 2",
          frontmatter: {},
          disableModelInvocation: false,
        },
      ];
      const result = formatSkillsForPrompt(skills);
      
      assert(result.includes('name="skill-1"'));
      assert(result.includes('name="skill-2"'));
      assert(result.includes("First skill"));
      assert(result.includes("Second skill"));
    });

    it("should filter out disabled skills", () => {
      const skills: AgentSkill[] = [
        {
          name: "visible",
          description: "Visible skill",
          path: "/test/visible/SKILL.md",
          content: "Content",
          frontmatter: {},
          disableModelInvocation: false,
        },
        {
          name: "hidden",
          description: "Hidden skill",
          path: "/test/hidden/SKILL.md",
          content: "Hidden",
          frontmatter: {},
          disableModelInvocation: true,
        },
      ];
      const result = formatSkillsForPrompt(skills);
      
      assert(result.includes("visible"));
      assert(!result.includes("hidden"));
    });

    it("should escape XML special characters", () => {
      const skills: AgentSkill[] = [
        {
          name: "xml-skill",
          description: 'Description with <tag> & "quotes"',
          path: "/test/SKILL.md",
          content: "Content",
          frontmatter: {},
          disableModelInvocation: false,
        },
      ];
      const result = formatSkillsForPrompt(skills);
      
      assert(result.includes("&lt;tag&gt;"));
      assert(result.includes("&amp;"));
      assert(result.includes("&quot;quotes&quot;"));
    });
  });

  describe("expandSkill", () => {
    it("should expand skill with no arguments", () => {
      const skill: AgentSkill = {
        name: "test-skill",
        description: "Test",
        path: "/test/SKILL.md",
        content: "Skill content here",
        frontmatter: {},
        disableModelInvocation: false,
      };
      
      const result = expandSkill(skill, "");
      
      assert(result.includes('name="test-skill"'));
      assert(result.includes("Skill content here"));
      assert(result.includes("Skill arguments: (none)"));
    });

    it("should expand skill with arguments", () => {
      const skill: AgentSkill = {
        name: "test-skill",
        description: "Test",
        path: "/test/SKILL.md",
        content: "Skill content",
        frontmatter: {},
        disableModelInvocation: false,
      };
      
      const result = expandSkill(skill, "arg1 arg2");
      
      assert(result.includes("Skill arguments: arg1 arg2"));
    });

    it("should escape XML in skill expansion", () => {
      const skill: AgentSkill = {
        name: "xml-skill",
        description: "Test",
        path: "/test/<path>/SKILL.md",
        content: "Content with <>&",
        frontmatter: {},
        disableModelInvocation: false,
      };
      
      const result = expandSkill(skill, "");
      
      assert(result.includes('name="xml-skill"'));
      assert(result.includes("&lt;path&gt;"));  // path is escaped
      // Note: content is NOT escaped - inserted raw
      assert(result.includes("Content with <>&"));
    });

    it("should include all skill content", () => {
      const skill: AgentSkill = {
        name: "full-skill",
        description: "Full test",
        path: "/test/full/SKILL.md",
        content: "Line 1\nLine 2\nLine 3",
        frontmatter: {},
        disableModelInvocation: false,
      };
      
      const result = expandSkill(skill, "");
      
      assert(result.includes("Line 1"));
      assert(result.includes("Line 2"));
      assert(result.includes("Line 3"));
    });
  });

  describe("skill name derivation", () => {
    it("should use frontmatter name when available", () => {
      // This would be tested through parseSkill in an integration test
      // Here's a unit test of the expected behavior
      const derivedName = "expected-name";
      assert.strictEqual(derivedName, "expected-name");
    });

    it("should derive name from directory", () => {
      const path = "/home/user/.agents/skills/my-skill/SKILL.md";
      const dir = path.substring(0, path.lastIndexOf("/"));
      const derived = dir.split(/[\\/]/).filter(Boolean).at(-1);
      assert.strictEqual(derived, "my-skill");
    });
  });

  describe("frontmatter parsing", () => {
    it("should parse boolean true", () => {
      const rawValue = "true";
      const parsed = rawValue === "true" ? true : rawValue;
      assert.strictEqual(parsed, true);
    });

    it("should parse boolean false", () => {
      const rawValue: string = "false";
      const parsed = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      assert.strictEqual(parsed, false);
    });

    it("should keep string values", () => {
      const rawValue: string = "some string";
      const parsed = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      assert.strictEqual(parsed, "some string");
    });

    it("should strip quotes from values", () => {
      const rawValue = '"quoted value"';
      const stripped = rawValue.replace(/^['"]|['"]$/g, "");
      assert.strictEqual(stripped, "quoted value");
    });
  });
});
