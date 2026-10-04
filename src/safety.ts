/**
 * P-MCP TypeScript SDK — Safety Module
 * ======================================
 * Safety constitution checking, shadow preview client, audit trail.
 */

import {
  PmcpErrorCode,
  ShadowPreview,
} from './types';

// ============================================================================
// Shadow Preview Client
// ============================================================================

export interface TrajectoryWaypoint {
  x: number;
  y: number;
  z: number;
  roll?: number;
  pitch?: number;
  yaw?: number;
  timestampMs?: number;
}

export interface TrajectoryRequest {
  robotId: string;
  waypoints: TrajectoryWaypoint[];
  speedMs?: number;
  actuationName?: string;
}

export interface ShadowPreviewResponse {
  allowed: boolean;
  violations: string[];
  energyJ: number;
  durationMs: number;
  simTimeMs: number;
  finalPose?: TrajectoryWaypoint;
}

export class ShadowPreviewClient {
  constructor(
    private readonly serverUrl: string,
    private readonly timeoutMs = 500,
  ) {}

  async preview(request: TrajectoryRequest): Promise<ShadowPreviewResponse> {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.serverUrl}/shadow/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!resp.ok) {
        return {
          allowed: false,
          violations: [`Shadow server returned HTTP ${resp.status}`],
          energyJ: 0,
          durationMs: 0,
          simTimeMs: 0,
        };
      }

      const data = await resp.json() as ShadowPreviewResponse;
      return data;
    } catch (err) {
      clearTimeout(tid);
      return {
        allowed: false,
        violations: [`Shadow preview error: ${err}`],
        energyJ: 0,
        durationMs: 0,
        simTimeMs: 0,
      };
    }
  }
}

// ============================================================================
// Constitution Rule Engine
// ============================================================================

export type ConstitutionOperator =
  | 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'
  | 'in' | 'nin' | 'exists' | 'regex';

export interface ConstitutionRule {
  id: string;
  name: string;
  field: string;
  operator: ConstitutionOperator;
  value?: unknown;
  errorCode?: PmcpErrorCode;
  blocking: boolean;
  message?: string;
}

export interface ConstitutionCheckResult {
  allowed: boolean;
  violations: Array<{
    ruleId: string;
    ruleName: string;
    field: string;
    actual: unknown;
    message: string;
    errorCode: PmcpErrorCode;
    blocking: boolean;
  }>;
  warnings: string[];
}

export class ConstitutionEngine {
  private rules: ConstitutionRule[] = [];
  private version = 1;

  loadRules(rules: ConstitutionRule[]): void {
    this.rules = [...rules];
    this.version++;
  }

  addRule(rule: ConstitutionRule): void {
    this.rules = this.rules.filter((r) => r.id !== rule.id);
    this.rules.push(rule);
    this.version++;
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.version++;
  }

  getVersion(): number { return this.version; }

  check(
    actuationName: string,
    params: Record<string, unknown>,
  ): ConstitutionCheckResult {
    const violations: ConstitutionCheckResult['violations'] = [];
    const warnings: string[] = [];

    for (const rule of this.rules) {
      const actual = this.getField(params, rule.field);
      const passes = this.evaluate(actual, rule.operator, rule.value);

      if (!passes) {
        const msg = rule.message ?? `Rule '${rule.name}' violated: ${rule.field} ${rule.operator} ${JSON.stringify(rule.value)}`;

        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          field: rule.field,
          actual,
          message: msg,
          errorCode: rule.errorCode ?? PmcpErrorCode.ConstitutionBlocked,
          blocking: rule.blocking,
        });

        if (!rule.blocking) {
          warnings.push(`[non-blocking] ${msg}`);
        }
      }
    }

    const blocked = violations.some((v) => v.blocking);
    return { allowed: !blocked, violations, warnings };
  }

  private getField(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  private evaluate(actual: unknown, op: ConstitutionOperator, expected: unknown): boolean {
    switch (op) {
      case 'lt': return Number(actual) < Number(expected);
      case 'lte': return Number(actual) <= Number(expected);
      case 'gt': return Number(actual) > Number(expected);
      case 'gte': return Number(actual) >= Number(expected);
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'in': return Array.isArray(expected) && expected.includes(actual);
      case 'nin': return Array.isArray(expected) && !expected.includes(actual);
      case 'exists': return actual !== undefined && actual !== null;
      case 'regex':
        return typeof actual === 'string' && new RegExp(String(expected)).test(actual);
    }
  }
}

// ============================================================================
// Audit Trail
// ============================================================================

export type AuditEventType =
  | 'actuation.started'
  | 'actuation.completed'
  | 'actuation.failed'
  | 'safety.blocked'
  | 'safety.estop'
  | 'lease.acquired'
  | 'lease.released'
  | 'shadow.blocked'
  | 'constitution.violation'
  | 'client.connected'
  | 'client.disconnected'
  | 'server.started'
  | 'server.stopped';

export interface AuditRecord {
  id: string;
  timestampMs: number;
  type: AuditEventType;
  robotId: string;
  sessionId?: string;
  clientDid?: string;
  actuation?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  violations?: string[];
  durationMs?: number;
  energyJ?: number;
}

export type AuditSink = (record: AuditRecord) => Promise<void> | void;

export class AuditTrail {
  private records: AuditRecord[] = [];
  private sinks: AuditSink[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;
  }

  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  async record(event: Omit<AuditRecord, 'id' | 'timestampMs'>): Promise<void> {
    const entry: AuditRecord = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestampMs: Date.now(),
      ...event,
    };
    this.records.push(entry);
    if (this.records.length > this.maxSize) this.records.shift();

