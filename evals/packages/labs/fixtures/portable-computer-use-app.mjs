// Disposable native app used as an OS-level witness, never a real user's app.
import { app, BrowserWindow, screen, nativeImage } from "electron";
import { createInterface } from "node:readline";
import { connect } from "node:net";
const channel = connect({ host: "127.0.0.1", port: Number(process.env.OMNIRUSH_FIXTURE_PORT) });
channel.on("connect", () => channel.write(JSON.stringify({ token: process.env.OMNIRUSH_FIXTURE_TOKEN }) + "\n"));
import { createRequire } from "node:module";
const requireDesktop = createRequire(new URL("../../../../apps/desktop/package.json", import.meta.url));
let windows = [];
app.setPath("userData", process.argv.at(-1));
const ready = app.whenReady().then(async () => {
  for (const [index, title] of ["Workspace window", "Other window"].entries()) {
    const window = new BrowserWindow({ width: 620, height: 450, x: 50 + index * 700, y: 120, title, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const html = "<title>" + title + "</title>" + "<style>body{margin:0;background:white;color:black;font:16px sans-serif}button{position:absolute;left:70px;top:70px;width:180px;height:55px}input{position:absolute;left:70px;top:160px;width:300px;height:40px;caret-color:transparent}#count{position:absolute;left:70px;top:230px}#doubles{left:420px;width:150px}#scroll{position:absolute;left:420px;top:160px;width:150px;height:230px;overflow:auto;background:#ddddff}#drag{position:absolute;left:70px;top:290px;width:120px;height:55px;background:#008080;touch-action:none;user-select:none}</style><button id=\"increment\">Increment</button><input id=\"draft\" aria-label=\"Fixture draft\" value=\"Initial draft\"><p id=\"count\">0</p><button id=\"doubles\">Double click</button><div id=\"scroll\"><div style=\"height:1000px\">Scroll me</div></div><div id=\"drag\">Drag me</div><script>window.counter=0;window.pointer={doubles:0,held:false};window.wheelEvents=[];document.addEventListener(\"wheel\",e=>{window.wheelEvents.push({x:e.clientX,y:e.clientY,deltaY:e.deltaY,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,target:e.target.id,parent:e.target.parentElement?.id});if(window.wheelEvents.length>20)window.wheelEvents.shift()},{passive:true});document.getElementById(\"increment\").onclick=()=>{document.getElementById(\"count\").textContent=String(++window.counter)};document.getElementById(\"doubles\").ondblclick=()=>{document.getElementById(\"doubles\").textContent=String(++window.pointer.doubles)};const handle=document.getElementById(\"drag\");let start;handle.onpointerdown=e=>{window.pointer.held=true;start={x:e.clientX,y:e.clientY,left:handle.offsetLeft,top:handle.offsetTop};handle.setPointerCapture(e.pointerId)};handle.onpointermove=e=>{if(window.pointer.held&&e.buttons===1){handle.style.left=(start.left+e.clientX-start.x)+\"px\";handle.style.top=(start.top+e.clientY-start.y)+\"px\"}};handle.onpointerup=()=>{window.pointer.held=false};</script>";
    await window.loadURL("data:text/html," + encodeURIComponent(html)); windows.push(window);
  }
});
createInterface({ input: channel }).on("line", async (line) => {
  const request = JSON.parse(line);
  try {
    await ready; let result;
    if (request.method === "state") result = await Promise.all(windows.map((w) => w.webContents.executeJavaScript('({ count: window.counter, draft: document.getElementById("draft").value })')));
    else if (request.method === "input_events") result = await Promise.all(windows.map((w) => w.webContents.executeJavaScript("window.wheelEvents")));
    else if (request.method === "pointer_state") result = await Promise.all(windows.map((w) => w.webContents.executeJavaScript('({ doubles: window.pointer.doubles, scrolled: document.getElementById("scroll").scrollTop > 0, dragged: document.getElementById("drag").offsetLeft > 170, released: !window.pointer.held })')));
    else if (request.method === "bounds") result = windows.map((w) => ({ bounds: w.getBounds(), contentBounds: w.getContentBounds(), scale: screen.getDisplayMatching(w.getBounds()).scaleFactor }));
    else if (request.method === "focus_other") { windows[1].focus(); result = {}; }
    else if (request.method === "outside_input") {
      const koffi = requireDesktop("koffi");
      if (process.platform === "win32") {
        const keyboard = koffi.struct({ wVk: "uint16_t", wScan: "uint16_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
        const mouse = koffi.struct({ dx: "int32_t", dy: "int32_t", mouseData: "uint32_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
        const input = koffi.struct({ type: "uint32_t", value: koffi.union({ ki: keyboard, mi: mouse }) });
        const send = koffi.load("user32.dll").func("uint32_t __stdcall SendInput(uint32_t count, void *input, int size)");
        const data = Buffer.alloc(koffi.sizeof(input) * 2);
        koffi.encode(data, input, [{ type: 1, value: { ki: { wVk: 16, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } }, { type: 1, value: { ki: { wVk: 16, wScan: 0, dwFlags: 2, time: 0, dwExtraInfo: 0 } } }], 2);
        if (send(2, data, koffi.sizeof(input)) !== 2) throw new Error("Outside keyboard stimulus unavailable.");
      } else {
        const x = koffi.load("libX11.so.6"), xt = koffi.load("libXtst.so.6"), display = x.func("void *XOpenDisplay(str name)")(null);
        if (!display) throw new Error("Outside input display unavailable.");
        try {
          const code = x.func("uint8_t XKeysymToKeycode(void *display, ulong symbol)")(display, 0xffe1);
          const send = xt.func("int XTestFakeKeyEvent(void *display, uint code, int down, ulong delay)");
          send(display, code, 1, 0); send(display, code, 0, 0); x.func("int XSync(void *display, int discard)")(display, 0);
        } finally { x.func("int XCloseDisplay(void *display)")(display); }
      }
      result = {};
    }
    else if (request.method === "cover") { windows[1].setBounds(windows[0].getBounds()); windows[1].setAlwaysOnTop(true); await windows[1].webContents.executeJavaScript('document.body.style.background="#ff00ff"'); windows[1].focus(); result = {}; }
    else if (request.method === "image_pixel") { const image = nativeImage.createFromBuffer(Buffer.from(request.params.data, "base64")); const size = image.getSize(), pixels = image.toBitmap(); const offset = ((size.height - 50) * size.width + 20) * 4; result = { width: size.width, height: size.height, rgb: [pixels[offset + 2], pixels[offset + 1], pixels[offset]] }; }
    else if (request.method === "change") { await windows[0].webContents.executeJavaScript('document.getElementById("draft").value="Changed by person"; document.body.style.background="#eeeeee"; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); result = {}; }
    else if (request.method === "minimize") { windows[0].minimize(); result = {}; }
    else if (request.method === "restore") { windows[0].restore(); result = {}; }
    else if (request.method === "close") { app.quit(); return; }
    else throw new Error("Unknown fixture request.");
    channel.write(JSON.stringify({ id: request.id, result }) + "\n");
  } catch (error) { channel.write(JSON.stringify({ id: request.id, error: { message: error.message } }) + "\n"); }
});
channel.on("close", () => app.quit());
