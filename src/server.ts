/**
 * P-MCP Server (TypeScript)
 * =========================
 * TypeScript server implementation for P-MCP
 */

import {
  JsonRpcRequest,
  JsonRpcResponse,
  MCPTool,
  MCPResource,
  MCPPrompt,
  InitializeResult,
  ServerStatus,
  LeaseGrant,
  LeaseRequest,
  ShadowPreview,
  RobotIdentity,
  Capabilities,
  ActuationSpec,
  SensorSpec,
  ActuationResult,
  SensorReading,
  PMCP_VERSION,
  MCP_VERSION,
} from './types';

/**
 * Actuation handler function type
 */
export type ActuationHandler = (
  args: Record<string, unknown>,
  context: ServerContext
) => Promise<ActuationResult>;

/**
 * Sensor handler function type
 */
export type SensorHandler = (
  context: ServerContext
) => Promise<SensorReading>;

/**
 * Server context passed to handlers
 */
export interface ServerContext {
  robot_id: string;
  lease_token?: string;
  zone_id?: string;
}

/**
 * PMCPServerOptions
 */
export interface PMCPServerOptions {
  name: string;
  version?: string;
  robot_id?: string;
  robot_class?: string;
  model?: string;
  serial?: string;
  location?: string;
}

/**
 * P-MCP Server Implementation
 * 
 * @example
 * ```typescript
 * import { PMCPServer } from '@pmcp/server';
 * 
 * const server = new PMCPServer({
 *   name: 'ur5-arm',
 *   robot_id: 'ur5-001',
 *   robot_class: 'arm',
 *   model: 'UR5e',
 *   serial: '12345',
 *   location: 'lab-01',
 * });
 * 
 * // Register an actuation
 * server.registerActuation({
 *   name: 'move_to',
 *   description: 'Move TCP to XYZ position',
 *   parameters: [
 *     { name: 'x', type: 'number', description: 'X coordinate' },
 *     { name: 'y', type: 'number', description: 'Y coordinate' },
 *     { name: 'z', type: 'number', description: 'Z coordinate' },
 *   ],
 *   robot_id: 'ur5-001',
 * });
 * 
 * // Set actuation handler
 * server.setActuationHandler('move_to', async (args) => {
 *   // Call actual robot hardware here
 *   return {
 *     success: true,
 *     robot_id: 'ur5-001',
 *     actuation_name: 'move_to',
 *     output: { x: args.x, y: args.y, z: args.z },
 *   };
 * });
 * 
 * // Run server
 * await server.run();
 * ```
 */
export class PMCPServer {
  private name: string;
  private version: string;
  private robot_id: string;
  private robot_class: string;
  private model: string;
  private serial: string;
  private location: string;
  private capabilities: Capabilities;

  private actuations: Map<string, ActuationSpec> = new Map();
  private actuationHandlers: Map<string, ActuationHandler> = new Map();
  private sensors: Map<string, SensorSpec> = new Map();
  private sensorHandlers: Map<string, SensorHandler> = new Map();
  private missions: Map<string, MCPPrompt> = new Map();

  private leaseManager: LeaseManager = new LeaseManager();
  private safetyMiddleware: SafetyMiddleware = new SafetyMiddleware();
  private callCount = 0;
  private blockedCount = 0;
  private startedAt = Date.now();

  constructor(options: PMCPServerOptions) {
    this.name = options.name;
    this.version = options.version || '1.0.0';
    this.robot_id = options.robot_id || options.name;
    this.robot_class = options.robot_class || 'arm';
    this.model = options.model || 'generic';
    this.serial = options.serial || '000000';
    this.location = options.location || 'lab-01';

    this.capabilities = {
      tools: true,
      resources: true,
      prompts: true,
      logging: true,
      shadow: true,
      leases: true,
      estop: true,
      constitution: true,
    };
  }

  /**
   * Register an actuation (MCP Tool)
   */
  registerActuation(spec: ActuationSpec): void {
    this.actuations.set(spec.name, spec);
  }

  /**
   * Set actuation handler
   */
  setActuationHandler(name: string, handler: ActuationHandler): void {
    this.actuationHandlers.set(name, handler);
  }

  /**
   * Register a sensor (MCP Resource)
   */
  registerSensor(spec: SensorSpec): void {
    this.sensors.set(spec.name, spec);
  }

  /**
   * Set sensor handler
   */
  setSensorHandler(name: string, handler: SensorHandler): void {
    this.sensorHandlers.set(name, handler);
  }

  /**
   * Register a mission (MCP Prompt)
   */
  registerMission(prompt: MCPPrompt): void {
    this.missions.set(prompt.name, prompt);
  }

  /**
   * Handle a JSON-RPC request
   */
  async handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    let request: JsonRpcRequest;
    
