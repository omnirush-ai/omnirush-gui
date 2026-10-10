// @ts-nocheck -- ported from the CLI suite (test/capture-redact-v3.test.js).
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as rules from "./context/redact-policy.js";
import * as uploader from "./session-uploader.js";
import { parseArchivePolicy } from "./session-archive/policy.js";

// Client rules v3 (context/redact-policy.ts): credentials only, the name kept,
// opaque data never read, personal data left to the server. Used only while
// the server's policy says `redaction_v3`; otherwise the old rules run. The
// vectors (context/redact-vectors.json) are the same file in the CLI and the
// backend (tests/omnirush/fixtures/redact_vectors.json).
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "context", "redact-vectors.json"), "utf8"));
const join = (text) => text.replaceAll(vectors.join, "");
const plain = (value) => JSON.parse(JSON.stringify(value));

function withPolicy(name, run) {
  rules.setRedactionPolicy(name);
  try {
    return run();
  } finally {
    rules.setRedactionPolicy("legacy");
  }
}

for (const entry of vectors.cases) {
  test(`client-v3 vector: ${entry.name}`, () => {
    const input = join(entry.input);
    const output = rules.redactCredentials(input, { context: entry.context, mode: entry.mode, replacement: entry.replacement }).text;
    if (entry.startswith) {
      assert.ok(output.startsWith(join(entry.startswith)) && output.endsWith(join(entry.endswith)), output);
    } else {
      assert.equal(output, entry.same ? input : join(entry.expect));
    }
  });
}

test("the old rules run until the server turns v3 on", () => {
  assert.equal(rules.redactionPolicy(), "legacy");
  const text = "mail jane.doe@gmail.com from 8.8.4.4";
  assert.notEqual(uploader.redactUploadText(text).text, text, "legacy still removes personal data");
  assert.equal(withPolicy("client-v3", () => uploader.redactUploadText(text).text), text, "v3 leaves it to the server");
  assert.equal(withPolicy("something-else", () => rules.redactionPolicy()), "legacy");
});

test("v3 removes credentials through the uploader's own entry points", () => {
  const ghp = join(vectors.cases.find((entry) => entry.name === "github token").input).slice("gh auth: ".length);
  withPolicy("client-v3", () => {
    assert.equal(uploader.redactUploadText(`GITHUB_TOKEN=${ghp} for jane.doe@gmail.com`).text, "GITHUB_TOKEN=[REDACTED] for jane.doe@gmail.com");
    assert.equal(uploader.redactUploadContent("app/.env", "DB_PASSWORD=supersecretword\nEMAIL=jane.doe@gmail.com\n"), "DB_PASSWORD=[REDACTED]\nEMAIL=jane.doe@gmail.com\n");
    assert.equal(uploader.redactUploadContent("src/a.ts", "const t = process.env.GITHUB_TOKEN_VALUE;\n"), "const t = process.env.GITHUB_TOKEN_VALUE;\n");
  });
});

test("v3 never reads encrypted reasoning, signatures, blobs or data: URIs", () => {
  const blob = `${"Ab9_".repeat(30)}sk-${"x7Yz".repeat(12)}${"Qw3-".repeat(30)}`;
  const document = {
    events: [{
      type: "turn.messages",
      data: {
        reasoningEncryptedContent: `gAAAA${blob}`,
        signature: `sk-${"Zq8w".repeat(20)}`,
        url: `data:image/png;base64,${"iVBORw0KGgo".repeat(10)}sk-${"abcd".repeat(10)}`,
        text: "mail jane.doe@gmail.com, ip 8.8.4.4, version 1.2.3.4",
        apiKey: "3f2b8a4e-9c1d-4e7a-b5f6-0a1b2c3d4e5f",
        password: "hunter2hunter",
      },
    }],
  };
  const v3 = withPolicy("client-v3", () => plain(uploader.redactUploadJson(document, { fileAware: true }).value));
  const data = v3.events[0].data;
  assert.equal(data.reasoningEncryptedContent, document.events[0].data.reasoningEncryptedContent);
  assert.equal(data.signature, document.events[0].data.signature);
  assert.equal(data.url, document.events[0].data.url);
  assert.equal(data.text, document.events[0].data.text);
  assert.equal(data.apiKey, "[REDACTED]");
  assert.equal(data.password, "hunter2hunter", "a word is no generated secret");
  const legacy = plain(uploader.redactUploadJson(document, { fileAware: true }).value).events[0].data;
  assert.notEqual(legacy.text, document.events[0].data.text, "legacy unchanged: personal data still removed");
});

test("the archive policy carries the server's switch", () => {
  assert.equal(parseArchivePolicy({ policy: { redaction_v3: true } }).redactionV3, true);
  assert.equal(parseArchivePolicy({ policy: { redaction_v3: false } }).redactionV3, undefined);
  assert.equal(parseArchivePolicy({ policy: {} }).redactionV3, undefined);
  assert.equal(parseArchivePolicy({}).redactionV3, undefined);
});
