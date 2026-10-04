/**
 * P-MCP TypeScript SDK — Server-Side Implementation
 * ==================================================
 * Build P-MCP robot servers in TypeScript/Node.js.
 */

import { EventEmitter } from 'eventemitter3';
import * as http from 'http';
import * as https from 'https';
import {
  ActuationParameter,
  ActuationResult,
  ActuationSpec,
  JsonRpcRequest,
  JsonRpcResponse,
  LeaseGrant,
  MetricsSnapshot,
  PmcpErrorCode,
  SensorReading,
  SensorSpec,
  SensorType,
  PMCP_VERSION,
} from './types';

// ============================================================================
// Handler Types
// ============================================================================

export type ActuationHandler = (
  params: Record<string, unknown>,
  context: RequestContext,
) => Promise<ActuationResult>;

export type SensorHandler = (
  context: RequestContext,
) => Promise<SensorReading>;

export interface RequestContext {
  requestId: string | number;
  robotId: string;
  clientDid?: string;
  bearerToken?: string;
  leaseId?: string;
  timestamp: number;
}

// ============================================================================
// Safety Middleware
// ============================================================================

export interface SafetyMiddleware {
  name: string;
  check(
    actuationName: string,
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{ allowed: boolean; reason?: string; code?: PmcpErrorCode }>;
}

export class RateLimitMiddleware implements SafetyMiddleware {
  name = 'RateLimit';
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly rateHz: number;
  private readonly burst: number;

  constructor(rateHz = 10, burst = 20) {
    this.rateHz = rateHz;
    this.burst = burst;
  }

  async check(
    actuationName: string,
    _params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{ allowed: boolean; reason?: string; code?: PmcpErrorCode }> {
    const key = `${context.robotId}:${actuationName}`;
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, lastRefill: now };

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.rateHz);
    bucket.lastRefill = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, reason: 'Rate limit exceeded', code: PmcpErrorCode.InternalError };
  }
}

export class EstopMiddleware implements SafetyMiddleware {
  name = 'Estop';
  private stopped = false;

  engage(): void { this.stopped = true; }
  disengage(): void { this.stopped = false; }
  isEngaged(): boolean { return this.stopped; }

  async check(): Promise<{ allowed: boolean; reason?: string; code?: PmcpErrorCode }> {
    if (this.stopped) {
      return { allowed: false, reason: 'Emergency stop is active', code: PmcpErrorCode.EstopActive };
    }
    return { allowed: true };
  }
}

// ============================================================================
// Zone Lease Manager
// ============================================================================

export interface LeaseRecord {
  leaseId: string;
  zoneId: string;
  robotId: string;
  expiresMs: number;
}

/** Result of a lease acquisition attempt. Internal camelCase, not the wire
 *  `LeaseGrant` — that is what gets serialized to the client. */
export interface LeaseOutcome extends LeaseRecord {
  granted: boolean;
}

export class LeaseManager {
  private leases = new Map<string, LeaseRecord>();