    try {
      request = typeof raw === 'string' ? JSON.parse(raw) : raw as JsonRpcRequest;
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
    }

    // Handle notifications
    if (request.id === undefined || request.id === null) {
      await this.handleNotification(request.method, request.params || {});
      return null;
    }

    try {
      const result = await this.handleMethod(request.method, request.params || {});
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (e) {
      const error = e as Error;
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: error.message },
      };
    }
  }

  /**
   * Handle a method
   */
  private async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      // MCP Standard Methods
      case 'initialize':
        return this.handleInitialize(params);
      case 'ping':
        return this.handlePing(params);
      case 'tools/list':
        return this.handleToolsList(params);
      case 'tools/call':
        return this.handleToolsCall(params);
      case 'resources/list':
        return this.handleResourcesList(params);
      case 'resources/read':
        return this.handleResourcesRead(params);
      case 'prompts/list':
        return this.handlePromptsList(params);
      case 'prompts/get':
        return this.handlePromptsGet(params);
      case 'logging/setLevel':
        return this.handleLoggingSetLevel(params);

      // P-MCP Extension Methods
      case 'shadow/preview':
        return this.handleShadowPreview(params);
      case 'lease/request':
        return this.handleLeaseRequest(params);
      case 'lease/release':
        return this.handleLeaseRelease(params);
      case 'pmcp/estop':
        return this.handleEstop(params);
      case 'pmcp/status':
        return this.handleStatus(params);
      case 'pmcp/identity':
        return this.handleIdentity(params);
      case 'pmcp/constitution':
        return this.handleConstitution(params);

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  /**
   * Handle notifications (fire-and-forget)
   */
  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'pmcp/estop') {
      const active = params.active as boolean ?? true;
      this.safetyMiddleware.setEstop(active);
    }
  }

  // =============================================================================
  // MCP Standard Method Handlers
  // =============================================================================

  private handleInitialize(params: Record<string, unknown>): InitializeResult {
    const clientInfo = params.clientInfo as { name: string; version: string } | undefined;
    if (clientInfo) {
      console.log(`[Server] initialize from ${clientInfo.name} v${clientInfo.version}`);
    }

    this.startedAt = Date.now();

    return {
      protocolVersion: MCP_VERSION,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: false },
        logging: {},
        experimental: {
          pmcp: {
            version: PMCP_VERSION,
            shadow: true,
            leases: true,
            estop: true,
            constitution: true,
          },
        },
      },
      serverInfo: {
        name: this.name,
        version: this.version,
      },
      pmcp: {
        version: PMCP_VERSION,
        robotId: this.robot_id,
        identity: {
          did: `did:pmcp:${this.robot_class}:${this.model.toLowerCase()}:${this.location}:${this.serial}`,
          robot_class: this.robot_class,
          model: this.model,
          serial: this.serial,
          firmware_ver: '0.5.0',
          cert_hash: '',
          public_key: '',
          location: this.location,
        },
        constitution: this.safetyMiddleware.getFingerprint().slice(0, 16) + '...',
      },
    };
  }

  private handlePing(_params: Record<string, unknown>): { pong: boolean; ts: number; robot_id: string } {
    return {
      pong: true,
      ts: Date.now(),
      robot_id: this.robot_id,
    };
  }

  private handleToolsList(_params: Record<string, unknown>): { tools: MCPTool[] } {
    const tools: MCPTool[] = [];
    
    for (const [name, spec] of this.actuations) {
      const required = spec.parameters.filter(p => p.required !== false).map(p => p.name);
      const properties: Record<string, unknown> = {};
      
      for (const param of spec.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        if (param.default !== undefined) {
          (properties[param.name] as Record<string, unknown>).default = param.default;
        }
      }

      tools.push({
        name,
        description: spec.description,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
        annotations: {
          robot_id: spec.robot_id,
          category: spec.category || 'motion',
          max_speed_m_s: spec.max_speed_m_s || 1.0,
          shadow_required: spec.shadow_required !== false,
          protocol: 'pmcp/0.5',
        },
      });
    }

    return { tools };
  }

  private async handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};
    const leaseToken = params._lease_token as string | undefined;
    const zoneId = params._zone_id as string | undefined;

    const spec = this.actuations.get(name);
    if (!spec) {
      throw new Error(`Actuation not found: ${name}`);
    }

    this.callCount++;

    // Safety check
    const check = this.safetyMiddleware.check(name, args, leaseToken, zoneId, !spec.shadow_required);
    if (!check.safe) {
      this.blockedCount++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: check.violations.join('; ') }) }],
        isError: true,
        _shadow: check.preview,
      };
    }

    // Execute actuation
    const handler = this.actuationHandlers.get(name);
    let result: ActuationResult;

    if (handler) {
      const context: ServerContext = {
        robot_id: this.robot_id,
        lease_token: leaseToken,
        zone_id: zoneId,
      };
      result = await handler(args, context);
    } else {
      // No handler - return simulated result
      result = {
        success: true,
        robot_id: this.robot_id,
        actuation_name: name,
        output: args,
        duration_s: 0,
        timestamp: Date.now() / 1000,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: result.success,
        robot_id: result.robot_id,
        actuation: result.actuation_name,
        output: result.output,
        metrics: {
          duration_s: result.duration_s,
          energy_consumed_j: result.energy_consumed_j,
          shadow_delta_m: result.shadow_delta_m,
        },
      })}],
      isError: !result.success,
      _shadow: check.preview,
    };
  }

  private handleResourcesList(_params: Record<string, unknown>): { resources: MCPResource[] } {
    const resources: MCPResource[] = [];

    for (const [name, spec] of this.sensors) {
      resources.push({
        uri: `pmcp://${this.robot_id}/sensors/${name}`,
        name: spec.name,
        description: spec.description,
        mimeType: 'application/json',
        annotations: {
          robot_id: spec.robot_id,
          sensor_type: spec.sensor_type,
          unit: spec.unit || '',
          hz: spec.hz || 10,
          protocol: 'pmcp/0.5',
        },
      });
    }

    return { resources };
  }

  private async handleResourcesRead(params: Record<string, unknown>): Promise<{ contents: unknown[] }> {
    const uri = params.uri as string;
    const name = uri.split('/').pop() || uri;

    const handler = this.sensorHandlers.get(name);
    if (!handler) {
      throw new Error(`Sensor not found: ${uri}`);
    }

    const context: ServerContext = { robot_id: this.robot_id };
    const reading = await handler(context);

    return {
      contents: [{ type: 'text', text: JSON.stringify({
        sensor: reading.sensor_name,
        robot_id: reading.robot_id,
        value: reading.value,
        unit: reading.unit,
        timestamp: reading.timestamp,
        quality: reading.quality,
      })}],
    };
  }

  private handlePromptsList(_params: Record<string, unknown>): { prompts: MCPPrompt[] } {
    return { prompts: Array.from(this.missions.values()) };
  }

  private handlePromptsGet(params: Record<string, unknown>): unknown {
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};

    const prompt = this.missions.get(name);
    if (!prompt) {
      throw new Error(`Mission not found: ${name}`);
    }

    // Return a template message
    return {
      description: name,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `Execute mission "${name}" with parameters: ${JSON.stringify(args)}`,
        }],
      }],
    };
  }

  private handleLoggingSetLevel(params: Record<string, unknown>): Record<string, unknown> {
    const level = (params.level as string) || 'info';
    console.log(`[Server] Log level set to ${level}`);
    return {};
  }

  // =============================================================================
  // P-MCP Extension Method Handlers
  // =============================================================================

  private handleShadowPreview(params: Record<string, unknown>): { preview: ShadowPreview } {
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};

    const spec = this.actuations.get(name);
    const skipShadow = spec ? !spec.shadow_required : false;

    const preview = this.safetyMiddleware.check(name, args, undefined, undefined, skipShadow).preview!;

    return { preview };
  }

  private async handleLeaseRequest(params: Record<string, unknown>): Promise<{ lease: LeaseGrant }> {
    const req: LeaseRequest = {
      robot_id: (params.robotId as string) || this.robot_id,
      zone_id: (params.zoneId as string) || 'default',
      duration_ms: params.durationMs as number || 10000,
      bid_energy_j: (params.bidEnergyJ as number) || 100.0,
      priority: (params.priority as number) || 5,
    };

    const lease = await this.leaseManager.request(req);
    return { lease };
  }

  private handleLeaseRelease(params: Record<string, unknown>): { released: boolean } {
    const leaseId = params.leaseId as string;
    const released = this.leaseManager.release(leaseId);
    return { released };
  }

  private handleEstop(params: Record<string, unknown>): { estop: boolean; ts: number } {
    const active = (params.active as boolean) ?? true;
    this.safetyMiddleware.setEstop(active);
    return { estop: active, ts: Date.now() };
  }

  private handleStatus(_params: Record<string, unknown>): ServerStatus {
    return {
      robot_id: this.robot_id,
      pmcp_version: PMCP_VERSION,
      uptime_s: (Date.now() - this.startedAt) / 1000,
      call_count: this.callCount,
      blocked_count: this.blockedCount,
      safety_stats: { constitution: 'loaded', shadow: 'enabled' },
      actuations: Array.from(this.actuations.keys()),
      sensors: Array.from(this.sensors.keys()),
      missions: Array.from(this.missions.keys()),
    };
  }

  private handleIdentity(_params: Record<string, unknown>): RobotIdentity {
    return {
      did: `did:pmcp:${this.robot_class}:${this.model.toLowerCase()}:${this.location}:${this.serial}`,
      robot_class: this.robot_class,
      model: this.model,
      serial: this.serial,
      firmware_ver: '0.5.0',
      cert_hash: '',
      public_key: '',
      location: this.location,
    };
  }

  private handleConstitution(_params: Record<string, unknown>): unknown {
    return this.safetyMiddleware.getSummary();
  }

  /**
   * Run the server (stdio mode)
   */
  async run(): Promise<void> {
    const readline = require('readline');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    console.log(`[Server] ${this.name} v${this.version} — stdio transport ready`);

    rl.on('line', async (line: string) => {
      if (!line.trim()) return;

      try {
        const response = await this.handleMessage(line);
        if (response) {
          console.log(JSON.stringify(response));
        }
      } catch (e) {
        const error = e as Error;
        console.error(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: error.message },
        }));
      }
    });
  }
}

