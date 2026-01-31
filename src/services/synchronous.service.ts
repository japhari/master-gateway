import { configService } from './config.service';
import { httpService } from './http.service';
import { jwtService } from './jwt.service';
import * as winston from 'winston';

export interface SynchronousResult {
  status: number;
  body: any;
}

export class SynchronousService {
  async handlePost(pathKey: string, payload: any): Promise<SynchronousResult> {
    winston.info('[sync] handlePost called', { pathKey });

    const { destination } = await configService.findSynchronousPath(pathKey);
    if (!destination) {
      winston.warn(`[sync] No destination found for pathKey`, { pathKey });
      const response = { success: false, esbBody: '', message: 'Invalid Destination' };
      return this.errorResponse(response, 400);
    }
    // Log raw destination config to see exactly what came from OpenHIM/mediator config
    winston.info('[sync] Destination config', {
      pathKey,
      destination,
    });
    if (destination.status === 'STOP') {
      winston.warn(`[sync] Destination is STOP`, { pathKey });
      const response = { success: false, esbBody: '', message: 'Channel is Disabled' };
      return this.errorResponse(response, 400);
    }

    let data: any;
    let signature: string | undefined;

    if (payload && typeof payload === 'object' && 'data' in payload) {
      data = (payload as any).data;
      signature = (payload as any).signature;
    } else {
      data = { esbBody: payload };
    }

    winston.info('[sync] Payload parsed', {
      pathKey,
      hasSignature: !!signature,
    });

    if (signature) {
      const isHexHmac = /^[0-9a-f]{64}$/i.test(signature);

      if (isHexHmac) {
        const verified = jwtService.verifyPayload({ signedData: data, signature });
        if (!verified) {
          winston.warn('[sync] Signature verification failed', { pathKey });
          const response = { success: false, esbBody: '', message: 'Invalid Message Signature' };
          return this.errorResponse(response, 400);
        }
        winston.info('[sync] Signature verification passed (HMAC)', { pathKey });
      } else {
        // Non-HMAC (e.g. GOVESB ECDSA) signatures are accepted as-is for now.
        winston.info('[sync] Skipping local HMAC verification for non-hex signature', {
          pathKey,
          signatureLength: signature.length,
        });
      }
    }

    const requestData: { data: any; signature?: string } = { data, signature };

    let url: string;
    let buildMode: string;

    if (typeof destination.host === 'string' && /^https?:\/\//.test(destination.host)) {
      // Host is already an absolute URL – use it exactly as provided
      url = destination.host;
      buildMode = 'absolute-host';
    } else if (destination.automaticBuildFullUrl === 'NO') {
      url = `${destination.host}`;
      buildMode = 'host-only';
    } else {
      url = `${destination.host}:${destination.port}/${destination.sourcePath}`;
      buildMode = 'host-port-sourcePath';
    }

    winston.info('[sync] Resolved downstream URL', {
      pathKey,
      host: destination.host,
      port: destination.port,
      sourcePath: destination.sourcePath,
      automaticBuildFullUrl: destination.automaticBuildFullUrl,
      resolvedUrl: url,
      buildMode,
    });

    winston.info('[sync] Forwarding request', {
      pathKey,
      url,
      hasAuth: !!(destination.username && destination.password),
    });

    const results = await httpService.post(
      url,
      requestData.data.esbBody,
      destination.username,
      destination.password,
    );
    winston.info('[sync] Downstream response received', {
      pathKey,
      url,
      resultType: typeof results,
    });
    const response = { success: true, esbBody: results, message: 'Received successfully' };
    return this.okResponse(response);
  }

  async handleGet(pathKey: string, query: Record<string, string | string[]>): Promise<SynchronousResult> {
    winston.info('[sync] handleGet called', { pathKey, queryKeys: Object.keys(query || {}) });

    const { destination } = await configService.findSynchronousPath(pathKey);
    if (!destination) {
      winston.warn('[sync] No destination found for pathKey (GET)', { pathKey });
      const response = { success: false, esbBody: '', message: 'Invalid Destination' };
      return this.errorResponse(response, 400);
    }
    if (destination.status === 'STOP') {
      winston.warn('[sync] Destination is STOP (GET)', { pathKey });
      const response = { success: false, esbBody: '', message: 'Channel is Disabled' };
      return this.errorResponse(response, 400);
    }
    if (destination.channelHttpMethod !== 'GET') {
      const response = { success: false, esbBody: '', message: 'The method must be GET' };
      return this.errorResponse(response, 400);
    }

    let baseUrl: string;
    if (destination.automaticBuildFullUrl === 'NO') {
      baseUrl = `${destination.host}`;
    } else {
      baseUrl = `${destination.host}:${destination.port}/${destination.sourcePath}`;
    }

    const searchParams = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.filter(Boolean).forEach((v) => searchParams.append(key, v));
      } else if (value !== undefined && value !== null && value !== '') {
        searchParams.append(key, value);
      }
    });

    const fullUrl = searchParams.toString() ? `${baseUrl}?${searchParams.toString()}` : baseUrl;
    winston.info('[sync] Forwarding GET request', { pathKey, fullUrl });
    const results = await httpService.getValues(fullUrl, destination.username, destination.password);
    winston.info('[sync] Downstream GET response received', {
      pathKey,
      fullUrl,
      resultType: typeof results,
    });
    const response = { success: true, esbBody: results, message: 'Received successfully' };
    return this.okResponse(response);
  }

  private okResponse(data: any): SynchronousResult {
    return {
      status: 200,
      body: {
        data,
        signature: jwtService.signPayload(data),
      },
    };
  }

  private errorResponse(data: any, status: number): SynchronousResult {
    return {
      status,
      body: {
        data,
        signature: jwtService.signPayload(data),
      },
    };
  }
}

export const synchronousService = new SynchronousService();


