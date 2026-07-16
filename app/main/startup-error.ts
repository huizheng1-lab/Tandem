import type { StartupErrorInfo } from "../shared/ipc.js";

export function startupErrorInfo(error: unknown): StartupErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: "Tandem could not start",
    message: message || "Unknown startup error. Check the main-process log for details."
  };
}
