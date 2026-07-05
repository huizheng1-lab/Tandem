import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionEvent {
  type: string;
  at: string;
  payload: unknown;
}

export function projectHash(cwd = process.cwd()): string {
  return createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function sessionDir(cwd = process.cwd(), homeDir = homedir()): string {
  return path.join(homeDir, ".tandem", "sessions", projectHash(cwd));
}

export class SessionStore {
  readonly id: string;
  readonly filePath: string;

  private constructor(id: string, filePath: string) {
    this.id = id;
    this.filePath = filePath;
  }

  static async create(cwd = process.cwd(), homeDir = homedir()): Promise<SessionStore> {
    const id = randomUUID();
    const dir = sessionDir(cwd, homeDir);
    await mkdir(dir, { recursive: true });
    return new SessionStore(id, path.join(dir, `${id}.jsonl`));
  }

  static async open(id: string, cwd = process.cwd(), homeDir = homedir()): Promise<SessionStore> {
    const filePath = path.join(sessionDir(cwd, homeDir), `${id}.jsonl`);
    if (!existsSync(filePath)) throw new Error(`No session ${id}. Run /sessions to list sessions.`);
    return new SessionStore(id, filePath);
  }

  async append(type: string, payload: unknown): Promise<void> {
    const event: SessionEvent = { type, at: new Date().toISOString(), payload };
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(this.filePath, { flags: "a" });
      stream.once("error", reject);
      stream.end(`${JSON.stringify(event)}\n`, resolve);
    });
  }

  async read(): Promise<SessionEvent[]> {
    if (!existsSync(this.filePath)) return [];
    const content = await readFile(this.filePath, "utf8");
    return content
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  }
}

export async function listSessions(cwd = process.cwd(), homeDir = homedir()): Promise<string[]> {
  const dir = sessionDir(cwd, homeDir);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files.filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, ""));
}
