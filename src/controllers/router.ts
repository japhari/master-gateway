import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { govesbService } from '../services/govesb.service';
import { publishService } from '../services/publish.service';
import { synchronousService } from '../services/synchronous.service';
import { rabbitmqService } from '../services/rabbitmq.service';
import { requestTrackerService } from '../services/request-tracker.service';
import { maliasiliService } from '../services/maliasili.service';
import { httpService } from '../services/http.service';
import { configService } from '../services/config.service';
import * as localMediatorConfig from '../config/mediator.json';

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

function sanitizePayloadForQueue(input: any): any {
    if (input === null || input === undefined) return input;
    if (Array.isArray(input)) {
        return input.map(sanitizePayloadForQueue);
    }
    if (typeof input === 'object') {
        const cleaned: Record<string, any> = {};
        for (const [key, value] of Object.entries(input)) {
            const keyNormalized = key.toLowerCase();
            const isAttachmentLike =
                keyNormalized.includes('attachment') ||
                keyNormalized.includes('file[') ||
                keyNormalized === 'file' ||
                keyNormalized === 'files' ||
                keyNormalized.includes('image[') ||
                keyNormalized === 'image' ||
                keyNormalized === 'images';
            if (isAttachmentLike) continue;
            cleaned[key] = sanitizePayloadForQueue(value);
        }
        return cleaned;
    }
    if (typeof input === 'string') {
        // Drop suspicious binary-like values and cap very long strings.
        const hasBinaryPattern = /\u0000|JFIF|PNG|Exif|ICC_PROFILE/i.test(input);
        if (hasBinaryPattern) return '';
        const maxLen = 8000;
        return input.length > maxLen ? input.slice(0, maxLen) : input;
    }
    return input;
}

function normalizeIncidentPayload(input: any): any {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

    const payload = { ...input } as Record<string, any>;

    // Support client variants while preserving original keys.
    if (!payload.incident_type && payload.incident_type_id) {
        payload.incident_type = payload.incident_type_id;
    }
    if (!payload.location_type && payload.locationType) {
        payload.location_type = payload.locationType;
    }
    if (!payload.reported_datetime && payload.reportedDateTime) {
        payload.reported_datetime = payload.reportedDateTime;
    }

    return payload;
}

async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (!chunks.length) return undefined;
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = (req.headers['content-type'] || '').toString().toLowerCase();

    if (contentType.includes('multipart/form-data')) {
        return parseMultipartFormData(raw, contentType);
    }

    // Some clients send incorrect content-type while body is multipart.
    if (raw.includes('Content-Disposition: form-data;')) {
        return parseMultipartFormData(raw, contentType);
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw);
        const result: Record<string, string> = {};
        params.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function parseMultipartFormData(raw: string, contentType: string): any {
    const markers = resolveMultipartMarkers(raw, contentType);
    if (!markers.length) {
        return raw;
    }

    let best: Record<string, string> = {};
    for (const marker of markers) {
        const parsed = parseMultipartWithMarker(raw, marker);
        if (Object.keys(parsed).length > Object.keys(best).length) {
            best = parsed;
        }
    }

    // Some clients still produce malformed boundary framing.
    // Fallback to a boundary-agnostic parser based on Content-Disposition blocks.
    if (
        !Object.keys(best).length ||
        hasMultipartLeakage(best)
    ) {
        const dispositionParsed = parseMultipartByDisposition(raw);
        if (Object.keys(dispositionParsed).length > Object.keys(best).length) {
            best = dispositionParsed;
        }
    }

    return Object.keys(best).length ? best : raw;
}

function resolveMultipartMarkers(raw: string, contentType: string): string[] {
    const out: string[] = [];
    const pushUnique = (m?: string) => {
        if (!m || out.includes(m)) return;
        out.push(m);
    };

    const fromHeaderRaw = contentType
        .match(/boundary=([^;]+)/i)?.[1]
        ?.trim()
        .replace(/^"|"$/g, '');

    if (fromHeaderRaw) {
        pushUnique(`--${fromHeaderRaw}`);
        if (fromHeaderRaw.startsWith('--')) {
            pushUnique(`--${fromHeaderRaw.replace(/^--/, '')}`);
        } else {
            pushUnique(`----${fromHeaderRaw}`);
        }
    }

    // Fallback: use first line if it looks like a multipart boundary marker.
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
    if (firstLine?.startsWith('--')) {
        pushUnique(firstLine);
    }

    return out;
}

