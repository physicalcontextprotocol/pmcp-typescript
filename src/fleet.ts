/**
 * P-MCP TypeScript SDK — Fleet Client
 * =====================================
 * High-level fleet orchestration for multi-robot deployments.
 */

import { EventEmitter } from 'eventemitter3';
import {
  ActuationResult,
  BatchActuationResult,
  JsonRpcRequest,
  JsonRpcResponse,
  LeaseGrant,
  MetricsSnapshot,
  PmcpError,
  PmcpErrorCode,
  SensorReading,
  PMCP_VERSION,
} from './types';

// ============================================================================
// Robot Endpoint Configuration
// ============================================================================

export interface RobotEndpointConfig {
  robotId: string;
  host: string;
  port: number;
  transport?: 'http' | 'ws' | 'tcp';
  tls?: boolean;
  bearerToken?: string;
  did?: string;
  timeoutMs?: number;
}

export interface RobotStatus {
  robotId: string;
  online: boolean;
  lastSeenMs: number;
  actuations: string[];
  sensors: string[];
  activeLease?: string;
  error?: string;
}

// ============================================================================
// Single Robot Client
// ============================================================================

export class PMCPRobotClient extends EventEmitter {
  private readonly config: Required<RobotEndpointConfig>;
  private reqCounter = 0;

  constructor(config: RobotEndpointConfig) {
    super();
    this.config = {
      transport: 'http',
      tls: false,
      bearerToken: '',
      did: '',
      timeoutMs: 30_000,
      ...config,
    };
  }

  get robotId(): string { return this.config.robotId; }

  get baseUrl(): string {
    const scheme = this.config.tls ? 'https' : 'http';
    return `${scheme}://${this.config.host}:${this.config.port}`;
  }

  // ── core RPC ──────────────────────────────────────────────────────────────

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.reqCounter++;
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.reqCounter,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.bearerToken) {
      headers['Authorization'] = `Bearer ${this.config.bearerToken}`;
    }
    if (this.config.did) {
      headers['X-PMCP-DID'] = this.config.did;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const body = await response.json() as JsonRpcResponse;

      if (body.error) {
        const err = new PMCPClientError(body.error.message, body.error.code);
        this.emit('error', err);
        throw err;
      }

      return body.result as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── actuations ────────────────────────────────────────────────────────────

  async initialize(): Promise<Record<string, unknown>> {
    return this.call('initialize', {
      protocolVersion: PMCP_VERSION,
      clientInfo: { name: 'pmcp-ts-client', version: '1.0.0' },
    });
  }

  async actuate(name: string, params: Record<string, unknown>): Promise<ActuationResult> {
    const result = await this.call<Record<string, unknown>>('actuations/execute', { name, params });
    return {
      success: Boolean(result.success),
      finalPose: result.final_pose as Record<string, number> | undefined,
      energyConsumedJ: Number(result.energy_consumed_j ?? 0),
      durationMs: Number(result.duration_ms ?? 0),
      errorMsg: result.error_msg as string | undefined,
    };
  }

  async listActuations(): Promise<{ name: string; description: string }[]> {
    const result = await this.call<{ actuations: unknown[] }>('actuations/list', {});
    return (result.actuations ?? []) as { name: string; description: string }[];
  }

  // ── sensors ───────────────────────────────────────────────────────────────

  async readSensor(name: string): Promise<SensorReading> {
    const result = await this.call<Record<string, unknown>>('sensors/read', { name });
    return {
      value: result.value,
      unit: String(result.unit ?? ''),
      timestampMs: Number(result.timestamp_ms ?? Date.now()),
      quality: Number(result.quality ?? 1.0),
    };
  }

  async listSensors(): Promise<{ name: string; sensorType: string }[]> {
    const result = await this.call<{ sensors: unknown[] }>('sensors/list', {});
    return (result.sensors ?? []) as { name: string; sensorType: string }[];
  }

  // ── leases ────────────────────────────────────────────────────────────────

  async acquireLease(zoneId: string, durationMs = 30_000): Promise<LeaseGrant> {
    const result = await this.call<Record<string, unknown>>('leases/acquire', {
      zone_id: zoneId,
      duration_ms: durationMs,
    });
    return {
      leaseId: String(result.lease_id ?? ''),
      zoneId,
      robotId: this.robotId,
      expiresMs: Number(result.expires_ms ?? 0),
      granted: Boolean(result.granted),
    };
  }

  async releaseLease(leaseId: string): Promise<boolean> {
    const result = await this.call<{ released: boolean }>('leases/release', { lease_id: leaseId });
    return result.released ?? false;
  }

  // ── metrics ───────────────────────────────────────────────────────────────

  async getMetrics(): Promise<MetricsSnapshot> {
    const result = await this.call<Partial<MetricsSnapshot>>('pmcp/metrics', {});
    return {
      actuationCount: result.actuationCount ?? 0,
      sensorReadCount: result.sensorReadCount ?? 0,
      safetyViolations: result.safetyViolations ?? 0,
      avgActuationDurationMs: result.avgActuationDurationMs ?? 0,
      uptimeSeconds: result.uptimeSeconds ?? 0,
      energyUsedJ: result.energyUsedJ ?? 0,
      connectedClients: result.connectedClients ?? 0,
      lastHeartbeatMs: result.lastHeartbeatMs ?? 0,
    };
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.call('pmcp/ping', {});
    return performance.now() - start;
  }
}

