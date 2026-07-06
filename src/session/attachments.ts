import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelEntry } from "../providers/registry.js";

export interface AttachmentRef {
  path: string;
  name: string;
  size: number;
  mediaType?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mediaType?: string }
  | { type: "file"; data: Uint8Array; mediaType: string; filename?: string };

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

function attachmentDir(cwd: string): string {
  return path.join(cwd, "attachments");
}

function resolveInside(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${target}. Choose a path inside ${cwd}.`);
  }
  return resolved;
}

function sanitizeName(fileName: string): string {
  return path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "attachment";
}

async function uniqueAttachmentPath(cwd: string, fileName: string): Promise<{ fullPath: string; relativePath: string; name: string }> {
  await mkdir(attachmentDir(cwd), { recursive: true });
  const safe = sanitizeName(fileName);
  const parsed = path.parse(safe);
  let name = safe;
  let fullPath = path.join(attachmentDir(cwd), name);
  let index = 2;
  while (existsSync(fullPath)) {
    name = `${parsed.name}-${index}${parsed.ext}`;
    fullPath = path.join(attachmentDir(cwd), name);
    index += 1;
  }
  return { fullPath, relativePath: path.join("attachments", name), name };
}

function mediaTypeFor(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  return IMAGE_TYPES[ext];
}

export async function copyAttachment(cwd: string, sourcePath: string): Promise<AttachmentRef> {
  const source = path.resolve(sourcePath);
  const sourceStat = await stat(source);
  if (sourceStat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${path.basename(source)} is too large. Maximum size is 20 MB.`);
  const target = await uniqueAttachmentPath(cwd, path.basename(source));
  await copyFile(source, target.fullPath);
  return { path: target.relativePath, name: target.name, size: sourceStat.size, mediaType: mediaTypeFor(target.name) };
}

export async function writeAttachmentData(cwd: string, fileName: string, data: Uint8Array): Promise<AttachmentRef> {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${fileName} is too large. Maximum size is 20 MB.`);
  const target = await uniqueAttachmentPath(cwd, fileName);
  await writeFile(target.fullPath, data);
  return { path: target.relativePath, name: target.name, size: data.byteLength, mediaType: mediaTypeFor(target.name) };
}

export function formatAttachmentBlock(attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return "";
  return `[Attached files: ${attachments.map((item) => item.path).join(", ")}]`;
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function imageDimensions(buffer: Uint8Array, filePath: string): { width?: number; height?: number; format: string } {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "") || "image";
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + 16, 8);
    return { format: "png", width: view.getUint32(0), height: view.getUint32(4) };
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + 6, 4);
    return { format: "gif", width: view.getUint16(0, true), height: view.getUint16(2, true) };
  }
  return { format: ext };
}

export function pdfPageCount(buffer: Uint8Array): number | undefined {
  const text = Buffer.from(buffer).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches?.length;
}

export async function mediaContentForFile(cwd: string, filePath: string, model: Pick<ModelEntry, "media">): Promise<ContentPart[] | string> {
  const fullPath = resolveInside(cwd, filePath);
  const buffer = await readFile(fullPath);
  const ext = path.extname(filePath).toLowerCase();
  const size = describeBytes(buffer.byteLength);
  const imageMediaType = IMAGE_TYPES[ext];
  if (imageMediaType) {
    if (model.media?.images) return [{ type: "image", image: buffer, mediaType: imageMediaType }];
    const dims = imageDimensions(buffer, filePath);
    const dimensions = dims.width && dims.height ? `, dimensions ${dims.width}x${dims.height}` : "";
    return `[image attached at ${filePath} - this model cannot view images; format ${dims.format}${dimensions}, size ${size}]`;
  }
  if (ext === ".pdf") {
    if (model.media?.pdf) return [{ type: "file", data: buffer, mediaType: "application/pdf", filename: path.basename(filePath) }];
    const pages = pdfPageCount(buffer);
    return `[PDF attached at ${filePath} - this model cannot view PDFs; ${pages === undefined ? "page count unknown" : `${pages} page${pages === 1 ? "" : "s"}`}, size ${size}]`;
  }
  return "";
}

export async function buildUserContentWithAttachments(cwd: string, text: string, attachments: AttachmentRef[], model: Pick<ModelEntry, "media">): Promise<string | ContentPart[]> {
  if (attachments.length === 0) return text;
  let textPart = text;
  const parts: ContentPart[] = [{ type: "text", text: textPart }];
  const fallback: string[] = [];
  for (const attachment of attachments) {
    const content = await mediaContentForFile(cwd, attachment.path, model);
    if (typeof content === "string") {
      if (content) fallback.push(content);
    } else {
      parts.push(...content);
    }
  }
  if (fallback.length > 0) {
    textPart = `${text}\n\n${fallback.join("\n")}`;
    parts[0] = { type: "text", text: textPart };
  }
  return parts.length === 1 ? textPart : parts;
}
