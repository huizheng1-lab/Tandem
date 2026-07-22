import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ipcChannels } from "../app/shared/ipc.js";

describe("desktop IPC contract", () => {
  it("uses unique channel names", () => {
    const channels = Object.values(ipcChannels);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps paired request and response channels explicit", () => {
    expect(ipcChannels.permissionRequest).toBe("permission:request");
    expect(ipcChannels.permissionRespond).toBe("permission:respond");
    expect(ipcChannels.planConfirm).toBe("plan:confirm");
    expect(ipcChannels.planRespond).toBe("plan:respond");
  });

  it("wires typed session search start, cancel, and batch channels through main and preload", async () => {
    expect(ipcChannels.sessionsSearchStart).toBe("sessions:search:start");
    expect(ipcChannels.sessionsSearchCancel).toBe("sessions:search:cancel");
    expect(ipcChannels.sessionSearchBatch).toBe("evt:session-search:batch");

    const [mainSource, preloadSource] = await Promise.all([
      readFile(new URL("../app/main/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/preload/index.ts", import.meta.url), "utf8")
    ]);
    expect(mainSource).toContain("ipcChannels.sessionsSearchStart");
    expect(mainSource).toContain("ipcChannels.sessionsSearchCancel");
    expect(mainSource).toContain("ipcChannels.sessionSearchBatch");
    expect(preloadSource).toContain("startSessionSearch:");
    expect(preloadSource).toContain("cancelSessionSearch:");
    expect(preloadSource).toContain("onSessionSearchBatch:");
  });
});
