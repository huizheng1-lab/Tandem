import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyAttachment, formatAttachmentBlock, imageDimensions, MAX_ATTACHMENT_BYTES, mediaContentForFile, writeAttachmentData } from "../src/session/attachments.js";
import { readFileTool } from "../src/tools/fs.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-attachments-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const oneByOnePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3chgAAAABJRU5ErkJggg==", "base64");

describe("attachments", () => {
  it("copies attachments into collision-safe project paths", async () => {
    const cwd = await tempDir();
    const source = path.join(await tempDir(), "mock.png");
    await writeFile(source, oneByOnePng);

    const first = await copyAttachment(cwd, source);
    const second = await copyAttachment(cwd, source);

    expect(first.path).toBe(path.join("attachments", "mock.png"));
    expect(second.path).toBe(path.join("attachments", "mock-2.png"));
    await expect(readFile(path.join(cwd, first.path))).resolves.toEqual(oneByOnePng);
  });

  it("writes pasted image data and formats prompt blocks", async () => {
    const cwd = await tempDir();
    const attachment = await writeAttachmentData(cwd, "pasted-1.png", oneByOnePng);

    expect(attachment).toMatchObject({ path: path.join("attachments", "pasted-1.png"), name: "pasted-1.png", mediaType: "image/png" });
    expect(formatAttachmentBlock([attachment])).toBe(`[Attached files: ${path.join("attachments", "pasted-1.png")}]`);
  });

  it("refuses oversized attachments", async () => {
    const cwd = await tempDir();
    const source = path.join(await tempDir(), "huge.bin");
    await writeFile(source, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

    await expect(copyAttachment(cwd, source)).rejects.toThrow(/Maximum size is 20 MB/);
  });

  it("returns image parts for image-capable callers and stubs otherwise", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "attachments"), { recursive: true });
    await writeFile(path.join(cwd, "attachments", "mock.png"), oneByOnePng);

    await expect(mediaContentForFile(cwd, "attachments/mock.png", { media: { images: true } })).resolves.toMatchObject([{ type: "image", mediaType: "image/png" }]);
    await expect(mediaContentForFile(cwd, "attachments/mock.png", { media: {} })).resolves.toContain("dimensions 1x1");
  });

  it("returns PDF parts for PDF-capable callers and stubs otherwise", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "attachments"), { recursive: true });
    await writeFile(path.join(cwd, "attachments", "spec.pdf"), "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n", "utf8");

    await expect(mediaContentForFile(cwd, "attachments/spec.pdf", { media: { pdf: true } })).resolves.toMatchObject([{ type: "file", mediaType: "application/pdf" }]);
    await expect(mediaContentForFile(cwd, "attachments/spec.pdf", { media: {} })).resolves.toContain("1 page");
  });

  it("keeps text read_file behavior unchanged", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "index.ts"), "const value = 1;\n", "utf8");

    await expect(readFileTool({ cwd }, "index.ts")).resolves.toContain("1: const value = 1;");
  });

  it("parses cheap image dimensions", () => {
    expect(imageDimensions(oneByOnePng, "mock.png")).toMatchObject({ format: "png", width: 1, height: 1 });
  });
});
