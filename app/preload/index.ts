import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type TandemDesktopApi } from "../shared/ipc.js";

const api: TandemDesktopApi = {
  ping: () => ipcRenderer.invoke(ipcChannels.ping)
};

contextBridge.exposeInMainWorld("tandem", api);
