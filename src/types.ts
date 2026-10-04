/**
 * P-MCP Types
 * ===========
 * TypeScript type definitions for P-MCP v0.5
 */

// Protocol Constants
export const PMCP_VERSION = "0.5";
export const MCP_VERSION = "2024-11-05";
export const JSONRPC_VERSION = "2.0";

// ============================================================================
// Error Codes
// ============================================================================

export enum PmcpErrorCode {
  // JSON-RPC 2.0 standard
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // P-MCP Physical Safety
  ShadowBlocked = -33001,
  ConstitutionBlocked = -33002,
  LeaseRequired = -33003,
  LeaseExpired = -33004,
  EstopActive = -33005,
  FloorGuard = -33006,
  SpeedLimit = -33007,
  EnergyBudget = -33008,
  HumanProximity = -33009,
  ZkProofInvalid = -33010,
  JointLimit = -33011,
  TorqueLimit = -33012,
  WorkspaceViolation = -33013,
  CollisionDetected = -33014,
  RobotFault = -33015,
}

export interface PmcpError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: PmcpError;
  id?: string | number | null;
}

// ============================================================================
// Robot Identity (W3C DID-based)
// ============================================================================

export interface RobotIdentity {
  did: string;
  robot_class: string;
  model: string;
  serial: string;
  firmware_ver: string;
  cert_hash: string;
  public_key: string;
  location: string;
}

// ============================================================================
// Actuation Types (MCP Tool equivalent)
// ============================================================================

export interface ActuationParameter {
  name: string;
  type: 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  unit?: string;
}

export interface ActuationSpec {
  name: string;
  description: string;
  parameters: ActuationParameter[];
  robot_id: string;
  category?: string;
  max_speed_m_s?: number;
  max_force_n?: number;
  max_energy_j?: number;
  est_duration_s?: number;
  requires_lease?: boolean;
  shadow_required?: boolean;
  iso_class?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
}

export interface ActuationResult {
  success: boolean;
  robot_id: string;
  actuation_name: string;
  output: Record<string, unknown>;
  error_message?: string;
  duration_s?: number;
  energy_consumed_j?: number;
  final_pose?: Record<string, unknown>;
  shadow_delta_m?: number;
  timestamp?: number;
}

// ============================================================================
// Sensor Types (MCP Resource equivalent)
// ============================================================================

export type SensorType =
  | 'joint_states'
  | 'end_effector'
  | 'force_torque'
  | 'camera_rgb'
  | 'camera_depth'
  | 'lidar'
  | 'imu'
  | 'battery'
  | 'temperature'
  | 'proximity'
  | 'gps'
  | 'odometry'
  | 'plant_health'
  | 'energy_meter'
  | 'custom';

export interface SensorSpec {
  name: string;
  description: string;
  robot_id: string;
  sensor_type: SensorType;
  unit?: string;
  hz?: number;
  is_stream?: boolean;
}

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  annotations?: Record<string, unknown>;
}

export interface SensorReading {
  sensor_name: string;
  robot_id: string;
  value: unknown;
  unit?: string;
  timestamp?: number;
  quality?: number;
}

// ============================================================================
// Mission Types (MCP Prompt equivalent)
// ============================================================================

export interface MissionArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments: MissionArgument[];
}

// ============================================================================
// Lease System
// ============================================================================

export type LeaseState = 'GRANTED' | 'DENIED' | 'EXPIRED' | 'RELEASED';

export interface LeaseRequest {
  robot_id: string;
  zone_id: string;
  duration_ms?: number;
  bid_energy_j?: number;
  priority?: number;
}

export interface LeaseGrant {
  lease_id: string;
  robot_id: string;
  zone_id: string;
  state: LeaseState;
  expires_at: number;
  remaining_ms?: number;
  /** Energy bid in joules that won this zone. Carried on the grant so a
   *  competing bid can be compared against the incumbent without a lookup. */
  bid_energy_j?: number;
}

/** Per-robot outcome of a batched actuation request. */
export interface BatchActuationResult {
  batch_id: string;
  results: Record<string, ActuationResult>;
  succeeded: number;
  failed: number;
  energy_consumed_j: number;
  duration_s?: number;
}

/** Server metrics as reported by `pmcp/metrics`. */
export interface MetricsSnapshot {
  uptime_s: number;
  requests_total: number;
  errors_total: number;
  active_leases: number;
  connected_robots: number;
  energy_budget_j?: number;
  energy_consumed_j?: number;
}

// ============================================================================
// Shadow Preview
// ============================================================================

export type ShadowStatus =
  | 'SAFE'
  | 'COLLISION'
  | 'JOINT_LIMIT'
  | 'WORKSPACE_VIOLATION'
  | 'SPEED_EXCEEDED'
  | 'ENERGY_EXCEEDED'
  | 'SIMULATED'
  | 'SKIPPED';

export interface ShadowPreview {
  actuation_name: string;
  arguments: Record<string, unknown>;
  status: ShadowStatus;
  safe: boolean;
  risk_score?: number;
  est_duration_s?: number;
  est_energy_j?: number;
  collision_body?: string;
  warnings?: string[];
  engine?: string;
  timestamp?: number;
}

// ============================================================================
// Capabilities
// ============================================================================

export interface Capabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
  sampling?: boolean;
  shadow?: boolean;
  leases?: boolean;
  estop?: boolean;
  constitution?: boolean;
  streaming?: boolean;
}

export interface MCPCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

// ============================================================================
// Initialize Response
// ============================================================================

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ClientInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: MCPCapabilities;
  serverInfo: ServerInfo;
  pmcp: {
    version: string;
    robotId: string;
    identity: RobotIdentity;
    constitution: string;
  };
}

// ============================================================================
// Server Status
// ============================================================================

export interface ServerStatus {
  robot_id: string;
  pmcp_version: string;
  uptime_s: number;
  call_count: number;
  blocked_count: number;
  safety_stats?: Record<string, unknown>;
  actuations: string[];
  sensors: string[];
  missions: string[];
}

// ============================================================================
// Safety Constitution
// ============================================================================

export interface SafetyRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface SafetyConstitution {
  robotId: string;
  fingerprint: string;
  ruleCount: number;
  rules: SafetyRule[];
}