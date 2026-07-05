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
});