  acquire(zoneId: string, robotId: string, durationMs: number): LeaseOutcome {
    // Check if zone is already held by another robot
    const existing = this.leases.get(zoneId);
    if (existing && existing.expiresMs > Date.now() && existing.robotId !== robotId) {
      return {
        leaseId: '',
        zoneId,
        robotId,
        expiresMs: 0,
        granted: false,
      };
    }

    const leaseId = `lease_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresMs = Date.now() + durationMs;
    const record: LeaseRecord = { leaseId, zoneId, robotId, expiresMs };
    this.leases.set(zoneId, record);

    return {
      leaseId,
      zoneId,
      robotId,
      expiresMs,
      granted: true,
    };
  }

  release(leaseId: string): boolean {
    for (const [zone, record] of this.leases.entries()) {
      if (record.leaseId === leaseId) {
        this.leases.delete(zone);
        return true;
      }
    }
    return false;
  }

  check(leaseId: string, zoneId: string, robotId: string): boolean {
    const record = this.leases.get(zoneId);
    if (!record) return false;
    return (
      record.leaseId === leaseId &&
      record.robotId === robotId &&
      record.expiresMs > Date.now()
    );
  }

  /** Leases granted and not yet expired. Used by the `pmcp/metrics` handler. */
  activeCount(now: number = Date.now()): number {
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.expiresMs > now) n++;
    }
    return n;
  }

  expireStale(): void {
    const now = Date.now();
    for (const [zone, record] of this.leases.entries()) {
      if (record.expiresMs <= now) {
        this.leases.delete(zone);
      }
    }
  }
}

// ============================================================================
// PMCPServer
// ============================================================================

export interface PMCPServerOptions {
  name: string;
  version?: string;
  robotId?: string;
  robotClass?: string;
  model?: string;
  serial?: string;
  location?: string;
  port?: number;
  host?: string;
  tls?: boolean;
  tlsKey?: Buffer;
  tlsCert?: Buffer;
  enableMetrics?: boolean;
  enableAuditLog?: boolean;
  maxConnections?: number;
}

export interface RegisterActuationOptions {
  name: string;
  description: string;
  parameters?: ActuationParameter[];
  maxSpeedMs?: number;
  maxForceN?: number;
  maxEnergyJ?: number;
}

export interface RegisterSensorOptions {
  name: string;
  description: string;
  sensorType?: SensorType;
  unit?: string;
  sampleRateHz?: number;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  type: string;
  robotId: string;
  actuation?: string;
  success?: boolean;
  params?: Record<string, unknown>;
  errorCode?: number;
  errorMessage?: string;
}

export class PMCPServer extends EventEmitter {
  private readonly opts: Required<PMCPServerOptions>;
  private readonly actuationHandlers = new Map<string, ActuationHandler>();
  private readonly actuationSpecs = new Map<string, ActuationSpec>();
  private readonly sensorHandlers = new Map<string, SensorHandler>();
  private readonly sensorSpecs = new Map<string, SensorSpec>();
  private readonly middleware: SafetyMiddleware[] = [];
  private readonly leaseManager = new LeaseManager();
  private readonly estop = new EstopMiddleware();
  private readonly rateLimit = new RateLimitMiddleware();
  private server?: http.Server | https.Server;

  // Metrics
  private actuationCount = 0;
  private sensorReadCount = 0;
  private safetyViolations = 0;
  private totalActuationDurationMs = 0;
  private energyUsedJ = 0;
  private startTime = Date.now();
  private auditLog: AuditEntry[] = [];

  constructor(options: PMCPServerOptions) {
    super();
    this.opts = {
      version: '1.0.0',
      robotId: `robot_${Math.random().toString(36).slice(2, 10)}`,
      robotClass: 'GenericRobot',
      model: 'unknown',
      serial: 'unknown',
      location: 'unknown',
      port: 8080,
      host: '0.0.0.0',
      tls: false,
      tlsKey: Buffer.alloc(0),
      tlsCert: Buffer.alloc(0),
      enableMetrics: true,
      enableAuditLog: true,
      maxConnections: 100,
      ...options,
    };

    // Register built-in middleware
    this.middleware.push(this.estop);
    this.middleware.push(this.rateLimit);
  }

  // ── registration ─────────────────────────────────────────────────────────

  actuation(options: RegisterActuationOptions, handler: ActuationHandler): this {
    const spec: ActuationSpec = {
      name: options.name,
      description: options.description,
      parameters: options.parameters ?? [],
      robot_id: this.opts.robotId,
      max_speed_m_s: options.maxSpeedMs ?? 1.0,
      max_force_n: options.maxForceN ?? 100.0,
      max_energy_j: options.maxEnergyJ ?? 500.0,
    };
    this.actuationHandlers.set(options.name, handler);
    this.actuationSpecs.set(options.name, spec);
    return this;
  }

  sensor(options: RegisterSensorOptions, handler: SensorHandler): this {
    const spec: SensorSpec = {
      name: options.name,
      description: options.description,
      sensor_type: options.sensorType ?? 'custom',
      unit: options.unit ?? '',
      robot_id: this.opts.robotId,
      hz: options.sampleRateHz ?? 1.0,
    };
    this.sensorHandlers.set(options.name, handler);
    this.sensorSpecs.set(options.name, spec);
    return this;
  }

  use(middleware: SafetyMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  // ── safety controls ──────────────────────────────────────────────────────

  estopEngage(): void {
    this.estop.engage();
    this.emit('estopEngaged');
  }

  estopDisengage(): void {
    this.estop.disengage();
    this.emit('estopDisengaged');
  }

  // ── message dispatch ─────────────────────────────────────────────────────

  private async handleMessage(
    body: JsonRpcRequest,
    context: RequestContext,
  ): Promise<JsonRpcResponse> {
    const { method, params = {}, id } = body;
    const p = params as Record<string, unknown>;

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = this.handleInitialize(p);
          break;
        case 'actuations/list':
          result = { actuations: [...this.actuationSpecs.values()] };
          break;
        case 'actuations/execute':
          result = await this.handleActuate(p, context);
          break;
        case 'actuations/batch':
          result = await this.handleBatchActuate(p, context);
          break;
        case 'sensors/list':
          result = { sensors: [...this.sensorSpecs.values()] };
          break;
        case 'sensors/read':
          result = await this.handleSensorRead(p, context);
          break;
        case 'leases/acquire':
          result = this.leaseManager.acquire(
            String(p.zone_id ?? ''),
            this.opts.robotId,
            Number(p.duration_ms ?? 30_000),
          );
          break;
        case 'leases/release':
          result = { released: this.leaseManager.release(String(p.lease_id ?? '')) };
          break;
        case 'pmcp/metrics':
          result = this.getMetrics();
          break;
        case 'pmcp/ping':
          result = { pong: true, timestamp: Date.now() };
          break;
        case 'safety/estop/engage':
          this.estopEngage();
          result = { engaged: true };
          break;
        case 'safety/estop/disengage':
          this.estopDisengage();
          result = { engaged: false };
          break;
        case 'audit/list':
          result = {
            entries: this.auditLog
              .slice(-Number(p.limit ?? 50))
              .filter((e) => !p.since_ms || e.timestamp >= Number(p.since_ms)),
          };
          break;
        default:
          return {
            jsonrpc: '2.0',
            error: { code: PmcpErrorCode.MethodNotFound, message: `Method not found: ${method}` },
            id: id ?? null,
          };
      }

      return { jsonrpc: '2.0', result, id: id ?? null };
    } catch (err) {
      const code = (err as { code?: number }).code ?? PmcpErrorCode.InternalError;
      const message = String((err as Error).message ?? err);
      this.auditEvent('error', { method, errorCode: code, errorMessage: message });
      return {
        jsonrpc: '2.0',
        error: { code, message },
        id: id ?? null,
      };
    }
  }

  private handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
    return {
      protocolVersion: PMCP_VERSION,
      serverInfo: {
        name: this.opts.name,
        version: this.opts.version,
        robotId: this.opts.robotId,
        robotClass: this.opts.robotClass,
        model: this.opts.model,
        serial: this.opts.serial,
        location: this.opts.location,
      },
      capabilities: {
        actuations: Object.fromEntries(this.actuationSpecs),
        sensors: Object.fromEntries(this.sensorSpecs),
        features: {
          shadow: false,
          constitution: false,
          leases: true,
          metrics: true,
          auditLog: this.opts.enableAuditLog,
          batching: true,
        },
      },
    };
  }

  private async handleActuate(
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<ActuationResult> {
    const name = String(params.name ?? '');
    const p = (params.params ?? {}) as Record<string, unknown>;

    const handler = this.actuationHandlers.get(name);
    if (!handler) {
      throw { code: PmcpErrorCode.MethodNotFound, message: `Actuation not found: ${name}` };
    }

    // Run middleware checks
    for (const mw of this.middleware) {
      const result = await mw.check(name, p, context);
      if (!result.allowed) {
        this.safetyViolations++;
        this.auditEvent('safety_violation', { actuation: name, middleware: mw.name, reason: result.reason });
        throw { code: result.code ?? PmcpErrorCode.InternalError, message: result.reason ?? 'Blocked by safety middleware' };
      }
    }

    const start = performance.now();
    let result: ActuationResult;

    try {
      result = await handler(p, context);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      result = { success: false, robot_id: this.opts.robotId, actuation_name: name, output: {}, error_message: msg };
    }

    const duration = performance.now() - start;
    this.actuationCount++;
    this.totalActuationDurationMs += duration;
    this.energyUsedJ += result.energy_consumed_j ?? 0;

    this.auditEvent('actuation', {
      actuation: name,
      success: result.success,
      duration,
      params: p,
    });

    return result;
  }

  private async handleBatchActuate(
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{ success: boolean; results: ActuationResult[]; totalDurationMs: number }> {
    const items = (params.actuations ?? []) as Array<{ name: string; params: Record<string, unknown> }>;
    const atomic = Boolean(params.atomic ?? true);

    const start = performance.now();
    const results: ActuationResult[] = [];

    for (const item of items) {
      const r = await this.handleActuate({ name: item.name, params: item.params }, context);
      results.push(r);
      if (atomic && !r.success) break;
    }

    return {
      success: results.every((r) => r.success),
      results,
      totalDurationMs: performance.now() - start,
    };
  }

  private async handleSensorRead(
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<SensorReading> {
    const name = String(params.name ?? '');
    const handler = this.sensorHandlers.get(name);
    if (!handler) {
      throw { code: PmcpErrorCode.MethodNotFound, message: `Sensor not found: ${name}` };
    }
    this.sensorReadCount++;
    return handler(context);
  }

  private getMetrics(): MetricsSnapshot {
    return {
      requests_total: this.actuationCount + this.sensorReadCount,
      errors_total: this.safetyViolations,
      uptime_s: (Date.now() - this.startTime) / 1000,
      energy_consumed_j: this.energyUsedJ,
      active_leases: this.leaseManager ? this.leaseManager.activeCount() : 0,
      connected_robots: 0,
    };
  }

  private auditEvent(type: string, data: Record<string, unknown>): void {
    if (!this.opts.enableAuditLog) return;
    const entry: AuditEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type,
      robotId: this.opts.robotId,
      ...data,
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 10_000) this.auditLog.shift();
    this.emit('audit', entry);
  }

  // ── HTTP server ───────────────────────────────────────────────────────────

  async listen(): Promise<void> {
    const handler = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', robotId: this.opts.robotId }));
        return;
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        const m = this.getMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(m));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk as Buffer));
      }

      let body: JsonRpcRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }));
        return;
      }

      const context: RequestContext = {
        requestId: body.id ?? 0,
        robotId: this.opts.robotId,
        clientDid: req.headers['x-pmcp-did'] as string | undefined,
        bearerToken: req.headers.authorization?.replace('Bearer ', ''),
        timestamp: Date.now(),
      };

      const response = await this.handleMessage(body, context);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-PMCP-Version': PMCP_VERSION,
      });
      res.end(JSON.stringify(response));
    };

    this.server = this.opts.tls
      ? https.createServer({ key: this.opts.tlsKey, cert: this.opts.tlsCert }, handler)
      : http.createServer(handler);

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => {
        this.emit('listening', this.opts.port);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}
