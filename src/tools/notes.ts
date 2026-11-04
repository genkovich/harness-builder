import { tool } from 'ai';
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Зверху звичайне сховище нотаток, знизу описи тулів для моделі. chatId у тули не входить.
export type Note = { id: string; chatId: string; text: string; createdAt: string };

// Нотатки живуть у файлі, тож переживають перезапуск. Тести підставляють свій NOTES_FILE.
function notesFile() {
  return process.env.NOTES_FILE || '.data/notes.json';
}

export function readNotes(): Note[] {
  if (!existsSync(notesFile())) {
    return [];
  }
  return JSON.parse(readFileSync(notesFile(), 'utf8'));
}

function writeNotes(notes: Note[]) {
  mkdirSync(dirname(notesFile()), { recursive: true });
  writeFileSync(notesFile(), JSON.stringify(notes, null, 2), 'utf8');
}

export function saveNote(chatId: string, text: string) {
  const note = { id: randomUUID(), chatId, text: text.trim(), createdAt: new Date().toISOString() };
  writeNotes([...readNotes(), note]);
  return note;
}

const noteInput = z.object({ text: z.string() });

// У схемах немає chatId: модель не може його підмінити, його підставляє код.
export const noteTools = {
  saveNote: tool({
    description: 'Save one note for the user when they ask to remember something.',
    inputSchema: noteInput,
  }),
};

export function runNoteTool(name: string, input: unknown, chatId: string) {
  switch (name) {
    case 'saveNote':
      return saveNote(chatId, noteInput.parse(input).text);
    default:
      return undefined;
  }
}