function parseMultipartWithMarker(raw: string, marker: string): Record<string, string> {
    const sections = raw.split(marker);
    const result: Record<string, string> = {};

    for (const section of sections) {
        const part = section.trim();
        if (!part || part === '--') continue;
        const splitIndex = part.search(/\r?\n\r?\n/);
        if (splitIndex < 0) continue;

        const headers = part.slice(0, splitIndex);
        let value = part.slice(splitIndex).replace(/^\r?\n\r?\n/, '');
        value = value.replace(/\r?\n--$/, '').trim();

        const nameMatch = headers.match(/name="([^"]+)"/i);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];
        const partTypeMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
        const partType = (partTypeMatch?.[1] || '').toLowerCase();

        // Skip file uploads and non-text multipart parts.
        if (
            /filename="/i.test(headers) ||
            /^image\//.test(partType) ||
            /^audio\//.test(partType) ||
            /^video\//.test(partType) ||
            partType === 'application/octet-stream'
        ) {
            continue;
        }

        // Defensive skip by field name for known attachment keys.
        if (
            /^(file|files|attachment|attachments|image|images)$/i.test(fieldName) ||
            /^attachments?\[[^\]]*\]$/i.test(fieldName) ||
            /^files?\[[^\]]*\]$/i.test(fieldName) ||
            /^images?\[[^\]]*\]$/i.test(fieldName)
        ) {
            continue;
        }

        // Prevent forwarding very large field values that can trigger upstream 413.
        const maxFieldLength = 20000;
        result[fieldName] = value.length > maxFieldLength ? value.slice(0, maxFieldLength) : value;
    }

    return result;
}

function parseMultipartByDisposition(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    const blockRegex =
        /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?\s*(?:\r?\nContent-Type:\s*([^\r\n]+))?\s*\r?\n\r?\n([\s\S]*?)(?=\r?\n--[^\r\n]+(?:--)?\r?\n?|\s*$)/gi;

    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(raw)) !== null) {
        const fieldName = match[1];
        const filename = match[2] || '';
        const partType = (match[3] || '').toLowerCase();
        let value = (match[4] || '').trim();

        if (
            filename ||
            /^image\//.test(partType) ||
            /^audio\//.test(partType) ||
            /^video\//.test(partType) ||
            partType === 'application/octet-stream'
        ) {
            continue;
        }

        if (
            /^(file|files|attachment|attachments|image|images)$/i.test(fieldName) ||
            /^attachments?\[[^\]]*\]$/i.test(fieldName) ||
            /^files?\[[^\]]*\]$/i.test(fieldName) ||
            /^images?\[[^\]]*\]$/i.test(fieldName)
        ) {
            continue;
        }

        const maxFieldLength = 20000;
        result[fieldName] = value.length > maxFieldLength ? value.slice(0, maxFieldLength) : value;
    }

    return result;
}

function hasMultipartLeakage(parsed: Record<string, string>): boolean {
    return Object.values(parsed).some(
        (v) => typeof v === 'string' && /Content-Disposition:\s*form-data/i.test(v),
    );
}

