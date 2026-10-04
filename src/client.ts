/**
 * P-MCP Client
 * ============
 * Client implementation for connecting to P-MCP servers
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
  ShadowPreview,
  RobotIdentity,
  Capabilities,
  SafetyConstitution,
  PmcpError,
  PmcpErrorCode,
} from './types';

export type TransportType = 'stdio' | 'websocket' | 'http';

export interface ClientOptions {
  transport: TransportType;
  serverCommand?: string[];
  serverUrl?: string;
  clientInfo?: { name: string; version: string };
}

/**
 * P-MCP Client
 * 
 * Connect to a P-MCP server using stdio, WebSocket, or HTTP transport.
 * 
 * @example
 * ```typescript
 * import { PMCPServerClient } from 'physicalcontextprotocol';
 * 
 * const client = new PMCPServerClient({
 *   transport: 'stdio',
 *   serverCommand: ['python', 'arm_server.py'],
 * });
 * 
 * await client.connect();
 * const tools = await client.listTools();
 * const result = await client.callTool('move_to', { x: 0, y: 0, z: 0.5 });
 * await client.disconnect();
 * ```
 */
export class PMCPServerClient {
  private transport: TransportType;
  private serverCommand?: string[];
  private serverUrl?: string;
  private clientInfo: { name: string; version: string };
  
  private process?: import('child_process').ChildProcessWithoutNullStreams;
  private ws?: import('ws').WebSocket;
  private requestId = 0;
  private initialized = false;
  private capabilities?: Capabilities;

  constructor(options: ClientOptions) {
    this.transport = options.transport;
    this.serverCommand = options.serverCommand;
    this.serverUrl = options.serverUrl;
    this.clientInfo = options.clientInfo || { name: 'pmcp-typescript-client', version: '1.0.0' };
  }

  /**
   * Connect to the P-MCP server
   */
  async connect(): Promise<void> {
    switch (this.transport) {
      case 'stdio':
        await this.connectStdio();
        break;
      case 'websocket':
        await this.connectWebSocket();
        break;
      case 'http':
        // HTTP is connectionless, just validate URL
        if (!this.serverUrl) {
          throw new Error('serverUrl is required for HTTP transport');
        }
        break;
    }

    // Initialize the connection
    await this.initialize();
  }

