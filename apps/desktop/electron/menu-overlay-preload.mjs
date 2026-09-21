import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("omnirush:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

ipcRenderer.on("omnirush:menu-overlay:hide", () => {
  latestRequest = null;
  showCallback?.(null);
});

contextBridge.exposeInMainWorld("__OMNIRUSH_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("omnirush:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("omnirush:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("omnirush:menu-overlay:close", { requestId });
  },
});
