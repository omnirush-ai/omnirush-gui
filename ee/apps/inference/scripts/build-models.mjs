import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const sourceDir = path.join(appDir, "src", "models")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devOmniRushApi = "http://127.0.0.1:8791/api/v1"
const prodOmniRushApi = "https://inference.omnirushlabs.com/api/v1"

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function omnirushProvider(models, api) {
  return {
    omnirush: {
      id: "omnirush",
      env: ["OMNIRUSH_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "OmniRush.ai Models",
      api,
      models,
    },
  }
}

const isDevMode = process.env.OMNIRUSH_DEV_MODE === "1"
const base = await readJson(path.join(sourceDir, "base.json"))
const omnirushModels = await readJson(path.join(sourceDir, "omnirush-models.json"))
const omnirush = omnirushProvider(omnirushModels, isDevMode ? devOmniRushApi : prodOmniRushApi)
const models = { ...base, ...omnirush }

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[inference] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
