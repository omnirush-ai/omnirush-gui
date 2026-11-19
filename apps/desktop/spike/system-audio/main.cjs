// M0 spike: system audio ("Them") through Electron's display-media loopback.
// Usage: electron main.cjs --mode=catap|sck|screen --seconds=N --out=DIR [--mic]
//   catap  : video = our own frame (no Screen Recording), audio = "loopback" (Core Audio tap on macOS 14.2+)
//   sck    : same, with Chromium's tap feature off, so macOS falls back to ScreenCaptureKit
//   screen : video = a real screen source (needs Screen Recording), audio = "loopback"
const { app, BrowserWindow, session, desktopCapturer, ipcMain, systemPreferences } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const mode = arg("mode", "catap")
const seconds = Number(arg("seconds", "20"))
const out = arg("out", path.join(require("node:os").tmpdir(), "m0audio"))
const mic = process.argv.includes("--mic")
if (mode === "sck") app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare")

fs.mkdirSync(out, { recursive: true })
const logFile = path.join(out, "levels.jsonl")
fs.writeFileSync(logFile, "")
const t0 = Date.now()
const log = (o) => {
  const line = JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o })
  fs.appendFileSync(logFile, line + "\n")
  console.log(line)
}

function wav(data, rate) {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8)
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write("data", 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

ipcMain.handle("cfg", () => ({ mode, seconds, mic }))
ipcMain.on("log", (_e, o) => log(o))
ipcMain.on("done", (_e, clips) => {
  for (const [name, pcm] of Object.entries(clips)) fs.writeFileSync(path.join(out, `${name}.wav`), wav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), 16000))
  log({ event: "done" })
  app.quit()
})

app.whenReady().then(async () => {
  log({ event: "start", mode, seconds, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, osRelease: require("node:os").release() })
  if (process.platform === "darwin") {
    for (const kind of ["screen", "microphone"]) log({ event: "tcc", kind, status: systemPreferences.getMediaAccessStatus(kind) })
  }
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    log({ event: "request", videoRequested: request.videoRequested, audioRequested: request.audioRequested })
    try {
      if (mode === "screen") {
        const [source] = await desktopCapturer.getSources({ types: ["screen"] })
        log({ event: "screen-source", id: source?.id })
        callback({ video: source, audio: "loopback" })
      } else {
        // Our own frame as the video track: tab capture, no OS permission. The renderer stops it at once.
        callback({ video: request.frame, audio: "loopback" })
      }
    } catch (e) {
      log({ event: "handler-error", message: String(e?.message ?? e) })
      callback(null)
    }
  })
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  await win.loadFile(path.join(__dirname, "page.html"))
  win.webContents.executeJavaScript("start()", true)
  // Hard stop: a macOS permission prompt nobody answers blocks the tap for up to 60 s.
  setTimeout(() => { log({ event: "timeout" }); app.quit() }, (seconds + 90) * 1000).unref()
})
app.on("window-all-closed", () => app.quit())
