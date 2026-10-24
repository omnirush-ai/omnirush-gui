// Streaming ZIP (stored entries): image archives are already compressed. Never
// buffer an environment image in RAM. Refuse ZIP32 overflow rather than produce
// a corrupt bundle; callers retain the source artifacts for recovery.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const table = Uint32Array.from({length: 256}, (_, n) => {
  let crc = n; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0;
});
export async function zipDirectory(directory: string, target: string) {
  const temporary = `${target}.tmp`, out = fs.createWriteStream(temporary, {mode: 0o600});
  let offset = 0; const central: Buffer[] = [];
  let failure: Error | undefined;
  out.on("error", error => { failure = error; });
  const write = async (bytes: Buffer) => { if (failure) throw failure; offset += bytes.length; if (offset > 0xffffffff) throw new Error("Bundle exceeds ZIP32 limit; retain split environment archives"); if (!out.write(bytes)) await once(out, "drain"); };
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error("Unsupported bundle file");
      const name = Buffer.from(path.relative(directory, file).split(path.sep).join("/"));
      const stat = await fsp.lstat(file), symlink = entry.isSymbolicLink();
      const link = symlink ? Buffer.from(await fsp.readlink(file)) : undefined;
      const size = link ? link.length : stat.size, start = offset;
      if (size > 0xffffffff || name.length > 65535 || central.length >= 65535) throw new Error("Bundle exceeds ZIP32 limit");
      const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(name.length, 26);
      await write(header); await write(name); let crc = 0xffffffff, actual = 0;
      const consume = async (bytes: Buffer) => { for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); actual += bytes.length; await write(bytes); };
      if (link) await consume(link); else for await (const chunk of fs.createReadStream(file)) await consume(chunk);
      if (actual !== size) throw new Error("Bundle file changed while exporting");
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); await write(descriptor);
      const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x808, 8); index.writeUInt32LE(crc, 16); index.writeUInt32LE(size, 20); index.writeUInt32LE(size, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE((stat.mode << 16) >>> 0, 38); index.writeUInt32LE(start, 42);
      central.push(Buffer.concat([index, name]));
    }
  };
  try {
    await walk(directory); const start = offset;
    for (const entry of central) await write(entry);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); await write(end);
    out.end(); await once(out, "close"); if (failure) throw failure;
    const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await fsp.rename(temporary, target);
    if (process.platform !== "win32") { const parent = fs.openSync(path.dirname(target), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
  } catch (error) { out.destroy(); await fsp.rm(temporary, {force: true}); throw error; }
}
