// Bundled stdio relay. Reads fresh discovery on each launch so app restarts do
// not leave stale ports in a workspace. Only the desktop host can approve access.
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
const file = process.argv[2];
try {
  if (!file) throw new Error("Missing desktop connection. Enable Computer Use in OmniRush.ai.");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.version !== 1 || value.host !== "127.0.0.1" || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid desktop connection. Restart OmniRush.ai.");
  const socket = createConnection({ host: value.host, port: value.port });
  socket.setTimeout(5000, () => { process.stderr.write("OmniRush.ai desktop did not respond.\n"); socket.destroy(); });
  socket.once("connect", () => {
    socket.setTimeout(0); socket.write(JSON.stringify({ token: value.token }) + "\n");
    process.stdin.pipe(socket); socket.pipe(process.stdout);
  });
  socket.on("error", () => { process.stderr.write("Open OmniRush.ai and enable Computer Use before reconnecting.\n"); process.exitCode = 1; process.stdin.destroy(); });
  socket.on("close", () => { process.stdin.destroy(); });
  process.stdin.on("error", () => socket.destroy());
  process.stdout.on("error", () => socket.destroy());
} catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
