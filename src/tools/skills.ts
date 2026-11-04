import { tool } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Section } from '../harness.ts';

// Спершу модель бачить лише назву й опис кожного skill. Повний текст читає тулом, коли треба.
const directory = new URL('../../skills/', import.meta.url);

export const skills = readdirSync(directory)
  .filter(name => existsSync(new URL(`${name}/SKILL.md`, directory)))
  .sort()
  .map(name => {
    const text = readFileSync(new URL(`${name}/SKILL.md`, directory), 'utf8');
    const description = /^description: (.+)$/m.exec(text)?.[1];
    if (!description) {
      throw new Error(`Немає description у skills/${name}/SKILL.md`);
    }
    return { name, description, text };
  });

export function readSkill(name: string) {
  // Обираємо зі знайдених skills, а не відкриваємо шлях від моделі.
  const skill = skills.find(item => item.name === name);
  if (!skill) {
    throw new Error(`Невідомий skill: ${name}. Є: ${skills.map(item => item.name).join(', ')}`);
  }
  return { name, text: skill.text };
}

export function skillCatalog(): Section {
  const header = 'Before working on a task that matches one of these skills, call readSkill with its name.';
  const lines = skills.map(skill => `${skill.name}: ${skill.description}`);
  return { tag: 'skills', source: 'skills/', text: [header, ...lines].join('\n') };
}

const skillInput = z.object({ name: z.string().min(1).max(64) });

export const skillTools = {
  readSkill: tool({
    description: 'Load the full instructions of a skill from <skills> by its name. Call it first when a skill matches the task.',
    inputSchema: skillInput,
  }),
};

export function runSkillTool(name: string, input: unknown) {
  return name === 'readSkill' ? readSkill(skillInput.parse(input).name) : undefined;
}
