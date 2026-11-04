import { readFileSync } from 'node:fs';
import type { Section } from './harness.ts';

// Інструкції проєкту з AGENTS.md. Файл не змінюється між задачами, тож лежить у стабільному префіксі запиту.
export function loadContext(root = new URL('../', import.meta.url)): Section[] {
  return [{ tag: 'project', source: 'AGENTS.md', text: readFileSync(new URL('AGENTS.md', root), 'utf8') }];
}
