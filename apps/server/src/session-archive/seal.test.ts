import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import vectors from "./__fixtures__/orseal_vectors.json" with { type: "json" };
import {
  SEAL_CHUNK,
  SealError,
  SealStream,
  openSealed,
  openSealedBuffer,
  sealBuffer,
  sealKeyring,
  sealKid,
  x25519PrivateKey,
  x25519PublicRaw,
} from "./seal.js";

type KeyName = "server" | "previous" | "unrelated";

const hex = (value: string) => Buffer.from(value, "hex");
const keyring = sealKeyring([hex(vectors.keys.server.private_hex), hex(vectors.keys.previous.private_hex)]);
const fixed = { ephemeralPrivateKey: hex(vectors.keys.ephemeral.private_hex), salt: hex(vectors.salt_hex) };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function isKeyName(name: string): name is KeyName {
  return name === "server" || name === "previous" || name === "unrelated";
}

function plaintextOf(vector: (typeof vectors.positive)[number]): Buffer {
  if ("plaintext_hex" in vector && typeof vector.plaintext_hex === "string") return hex(vector.plaintext_hex);
  const length = vector.plaintext_len;
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
}

async function sealStreamed(plaintext: Buffer, options: ConstructorParameters<typeof SealStream>[0], pieceSize: number) {
  const sealer = new SealStream(options);
  const out: Buffer[] = [];
  sealer.on("data", (piece: Buffer) => out.push(piece));
  const done = new Promise<void>((resolve, reject) => {
    sealer.on("end", resolve);
    sealer.on("error", reject);
  });
  for (let offset = 0; offset < plaintext.length; offset += pieceSize) sealer.write(plaintext.subarray(offset, offset + pieceSize));
  sealer.end();
  await done;
  return { sealed: Buffer.concat(out), result: sealer.result() };
}

describe("ORSEAL01 vectors", () => {
  test("keys and kids match the fixture", () => {
    for (const name of ["server", "previous", "unrelated"] as const) {
      const key = vectors.keys[name];
      expect(x25519PublicRaw(x25519PrivateKey(hex(key.private_hex))).toString("hex")).toBe(key.public_hex);
      expect(sealKid(hex(key.public_hex))).toBe(key.kid);
    }
    expect([...keyring.keys()]).toEqual(vectors.decoder_kids);
  });

  for (const vector of vectors.positive) {
    test(`positive ${vector.name}: seal reproduces the vector and opens`, async () => {
      if (!isKeyName(vector.recipient)) throw new Error(`unknown recipient ${vector.recipient}`);
      const plaintext = plaintextOf(vector);
      expect(sha256(plaintext)).toBe(vector.plaintext_sha256);
      const options = { publicKey: hex(vectors.keys[vector.recipient].public_hex), chunk: vector.chunk, testOnlyFixedSecrets: fixed };
      const whole = sealBuffer(plaintext, options);
      expect(whole.kid).toBe(vector.kid);
      expect(whole.size).toBe(vector.sealed_len);
      expect(whole.sha256).toBe(vector.sealed_sha256);
      expect(sha256(whole.sealed)).toBe(vector.sealed_sha256);
      if ("sealed_hex" in vector && typeof vector.sealed_hex === "string") expect(whole.sealed.toString("hex")).toBe(vector.sealed_hex);
      // The streaming sealer gives the same bytes whatever the write sizes.
      for (const pieceSize of [1, 7, vector.chunk, 65_536]) {
        if (plaintext.length > 100_000 && pieceSize < 1000) continue;
        const streamed = await sealStreamed(plaintext, options, pieceSize);
        expect(streamed.result.sha256).toBe(vector.sealed_sha256);
        expect(streamed.sealed.equals(whole.sealed)).toBe(true);
      }
      expect((await openSealedBuffer(whole.sealed, keyring)).equals(plaintext)).toBe(true);
    });
  }

  for (const vector of vectors.negative) {
    test(`negative ${vector.name}: fails with ${vector.expect_error}`, async () => {
      let code: string | null = null;
      try {
        await openSealedBuffer(hex(vector.sealed_hex), keyring);
      } catch (error) {
        code = error instanceof SealError ? error.code : `unexpected ${String(error)}`;
      }
      expect(code).toBe(vector.expect_error);
    });
  }
});

describe("ORSEAL01 streaming", () => {
  test("a random multi-MiB payload round-trips with bounded frames", async () => {
    const publicKey = hex(vectors.keys.server.public_hex);
    const plaintext = randomBytes(5 * SEAL_CHUNK + 12_345);
    const { sealed, result } = await sealStreamed(plaintext, { publicKey }, 300_000);
    expect(result.size).toBe(sealed.length);
    expect(result.sha256).toBe(sha256(sealed));
    // 12 + header + L + 20 * frames (section 6.2).
    const headerLength = sealed.readUInt32BE(8);
    expect(sealed.length).toBe(12 + headerLength + plaintext.length + 20 * 6);
    // Opening streams frame by frame from small source pieces: no emitted piece exceeds one chunk.
    const source = Readable.from((function* () {
      for (let offset = 0; offset < sealed.length; offset += 64 * 1024) yield sealed.subarray(offset, offset + 64 * 1024);
    })());
    const pieces: Buffer[] = [];
    for await (const piece of openSealed(source, keyring)) {
      expect(piece.length).toBeLessThanOrEqual(SEAL_CHUNK);
      pieces.push(piece);
    }
    expect(Buffer.concat(pieces).equals(plaintext)).toBe(true);
  });

  test("fresh ephemeral keys and salts make every seal unique", () => {
    const publicKey = hex(vectors.keys.server.public_hex);
    const first = sealBuffer(Buffer.from("same"), { publicKey });
    const second = sealBuffer(Buffer.from("same"), { publicKey });
    expect(first.sealed.equals(second.sealed)).toBe(false);
    expect(first.kid).toBe(vectors.keys.server.kid);
  });

  test("an archive sealed to an unrelated key is unknown_kid", async () => {
    const { sealed } = sealBuffer(Buffer.from("x"), { publicKey: hex(vectors.keys.unrelated.public_hex) });
    await expect(openSealedBuffer(sealed, keyring)).rejects.toMatchObject({ code: "unknown_kid" });
  });
});