// ============================================================================
// Fleet Client
// ============================================================================

export interface FleetActuateOptions {
  failFast?: boolean;
  timeoutMs?: number;
}

export interface MissionStep {
  stepId: string;
  robotId: string;
  actuation: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
  timeoutMs?: number;
  retryOnFail?: boolean;
}

export interface MissionResult {
  missionId: string;
  success: boolean;
  stepResults: Map<string, ActuationResult>;
  totalDurationMs: number;
  failedSteps: string[];
}

export class PMCPFleetClient extends EventEmitter {
  private readonly robots = new Map<string, PMCPRobotClient>();
  private readonly status = new Map<string, RobotStatus>();
  private healthInterval?: NodeJS.Timeout;

  // ── robot management ─────────────────────────────────────────────────────

  async addRobot(config: RobotEndpointConfig, probe = true): Promise<RobotStatus> {
    const client = new PMCPRobotClient(config);
    this.robots.set(config.robotId, client);

    const s: RobotStatus = {
      robotId: config.robotId,
      online: false,
      lastSeenMs: 0,
      actuations: [],
      sensors: [],
    };
    this.status.set(config.robotId, s);

    client.on('error', (err) => this.emit('robotError', config.robotId, err));

    if (probe) {
      await this.probeRobot(config.robotId);
    }

    return this.status.get(config.robotId)!;
  }

  removeRobot(robotId: string): void {
    this.robots.delete(robotId);
    this.status.delete(robotId);
  }

  getClient(robotId: string): PMCPRobotClient | undefined {
    return this.robots.get(robotId);
  }

  listRobots(): RobotStatus[] {
    return [...this.status.values()];
  }

  onlineRobots(): RobotStatus[] {
    return this.listRobots().filter((s) => s.online);
  }

  // ── probe ────────────────────────────────────────────────────────────────

  private async probeRobot(robotId: string): Promise<void> {
    const client = this.robots.get(robotId);
    const s = this.status.get(robotId);
    if (!client || !s) return;

    try {
      const result = await client.initialize() as Record<string, unknown>;
      const caps = (result.capabilities ?? {}) as Record<string, unknown>;
      s.online = true;
      s.lastSeenMs = Date.now();
      s.actuations = Object.keys((caps.actuations ?? {}) as object);
      s.sensors = Object.keys((caps.sensors ?? {}) as object);
      this.emit('robotOnline', robotId);
    } catch (err) {
      s.online = false;
      s.error = String(err);
      this.emit('robotOffline', robotId, err);
    }
  }

