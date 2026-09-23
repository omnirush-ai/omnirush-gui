/**
 * Keeps the desktop's omnirush.ai model catalog in step with the account's:
 * GET /omnirush/v1/models through the gateway broker (device bearer), shortly
 * after the server starts (which is also every sign-in) and then every
 * ~15 minutes.
 *
 * A sanitized catalog that differs from the one the engine config is built
 * from is persisted, and the engine is ALWAYS reloaded after it. The runtime
 * config file cannot be trusted to tell: any ENGINE_GLOBAL runtime-DB write
 * rewrites it from the new cache (keepOmniRushRuntimeConfigFileFresh), so its
 * `changed` flag may already be spent by the time the sync writes. The engine
 * pool rewrites the file before a rollover and skips an unchanged
 * fingerprint, so an extra reload costs nothing.
 *
 * A failed fetch or an unusable body keeps the last good catalog.
 */
import {
  canonicalOmniRushModelCatalog,
  clearOmniRushModelCatalog,
  readOmniRushModelCatalog,
  sanitizeOmniRushModelCatalog,
  writeOmniRushModelCatalog,
  type OmniRushModelCatalog,
} from "./omnirush-model-catalog.js";
import type { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { writeOmniRushRuntimeConfigFile } from "./omnirush-runtime-config.js";
import type { ServerConfig } from "./types.js";

type SyncLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

export type OmniRushModelCatalogSyncOptions = {
  config: ServerConfig;
  fetchCatalog: () => Promise<Response>;
  reloadEngine: () => Promise<void>;
  /** A busy engine defers the reload; unknown activity never blocks it. */
  engineBusy?: () => Promise<boolean>;
  log?: SyncLog;
  /** Off the startup path: the engine and the session restore go first. */
  initialDelayMs?: number;
  intervalMs?: number;
  reloadRetryMs?: number;
};

export type OmniRushModelCatalogSyncResult = "applied" | "unchanged" | "failed";

const INITIAL_DELAY_MS = 20_000;
const INTERVAL_MS = 15 * 60_000;
const RELOAD_RETRY_MS = 15_000;

export class OmniRushModelCatalogSync {
  private readonly options: OmniRushModelCatalogSyncOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadPending = false;
  private stopped = false;

  constructor(options: OmniRushModelCatalogSyncOptions) {
    this.options = options;
  }

  start(): void {
    this.schedule(this.options.initialDelayMs ?? INITIAL_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.timer = null;
    this.reloadTimer = null;
  }

  /** One sync pass. Passes are serialized, so a slow fetch never overlaps the next. */
  run(): Promise<OmniRushModelCatalogSyncResult> {
    const pass = this.queue.then(() => this.pass());
    this.queue = pass.catch(() => undefined);
    return pass;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().catch(() => undefined).finally(() => {
        const interval = this.options.intervalMs ?? INTERVAL_MS;
        // ±10% so desktops that started together do not poll together.
        this.schedule(interval * (0.9 + Math.random() * 0.2));
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async pass(): Promise<OmniRushModelCatalogSyncResult> {
    if (this.stopped) return "unchanged";
    const catalog = await this.download();
    if (!catalog || this.stopped) return "failed";
    const current = await readOmniRushModelCatalog(this.options.config);
    if (canonicalOmniRushModelCatalog(catalog) === canonicalOmniRushModelCatalog(current)) return "unchanged";
    await writeOmniRushModelCatalog(this.options.config, catalog);
    this.options.log?.("info", "omnirush.ai model catalog changed; reloading the engine", {
      models: catalog.map((model) => model.id).join(","),
    });
    this.reloadPending = true;
    await this.reload();
    return "applied";
  }

  private async download(): Promise<OmniRushModelCatalog | null> {
    try {
      const response = await this.options.fetchCatalog();
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        this.options.log?.("warn", "omnirush.ai model catalog fetch failed; keeping the last catalog", { status: response.status });
        return null;
      }
      const catalog = sanitizeOmniRushModelCatalog(await response.json());
      if (!catalog) this.options.log?.("warn", "omnirush.ai model catalog had no usable model; keeping the last catalog");
      return catalog;
    } catch (error) {
      this.options.log?.("warn", "omnirush.ai model catalog fetch failed; keeping the last catalog", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  }

  private async reload(): Promise<void> {
    if (!this.reloadPending || this.stopped) return;
    if (await this.engineBusy()) {
      this.scheduleReload();
      return;
    }
    try {
      // An engine without a rollover pool reloads in place and reads the file
      // as it stands; the pool rewrites it itself before comparing.
      await writeOmniRushRuntimeConfigFile(this.options.config);
      await this.options.reloadEngine();
      this.reloadPending = false;
    } catch (error) {
      this.options.log?.("warn", "omnirush.ai model catalog engine reload failed; retrying", {
        error: error instanceof Error ? error.message : "unknown",
      });
      this.scheduleReload();
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer || this.stopped) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const retry = this.queue.then(() => this.reload());
      this.queue = retry.catch(() => undefined);
    }, this.options.reloadRetryMs ?? RELOAD_RETRY_MS);
    this.reloadTimer.unref?.();
  }

  private async engineBusy(): Promise<boolean> {
    try {
      return (await this.options.engineBusy?.()) === true;
    } catch {
      return false;
    }
  }
}

/**
 * Starts the sync while the broker holds omnirush.ai account credentials. A
 * signed-out server drops the stored catalog instead, so the next account to
 * sign in never starts from another account's models.
 */
export function startOmniRushModelCatalogSync(input: {
  config: ServerConfig;
  broker: Pick<OmniRushGatewayBroker, "enabled" | "modelCatalog">;
  reloadEngine: () => Promise<void>;
  engineBusy?: () => Promise<boolean>;
  log?: SyncLog;
}): { stop: () => void } {
  if (!input.broker.enabled) {
    void clearOmniRushModelCatalog(input.config).catch(() => undefined);
    return { stop: () => undefined };
  }
  const sync = new OmniRushModelCatalogSync({
    config: input.config,
    fetchCatalog: () => input.broker.modelCatalog(),
    reloadEngine: input.reloadEngine,
    engineBusy: input.engineBusy,
    log: input.log,
  });
  sync.start();
  return sync;
}
