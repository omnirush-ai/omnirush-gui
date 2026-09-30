// Native desktop access lives off the Electron main thread. No shell execution.
const parentPort = { postMessage: (value) => process.send?.(value), on: (name, listener) => process.on(name === "close" ? "disconnect" : name, listener), close: () => process.disconnect() };
import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import koffi from "koffi";
import { crc32, deflateSync } from "node:zlib";

let generation = 0;
let backend;
const changed = () => { generation++; parentPort.postMessage({ event: "person-input", generation }); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const protectedNames = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "conhost.exe", "credentialuibroker.exe", "consent.exe", "logonui.exe", "keepass.exe", "keepassxc.exe", "1password.exe", "gnome-terminal-server", "konsole", "xterm", "alacritty", "kitty", "foot", "gnome-keyring-daemon", "keepassxc", "1password"]);
function safeWindow(value) {
  if ((value.pid === process.pid || value.pid === process.ppid) || protectedNames.has(path.basename(value.executable).toLowerCase())) fail("protected_app", "Use a shell tool for terminals. Computer Use cannot operate the host, security prompts, or password managers.");
  if (!Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.pid) || value.pid <= 0) fail("window_unavailable", "This window cannot be identified safely.");
  return value;
}
const keyNames = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Left: 37, Up: 38, Right: 39, Down: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
function keys(action) {
  if (typeof action.key !== "string") fail("invalid_action", "A key name is required.");
  const modifiers = action.modifiers ?? [];
  if (!Array.isArray(modifiers) || modifiers.some((v) => !["ctrl", "shift", "alt"].includes(v)) || new Set(modifiers).size !== modifiers.length) fail("invalid_action", "Only ctrl, shift, and alt modifiers are supported.");
  if ((modifiers.includes("alt") && ["Tab", "Escape", "F4"].includes(action.key)) || (modifiers.includes("ctrl") && (modifiers.includes("alt") || action.key === "Escape"))) fail("unsupported_action", "System-wide shortcuts are unavailable.");
  if (!(action.key in keyNames) && !/^[a-z0-9]$/i.test(action.key) && !/^F([1-9]|1[0-2])$/.test(action.key)) fail("unsupported_action", "This key is not supported.");
  return modifiers;
}