  // ── health loop ──────────────────────────────────────────────────────────

  startHealthLoop(intervalMs = 30_000): void {
    this.healthInterval = setInterval(async () => {
      for (const robotId of this.robots.keys()) {
        await this.probeRobot(robotId).catch(() => {});
      }
    }, intervalMs);
  }

  stopHealthLoop(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = undefined;
    }
  }

  // ── actuation ────────────────────────────────────────────────────────────

  async actuate(
    robotId: string,
    actuation: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<ActuationResult> {
    const client = this.robots.get(robotId);
    if (!client) throw new Error(`Robot ${robotId} not registered`);
    return client.actuate(actuation, params);
  }

  async actuateAll(
    actuation: string,
    robotParams: Map<string, Record<string, unknown>>,
    options: FleetActuateOptions = {},
  ): Promise<Map<string, ActuationResult>> {
    const results = new Map<string, ActuationResult>();
    const promises = [...robotParams.entries()].map(async ([robotId, params]) => {
      try {
        const r = await this.actuate(robotId, actuation, params, { timeoutMs: options.timeoutMs });
        results.set(robotId, r);
        if (options.failFast && !r.success) {
          throw new Error(`Robot ${robotId} actuation failed: ${r.errorMsg}`);
        }
      } catch (err) {
        results.set(robotId, {
          success: false,
          energyConsumedJ: 0,
          durationMs: 0,
          errorMsg: String(err),
        });
        if (options.failFast) throw err;
      }
    });

    if (options.failFast) {
      await Promise.all(promises);
    } else {
      await Promise.allSettled(promises);
    }

    return results;
  }

  // ── sensors ───────────────────────────────────────────────────────────────

  async readAllSensors(
    sensorName: string,
    robotIds?: string[],
  ): Promise<Map<string, SensorReading>> {
    const targets = robotIds ?? [...this.robots.keys()];
    const results = new Map<string, SensorReading>();

    await Promise.allSettled(
      targets.map(async (robotId) => {
        const client = this.robots.get(robotId);
        if (!client) return;
        try {
          results.set(robotId, await client.readSensor(sensorName));
        } catch {
          results.set(robotId, { value: null, unit: '', timestampMs: Date.now(), quality: 0 });
        }
      }),
    );

    return results;
  }

  // ── mission orchestration ────────────────────────────────────────────────

  async runMission(steps: MissionStep[], missionId?: string): Promise<MissionResult> {
    const id = missionId ?? crypto.randomUUID().slice(0, 8);
    const start = Date.now();
    const stepResults = new Map<string, ActuationResult>();
    const failedSteps: string[] = [];
    const completed = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.stepId, s]));

    while (completed.size + failedSteps.length < steps.length) {
      // Find ready steps
      const ready = steps.filter(
        (s) =>
          !completed.has(s.stepId) &&
          !failedSteps.includes(s.stepId) &&
          (s.dependsOn ?? []).every((d) => completed.has(d)),
      );

      if (ready.length === 0) break;

      await Promise.allSettled(
        ready.map(async (step) => {
          try {
            const client = this.robots.get(step.robotId);
            if (!client) throw new Error(`Robot ${step.robotId} not found`);

            const result = await client.actuate(step.actuation, step.params);
            stepResults.set(step.stepId, result);

            if (result.success) {
              completed.add(step.stepId);
            } else {
              failedSteps.push(step.stepId);
              this.cascadeFail(step.stepId, steps, failedSteps);
            }
          } catch (err) {
            stepResults.set(step.stepId, {
              success: false,
              energyConsumedJ: 0,
              durationMs: 0,
              errorMsg: String(err),
            });
            failedSteps.push(step.stepId);
            this.cascadeFail(step.stepId, steps, failedSteps);
          }
        }),
      );
    }

    return {
      missionId: id,
      success: failedSteps.length === 0,
      stepResults,
      totalDurationMs: Date.now() - start,
      failedSteps,
    };
  }

  private cascadeFail(failedId: string, steps: MissionStep[], failedSteps: string[]): void {
    for (const step of steps) {
      if (step.dependsOn?.includes(failedId) && !failedSteps.includes(step.stepId)) {
        failedSteps.push(step.stepId);
        this.cascadeFail(step.stepId, steps, failedSteps);
      }
    }
  }

  // ── fleet metrics ─────────────────────────────────────────────────────────

  async getFleetMetrics(): Promise<Map<string, MetricsSnapshot>> {
    const results = new Map<string, MetricsSnapshot>();
    await Promise.allSettled(
      [...this.robots.entries()].map(async ([robotId, client]) => {
        try {
          results.set(robotId, await client.getMetrics());
        } catch {
          // ignore
        }
      }),
    );
    return results;
  }

  destroy(): void {
    this.stopHealthLoop();
    this.removeAllListeners();
  }
}

