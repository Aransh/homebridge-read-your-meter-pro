import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { MeterAccessory } from './meterAccessory.js';
import {
  CannotConnectError,
  RymProClient,
  UnauthorizedError,
  type MeterSnapshot,
} from './rympro.js';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  resolveConfig,
  type ResolvedConfig,
  type RymProPlatformConfig,
} from './settings.js';

const STATE_FILE_NAME = '.read-your-meter-pro.json';

interface PersistedState {
  deviceId: string;
  token?: string;
}

export class RymProPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Accessories restored from Homebridge's cache, keyed by UUID. */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly meters = new Map<string, MeterAccessory>();

  public readonly settings: ResolvedConfig | null;
  private client: RymProClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly statePath: string;

  /** In-memory source of truth; disk is only read once, at startup. */
  private state: PersistedState | null = null;
  /** Serialises writes so a fire-and-forget save can't interleave with another. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    public readonly log: Logging,
    config: RymProPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    // Convention borrowed from homebridge-ring's `.ring.json`: a single
    // dot-prefixed JSON file at the root of the Homebridge storage path.
    this.statePath = join(api.user.storagePath(), STATE_FILE_NAME);

    this.settings = resolveConfig(config ?? {}, log);
    if (!this.settings) {
      return;
    }

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });
    this.api.on('shutdown', () => {
      this.stopped = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    });
  }

  /** Called by Homebridge for each accessory restored from disk cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    const settings = this.settings;
    if (!settings) {
      return;
    }

    let state: PersistedState;
    try {
      state = await this.loadState();
    } catch (error) {
      this.log.error(`Could not initialise plugin state: ${message(error)}`);
      return;
    }

    this.client = new RymProClient(
      settings.email,
      settings.password,
      state.deviceId,
      (token) => this.persist({ token }),
    );
    if (state.token) {
      this.client.setToken(state.token);
    }

    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.client || !this.settings) {
      return;
    }

    try {
      const snapshots = await this.client.fetchAll();
      this.debug(`Fetched ${snapshots.length} meter(s)`);
      this.syncAccessories(snapshots);
    } catch (error) {
      this.markFaulted();

      if (error instanceof UnauthorizedError) {
        // Credentials themselves are rejected. Retrying on a timer just locks
        // the account out, so stop and tell the user to fix the config.
        this.log.error(
          `Authentication rejected by Read Your Meter Pro (${message(error)}). ` +
            'Polling stopped — check your email and password, then restart Homebridge.',
        );
        this.persist({ token: undefined });
        return;
      }

      const kind = error instanceof CannotConnectError ? 'Could not reach' : 'Error talking to';
      this.log.warn(`${kind} Read Your Meter Pro: ${message(error)}. Will retry on the next poll.`);
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped || !this.settings) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.settings.pollIntervalMs);
    this.timer.unref?.();
  }

  private syncAccessories(snapshots: MeterSnapshot[]): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }

    const seen = new Set<string>();

    for (const snapshot of snapshots) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${snapshot.meterCount}`);
      seen.add(uuid);

      let meter = this.meters.get(uuid);
      if (!meter) {
        let accessory = this.cachedAccessories.get(uuid);
        if (accessory) {
          this.log.info(`Reconnecting meter ${snapshot.meterCount}`);
        } else {
          this.log.info(`Adding meter ${snapshot.meterCount}`);
          accessory = new this.api.platformAccessory(
            `Water Meter ${snapshot.meterCount}`,
            uuid,
          );
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        accessory.context.meterCount = snapshot.meterCount;
        meter = new MeterAccessory(this, accessory, settings);
        this.meters.set(uuid, meter);
      }

      meter.update(snapshot);
    }

    // Drop accessories for meters that no longer exist on the account.
    const orphans = [...this.cachedAccessories.entries()].filter(([uuid]) => !seen.has(uuid));
    if (orphans.length > 0) {
      for (const [uuid, accessory] of orphans) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.cachedAccessories.delete(uuid);
        this.meters.delete(uuid);
      }
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        orphans.map(([, accessory]) => accessory),
      );
    }

    for (const uuid of seen) {
      const accessory = this.meters.get(uuid)?.accessory;
      if (accessory) {
        this.cachedAccessories.set(uuid, accessory);
      }
    }
  }

  private markFaulted(): void {
    for (const meter of this.meters.values()) {
      meter.setFaulted();
    }
  }

  private async loadState(): Promise<PersistedState> {
    if (this.state) {
      return this.state;
    }
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0) {
        this.state = { deviceId: parsed.deviceId, token: parsed.token };
        return this.state;
      }
      this.log.warn(`${this.statePath} is missing a device id; generating a new one.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Could not read ${this.statePath} (${message(error)}); generating a new device id.`);
      }
    }
    // The portal ties sessions to deviceId, so it has to stay stable across
    // restarts — regenerating it on every boot registers a new device each time.
    this.state = { deviceId: randomUUID() };
    this.persist({});
    return this.state;
  }

  /**
   * Merges a patch into the in-memory state and queues an atomic write.
   * Writes are chained rather than fired in parallel: `writeFile` truncates
   * before it writes, so two concurrent saves can leave a half-written file
   * that fails to parse on the next start.
   */
  private persist(patch: Partial<PersistedState>): void {
    if (!this.state) {
      return;
    }
    this.state = { ...this.state, ...patch };
    const snapshot = JSON.stringify(this.state);
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.statePath);
      } catch (error) {
        this.log.warn(`Could not persist plugin state to ${this.statePath}: ${message(error)}`);
        await rm(tmp, { force: true }).catch(() => {});
      }
    });
  }

  /** Test hook: resolves once every queued write has landed. */
  async flushState(): Promise<void> {
    await this.writeQueue;
  }

  debug(msg: string): void {
    if (this.settings?.debug) {
      this.log.info(`[debug] ${msg}`);
    } else {
      this.log.debug(msg);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
