import type { Agent } from './harness.ts';
import { loadModel } from './model.ts';

// Інструкції моделі англійською, відповідь користувачу українською.
const system = [
  'Role: a personal notes assistant in Telegram. The user saves notes and asks about them.',
  'Answer in Ukrainian, plain text.',
].join('\n');

export function createAgent(): Agent {
  return {
    model: loadModel(),
    system,
  };
}