// ============================================================================
// WebSocket Client
// ============================================================================

export class PMCPWebSocketClient extends EventEmitter {
  private ws?: WebSocket;
  private reqCounter = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;

  constructor(
    private readonly url: string,
    private readonly options: {
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
      bearerToken?: string;
    } = {},
  ) {
    super();
  }

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit('connected');
    };

    this.ws.onclose = (ev) => {
      this.emit('disconnected', ev.code, ev.reason);
      this.scheduleReconnect();
    };

    this.ws.onerror = (ev) => {
      this.emit('error', ev);
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as JsonRpcResponse;
        if (msg.id != null) {
          const pending = this.pending.get(msg.id as number);
          if (pending) {
            this.pending.delete(msg.id as number);
            if (msg.error) {
              pending.reject(new PMCPClientError(msg.error.message, msg.error.code));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if ('method' in msg) {
          // Notification
          this.emit('notification', (msg as unknown as { method: string; params: unknown }).method,
            (msg as unknown as { params: unknown }).params);
        }
      } catch (err) {
        this.emit('parseError', err);
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.reqCounter++;
    const id = this.reqCounter;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      const req: JsonRpcRequest = { jsonrpc: '2.0', method, params, id };
      this.ws!.send(JSON.stringify(req));

      // Timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30_000);
    });
  }

  async actuate(name: string, params: Record<string, unknown>): Promise<ActuationResult> {
    const result = await this.call<Record<string, unknown>>('actuations/execute', { name, params });
    return {
      success: Boolean(result.success),
      finalPose: result.final_pose as Record<string, number> | undefined,
      energyConsumedJ: Number(result.energy_consumed_j ?? 0),
      durationMs: Number(result.duration_ms ?? 0),
      errorMsg: result.error_msg as string | undefined,
    };
  }

  private scheduleReconnect(): void {
    const max = this.options.maxReconnectAttempts ?? 10;
    const delay = this.options.reconnectDelayMs ?? 1000;
    if (this.reconnectAttempts >= max) return;

    this.reconnectAttempts++;
    const backoff = delay * Math.pow(2, this.reconnectAttempts - 1);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, backoff);
  }
}

// ============================================================================
// Error Types
// ============================================================================

export class PMCPClientError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = 'PMCPClientError';
  }

  get isPmcpError(): boolean {
    return this.code >= -33999 && this.code <= -33000;
  }

  get isSafetyError(): boolean {
    return [
      PmcpErrorCode.ShadowBlocked,
      PmcpErrorCode.ConstitutionBlocked,
      PmcpErrorCode.EstopActive,
      PmcpErrorCode.CollisionDetected,
      PmcpErrorCode.HumanProximity,
    ].includes(this.code as PmcpErrorCode);
  }
}

// ============================================================================
// Convenience Factory
// ============================================================================

export function createFleetClient(): PMCPFleetClient {
  return new PMCPFleetClient();
}

export async function connectRobot(config: RobotEndpointConfig): Promise<PMCPRobotClient> {
  const client = new PMCPRobotClient(config);
  await client.initialize();
  return client;
}