    // Fan-out to sinks (non-blocking)
    for (const sink of this.sinks) {
      try {
        await Promise.resolve(sink(entry));
      } catch {
        // sink errors don't affect operation
      }
    }
  }

  query(options: {
    sinceMs?: number;
    untilMs?: number;
    type?: AuditEventType;
    robotId?: string;
    limit?: number;
  }): AuditRecord[] {
    let results = this.records;

    if (options.sinceMs) results = results.filter((r) => r.timestampMs >= options.sinceMs!);
    if (options.untilMs) results = results.filter((r) => r.timestampMs <= options.untilMs!);
    if (options.type) results = results.filter((r) => r.type === options.type);
    if (options.robotId) results = results.filter((r) => r.robotId === options.robotId);

    return results.slice(-(options.limit ?? 100));
  }

  clear(): void {
    this.records = [];
  }

  size(): number { return this.records.length; }
}

// ============================================================================
// Safety Monitor (composite)
// ============================================================================

export interface SafetyMonitorConfig {
  maxSpeedMs?: number;
  maxForceN?: number;
  maxTorqueNm?: number;
  maxEnergyCycleJ?: number;
  workspaceLimits?: {
    xMin?: number; xMax?: number;
    yMin?: number; yMax?: number;
    zMin?: number; zMax?: number;
  };
  humanProximityRadius?: number;
  enableShadow?: boolean;
  shadowServerUrl?: string;
}

export class SafetyMonitor {
  private readonly engine = new ConstitutionEngine();
  private readonly audit = new AuditTrail();
  private shadowClient?: ShadowPreviewClient;
  private estopEngaged = false;
  private energyCycle = 0;
  private energyCycleStart = Date.now();

  constructor(private readonly config: SafetyMonitorConfig = {}) {
    this._buildDefaultRules();
    if (config.enableShadow && config.shadowServerUrl) {
      this.shadowClient = new ShadowPreviewClient(config.shadowServerUrl);
    }
  }

  private _buildDefaultRules(): void {
    const { config } = this;

    if (config.maxSpeedMs) {
      this.engine.addRule({
        id: 'speed_limit',
        name: 'Speed Limit',
        field: 'speed_m_s',
        operator: 'lte',
        value: config.maxSpeedMs,
        errorCode: PmcpErrorCode.SpeedLimit,
        blocking: true,
        message: `Speed must be ≤ ${config.maxSpeedMs} m/s`,
      });
    }

    if (config.maxForceN) {
      this.engine.addRule({
        id: 'force_limit',
        name: 'Force Limit',
        field: 'force_n',
        operator: 'lte',
        value: config.maxForceN,
        errorCode: PmcpErrorCode.TorqueLimit,
        blocking: true,
        message: `Force must be ≤ ${config.maxForceN} N`,
      });
    }

    const ws = config.workspaceLimits;
    if (ws) {
      if (ws.xMin !== undefined) {
        this.engine.addRule({
          id: 'ws_x_min', name: 'Workspace X Min',
          field: 'target.x', operator: 'gte', value: ws.xMin,
          errorCode: PmcpErrorCode.WorkspaceViolation, blocking: true,
        });
      }
      if (ws.xMax !== undefined) {
        this.engine.addRule({
          id: 'ws_x_max', name: 'Workspace X Max',
          field: 'target.x', operator: 'lte', value: ws.xMax,
          errorCode: PmcpErrorCode.WorkspaceViolation, blocking: true,
        });
      }
      if (ws.zMin !== undefined) {
        this.engine.addRule({
          id: 'ws_z_min', name: 'Floor Guard',
          field: 'target.z', operator: 'gte', value: ws.zMin,
          errorCode: PmcpErrorCode.FloorGuard, blocking: true,
        });
      }
    }
  }

  async check(
    actuationName: string,
    params: Record<string, unknown>,
    robotId: string,
  ): Promise<{ allowed: boolean; violations: string[]; errorCode?: PmcpErrorCode }> {
    // E-stop takes priority
    if (this.estopEngaged) {
      await this.audit.record({
        type: 'safety.estop', robotId, actuation: actuationName,
        violations: ['Emergency stop active'],
      });
      return {
        allowed: false,
        violations: ['Emergency stop is engaged'],
        errorCode: PmcpErrorCode.EstopActive,
      };
    }

    // Constitution check
    const constitutionResult = this.engine.check(actuationName, params);
    if (!constitutionResult.allowed) {
      const firstBlocking = constitutionResult.violations.find((v) => v.blocking);
      await this.audit.record({
        type: 'constitution.violation',
        robotId,
        actuation: actuationName,
        violations: constitutionResult.violations.map((v) => v.message),
      });
      return {
        allowed: false,
        violations: constitutionResult.violations.map((v) => v.message),
        errorCode: firstBlocking?.errorCode ?? PmcpErrorCode.ConstitutionBlocked,
      };
    }

    return { allowed: true, violations: [] };
  }

  engageEstop(robotId: string): void {
    this.estopEngaged = true;
    this.audit.record({ type: 'safety.estop', robotId });
  }

  disengageEstop(robotId: string): void {
    this.estopEngaged = false;
    this.audit.record({ type: 'safety.estop', robotId, result: 'disengaged' });
  }

  getEngine(): ConstitutionEngine { return this.engine; }
  getAudit(): AuditTrail { return this.audit; }
}