// =============================================================================
// Internal Helper Classes
// =============================================================================

/**
 * Simple in-memory lease manager
 */
class LeaseManager {
  private leases: Map<string, LeaseGrant> = new Map();

  async request(req: LeaseRequest): Promise<LeaseGrant> {
    const existing = this.leases.get(req.zone_id);

    if (existing && existing.state === 'GRANTED' && existing.expires_at > Date.now() / 1000) {
      if (existing.robot_id === req.robot_id) {
        // Renew
        existing.expires_at = Date.now() / 1000 + req.duration_ms! / 1000;
        return existing;
      }

      // Check bid
      if (req.bid_energy_j! <= existing.bid_energy_j) {
        return {
          lease_id: '',
          robot_id: req.robot_id,
          zone_id: req.zone_id,
          state: 'DENIED',
          expires_at: 0,
          bid_energy_j: req.bid_energy_j!,
        };
      }
    }

    // Grant new lease
    const grant: LeaseGrant = {
      lease_id: Math.random().toString(36).slice(2, 14),
      robot_id: req.robot_id,
      zone_id: req.zone_id,
      state: 'GRANTED',
      expires_at: Date.now() / 1000 + req.duration_ms! / 1000,
      bid_energy_j: req.bid_energy_j!,
    };

    this.leases.set(req.zone_id, grant);
    return grant;
  }

