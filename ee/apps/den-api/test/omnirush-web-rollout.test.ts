import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeOmniRushWeb(value?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({ enabled: env.omnirushWebEnabled }))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/omnirush_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.omnirush.test",
      DEN_ORG_MODE: "single_org",
      STRIPE_SECRET_KEY: "sk_test_configured",
      STRIPE_OMNIRUSH_WEB_PRICE_ID: "price_web_configured",
      OMNIRUSH_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(value === undefined ? {} : { DEN_OMNIRUSH_WEB_ENABLED: value }),
    },
  })
}

test("OmniRush.ai Web availability fails closed unless the deployment flag is true", () => {
  const unset = probeOmniRushWeb()
  const disabled = probeOmniRushWeb("false")
  const enabled = probeOmniRushWeb("true")
  const malformed = probeOmniRushWeb("enabled")

  expect(unset.status, unset.stderr).toBe(0)
  expect(unset.stdout.trim()).toBe('{"enabled":false}')
  expect(disabled.status, disabled.stderr).toBe(0)
  expect(disabled.stdout.trim()).toBe('{"enabled":false}')
  expect(enabled.status, enabled.stderr).toBe(0)
  expect(enabled.stdout.trim()).toBe('{"enabled":true}')
  expect(malformed.status, malformed.stderr).toBe(0)
  expect(malformed.stdout.trim()).toBe('{"enabled":false}')
})
