import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as winston from 'winston';
import { configService } from './config.service';

export interface MaliasiliError {
  status: number;
  message: any;
  code?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface MaliasiliSettings {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
}

const DEFAULTS: Omit<MaliasiliSettings, 'baseUrl' | 'apiKey'> = {
  timeoutMs: 10000,
  retries: 3,
  cacheTtlMs: 60_000,
};

const RETRYABLE_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class MaliasiliService {
  private cache = new Map<string, CacheEntry<any>>();
  private clientSignature = '';
  private client: AxiosInstance | null = null;

  async getGroupPeck(billId: string): Promise<any> {
    const trimmed = billId?.toString().trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      throw this.toError(400, 'Invalid billId: must be a positive integer');
    }

    const settings = await this.resolveSettings();
    const cacheKey = `group-peck:${trimmed}`;
    const cached = this.readCache<any>(cacheKey);
    if (cached !== undefined) {
      winston.info('[maliasili] Cache hit', { billId: trimmed, cacheKey });
      return cached;
    }

    winston.info('[maliasili] Fetching group-peck', { billId: trimmed });
    const client = await this.getClient(settings);
    const data = await this.request(
      () => client.get(`/bills/${encodeURIComponent(trimmed)}/group-peck`),
      settings.retries,
    );

    this.writeCache(cacheKey, data, settings.cacheTtlMs);
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async request<T>(fn: () => Promise<AxiosResponse<T>>, retries: number): Promise<T> {
    let attempt = 0;
    let lastErr: any;

    while (attempt <= retries) {
      try {
        const res = await fn();
        return res.data;
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        const code = err?.code;
        const retryable =
          (status && RETRYABLE_STATUSES.has(status)) ||
          (code && RETRYABLE_CODES.has(code)) ||
          (!status && !code);

        if (!retryable || attempt === retries) {
          winston.error('[maliasili] Request failed', {
            attempt,
            status,
            code,
            message: err?.message,
          });
          break;
        }

        const delay = Math.min(250 * 2 ** attempt, 2000);
        winston.warn('[maliasili] Transient failure, retrying', {
          attempt,
          nextDelayMs: delay,
          status,
          code,
          message: err?.message,
        });
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
      }
    }

    throw this.toError(
      lastErr?.response?.status || 502,
      lastErr?.response?.data || lastErr?.message || 'Maliasili request failed',
      lastErr?.code,
    );
  }

  private async getClient(settings: MaliasiliSettings): Promise<AxiosInstance> {
    // Rebuild client whenever settings change (hot-reload via OpenHIM heartbeat)
    const signature = `${settings.baseUrl}|${settings.apiKey}|${settings.timeoutMs}`;
    if (this.client && signature === this.clientSignature) return this.client;

    this.client = axios.create({
      baseURL: settings.baseUrl,
      timeout: settings.timeoutMs,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.request.use((config) => {
      config.params = { ...(config.params || {}), api_key: settings.apiKey };
      winston.info('[maliasili] Outgoing request', {
        method: (config.method || 'GET').toUpperCase(),
        url: `${config.baseURL || ''}${config.url || ''}`,
      });
      return config;
    });

    this.client.interceptors.response.use(
      (res) => {
        winston.info('[maliasili] Response received', {
          url: `${res.config.baseURL || ''}${res.config.url || ''}`,
          status: res.status,
        });
        return res;
      },
      (err) => Promise.reject(err),
    );

    this.clientSignature = signature;
    return this.client;
  }

  private async resolveSettings(): Promise<MaliasiliSettings> {
    const { maliasili } = await configService.getMaliasiliSettings();
    const baseUrl = (maliasili.baseUrl || '').toString().trim().replace(/\/+$/, '');
    const apiKey = (maliasili.apiKey || '').toString().trim();

    if (!baseUrl) throw this.toError(500, 'Maliasili baseUrl is not configured');
    if (!apiKey) throw this.toError(500, 'Maliasili apiKey is not configured');

    return {
      baseUrl,
      apiKey,
      timeoutMs: this.toPositiveInt(maliasili.timeoutMs, DEFAULTS.timeoutMs),
      retries: this.toNonNegativeInt(maliasili.retries, DEFAULTS.retries),
      cacheTtlMs: this.toNonNegativeInt(maliasili.cacheTtlMs, DEFAULTS.cacheTtlMs),
    };
  }

  private readCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private writeCache<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private toPositiveInt(v: any, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  private toNonNegativeInt(v: any, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private toError(status: number, message: any, code?: string): MaliasiliError {
    return { status, message, code };
  }
}

export const maliasiliService = new MaliasiliService();
