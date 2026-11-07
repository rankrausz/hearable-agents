// Exposes named shell actions across isolation; must not expose Electron or arbitrary IPC.
import { contextBridge, ipcRenderer } from "electron";

function listen(channel: string, callback: (value: unknown) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld("hearableShell", {
  loginState: () => ipcRenderer.invoke("hearable", { type: "login-state" }),
  setOpenAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke("hearable", { type: "set-login", enabled }),
  preferences: () => ipcRenderer.invoke("hearable", { type: "preferences" }),
  rememberAudio: (enabled: boolean) =>
    ipcRenderer.invoke("hearable", { type: "remember-audio", enabled }),
  openAgent: (agent: string, sessionId: string) =>
    ipcRenderer.invoke("hearable", { type: "open-agent", agent, sessionId }),
  quit: () => ipcRenderer.invoke("hearable", { type: "quit" }),
  audioState: () => ipcRenderer.invoke("hearable", { type: "audio-state" }),
  reportAudio: (audio: unknown) => ipcRenderer.invoke("hearable", { type: "report-audio", audio }),
  commandAudio: (command: unknown) =>
    ipcRenderer.invoke("hearable", { type: "audio-command", command }),
  onAudioCommand: (callback: (value: unknown) => void) =>
    listen("hearable:audio-command", callback),
  onAudioState: (callback: (value: unknown) => void) => listen("hearable:audio-state", callback),
  resize: (height: number) => ipcRenderer.invoke("hearable", { type: "resize", height }),
});