async function resolveMaliasiliTarget(path: string, apiKeyOverride?: string): Promise<string> {
    const { maliasili } = await configService.getMaliasiliSettings();
    const localMaliasili = ((localMediatorConfig as any)?.config?.maliasili || {}) as Record<string, any>;
    const baseUrl = (maliasili?.baseUrl || localMaliasili?.baseUrl || '')
        .toString()
        .trim()
        .replace(/\/+$/, '');
    const apiKey =
        (apiKeyOverride ?? '').toString().trim() ||
        (maliasili?.apiKey || localMaliasili?.apiKey || '').toString().trim();

    if (!baseUrl) {
        throw new Error('Maliasili baseUrl is not configured');
    }

    const target = `${baseUrl}/${path.replace(/^\/+/, '')}`;
    if (!apiKey) return target;
    const separator = target.includes('?') ? '&' : '?';
    return `${target}${separator}api_key=${encodeURIComponent(apiKey)}`;
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

        const requestId = body?.data?.requestId ?? null;
        const payload = normalizeIncidentPayload(
            sanitizePayloadForQueue(body?.data?.esbBody ?? body),
        );
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

    // Internal proxy for Maliasili portal's group-peck endpoint.
    // External: GET https://portal.maliasili.go.tz/api/v1/bills/{billId}/group-peck?api_key=...
    // Internal: GET /api/maliasili/bills/{billId}/group-peck  (api_key is injected server-side)
    'GET /api/maliasili/bills/:billId/group-peck': async (_req, res, params) => {
        const billId = params.billId?.trim();
        if (!billId || !/^\d+$/.test(billId)) {
            return json(res, 400, { success: false, message: 'Invalid billId' });
        }

        try {
            const data = await maliasiliService.getGroupPeck(billId);
            return json(res, 200, { success: true, esbBody: data, message: 'OK' });
        } catch (err: any) {
            const status = typeof err?.status === 'number' ? err.status : 502;
            return json(res, status, {
                success: false,
                message:
                    typeof err?.message === 'string'
                        ? err.message
                        : err?.message || 'Maliasili request failed',
            });
        }
    },

    // Compatibility route:
    // GET /api/v1/bills/group-check?bill_id=3010&api_key=...
    // -> forwards to {maliasili.baseUrl}/bills/3010/group-peck?api_key=...
    // Downstream currently exposes group-peck endpoint.
    'GET /api/v1/bills/group-check': async (req, res) => {
        const urlObj = new URL(req.url || '', 'http://localhost');
        const billId = (urlObj.searchParams.get('bill_id') || '').trim();
        const apiKey = (urlObj.searchParams.get('api_key') || '').trim();

        if (!billId || !/^\d+$/.test(billId)) {
            return json(res, 400, { success: false, message: 'Invalid or missing bill_id' });
        }
        if (!apiKey) {
            return json(res, 400, { success: false, message: 'Missing api_key' });
        }

        try {
            const targetUrl = await resolveMaliasiliTarget(`/bills/${encodeURIComponent(billId)}/group-peck`, apiKey);
            const data = await httpService.getValues(targetUrl);
            return json(res, 200, {
                success: true,
                esbBody: data,
                message: 'Group check request forwarded successfully',
            });
        } catch (err: any) {
            const status = typeof err?.response?.status === 'number' ? err.response.status : 502;
            const downstream =
                err?.response?.data?.message ||
                err?.response?.data?.error ||
                err?.response?.data ||
                err?.message ||
                'Group check forwarding failed';

            return json(res, status, {
                success: false,
                message: typeof downstream === 'string' ? downstream : JSON.stringify(downstream),
            });
        }
    },

    // Backward-compatible alias for older clients still using group-peck.
    'GET /api/v1/bills/group-peck': async (req, res, params, body) => {
        return routes['GET /api/v1/bills/group-check'](req, res, params, body);
    },

    // Direct proxy route (no queue) for payment check.
    // External target is resolved from maliasili baseUrl in mediator config.
    // Internal route:  POST /api/v1/faru/payment-check
    'POST /api/v1/faru/payment-check': async (_req, res, _params, body) => {
        const payload = body?.data?.esbBody ?? body ?? {};

        try {
            const targetUrl = await resolveMaliasiliTarget('/faru/payment-check');
            const data = await httpService.post(targetUrl, payload);
            return json(res, 200, {
                success: true,
                esbBody: data,
                message: 'Payment check request forwarded successfully',
            });
        } catch (err: any) {
            const status = typeof err?.response?.status === 'number' ? err.response.status : 502;
            const downstream =
                err?.response?.data?.message ||
                err?.response?.data?.error ||
                err?.response?.data ||
                err?.message ||
                'Payment check forwarding failed';

            return json(res, status, {
                success: false,
                message: typeof downstream === 'string' ? downstream : JSON.stringify(downstream),
            });
        }
    },

    // Direct proxy GET route (no queue) for payment check.
    // Internal route: GET /api/v1/faru/payment-check
    'GET /api/v1/faru/payment-check': async (_req, res) => {
        try {
            const targetUrl = await resolveMaliasiliTarget('/faru/payment-check');
            const data = await httpService.getValues(targetUrl);
            return json(res, 200, {
                success: true,
                esbBody: data,
                message: 'Payment check request forwarded successfully',
            });
        } catch (err: any) {
            const status = typeof err?.response?.status === 'number' ? err.response.status : 502;
            const downstream =
                err?.response?.data?.message ||
                err?.response?.data?.error ||
                err?.response?.data ||
                err?.message ||
                'Payment check forwarding failed';

            return json(res, status, {
                success: false,
                message: typeof downstream === 'string' ? downstream : JSON.stringify(downstream),
            });
        }
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


