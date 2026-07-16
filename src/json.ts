import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export function stripJsonBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

export function parseJsonText<T = unknown>(value: string): T {
  return JSON.parse(stripJsonBom(value)) as T;
}

export function readJsonFileSync<T = unknown>(filePath: string): T {
  return parseJsonText<T>(readFileSync(filePath, "utf8"));
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return parseJsonText<T>(await readFile(filePath, "utf8"));
}
