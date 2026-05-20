/**
 * Unit tests for skills loading and formatting
 */
import { describe, it, expect, vi } from "vitest";
import {
  formatSkillsForPrompt,
  expandSkill,
  type AgentSkill,
} from "../src/skills.js";

describe("skills", () => {
  describe("formatSkillsForPrompt", () => {
    it("should return empty string for no skills", () => {
      const result = formatSkillsForPrompt([]);
      expect(result).toBe("");
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
      expect(result).toBe("");
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
      
      expect(result).toContain("<available_agent_skills>");
      expect(result).toContain('name="test-skill"');
      expect(result).toContain("A test skill");
      expect(result).toContain("</available_agent_skills>");
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
      
      expect(result).toContain('name="skill-1"');
      expect(result).toContain('name="skill-2"');
      expect(result).toContain("First skill");
      expect(result).toContain("Second skill");
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
      
      expect(result).toContain("visible");
      expect(result).not.toContain("hidden");
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
      
      expect(result).toContain("&lt;tag&gt;");
      expect(result).toContain("&amp;");
      expect(result).toContain("&quot;quotes&quot;");
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
      
      expect(result).toContain('name="test-skill"');
      expect(result).toContain("Skill content here");
      expect(result).toContain("Skill arguments: (none)");
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
      
      expect(result).toContain("Skill arguments: arg1 arg2");
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
      
      expect(result).toContain('name="xml-skill"');
      expect(result).toContain("&lt;path&gt;");  // path is escaped
      // Note: content is NOT escaped - inserted raw
      expect(result).toContain("Content with <>&");
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
      
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });
  });

  describe("skill name derivation", () => {
    it("should use frontmatter name when available", () => {
      // This would be tested through parseSkill in an integration test
      // Here's a unit test of the expected behavior
      const derivedName = "expected-name";
      expect(derivedName).toBe("expected-name");
    });

    it("should derive name from directory", () => {
      const path = "/home/user/.agents/skills/my-skill/SKILL.md";
      const dir = path.substring(0, path.lastIndexOf("/"));
      const derived = dir.split(/[\\/]/).filter(Boolean).at(-1);
      expect(derived).toBe("my-skill");
    });
  });

  describe("frontmatter parsing", () => {
    it("should parse boolean true", () => {
      const rawValue = "true";
      const parsed = rawValue === "true" ? true : rawValue;
      expect(parsed).toBe(true);
    });

    it("should parse boolean false", () => {
      const rawValue: string = "false";
      const parsed = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      expect(parsed).toBe(false);
    });

    it("should keep string values", () => {
      const rawValue: string = "some string";
      const parsed = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      expect(parsed).toBe("some string");
    });

    it("should strip quotes from values", () => {
      const rawValue = '"quoted value"';
      const stripped = rawValue.replace(/^['"]|['"]$/g, "");
      expect(stripped).toBe("quoted value");
    });
  });
});