  /**
   * Disconnect from the P-MCP server
   */
  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.initialized = false;
  }

  /**
   * Initialize the connection with the server
   */
  private async initialize(): Promise<InitializeResult> {
    const result = await this.sendRequest<InitializeResult>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: this.clientInfo,
    });

    this.initialized = true;
    this.capabilities = result.capabilities as Capabilities;
    return result;
  }

  /**
   * Connect via stdio (spawns server process)
   */
  private async connectStdio(): Promise<void> {
    if (!this.serverCommand || this.serverCommand.length === 0) {
      throw new Error('serverCommand is required for stdio transport');
    }

    const { spawn } = await import('child_process');
    const [command, ...args] = this.serverCommand;

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to start
    await new Promise<void>((resolve) => {
      this.process!.stdout.once('data', () => resolve());
      setTimeout(resolve, 1000);
    });
  }

  /**
   * Connect via WebSocket
   */
  private async connectWebSocket(): Promise<void> {
    if (!this.serverUrl) {
      throw new Error('serverUrl is required for WebSocket transport');
    }

    return new Promise((resolve, reject) => {
      const WebSocket = require('ws');
      this.ws = new WebSocket(this.serverUrl!);

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = String(++this.requestId);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params: params || {},
      id,
    };

    let response: JsonRpcResponse;

    if (this.transport === 'stdio' && this.process) {
      response = await this.sendRequestStdio(request);
    } else if (this.transport === 'websocket' && this.ws) {
      response = await this.sendRequestWebSocket(request);
    } else if (this.transport === 'http' && this.serverUrl) {
      response = await this.sendRequestHttp(request);
    } else {
      throw new Error('Not connected to server');
    }

    if (response.error) {
      throw new Error(`RPC Error ${response.error.code}: ${response.error.message}`);
    }

    return response.result as T;
  }

  /**
   * Send request via stdio
   */
  private async sendRequestStdio(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(request) + '\n';
      this.process!.stdin.write(data);

      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, 10000);

      const handler = (chunk: Buffer) => {
        try {
          const response = JSON.parse(chunk.toString());
          clearTimeout(timeout);
          this.process!.stdout.off('data', handler);
          resolve(response);
        } catch {
          // Continue waiting for more data
        }
      };

      this.process!.stdout.on('data', handler);
    });
  }

  /**
   * Send request via WebSocket
   */
  private async sendRequestWebSocket(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = request.id;

      const handler = (data: import('ws').Data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === id) {
            this.ws!.off('message', handler);
            resolve(response);
          }
        } catch (err) {
          reject(err);
        }
      };

      this.ws!.on('message', handler);
      this.ws!.send(JSON.stringify(request));

      setTimeout(() => {
        this.ws!.off('message', handler);
        reject(new Error('Request timeout'));
      }, 10000);
    });
  }

  /**
   * Send request via HTTP
   */
  private async sendRequestHttp(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(`${this.serverUrl}/pmcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    return response.json();
  }

  // =============================================================================
  // MCP Standard Methods
  // =============================================================================

  /**
   * Ping the server
   */
  async ping(): Promise<{ pong: boolean; ts: number; robot_id: string }> {
    return this.sendRequest('ping');
  }

  /**
   * List available tools (actuations)
   */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest<{ tools: MCPTool[] }>('tools/list');
    return result.tools;
  }

  /**
   * Call a tool (actuation)
   */
  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    options?: { lease_token?: string; zone_id?: string }
  ): Promise<{ content: unknown[]; isError?: boolean; _shadow?: ShadowPreview }> {
    return this.sendRequest('tools/call', {
      name,
      arguments: arguments_,
      ...options,
    });
  }

  /**
   * List available resources (sensors)
   */
  async listResources(): Promise<MCPResource[]> {
    const result = await this.sendRequest<{ resources: MCPResource[] }>('resources/list');
    return result.resources;
  }

  /**
   * Read a resource (sensor value)
   */
  async readResource(uri: string): Promise<{ contents: unknown[] }> {
    return this.sendRequest('resources/read', { uri });
  }

  /**
   * List available prompts (missions)
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    const result = await this.sendRequest<{ prompts: MCPPrompt[] }>('prompts/list');
    return result.prompts;
  }

  /**
   * Get a prompt (mission template)
   */
  async getPrompt(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest('prompts/get', { name, arguments: arguments_ });
  }

  // =============================================================================
  // P-MCP Extension Methods
  // =============================================================================

  /**
   * Get server status
   */
  async getStatus(): Promise<ServerStatus> {
    return this.sendRequest('pmcp/status');
  }

  /**
   * Get robot identity
   */
  async getIdentity(): Promise<RobotIdentity> {
    return this.sendRequest('pmcp/identity');
  }

  /**
   * Get safety constitution
   */
  async getConstitution(): Promise<SafetyConstitution> {
    return this.sendRequest('pmcp/constitution');
  }

  /**
   * Request a lease for a zone
   */
  async requestLease(
    robotId: string,
    zoneId: string,
    durationMs?: number,
    bidEnergyJ?: number
  ): Promise<LeaseGrant> {
    const result = await this.sendRequest<{ lease: LeaseGrant }>('lease/request', {
      robotId,
      zoneId,
      durationMs: durationMs || 10000,
      bidEnergyJ: bidEnergyJ || 100.0,
    });
    return result.lease;
  }

  /**
   * Release a lease
   */
  async releaseLease(leaseId: string): Promise<boolean> {
    const result = await this.sendRequest<{ released: boolean }>('lease/release', {
      leaseId,
    });
    return result.released;
  }

  /**
   * Activate/deactivate emergency stop
   */
  async setEstop(active: boolean): Promise<{ estop: boolean; ts: number }> {
    return this.sendRequest('pmcp/estop', { active });
  }

  /**
   * Run shadow preview (simulation without execution)
   */
  async shadowPreview(
    name: string,
    arguments_: Record<string, unknown>
  ): Promise<{ preview: ShadowPreview }> {
    return this.sendRequest('shadow/preview', { name, arguments: arguments_ });
  }

  // =============================================================================
  // Utility Methods
  // =============================================================================

  /**
   * Check if client is connected and initialized
   */
  isConnected(): boolean {
    return this.initialized;
  }

  /**
   * Get server capabilities
   */
  getCapabilities(): Capabilities | undefined {
    return this.capabilities;
  }
}

/**
 * Factory function to create a P-MCP client
 */
export function createClient(options: ClientOptions): PMCPServerClient {
  return new PMCPServerClient(options);
}

/**
 * Convenience function to create a stdio client
 */
export function createStdioClient(serverCommand: string[]): PMCPServerClient {
  return new PMCPServerClient({
    transport: 'stdio',
    serverCommand,
  });
}

/**
 * Convenience function to create an HTTP client
 */
export function createHttpClient(serverUrl: string): PMCPServerClient {
  return new PMCPServerClient({
    transport: 'http',
    serverUrl,
  });
}

/**
 * Convenience function to create a WebSocket client
 */
export function createWebSocketClient(serverUrl: string): PMCPServerClient {
  return new PMCPServerClient({
    transport: 'websocket',
    serverUrl,
  });
}