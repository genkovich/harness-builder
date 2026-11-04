import type { JSONValue } from 'ai';
import type { Agent } from './harness.ts';
import { loadModel } from './model.ts';
import { noteTools, runNoteTool } from './tools/notes.ts';

// Інструкції моделі англійською, відповідь користувачу українською.
const system = [
  'Role: a personal notes assistant in Telegram. The user saves notes and asks about them.',
  'Notes: use saveNote and searchNotes. Never claim a note is saved or found without a tool result.',
  'The current chat is chosen by code, not by you.',
  'Answer in Ukrainian, plain text.',
].join('\n');

const tools = noteTools;

export function createAgent(): Agent {
  return {
    model: loadModel(),
    system,
    tools,
    async runTool(name, input, run) {
      const output = runNoteTool(name, input, run.chatId);
      if (output === undefined) {
        throw new Error(`Невідомий тул: ${name}`);
      }
      return output as JSONValue;
    },
    limits: {
      maxTurns: Number(process.env.MAX_TURNS) || undefined,
      maxCostUsd: Number(process.env.MAX_COST_USD) || undefined,
    },
  };
}
