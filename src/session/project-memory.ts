import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProjectInstructions {
  fileName: string;
  content: string;
  chars: number;
  truncated: boolean;
}

export const PROJECT_INSTRUCTION_FILES = ["TANDEM.md", "AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_INSTRUCTION_CHAR_LIMIT = 8000;
const NOTE_TEXT_LIMIT = 300;

function normalizeNote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function readProjectInstructions(cwd: string, limit = PROJECT_INSTRUCTION_CHAR_LIMIT): Promise<ProjectInstructions | undefined> {
  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    const filePath = path.join(cwd, fileName);
    if (!existsSync(filePath)) continue;
    const raw = await readFile(filePath, "utf8");
    const truncated = raw.length > limit;
    const suffix = "\n[project instructions truncated]";
    const content = truncated ? `${raw.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : raw;
    return { fileName, content, chars: raw.length, truncated };
  }
  return undefined;
}

export function formatProjectInstructions(instructions: ProjectInstructions | undefined): string {
  if (!instructions) return "Project instructions:\nnone";
  return `Project instructions (${instructions.fileName}):\n${instructions.content.trim() || "(empty)"}`;
}

function appendToNotesSection(content: string, bullet: string): string {
  const normalized = content.replace(/\s*$/, "");
  const notesHeading = /^## Notes\s*$/im.exec(normalized);
  if (!notesHeading?.index && notesHeading?.index !== 0) {
    return `${normalized ? `${normalized}\n\n` : ""}## Notes\n${bullet}\n`;
  }

  const insertAt = notesHeading.index + notesHeading[0].length;
  const afterHeading = normalized.slice(insertAt);
  const nextHeading = /\n##\s+/m.exec(afterHeading);
  if (!nextHeading) {
    return `${normalized}\n${bullet}\n`;
  }
  const splitAt = insertAt + nextHeading.index;
  const beforeNextHeading = normalized.slice(0, splitAt).replace(/\s*$/, "");
  return `${beforeNextHeading}\n${bullet}${normalized.slice(splitAt)}\n`;
}

export async function appendProjectMemoryNote(cwd: string, text: string): Promise<string> {
  const normalized = normalizeNote(text);
  if (!normalized) throw new Error("Memory note cannot be empty.");
  if (normalized.length > NOTE_TEXT_LIMIT) {
    throw new Error(`Memory note is too long (${normalized.length}/${NOTE_TEXT_LIMIT}). Save one short fact, constraint, or decision.`);
  }

  const filePath = path.join(cwd, "TANDEM.md");
  const existing = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const bullet = `- ${normalized}`;
  const alreadyPresent = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(bullet);
  if (alreadyPresent) return `Already remembered in TANDEM.md: ${normalized}`;

  await writeFile(filePath, appendToNotesSection(existing, bullet), "utf8");
  return `Remembered in TANDEM.md: ${normalized}`;
}
