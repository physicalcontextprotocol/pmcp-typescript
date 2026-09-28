/**
 * P-MCP Utilities
 * ===============
 * Utility functions for P-MCP client and server
 */

import { PMCP_VERSION } from './types';

/**
 * Generate a unique ID
 */
export function generateId(prefix = ''): string {
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return prefix ? `${prefix}-${uuid}` : uuid;
}

/**
 * Deep merge objects
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
        result[key] = deepMerge(result[key] as Record<string, unknown> || {}, source[key] as Record<string, unknown>) as T[Extract<keyof T, string>];
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }
  return result;
}

/**
 * Validate JSON-RPC request
 */
export function validateJsonRpcRequest(obj: unknown): { valid: boolean; error?: string } {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, error: 'Request must be an object' };
  }
  
  const req = obj as Record<string, unknown>;
  
  if (typeof req.jsonrpc !== 'string' || req.jsonrpc !== '2.0') {
    return { valid: false, error: 'Invalid jsonrpc version' };
  }
  
  if (typeof req.method !== 'string') {
    return { valid: false, error: 'Missing or invalid method' };
  }
  
  if (req.params !== undefined && (typeof req.params !== 'object' || Array.isArray(req.params))) {
    return { valid: false, error: 'Params must be an object if provided' };
  }
  
  if (req.id !== undefined && 
      typeof req.id !== 'string' && 
      typeof req.id !== 'number' && 
      req.id !== null) {
    return { valid: false, error: 'Invalid id type' };
  }
  
  return { valid: true };
}

/**
 * Parse query string
 */
export function parseQueryString(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(query);
  searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

/**
 * Build query string
 */
export function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  return searchParams.toString();
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    onRetry,
  } = options;
  
  let lastError: Error;
  let delay = initialDelay;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxAttempts) {
        if (onRetry) {
          onRetry(lastError, attempt);
        }
        await sleep(delay);
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }
  }
  
  throw lastError!;
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;
  
  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Buffer for collecting data
 */
export class DataBuffer {
  private buffer: Buffer;
  private offset = 0;
  
  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }
  
  write(data: Buffer): number {
    const written = Math.min(data.length, this.buffer.length - this.offset);
    data.copy(this.buffer, this.offset, 0, written);
    this.offset += written;
    return written;
  }
  
  read(length: number): Buffer | null {
    if (this.offset < length) {
      return null;
    }
    const data = this.buffer.slice(0, length);
    this.buffer.copyWithin(0, length, this.offset);
    this.offset -= length;
    return data;
  }
  
  peek(length: number): Buffer | null {
    if (this.offset < length) {
      return null;
    }
    return this.buffer.slice(0, length);
  }
  
  clear(): void {
    this.offset = 0;
  }
  
  get length(): number {
    return this.offset;
  }
  
  get isFull(): boolean {
    return this.offset >= this.buffer.length;
  }
}

/**
 * Event Emitter
 */
export class EventEmitter<T extends string = string> {
  private listeners: Map<T, Set<(...args: unknown[]) => void>> = new Map();
  
  on(event: T, listener: (...args: unknown[]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    
    return () => this.off(event, listener);
  }
  
  off(event: T, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  
  once(event: T, listener: (...args: unknown[]) => void): () => void {
    const wrapper = ((...args: unknown[]) => {
      this.off(event, wrapper);
      listener(...args);
    }) as (...args: unknown[]) => void;
    return this.on(event, wrapper);
  }
  
  emit(event: T, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(listener => {
      try {
        listener(...args);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    });
  }
  
  removeAllListeners(event?: T): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
  
  listenerCount(event: T): number {
    return this.listeners.get(event)?.size || 0;
  }
}

/**
 * LRUCache
 */
export class LRUCache<K, V> {
  private cache: Map<K, V> = new Map();
  private maxSize: number;
  
  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }
  
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    
    return value;
  }
  
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }
  
  has(key: K): boolean {
    return this.cache.has(key);
  }
  
  delete(key: K): boolean {
    return this.cache.delete(key);
  }
  
  clear(): void {
    this.cache.clear();
  }
  
  get size(): number {
    return this.cache.size;
  }
  
  keys(): K[] {
    return Array.from(this.cache.keys());
  }
  
  values(): V[] {
    return Array.from(this.cache.values());
  }
}

/**
 * Rate Limiter
 */
export class RateLimiter {
  private tokens: Map<string, { count: number; resetAt: number }> = new Map();
  
  constructor(
    private maxTokens: number,
    private windowMs: number
  ) {}
  
  tryAcquire(key: string, cost = 1): boolean {
    const now = Date.now();
    let entry = this.tokens.get(key);
    
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.tokens.set(key, entry);
    }
    
    if (entry.count + cost > this.maxTokens) {
      return false;
    }
    
    entry.count += cost;
    return true;
  }
  
  reset(key: string): void {
    this.tokens.delete(key);
  }
  
  getRemainingTokens(key: string): number {
    const entry = this.tokens.get(key);
    if (!entry) {
      return this.maxTokens;
    }
    return Math.max(0, this.maxTokens - entry.count);
  }
}

/**
 * Circuit Breaker
 */
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  
  constructor(
    private threshold: number,
    private timeout: number,
    private resetTimeout: number
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
  
  getState(): string {
    return this.state;
  }
  
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
  }
}

/**
 * Simple logger
 */
export class Logger {
  constructor(
    private prefix = '',
    private level: 'debug' | 'info' | 'warn' | 'error' = 'info'
  ) {}
  
  private shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }
  
  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.debug(`[${this.prefix}]`, ...args);
    }
  }
  
  info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.info(`[${this.prefix}]`, ...args);
    }
  }
  
  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.prefix}]`, ...args);
    }
  }
  
  error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(`[${this.prefix}]`, ...args);
    }
  }
}

/**
 * Format duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * Format bytes
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1073741824).toFixed(1)}GB`;
}

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Map value from one range to another
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

/**
 * Check if running in Node.js
 */
export function isNode(): boolean {
  return typeof process !== 'undefined' && 
         process.versions?.node !== undefined;
}

/**
 * Check if running in browser
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && 
         typeof document !== 'undefined';
}

/**
 * Get environment variable
 */
export function getEnv(name: string, defaultValue = ''): string {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name] || defaultValue;
  }
  return defaultValue;
}

/**
 * Version info
 */
export const version = PMCP_VERSION;