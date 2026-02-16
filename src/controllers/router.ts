import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { govesbService } from '../services/govesb.service';
import { publishService } from '../services/publish.service';
import { synchronousService } from '../services/synchronous.service';
import { rabbitmqService } from '../services/rabbitmq.service';
import { requestTrackerService } from '../services/request-tracker.service';

type RouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    body?: any,
) => Promise<void>;

function json(res: ServerResponse, status: number, data: any): void {
    const payload = JSON.stringify(data);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(payload);
}

function extractTrackingRequestId(body: any): string {
    const candidate =
        body?.requestId ??
        body?.data?.requestId ??
        body?.esbBody?.requestId ??
        body?.data?.esbBody?.requestId;
    return candidate?.toString?.().trim?.() || '';
}

async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (!chunks.length) return undefined;
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

export const routes: Record<string, RouteHandler> = {
    'POST /govesb/:serviceCode': async (_req, res, params, body) => {
        const serviceCode = params.serviceCode?.trim();
        if (!serviceCode)
            return json(res, 400, { success: false, message: 'Missing serviceCode' });

        try {
            const data = await govesbService.send(serviceCode, body, {});
            return json(res, 200, { success: true, esbBody: data, message: 'OK' });
        } catch (err: any) {
            return json(res, 502, {
                success: false,
                message: err?.message || 'GOVESB request failed',
            });
        }
    },

    // Optional POST variant for GOVESB that wraps key/value pairs into esbBody.
    // Example:
    //   POST /govesb/get/SRVC0048
    //   { "startDate": "2024-07-01", "endDate": "2025-06-30", "page": 10, "size": 0 }
    // Will forward payload as: { esbBody: { ... } }
    'POST /govesb/get/:serviceCode': async (_req, res, params, body) => {
        const serviceCode = params.serviceCode?.trim();
        if (!serviceCode) {
            return json(res, 400, { success: false, message: 'Missing serviceCode' });
        }

        const esbPayload =
            body && typeof body === 'object'
                ? { esbBody: body }
                : { esbBody: { value: body } };

        try {
            const data = await govesbService.send(serviceCode, esbPayload, {});
            return json(res, 200, { success: true, esbBody: data, message: 'OK' });
        } catch (err: any) {
            return json(res, 502, {
                success: false,
                message: err?.message || 'GOVESB request failed',
            });
        }
    },

    'POST /publish/:queue': async (_req, res, params, body) => {
        const queue = params.queue;
        if (!queue) return json(res, 400, { success: false, message: 'Missing queue' });

        const contentType = (_req.headers['content-type'] || '').toString();
        if (!contentType.startsWith('application/json')) {
            return json(res, 400, {
                success: false,
                message: 'Invalid content type please use application/json',
            });
        }

        const requestId = body?.data?.requestId ?? null;
        const payload = body?.data?.esbBody ?? body;
        const result = await publishService.publish(queue, payload, requestId);
        return json(res, result.status, result.body);
    },

    // Simple debug API: consume a single message from a RabbitMQ queue.
    // This uses a non-blocking get with noAck=true and returns either the
    // raw string or parsed JSON if possible.
    'GET /queue/:queue/consume-one': async (_req, res, params) => {
        const queue = params.queue;
        if (!queue) {
            return json(res, 400, { success: false, message: 'Missing queue' });
        }
        try {
            const msg = await rabbitmqService.consumeOne(queue);
            if (!msg) {
                return json(res, 200, { success: true, message: 'No messages available', esbBody: null });
            }
            return json(res, 200, {
                success: true,
                message: 'Message consumed',
                esbBody: msg.json ?? msg.raw,
                raw: msg.raw,
            });
        } catch (err: any) {
            return json(res, 500, {
                success: false,
                message: err?.message || 'Failed to consume message',
            });
        }
    },

    'GET /request-status/:requestId': async (_req, res, params) => {
        const requestId = params.requestId?.trim();
        if (!requestId) {
            return json(res, 400, { success: false, message: 'Missing requestId' });
        }
        const record = requestTrackerService.get(requestId);
        if (!record) {
            return json(res, 404, {
                success: false,
                message: 'Request ID not found in tracker. It may be expired or unknown.',
                requestId,
            });
        }
        return json(res, 200, {
            success: true,
            message: 'Request status retrieved successfully',
            data: record,
        });
    },

    'POST /request-status': async (_req, res, _params, body) => {
        const requestId = extractTrackingRequestId(body);
        if (!requestId) {
            return json(res, 400, {
                success: false,
                message: 'Missing requestId in request body',
            });
        }
        const record = requestTrackerService.get(requestId);
        if (!record) {
            return json(res, 404, {
                success: false,
                message: 'Request ID not found in tracker. It may be expired or unknown.',
                requestId,
            });
        }
        return json(res, 200, {
            success: true,
            message: 'Request status retrieved successfully',
            data: record,
        });
    },

    // Alias for integrations that already call /tracker
    'POST /tracker': async (_req, res, _params, body) => {
        const requestId = extractTrackingRequestId(body);
        if (!requestId) {
            return json(res, 400, {
                success: false,
                message: 'Missing requestId in request body',
            });
        }
        const record = requestTrackerService.get(requestId);
        if (!record) {
            return json(res, 404, {
                success: false,
                message: 'Request ID not found in tracker. It may be expired or unknown.',
                requestId,
            });
        }
        return json(res, 200, {
            success: true,
            message: 'Request status retrieved successfully',
            data: record,
        });
    },

    // Alias for router-based channels that call /api/v1/faru/tracker
    'POST /api/v1/faru/tracker': async (_req, res, _params, body) => {
        const requestId = extractTrackingRequestId(body);
        if (!requestId) {
            return json(res, 400, {
                success: false,
                message: 'Missing requestId in request body',
            });
        }
        const record = requestTrackerService.get(requestId);
        if (!record) {
            return json(res, 404, {
                success: false,
                message: 'Request ID not found in tracker. It may be expired or unknown.',
                requestId,
            });
        }
        return json(res, 200, {
            success: true,
            message: 'Request status retrieved successfully',
            data: record,
        });
    },

    'POST /sendToExternalSystemWithPushCode/:path': async (_req, res, params, body) => {
        const pathKey = params.path;
        if (!pathKey) return json(res, 400, { success: false, message: 'Missing path parameter' });
        try {
            const result = await govesbService.sendWithPushCode(pathKey, body);
            return json(res, 200, {
                success: true,
                esbBody: result,
                message: 'Payload routed via GOVESB',
            });
        } catch (err: any) {
            return json(res, 404, {
                success: false,
                message: err?.message || 'Failed to route payload',
            });
        }
    },

    'POST /sendToExternalSystemWithConnectionCode/:path': async (_req, res, params, body) => {
        const pathKey = params.path;
        if (!pathKey) return json(res, 400, { success: false, message: 'Missing path parameter' });
        try {
            const result = await govesbService.sendWithConnectionCode(pathKey, body);
            return json(res, 200, {
                success: true,
                esbBody: result,
                message: 'Payload routed via GOVESB connection code',
            });
        } catch (err: any) {
            return json(res, 404, {
                success: false,
                message: err?.message || 'Failed to route payload',
            });
        }
    },

    'POST /govesbmediator/:path': async (_req, res, params, body) => {
        const pathKey = params.path;
        const result = await synchronousService.handlePost(pathKey, body);
        return json(res, result.status, result.body);
    },

    'GET /getRequestFromGovesb/:path': async (req, res, params) => {
        const pathKey = params.path;
        const urlObj = new URL(req.url || '', 'http://localhost');
        const query: Record<string, string | string[]> = {};
        urlObj.searchParams.forEach((value, key) => {
            if (query[key]) {
                const existing = query[key];
                if (Array.isArray(existing)) {
                    existing.push(value);
                } else {
                    query[key] = [existing, value];
                }
            } else {
                query[key] = value;
            }
        });
        const result = await synchronousService.handleGet(pathKey, query);
        return json(res, result.status, result.body);
    },
};

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '/';
    const [pathOnly] = url.split('?');

    const routeKeys = Object.keys(routes);
    for (const key of routeKeys) {
        const [m, pattern] = key.split(' ');
        if (m !== method) continue;
        const partsPattern = pattern.split('/').filter(Boolean);
        const partsUrl = pathOnly.split('/').filter(Boolean);
        if (partsPattern.length !== partsUrl.length) continue;

        const params: Record<string, string> = {};
        let matched = true;
        for (let i = 0; i < partsPattern.length; i++) {
            const p = partsPattern[i];
            const u = partsUrl[i];
            if (p.startsWith(':')) {
                params[p.slice(1)] = decodeURIComponent(u);
            } else if (p !== u) {
                matched = false;
                break;
            }
        }
        if (!matched) continue;

        const body =
            method === 'POST' || method === 'PUT' || method === 'PATCH'
                ? await readBody(req)
                : undefined;
        try {
            await routes[key](req, res, params, body);
        } catch (err: any) {
            json(res, 500, { success: false, message: err?.message || 'Internal server error' });
        }
        return;
    }

    json(res, 404, { success: false, message: 'Not Found' });
}


