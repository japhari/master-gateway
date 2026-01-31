import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as winston from 'winston';

export class HttpService {
  async post(url: string, payload: any, username?: string | null, password?: string | null): Promise<any> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (username && password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const client = axios.create({
      // Shorter timeouts to avoid long hangs when downstream systems are unreachable
      httpAgent: new http.Agent({ keepAlive: true, timeout: 30000 }),
      httpsAgent: new https.Agent({ keepAlive: true, timeout: 30000 }),
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
      headers,
      validateStatus: () => true,
    });

    const safeHeaders = {
      ...headers,
      ...(headers.Authorization ? { Authorization: '[REDACTED]' } : {}),
    };
    const payloadPreview =
      typeof payload === 'string'
        ? payload.slice(0, 1000)
        : JSON.stringify(payload)?.slice(0, 1000);

    winston.info('[http] Outgoing POST', {
      url,
      headers: safeHeaders,
      payloadPreview,
    });

    try {
      const res = await client.post(url, payload);
      winston.info('[http] POST response received', {
        url,
        status: res.status,
        statusText: res.statusText,
      });
      return res.data ?? res;
    } catch (err: any) {
      winston.error('[http] POST request failed', {
        url,
        message: err?.message,
        code: err?.code,
      });
      throw err;
    }
  }

  async sendDataToGovEsb(url: string, payload: any, token: string): Promise<any> {
    const client = axios.create({
      httpAgent: new http.Agent({ keepAlive: true, timeout: 30000 }),
      httpsAgent: new https.Agent({ keepAlive: true, timeout: 30000 }),
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'accept-encoding': 'gzip,deflate',
      },
    });

    const payloadPreview =
      typeof payload === 'string'
        ? payload.slice(0, 1000)
        : JSON.stringify(payload)?.slice(0, 1000);

    winston.info('[http] Outgoing GOVESB POST', {
      url,
      headers: { Authorization: '[REDACTED]' },
      payloadPreview,
    });

    try {
      const res = await client.post(url, payload);
      winston.info('[http] GOVESB POST response received', {
        url,
        status: res.status,
        statusText: res.statusText,
      });
      return res.data ?? res;
    } catch (err: any) {
      winston.error('[http] GOVESB POST request failed', {
        url,
        message: err?.message,
        code: err?.code,
      });
      throw err;
    }
  }

  async getValues(fullUrl: string, username?: string, password?: string): Promise<any> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'accept-encoding': 'gzip,deflate',
    };
    if (username && password) {
      headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }

    const client = axios.create({
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
      headers,
    });

    const safeHeaders = {
      ...headers,
      ...(headers.Authorization ? { Authorization: '[REDACTED]' } : {}),
    };

    winston.info('[http] Outgoing GET', {
      url: fullUrl,
      headers: safeHeaders,
    });

    try {
      const res = await client.get(fullUrl);
      winston.info('[http] GET response received', {
        url: fullUrl,
        status: res.status,
        statusText: res.statusText,
      });
      return res.data ?? res;
    } catch (err: any) {
      winston.error('[http] GET request failed', {
        url: fullUrl,
        message: err?.message,
        code: err?.code,
      });
      throw err;
    }
  }

  convertToJsonObject(input: any): any {
    let result = input;
    let depth = 0;
    while (typeof result === 'string' && depth < 5) {
      try {
        result = JSON.parse(result);
        depth++;
      } catch {
        break;
      }
    }
    if (typeof result !== 'object') {
      throw new Error('Invalid or malformed JSON input');
    }
    return result;
  }
}

export const httpService = new HttpService();


