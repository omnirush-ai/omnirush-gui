const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("computerPreview", {
  action: (value) => { if (["stop", "hide", "pause"].includes(value)) ipcRenderer.send("omnirush-computer-use-preview-action", value); },
  onState: (listener) => ipcRenderer.on("omnirush-computer-use-preview-state", (_event, value) => listener(value)),
  onImage: (listener) => ipcRenderer.on("omnirush-computer-use-preview-image", (_event, value) => listener(value)),
});