function windows() {
  const u = koffi.load("user32.dll"), k = koffi.load("kernel32.dll"), dwm = koffi.load("dwmapi.dll");
  const f = (lib, declaration) => lib.func(declaration);
  const rect = koffi.struct("CU_RECT", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
  const point = koffi.struct("CU_POINT", { x: "int32_t", y: "int32_t" });
  const filetime = koffi.struct("CU_FILETIME", { low: "uint32_t", high: "uint32_t" });
  const mouse = koffi.struct("CU_MOUSEINPUT", { dx: "int32_t", dy: "int32_t", mouseData: "uint32_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const keyboard = koffi.struct("CU_KEYBDINPUT", { wVk: "uint16_t", wScan: "uint16_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const hardware = koffi.struct("CU_HARDWAREINPUT", { uMsg: "uint32_t", wParamL: "uint16_t", wParamH: "uint16_t" });
  const input = koffi.struct("CU_INPUT", { type: "uint32_t", value: koffi.union("CU_INPUT_VALUE", { mi: mouse, ki: keyboard, hi: hardware }) });
  const hookKey = koffi.struct("CU_KBDLLHOOKSTRUCT", { vkCode: "uint32_t", scanCode: "uint32_t", flags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const hookMouse = koffi.struct("CU_MSLLHOOKSTRUCT", { pt: point, mouseData: "uint32_t", flags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const msg = koffi.struct("CU_MSG", { hwnd: "uintptr_t", message: "uint32_t", wParam: "uintptr_t", lParam: "intptr_t", time: "uint32_t", pt: point, lPrivate: "uint32_t" });
  const enumProto = koffi.proto("int __stdcall CU_ENUMPROC(uintptr_t hwnd, intptr_t parameter)");
  // Low-level hook LPARAM points to event data. Keep its pointer type so Koffi
  // passes an external pointer to decode rather than converting it to a number.
  const hookProto = koffi.proto("intptr_t __stdcall CU_HOOKPROC(int code, uintptr_t wParam, void *lParam)");
  const enumWindows = f(u, "int __stdcall EnumWindows(CU_ENUMPROC *callback, intptr_t parameter)");
  const visible = f(u, "int __stdcall IsWindowVisible(uintptr_t hwnd)");
  const isWindow = f(u, "int __stdcall IsWindow(uintptr_t hwnd)");
  const iconic = f(u, "int __stdcall IsIconic(uintptr_t hwnd)");
  const pidOf = f(u, "uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)");
  const titleOf = f(u, "int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *text, int count)");
  const boundsOf = f(dwm, "int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attribute, _Out_ CU_RECT *rect, uint32_t size)");
  const foreground = f(u, "uintptr_t __stdcall GetForegroundWindow()");
  const ancestor = f(u, "uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flag)");
  const fromPoint = f(u, "uintptr_t __stdcall WindowFromPoint(CU_POINT point)");
  const focus = f(u, "int __stdcall SetForegroundWindow(uintptr_t hwnd)");
  const send = f(u, "uint32_t __stdcall SendInput(uint32_t count, CU_INPUT *inputs, int size)");
  const metrics = f(u, "int __stdcall GetSystemMetrics(int index)");
  const openProcess = f(k, "uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const processName = f(k, "int __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");
  const times = f(k, "int __stdcall GetProcessTimes(uintptr_t process, _Out_ CU_FILETIME *created, _Out_ CU_FILETIME *exited, _Out_ CU_FILETIME *kernel, _Out_ CU_FILETIME *user)");
  const closeHandle = f(k, "int __stdcall CloseHandle(uintptr_t handle)");
  const openDesktop = f(u, "uintptr_t __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)");
  const closeDesktop = f(u, "int __stdcall CloseDesktop(uintptr_t desktop)");
  const userInfo = f(u, "int __stdcall GetUserObjectInformationW(uintptr_t object, int index, _Out_ uint16_t *value, uint32_t size, _Out_ uint32_t *needed)");
  f(u, "intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)")(-4);
  const marker = 0x4f4d4e49;
  const inject = (value) => { if (send(1, [value], koffi.sizeof(input)) !== 1) fail("input_unavailable", "Windows blocked input. Keep the app on the active desktop, run it without administrator privileges, and continue."); };
  const keyEvent = (vk, scan, flags) => inject({ type: 1, value: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: marker } } });
  const mouseEvent = (flags, data = 0, dx = 0, dy = 0) => inject({ type: 0, value: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: marker } } });
  const downKeys = new Set();
  let pointerDown = false;
  const release = () => {
    for (const key of downKeys) { try { keyEvent(key, 0, 2); } catch {} }
    downKeys.clear();
    if (pointerDown) { try { mouseEvent(4); } catch {} pointerDown = false; }
  };
  const peek = f(u, "int __stdcall PeekMessageW(_Out_ CU_MSG *message, uintptr_t hwnd, uint32_t first, uint32_t last, uint32_t remove)");
  const nextHook = f(u, "intptr_t __stdcall CallNextHookEx(uintptr_t hook, int code, uintptr_t wParam, void *lParam)");
  const installHook = f(u, "uintptr_t __stdcall SetWindowsHookExW(int type, CU_HOOKPROC *callback, uintptr_t module, uint32_t thread)");
  const uninstall = f(u, "int __stdcall UnhookWindowsHookEx(uintptr_t hook)");
  let callbacks = [], hooks = [];
  // Global hooks are needed only while an approved Computer Use session is active.
  // Keeping the worker alive for discovery and capture must not intercept all user input.
  const startMonitoring = () => {
    if (hooks.length) return;
    callbacks = [hookKey, hookMouse].map((type) => koffi.register((code, wParam, lParam) => {
      if (code >= 0) {
        const value = koffi.decode(lParam, type);
        if (Number(value.dwExtraInfo) !== marker) { changed(); release(); }
      }
      return nextHook(0, code, wParam, lParam);
    }, koffi.pointer(hookProto)));
    hooks = [installHook(13, callbacks[0], 0, 0), installHook(14, callbacks[1], 0, 0)];
    if (hooks.some((v) => !v)) {
      hooks.forEach((h) => { if (h) uninstall(h); });
      callbacks.forEach((c) => koffi.unregister(c));
      hooks = [];
      callbacks = [];
      fail("input_unavailable", "Windows input monitoring is unavailable. Restart OmniRush.ai on your normal desktop.");
    }
  };
  const stopMonitoring = () => {
    hooks.forEach((hook) => uninstall(hook));
    callbacks.forEach((callback) => koffi.unregister(callback));
    hooks = [];
    callbacks = [];
  };
  const poll = () => {
    if (!hooks.length) return;
    const value = {};
    while (peek(value, 0, 0, 0, 1)) {}
  };
  const available = () => {
    const handle = openDesktop(0, 0, 1);
    if (!handle) return false;
    try { const data = Buffer.alloc(512), size = [0]; return Boolean(userInfo(handle, 2, data, data.length, size)) && data.toString("utf16le").split("\0")[0].toLowerCase() === "default"; }
    finally { closeDesktop(handle); }
  };
  function window(id) {
    if (!available() || !isWindow(id) || !visible(id) || iconic(id)) fail("window_unavailable", "Keep the approved app visible on an unlocked desktop.");
    const pid = [0]; pidOf(id, pid);
    const handle = openProcess(0x1000, 0, pid[0]);
    if (!handle) fail("window_unavailable", "This app cannot be inspected. Run it without administrator privileges.");
    let executable, identity;
    try {
      const name = Buffer.alloc(65536), size = [32768], created = {};
      if (!processName(handle, 0, name, size) || !times(handle, created, {}, {}, {})) fail("window_unavailable", "The app identity could not be verified.");
      executable = name.toString("utf16le", 0, size[0] * 2);
      identity = String(pid[0]) + ":" + created.high + ":" + created.low;
    } finally { closeHandle(handle); }
    const box = {}, title = Buffer.alloc(8192);
    if (boundsOf(id, 9, box, koffi.sizeof(rect)) !== 0) fail("window_unavailable", "The window bounds could not be read.");
    titleOf(id, title, 4096);
    const bounds = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    if (bounds.width <= 0 || bounds.height <= 0) fail("window_unavailable", "The window is not visible.");
    return safeWindow({ id: Number(id), pid: pid[0], identity, executable, appId: executable.toLowerCase(), appName: path.win32.basename(executable, ".exe"), title: title.toString("utf16le").split("\0")[0], bounds });
  }
  function guard(expected, expectedGeneration, pointValue, deadline) {
    if (Date.now() >= deadline) fail("session_expired", "The approved session expired. Start a new session.");
    poll();
    if (generation !== expectedGeneration) fail("user_interacting", "Your input interrupted Computer Use. Choose Continue when ready.");
    const current = window(expected.id);
    if (current.identity !== expected.identity || JSON.stringify(current.bounds) !== JSON.stringify(expected.bounds)) fail("window_changed", "The approved window changed. Observe it again.");
    if (Number(ancestor(foreground(), 2)) !== expected.id) fail("focus_changed", "The approved window must stay in front. Choose Continue when ready.");
    if (pointValue && Number(ancestor(fromPoint(pointValue), 2)) !== expected.id) fail("window_occluded", "Another window covers this point. Move it away and continue.");
    return current;
  }
  const move = (x, y) => {
    const left = metrics(76), top = metrics(77), width = metrics(78), height = metrics(79);
    if (width <= 1 || height <= 1) fail("input_unavailable", "The desktop bounds could not be read.");
    mouseEvent(0x8000 | 0x4000 | 1, 0, Math.round((x - left) * 65535 / (width - 1)), Math.round((y - top) * 65535 / (height - 1)));
  };
  return {
    poll, window, available, release, startMonitoring, stopMonitoring, check: guard,
    list() { const result = []; enumWindows((id) => { try { const item = window(id); if (item.title) result.push(item); } catch {} return 1; }, 0); return result; },
    focus(expected) { if (window(expected.id).identity !== expected.identity || !focus(expected.id)) fail("focus_changed", "Bring the approved app to the front, then choose Continue."); poll(); },
    async act(expected, expectedGeneration, action, deadline) {
      const checked = (p) => guard(expected, expectedGeneration, p, deadline);
      const pointValue = (p) => ({ x: expected.bounds.x + Math.round(p.x), y: expected.bounds.y + Math.round(p.y) });
      try {
        checked();
        if (action.type === "type") {
          for (const char of action.text) {
            checked();
            for (let i = 0; i < char.length; i++) { keyEvent(0, char.charCodeAt(i), 4); keyEvent(0, char.charCodeAt(i), 6); }
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        } else if (action.type === "key") {
          const modifiers = keys(action), vk = keyNames[action.key] ?? (/^F/.test(action.key) ? 111 + Number(action.key.slice(1)) : action.key.toUpperCase().charCodeAt(0));
          for (const modifier of modifiers) { const key = { ctrl: 17, shift: 16, alt: 18 }[modifier]; downKeys.add(key); keyEvent(key, 0, 0); }
          checked(); downKeys.add(vk); keyEvent(vk, 0, 0); keyEvent(vk, 0, 2); downKeys.delete(vk);
        } else if (["click", "double_click", "scroll", "drag"].includes(action.type)) {
          const points = action.type === "drag" ? action.path : [action];
          for (const p of points) {
            const position = pointValue(p); checked(position); move(position.x, position.y); checked(position);
            if (action.type === "drag" && !pointerDown) { pointerDown = true; mouseEvent(2); }
            await new Promise((resolve) => setTimeout(resolve, action.type === "scroll" ? 32 : action.type === "drag" ? 12 : 2));
          }
          const position = pointValue(points.at(-1)); checked(position);
          if (action.type === "scroll") mouseEvent(action.axis === "horizontal" ? 0x1000 : 0x800, action.delta * (action.axis === "horizontal" ? 120 : -120));
          else if (action.type !== "drag") {
            for (let i = 0; i < (action.type === "double_click" ? 2 : 1); i++) {
              checked(position); pointerDown = true; mouseEvent(2); mouseEvent(4); pointerDown = false;
              if (i === 0 && action.type === "double_click") await new Promise((resolve) => setTimeout(resolve, 60));
            }
          }
        } else fail("unsupported_action", "Use click, double_click, drag, scroll, type, or key.");
      } finally { release(); }
    },
    close() { release(); stopMonitoring(); },
  };
}

function x11() {
  if (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY) fail("wayland_unavailable", "Wayland needs a desktop portal connection. This build supports Linux X11; sign in to an X11 session or use the built-in browser and app connectors.");
  if (!process.env.DISPLAY) fail("desktop_unavailable", "Computer Use needs a graphical Linux desktop.");
  const x = koffi.load("libX11.so.6"), xt = koffi.load("libXtst.so.6"), xi = koffi.load("libXi.so.6");
  const attributes = koffi.struct("CU_XWindowAttributes", {
    x: "int", y: "int", width: "int", height: "int", border_width: "int", depth: "int", visual: "void *", root: "ulong", class: "int", bit_gravity: "int", win_gravity: "int", backing_store: "int", backing_planes: "ulong", backing_pixel: "ulong", save_under: "int", colormap: "ulong", map_installed: "int", map_state: "int", all_event_masks: "long", your_event_mask: "long", do_not_propagate_mask: "long", override_redirect: "int", screen: "void *",
  });
  const cookieType = koffi.struct("CU_XGenericEventCookie", { type: "int", serial: "ulong", send_event: "int", display: "void *", extension: "int", evtype: "int", cookie: "uint", data: "void *" });
  const rawType = koffi.struct("CU_XIRawEvent", { type: "int", serial: "ulong", send_event: "int", display: "void *", extension: "int", evtype: "int", time: "ulong", deviceid: "int", sourceid: "int", detail: "int", flags: "int", valuators: koffi.struct({ mask_len: "int", mask: "void *", values: "void *" }), raw_values: "void *" });
  const deviceType = koffi.struct("CU_XIDeviceInfo", { deviceid: "int", name: "str", use: "int", attachment: "int", enabled: "int", num_classes: "int", classes: "void *" });
  const maskType = koffi.struct("CU_XIEventMask", { deviceid: "int", mask_len: "int", mask: "void *" });
  const open = x.func("void *XOpenDisplay(str name)"), close = x.func("int XCloseDisplay(void *display)");
  const display = open(null);
  if (!display) fail("desktop_unavailable", "Could not connect to the X11 desktop.");
  const root = x.func("ulong XDefaultRootWindow(void *display)")(display);
  const atom = (name) => x.func("ulong XInternAtom(void *display, str name, int only)")(display, name, 0);
  const property = x.func("int XGetWindowProperty(void *display, ulong window, ulong property, long offset, long length, int remove, ulong requested, _Out_ ulong *actual, _Out_ int *format, _Out_ ulong *count, _Out_ ulong *remaining, _Out_ void **data)");
  const free = x.func("int XFree(void *data)");
  const boundsOf = x.func("int XGetWindowAttributes(void *display, ulong window, _Out_ CU_XWindowAttributes *attributes)");
  const translate = x.func("int XTranslateCoordinates(void *display, ulong source, ulong destination, int x, int y, _Out_ int *root_x, _Out_ int *root_y, _Out_ ulong *child)");
  const queryTree = x.func("int XQueryTree(void *display, ulong window, _Out_ ulong *root, _Out_ ulong *parent, _Out_ void **children, _Out_ uint *count)");
  const sync = x.func("int XSync(void *display, int discard)");
  const setError = x.func("void *XSetErrorHandler(void *callback)");
  const errorProto = koffi.proto("int CU_XErrorHandler(void *display, void *event)");
  let xError = false;
  const errorCallback = koffi.register(() => { xError = true; return 0; }, koffi.pointer(errorProto));
  setError(errorCallback);
  const pending = x.func("int XPending(void *display)"), nextEvent = x.func("int XNextEvent(void *display, void *event)");
  const eventData = x.func("int XGetEventData(void *display, _Inout_ CU_XGenericEventCookie *cookie)");
  const freeEventData = x.func("void XFreeEventData(void *display, CU_XGenericEventCookie *cookie)");
  const queryDevices = xi.func("CU_XIDeviceInfo *XIQueryDevice(void *display, int deviceid, _Out_ int *count)");
  const freeDevices = xi.func("void XIFreeDeviceInfo(CU_XIDeviceInfo *devices)");
  const selectEvents = xi.func("int XISelectEvents(void *display, ulong window, CU_XIEventMask *masks, int count)");
  const major = [2], minor = [0];
  if (xi.func("int XIQueryVersion(void *display, _Inout_ int *major, _Inout_ int *minor)")(display, major, minor) !== 0) fail("input_unavailable", "XInput2 is required for interruption monitoring.");
  const testDevices = new Set();
  const refreshDevices = () => { const count = [0], ptr = queryDevices(display, 0, count); testDevices.clear(); if (ptr) { for (const d of koffi.decode(ptr, deviceType, count[0])) if (d.name.includes("XTEST")) testDevices.add(d.deviceid); freeDevices(ptr); } };
  refreshDevices();
  const eventMask = Buffer.alloc(4);
  for (const type of [11, 13, 14, 15, 16, 17]) eventMask[type >> 3] |= 1 << (type & 7);
  if (selectEvents(display, root, [{ deviceid: 0, mask_len: eventMask.length, mask: eventMask }], 1) !== 0) fail("input_unavailable", "X11 input monitoring could not start.");
  sync(display, 0);
  let injecting = false;
  const poll = () => {
    while (pending(display)) {
      const event = Buffer.alloc(192); nextEvent(display, event);
      const cookie = koffi.decode(event, cookieType);
      if (cookie.type !== 35 || !eventData(display, cookie)) continue;
      try {
        if (cookie.evtype === 11) refreshDevices();
        else if ([13, 14, 15, 16, 17].includes(cookie.evtype)) {
          const raw = koffi.decode(cookie.data, rawType);
          if (!injecting || !testDevices.has(raw.sourceid)) changed();
        }
      } finally { freeEventData(display, cookie); }
    }
  };
  function prop(id, name) {
    const actual = [0], format = [0], count = [0], remaining = [0], data = [null];
    if (property(display, id, atom(name), 0, 4096, 0, 0, actual, format, count, remaining, data) !== 0 || !data[0]) return [];
    try {
      if (format[0] === 32) return Array.from(koffi.decode(data[0], "ulong", Math.min(count[0], 4096)), Number);
      if (format[0] === 8) return Buffer.from(koffi.decode(data[0], "uint8_t", Math.min(count[0], 16384))).toString("utf8");
      return [];
    } finally { free(data[0]); }
  }
  const tree = (id) => {
    const parent = [0], parentRoot = [0], data = [null], count = [0];
    if (!queryTree(display, id, parentRoot, parent, data, count)) return { parent: 0, children: [] };
    try { return { parent: Number(parent[0]), children: data[0] ? Array.from(koffi.decode(data[0], "ulong", Math.min(count[0], 4096)), Number) : [] }; }
    finally { if (data[0]) free(data[0]); }
  };
  const owner = (id, target) => { for (let i = 0; id && i < 32; i++) { if (Number(id) === target) return true; id = tree(id).parent; } return false; };
  function window(id) {
    const box = {};
    if (!boundsOf(display, id, box) || box.map_state !== 2 || box.width <= 0 || box.height <= 0) fail("window_unavailable", "Keep the approved app visible on your desktop.");
    const pid = prop(id, "_NET_WM_PID")[0];
    let executable, identity;
    try {
      executable = readlinkSync("/proc/" + pid + "/exe");
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      identity = String(pid) + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch { fail("window_unavailable", "The app identity could not be verified."); }
    const xRoot = [0], yRoot = [0], child = [0];
    if (!translate(display, id, root, 0, 0, xRoot, yRoot, child)) fail("window_unavailable", "Could not read the window position.");
    const title = prop(id, "_NET_WM_NAME") || prop(id, "WM_NAME");
    return safeWindow({ id: Number(id), pid: Number(pid), executable, identity, appId: executable, appName: path.basename(executable), title: typeof title === "string" ? title.replaceAll("\0", "") : "App window", bounds: { x: xRoot[0], y: yRoot[0], width: box.width, height: box.height } });
  }
  const currentFocus = () => { const focused = [0], revert = [0]; x.func("int XGetInputFocus(void *display, _Out_ ulong *focus, _Out_ int *revert)")(display, focused, revert); return Number(focused[0]); };
  function guard(expected, expectedGeneration, position, deadline) {
    if (Date.now() >= deadline) fail("session_expired", "The approved session expired. Start a new session.");
    poll();
    if (generation !== expectedGeneration) fail("user_interacting", "Your input interrupted Computer Use. Choose Continue when ready.");
    const current = window(expected.id);
    if (current.identity !== expected.identity || JSON.stringify(current.bounds) !== JSON.stringify(expected.bounds)) fail("window_changed", "The approved window changed. Observe it again.");
    if (!owner(currentFocus(), expected.id)) fail("focus_changed", "The approved window must stay in front. Choose Continue when ready.");
    if (position) {
      const children = [], outputRoot = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
      let parent = root;
      const queryPointer = x.func("int XQueryPointer(void *display, ulong window, _Out_ ulong *root, _Out_ ulong *child, _Out_ int *root_x, _Out_ int *root_y, _Out_ int *win_x, _Out_ int *win_y, _Out_ uint *mask)");
      for (let i = 0; i < 32; i++) { if (!queryPointer(display, parent, outputRoot, child, rx, ry, wx, wy, mask) || !child[0]) break; parent = Number(child[0]); children.push(parent); }
      if (!children.includes(expected.id)) fail("window_occluded", "Another window covers the pointer. Move it away and continue.");
    }
    return current;
  }
  // Capture the approved window's off-screen pixmap. XGetImage on the visible
  // window can include another app covering it on a non-compositing desktop.
  const composite = koffi.load("libXcomposite.so.1");
  const compositeMajor = [0], compositeMinor = [0];
  if (!composite.func("int XCompositeQueryVersion(void *display, _Out_ int *major, _Out_ int *minor)")(display, compositeMajor, compositeMinor) || (compositeMajor[0] === 0 && compositeMinor[0] < 2)) fail("capture_unavailable", "X11 Composite window capture is required.");
  const redirect = composite.func("void XCompositeRedirectWindow(void *display, ulong window, int update)");
  const unredirect = composite.func("void XCompositeUnredirectWindow(void *display, ulong window, int update)");
  const namePixmap = composite.func("ulong XCompositeNameWindowPixmap(void *display, ulong window)");
  const imageType = koffi.struct("CU_XImage", { width: "int", height: "int", xoffset: "int", format: "int", data: "void *", byte_order: "int", bitmap_unit: "int", bitmap_bit_order: "int", bitmap_pad: "int", depth: "int", bytes_per_line: "int", bits_per_pixel: "int", red_mask: "ulong", green_mask: "ulong", blue_mask: "ulong", obdata: "void *", functions: koffi.struct({ create_image: "void *", destroy_image: "void *", get_pixel: "void *", put_pixel: "void *", sub_image: "void *", add_pixel: "void *" }) });
  const visualType = koffi.struct("CU_XVisual", { ext_data: "void *", visualid: "ulong", class: "int", red_mask: "ulong", green_mask: "ulong", blue_mask: "ulong", bits_per_rgb: "int", map_entries: "int" });
  const getImage = x.func("CU_XImage *XGetImage(void *display, ulong drawable, int x, int y, uint width, uint height, ulong planes, int format)");
  const destroyImage = x.func("int XDestroyImage(CU_XImage *image)");
  const freePixmap = x.func("int XFreePixmap(void *display, ulong pixmap)");
  const redirected = new Set();
  const clearCapture = () => { for (const id of redirected) unredirect(display, id, 0); redirected.clear(); sync(display, 0); };
  const pngChunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(data, crc32(name))); return Buffer.concat([length, name, data, checksum]); };
  async function capture(expected) {
    const current = window(expected.id);
    if (current.identity !== expected.identity || JSON.stringify(current.bounds) !== JSON.stringify(expected.bounds)) fail("window_changed", "The window changed. Observe again.");
    if (current.bounds.width * current.bounds.height > 16_777_216) fail("capture_unavailable", "This window is too large to capture. Resize it and observe again.");
    if (!redirected.has(current.id)) {
      xError = false; redirect(display, current.id, 0); sync(display, 0);
      if (xError) fail("capture_unavailable", "The approved window cannot be captured separately.");
      redirected.add(current.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    xError = false;
    const pixmap = namePixmap(display, current.id); sync(display, 0);
    if (xError || !pixmap) fail("capture_unavailable", "The approved window cannot be captured separately.");
    let ptr;
    try {
      ptr = getImage(display, pixmap, 0, 0, current.bounds.width, current.bounds.height, ~0n, 2);
      if (!ptr) fail("capture_unavailable", "The window image is unavailable. Keep it visible and observe again.");
      const value = koffi.decode(ptr, imageType), bytes = value.bits_per_pixel / 8;
      const attributesValue = {};
      if (!boundsOf(display, current.id, attributesValue) || !attributesValue.visual) fail("capture_unavailable", "The window color format is unavailable.");
      const visual = koffi.decode(attributesValue.visual, visualType);
      if (![2, 3, 4].includes(bytes) || value.width !== current.bounds.width || value.height !== current.bounds.height || value.bytes_per_line < value.width * bytes || value.bytes_per_line * value.height > 67_108_864 || ![0, 1].includes(value.byte_order) || visual.class !== 4 || value.depth !== attributesValue.depth || !visual.red_mask || !visual.green_mask || !visual.blue_mask) fail("capture_unavailable", "This X11 image format is unavailable.");
      const source = Buffer.from(koffi.decode(value.data, "uint8_t", value.bytes_per_line * value.height));
      const ratio = Math.min(1, 1600 / Math.max(value.width, value.height));
      const width = Math.max(1, Math.floor(value.width * ratio)), height = Math.max(1, Math.floor(value.height * ratio));
      const rows = Buffer.alloc((width * 4 + 1) * height);
      const channels = [visual.red_mask, visual.green_mask, visual.blue_mask].map((mask) => ({ mask, shift: Math.log2((mask & -mask) >>> 0), max: mask >>> Math.log2((mask & -mask) >>> 0) }));
      for (let y = 0; y < height; y++) for (let column = 0; column < width; column++) {
        const offset = Math.floor(y / ratio) * value.bytes_per_line + Math.floor(column / ratio) * bytes;
        const pixel = value.byte_order === 0 ? source.readUIntLE(offset, bytes) : source.readUIntBE(offset, bytes);
        const destination = y * (width * 4 + 1) + 1 + column * 4;
        channels.forEach((channel, index) => { rows[destination + index] = Math.round(((pixel & channel.mask) >>> channel.shift) * 255 / channel.max); });
        rows[destination + 3] = 255;
      }
      const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
      return { image: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]), size: { width, height } };
    } finally { if (ptr) destroyImage(ptr); freePixmap(display, pixmap); }
  }
  const rawKey = xt.func("int XTestFakeKeyEvent(void *display, uint key, int down, ulong delay)");
  const rawButton = xt.func("int XTestFakeButtonEvent(void *display, uint button, int down, ulong delay)");
  const rawMotion = xt.func("int XTestFakeMotionEvent(void *display, int screen, int x, int y, ulong delay)");
  const inject = (fn, args, check = true) => {
    const previous = generation; poll();
    if (check && previous !== generation) fail("user_interacting", "Your input interrupted Computer Use. Choose Continue when ready.");
    injecting = true;
    try { const result = fn(...args); sync(display, 0); poll(); return result; }
    finally { injecting = false; }
  };
  const fakeKey = (...args) => inject(rawKey, args);
  const fakeButton = (...args) => inject(rawButton, args);
  const fakeMotion = (...args) => inject(rawMotion, args);
  const keysym = x.func("ulong XStringToKeysym(str name)"), keycode = x.func("uint8_t XKeysymToKeycode(void *display, ulong symbol)");
  const downKeys = new Set();
  let pointerDown = false, wheelDown = 0;
  const release = () => { for (const key of downKeys) inject(rawKey, [display, key, 0, 0], false); downKeys.clear(); if (pointerDown) inject(rawButton, [display, 1, 0, 0], false); pointerDown = false; if (wheelDown) inject(rawButton, [display, wheelDown, 0, 0], false); wheelDown = 0; sync(display, 0); };
  const symbolAt = x.func("ulong XKeycodeToKeysym(void *display, uint8_t code, int index)");
  const key = (name, down) => { const symbol = typeof name === "number" ? name : keysym(name); const code = keycode(display, symbol); if (!code) fail("unsupported_action", "This character is unavailable in the active keyboard layout. Use an app connector for arbitrary Unicode text."); if (down) downKeys.add(code); else downKeys.delete(code); if (!fakeKey(display, code, down ? 1 : 0, 0)) fail("input_unavailable", "X11 rejected keyboard input."); sync(display, 0); };
  return {
    poll, window, release, check: guard, capture, clearCapture, available: () => true,
    list() { const ids = prop(root, "_NET_CLIENT_LIST_STACKING"); const result = []; for (const id of Array.isArray(ids) && ids.length ? ids : tree(root).children) { try { result.push(window(id)); } catch {} } return result; },
    focus(expected) {
      if (window(expected.id).identity !== expected.identity) fail("window_unavailable", "The approved app has closed.");
      x.func("int XRaiseWindow(void *display, ulong window)")(display, expected.id);
      x.func("int XSetInputFocus(void *display, ulong window, int revert, ulong time)")(display, expected.id, 2, 0);
      sync(display, 0); poll();
    },
    async act(expected, expectedGeneration, action, deadline) {
      const checked = (position) => guard(expected, expectedGeneration, position, deadline);
      try {
        checked();
        if (action.type === "type") {
          for (const char of action.text) {
            checked();
            const cp = char.codePointAt(0);
            const symbol = char === "\n" ? keysym("Return") : char === "\t" ? keysym("Tab") : cp <= 255 ? cp : 0x01000000 + cp;
            const code = keycode(display, symbol);
            if (!code || (Number(symbolAt(display, code, 0)) !== symbol && Number(symbolAt(display, code, 1)) !== symbol)) fail("unsupported_action", "This character is unavailable in the active keyboard layout. Use an app connector for arbitrary Unicode text.");
            const shifted = Number(symbolAt(display, code, 1)) === symbol && Number(symbolAt(display, code, 0)) !== symbol;
            if (shifted) key("Shift_L", true);
            key(symbol, true); key(symbol, false);
            if (shifted) key("Shift_L", false);
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        } else if (action.type === "key") {
          const modifiers = keys(action), name = { Enter: "Return", Space: "space", PageUp: "Prior", PageDown: "Next" }[action.key] ?? action.key;
          for (const modifier of modifiers) key({ ctrl: "Control_L", shift: "Shift_L", alt: "Alt_L" }[modifier], true);
          checked(); key(name, true); key(name, false);
        } else if (["click", "double_click", "scroll", "drag"].includes(action.type)) {
          const points = action.type === "drag" ? action.path : [action];
          for (const p of points) {
            checked(); fakeMotion(display, -1, expected.bounds.x + Math.round(p.x), expected.bounds.y + Math.round(p.y), 0); sync(display, 0); checked(p);
            if (action.type === "drag" && !pointerDown) { pointerDown = true; fakeButton(display, 1, 1, 0); sync(display, 0); }
            await new Promise((resolve) => setTimeout(resolve, action.type === "scroll" ? 32 : action.type === "drag" ? 12 : 2));
          }
          checked(points.at(-1));
          if (action.type === "scroll") {
            const button = action.axis === "horizontal" ? action.delta > 0 ? 7 : 6 : action.delta > 0 ? 5 : 4;
            // Let the app process pointer entry and distinct wheel ticks.
            // Keep releases tracked so person input or Stop cannot leave a button held.
            for (let i = 0; i < Math.abs(action.delta); i++) {
              checked(points.at(-1)); wheelDown = button; fakeButton(display, button, 1, 0); sync(display, 0);
              await new Promise((resolve) => setTimeout(resolve, 8));
              fakeButton(display, button, 0, 0); wheelDown = 0; sync(display, 0);
              await new Promise((resolve) => setTimeout(resolve, 12));
            }
          } else if (action.type !== "drag") {
            for (let i = 0; i < (action.type === "double_click" ? 2 : 1); i++) { checked(points.at(-1)); pointerDown = true; fakeButton(display, 1, 1, 0); fakeButton(display, 1, 0, 0); pointerDown = false; sync(display, 0); if (i === 0 && action.type === "double_click") await new Promise((resolve) => setTimeout(resolve, 60)); }
          }
        } else fail("unsupported_action", "Use click, double_click, drag, scroll, type, or key.");
      } finally { release(); }
    },
    close() { release(); clearCapture(); close(display); setError(null); koffi.unregister(errorCallback); },
  };
}
let timer;
const startPolling = () => {
  if (timer) return;
  timer = setInterval(() => { try { backend?.poll(); } catch { changed(); } }, 10);
};
const stopPolling = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
};
try {
  backend = process.platform === "win32" ? windows() : x11();
  if (process.platform !== "win32") startPolling();
  parentPort.postMessage({ event: "ready", supported: true });
} catch (error) {
  parentPort.postMessage({ event: "ready", supported: false, code: error.code ?? "native_unavailable", error: error.message });
}
let busy = false;
parentPort.on("message", async ({ id, method, params }) => {
  let ownsBusy = false;
  try {
    if (method === "shutdown") {
      generation++; backend?.release(); backend?.stopMonitoring?.(); stopPolling();
      while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
      backend?.close(); backend = null;
      parentPort.postMessage({ id, result: {} }); parentPort.close(); return;
    }
    if (!backend) fail("native_unavailable", "Desktop access is unavailable.");
    if (method === "start") {
      if (busy) fail("busy", "Desktop operations must be sequential.");
      backend.startMonitoring?.();
      if (process.platform === "win32") startPolling();
      parentPort.postMessage({ id, result: {} });
      return;
    }
    if (method === "stop") {
      generation++;
      backend.release();
      backend.stopMonitoring?.();
      if (process.platform === "win32") stopPolling();
      backend.clearCapture?.();
      parentPort.postMessage({ id, result: {} });
      return;
    }
    if (busy) fail("busy", "Desktop operations must be sequential.");
    busy = true; ownsBusy = true;
    backend.poll();
    let result;
    if (method === "list") result = backend.list();
    else if (method === "window") result = backend.window(params.id);
    else if (method === "focus") { backend.focus(params.window); result = { generation }; }
    else if (method === "state") result = { generation, available: backend.available() };
    else if (method === "capture") { result = await backend.capture(params.window); }
    else if (method === "check") { backend.check(params.window, params.generation, undefined, params.deadline); result = {}; }
    else if (method === "act") { await backend.act(params.window, params.generation, params.action, params.deadline); result = { generation }; }
    else fail("unknown_method", "Unknown native operation.");
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { code: error.code ?? "native_error", message: error.message } });
  } finally { if (ownsBusy) busy = false; }
});
parentPort.on("close", () => { stopPolling(); backend?.close(); });
