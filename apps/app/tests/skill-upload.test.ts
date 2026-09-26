import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bytesToBase64,
  classifyDrop,
  groupSkillFiles,
  isSkillUploadJunk,
  readSkillFromDroppedFolder,
  readSkillFromFileList,
  readSkillFromZipBytes,
  SKILL_UPLOAD_LIMITS,
  SkillUploadError,
} from "../src/app/lib/skill-upload";
import { placeSkillFiles } from "../src/react-app/domains/settings/pages/skill-files-panel";

const text = (value: string) => new TextEncoder().encode(value);
const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

type ZipSpec = { name: string; data?: string; mode?: number; deflate?: boolean; encrypted?: boolean };

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal zip writer (CRCs are not checked by the reader). */
async function zip(entries: ZipSpec[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = text(entry.name);
    const raw = text(entry.data ?? "");
    const body = entry.deflate ? await deflateRaw(raw) : raw;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, entry.encrypted ? 1 : 0x800, true);
    lv.setUint16(8, entry.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(8, entry.encrypted ? 1 : 0x800, true);
    cv.setUint16(10, entry.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((entry.mode ?? 0o100644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const SKILL = "---\nname: greeter\ndescription: Greets\n---\n";

describe("readSkillFromZipBytes", () => {
  test("reads stored and deflated entries with exec bits, skipping dirs and junk", async () => {
    const bytes = await zip([
      { name: "greeter/", mode: 0o040755 },
      { name: "greeter/SKILL.md", data: SKILL, deflate: true },
      { name: "greeter/scripts/greet.sh", data: "#!/bin/sh\necho hi\n", mode: 0o100755 },
      { name: "__MACOSX/greeter/._SKILL.md", data: "junk" },
      { name: "greeter/.DS_Store", data: "junk" },
    ]);
    const read = await readSkillFromZipBytes(bytes, "greeter.zip");
    expect(read.kind).toBe("zip");
    expect(read.label).toBe("greeter.zip");
    expect(read.files.map((f) => f.path)).toEqual(["greeter/SKILL.md", "greeter/scripts/greet.sh"]);
    expect(decode(read.files[0]!.contentBase64)).toBe(SKILL);
    expect(read.files[0]!.executable).toBeUndefined();
    expect(read.files[1]!.executable).toBe(true);
    expect(read.skipped).toEqual(["__MACOSX/greeter/._SKILL.md", "greeter/.DS_Store"]);
  });

  test("refuses symlink entries, encryption, non-zips and oversized entries", async () => {
    const link = await zip([{ name: "SKILL.md", data: SKILL }, { name: "scripts/leak", data: "/etc/passwd", mode: 0o120777 }]);
    await expect(readSkillFromZipBytes(link)).rejects.toThrow(/cannot contain links.*scripts\/leak/);
    const encrypted = await zip([{ name: "SKILL.md", data: SKILL, encrypted: true }]);
    await expect(readSkillFromZipBytes(encrypted)).rejects.toThrow(/Encrypted/);
    await expect(readSkillFromZipBytes(text("not a zip at all, just text"))).rejects.toBeInstanceOf(SkillUploadError);
    const big = await zip([{ name: "big.txt", data: "a".repeat(SKILL_UPLOAD_LIMITS.maxFileBytes + 1), deflate: true }]);
    await expect(readSkillFromZipBytes(big)).rejects.toThrow(/larger than/);
  });

  test("a deflated entry that inflates past its declared size is refused (zip bomb)", async () => {
    const bytes = await zip([{ name: "SKILL.md", data: "a".repeat(100_000), deflate: true }]);
    // Lie about the uncompressed size in the central directory.
    const view = new DataView(bytes.buffer);
    const central = bytes.length - 22 - (46 + "SKILL.md".length);
    view.setUint32(central + 24, 10, true);
    await expect(readSkillFromZipBytes(bytes)).rejects.toThrow(/larger than it claims/);
  });
});

function relativeFile(path: string, content: string): File {
  const file = new File([content], path.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

describe("readSkillFromFileList", () => {
  test("keeps directory-input paths (with the picked folder) and drops junk", async () => {
    const read = await readSkillFromFileList([
      relativeFile("greeter/SKILL.md", SKILL),
      relativeFile("greeter/scripts/greet.sh", "#!/bin/sh\n"),
      relativeFile("greeter/.git/HEAD", "ref"),
    ]);
    expect(read.kind).toBe("folder");
    expect(read.label).toBe("greeter");
    expect(read.files.map((f) => f.path)).toEqual(["greeter/SKILL.md", "greeter/scripts/greet.sh"]);
    expect(read.skipped).toEqual(["greeter/.git/HEAD"]);
  });

  test("a single .zip from a file input is read as an archive", async () => {
    const bytes = await zip([{ name: "SKILL.md", data: SKILL }]);
    const read = await readSkillFromFileList([new File([bytes as BlobPart], "skill.zip")]);
    expect(read.kind).toBe("zip");
    expect(read.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  test("stops at the file cap", async () => {
    const many = Array.from({ length: SKILL_UPLOAD_LIMITS.maxFiles + 1 }, (_, i) => relativeFile(`s/${i}.md`, "x"));
    await expect(readSkillFromFileList(many)).rejects.toThrow(/at most/);
  });
});

type FakeEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (file: File) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: FakeEntry[]) => void) => void };
};

function fakeDir(fullPath: string, children: FakeEntry[]): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.split("/").at(-1)!,
    fullPath,
    createReader: () => {
      let done = false;
      return { readEntries: (ok) => { ok(done ? [] : children); done = true; } };
    },
  };
}

function fakeFile(fullPath: string, content: string): FakeEntry {
  const name = fullPath.split("/").at(-1)!;
  return { isFile: true, isDirectory: false, name, fullPath, file: (ok) => ok(new File([content], name)) };
}

describe("drag and drop", () => {
  test("walks a dropped folder without descending into skipped folders", async () => {
    let nodeModulesRead = false;
    const nodeModules = fakeDir("/greeter/node_modules", []);
    nodeModules.createReader = () => {
      nodeModulesRead = true;
      return { readEntries: (ok) => ok([]) };
    };
    const root = fakeDir("/greeter", [
      fakeFile("/greeter/SKILL.md", SKILL),
      fakeDir("/greeter/scripts", [fakeFile("/greeter/scripts/greet.sh", "#!/bin/sh\n")]),
      nodeModules,
    ]);
    const read = await readSkillFromDroppedFolder(root);
    expect(read.files.map((f) => f.path)).toEqual(["greeter/SKILL.md", "greeter/scripts/greet.sh"]);
    expect(read.skipped).toEqual(["greeter/node_modules/"]);
    expect(nodeModulesRead).toBe(false);
  });

  test("classifies a zip, a folder, loose files, and refuses several folders", () => {
    const transfer = (entries: Array<FakeEntry | null>, files: File[]) => ({
      items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
      files,
    }) as unknown as DataTransfer;
    const zipFile = new File(["x"], "skill.zip");
    expect(classifyDrop(transfer([fakeFile("/skill.zip", "x")], [zipFile]))?.kind).toBe("zip");
    expect(classifyDrop(transfer([fakeDir("/greeter", [])], [new File([], "greeter")]))?.kind).toBe("folder");
    expect(classifyDrop(transfer([fakeFile("/SKILL.md", SKILL)], [new File([SKILL], "SKILL.md")]))?.kind).toBe("files");
    expect(() => classifyDrop(transfer([fakeDir("/a", []), fakeDir("/b", [])], []))).toThrow(/one skill folder/);
  });
});

describe("helpers", () => {
  test("junk, base64, grouping and placement", () => {
    expect(isSkillUploadJunk("x/.DS_Store")).toBe(true);
    expect(isSkillUploadJunk("x/__pycache__/a.pyc")).toBe(true);
    expect(isSkillUploadJunk("scripts/run.py")).toBe(false);
    expect(bytesToBase64(text("héllo"))).toBe(Buffer.from("héllo").toString("base64"));
    expect(groupSkillFiles([{ path: "scripts/b.sh" }, { path: "SKILL.md" }, { path: "assets/x.png" }]).map((g) => g.folder)).toEqual(["", "assets", "scripts"]);
    expect(placeSkillFiles([{ path: "run.sh", contentBase64: "" }], "scripts").map((f) => f.path)).toEqual(["scripts/run.sh"]);
    expect(placeSkillFiles([{ path: "run.sh", contentBase64: "" }], "").map((f) => f.path)).toEqual(["run.sh"]);
  });
});

describe("Library wiring", () => {
  const mcpView = readFileSync(join(import.meta.dir, "../src/react-app/domains/settings/pages/mcp-view.tsx"), "utf8");
  const modal = readFileSync(join(import.meta.dir, "../src/react-app/domains/settings/pages/library-add-workspace-skill-modal.tsx"), "utf8");
  const route = readFileSync(join(import.meta.dir, "../src/react-app/shell/settings-route.tsx"), "utf8");

  test("the Add skill modal offers upload next to the SKILL.md editor", () => {
    expect(mcpView).toContain("onPreviewBundle={props.previewSkillBundle}");
    expect(mcpView).toContain("onInstallBundle={props.installSkillBundle}");
    expect(modal).toContain("<SkillUploadPane");
    // The paste flow is still the default mode.
    expect(modal).toContain('setMode("write")');
  });

  test("installed workspace skills show their files (not Connect skills)", () => {
    expect(mcpView).toMatch(/detailSkill\.origin !== "omnirush-connect" && props\.listSkillFiles[\s\S]*<SkillFilesPanel/);
    for (const prop of ["previewSkillBundle", "installSkillBundle", "listSkillFiles", "updateSkillFiles", "saveSkillContent"]) {
      expect(route).toContain(`${prop}={extensionsStore.${prop}}`);
    }
  });
});
