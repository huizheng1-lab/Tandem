export const ipcChannels = {
  ping: "app:ping"
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

export interface TandemDesktopApi {
  ping(): Promise<string>;
}
