import fs = require("node:fs");
import path = require("node:path");

type ProjectSkill = { name: string; description: string; body: string; filePath: string };

class SkillLoader {
    discover(workspace: string): ProjectSkill[] {
        const root = path.join(workspace, ".cli", "skills");
        if (!fs.existsSync(root)) return [];
        return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
            const filePath = path.join(root, entry.name, "SKILL.md");
            if (!fs.existsSync(filePath)) return [];
            const parsed = parseSkill(fs.readFileSync(filePath, "utf8"), filePath);
            return parsed ? [parsed] : [];
        }).sort((a, b) => a.name.localeCompare(b.name));
    }

    select(message: string, skills: ProjectSkill[], maxSkills = 2): ProjectSkill[] {
        const explicit = [...message.matchAll(/\$([a-z0-9-]+)/gi)].map((match) => match[1]?.toLowerCase());
        const messageTokens = tokens(message);
        return skills.map((skill) => {
            const explicitScore = explicit.includes(skill.name.toLowerCase()) ? 100 : 0;
            const metadataTokens = tokens(`${skill.name} ${skill.description}`);
            const relevance = metadataTokens.filter((token) => messageTokens.includes(token)).length;
            return { skill, score: explicitScore + relevance };
        }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, maxSkills).map((item) => item.skill);
    }

    formatPrompt(skills: ProjectSkill[]): string {
        if (skills.length === 0) return "";
        return skills.map((skill) => `Project skill: ${skill.name}\n${skill.body.slice(0, 12000)}`).join("\n\n---\n\n");
    }
}

function parseSkill(content: string, filePath: string): ProjectSkill | undefined {
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
    if (!match) return undefined;
    const frontmatter = match[1] ?? "";
    const name = frontmatter.match(/^name:\s*([a-z0-9-]+)\s*$/mi)?.[1];
    const description = frontmatter.match(/^description:\s*(.+)\s*$/mi)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (!name || !description) return undefined;
    return { name, description, body: (match[2] ?? "").trim(), filePath };
}

function tokens(value: string): string[] {
    return value.toLowerCase().match(/[a-z0-9-]{3,}|[\u0E00-\u0E7F]{3,}/g) ?? [];
}

module.exports = { SkillLoader, parseSkill };