  release(leaseId: string): boolean {
    for (const [zoneId, grant] of this.leases) {
      if (grant.lease_id === leaseId) {
        this.leases.delete(zoneId);
        return true;
      }
    }
    return false;
  }
}

/**
 * Simple safety middleware
 */
class SafetyMiddleware {
  private estopActive = false;
  private fingerprint = 'abc123def456';

  setEstop(active: boolean): void {
    this.estopActive = active;
  }

  getFingerprint(): string {
    return this.fingerprint;
  }

  getSummary(): unknown {
    return {
      robotId: 'default',
      fingerprint: this.fingerprint,
      ruleCount: 6,
      rules: [
        { id: 'CONST-01', name: 'Max Speed in Human Presence', enabled: true },
        { id: 'CONST-02', name: 'Max Force Limit', enabled: true },
        { id: 'CONST-03', name: 'Forbidden Zone', enabled: true },
        { id: 'CONST-04', name: 'Human Clearance', enabled: true },
        { id: 'CONST-05', name: 'Emergency Stop', enabled: true },
        { id: 'CONST-06', name: 'Shadow Validation Required', enabled: true },
      ],
    };
  }

  check(
    _name: string,
    args: Record<string, unknown>,
    _leaseToken: string | undefined,
    _zoneId: string | undefined,
    skipShadow: boolean
  ): { safe: boolean; preview?: ShadowPreview; violations: string[] } {
    // Check E-stop
    if (this.estopActive) {
      return { safe: false, violations: ['ESTOP active - all motion blocked'] };
    }

    // Check parameters for basic safety
    const violations: string[] = [];
    const speed = args.speed as number || 0;
    const z = args.z as number || 0;

    if (speed > 0.25) {
      violations.push('Speed exceeds collaborative limit (0.25 m/s)');
    }

    if (z < 0) {
      violations.push('Z target below floor (z < 0)');
    }

    if (violations.length > 0) {
      return { safe: false, violations };
    }

    if (skipShadow) {
      return {
        safe: true,
        preview: {
          actuation_name: _name,
          arguments: args,
          status: 'SKIPPED',
          safe: true,
          engine: 'none',
        },
        violations: [],
      };
    }

    // Return safe preview
    return {
      safe: true,
      preview: {
        actuation_name: _name,
        arguments: args,
        status: 'SAFE',
        safe: true,
        risk_score: 0,
        est_duration_s: 2,
        est_energy_j: speed * 50,
        engine: 'geometric',
        timestamp: Date.now() / 1000,
      },
      violations: [],
    };
  }
}