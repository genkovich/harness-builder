import type { JSONValue } from 'ai';
import type { Agent } from './harness.ts';
import { loadModel } from './model.ts';
import { preToolUse, toolsFor } from './permissions.ts';
import { noteTools, runNoteTool } from './tools/notes.ts';
import { runSkillTool, skillCatalog, skillTools } from './tools/skills.ts';

// Інструкції моделі англійською, відповідь користувачу українською.
const system = [
  'Role: a personal notes assistant in Telegram. The user saves notes and asks about them.',
  'Notes: use saveNote and searchNotes. Never claim a note is saved or found without a tool result.',
  'The current chat is chosen by code, not by you.',
  'Memory: earlier messages of this chat are your conversation history. Answer questions about what the user said before directly from them, without tools. Notes are only for what the user asks to save.',
  'Skills: check <skills> first. If a description matches the task, call readSkill before any other tool.',
  'Errors: if a tool returns an error, read it and tell the user what failed, or try another way.',
  'Answer in Ukrainian, plain text.',
].join('\n');

const tools = { ...noteTools, ...skillTools };

export function createAgent(): Agent {
  return {
    model: loadModel(),
    system,
    context: [skillCatalog()],
    tools,
    // Шар 1: кожен чат отримує свій список тулів. deleteNotes бачить лише власник.
    toolsFor: chatId => toolsFor(tools, chatId),
    async runTool(name, input, run) {
      const output = runSkillTool(name, input) ?? runNoteTool(name, input, run.chatId);
      if (output === undefined) {
        throw new Error(`Невідомий тул: ${name}`);
      }
      return output as JSONValue;
    },
    // PreToolUse: правила DENY_TOOLS з .env і owner-only перевіряються перед кожним викликом.
    preToolUse,
    limits: {
      maxTurns: Number(process.env.MAX_TURNS) || undefined,
      maxCostUsd: Number(process.env.MAX_COST_USD) || undefined,
    },
  };
}
