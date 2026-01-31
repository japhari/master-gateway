export interface Orchestration {
    name: string;
    request: {
        method: string;
        headers: Record<string, any>;
        body: any;
        timestamp: Date | string | number;
        path: string;
        querystring: string;
    };
    response: {
        status: number;
        headers: Record<string, any>;
        body: any;
        timestamp: Date | string | number;
    };
}

export interface ReturnObject {
    'x-mediator-urn': string;
    status: string;
    response: {
        status: number;
        headers: Record<string, any>;
        body: any;
        timestamp: number;
    };
    orchestrations: Orchestration[] | undefined;
    properties: Record<string, any> | undefined;
}

function parsePathAndQuery(inputUrl: string): { path: string; querystring: string } {
    try {
        // Ensure we can parse even relative paths by prefixing a dummy origin if needed
        const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(inputUrl);
        const effectiveUrl = hasProtocol ? inputUrl : `http://localhost${inputUrl.startsWith('/') ? '' : '/'}${inputUrl}`;
        const u = new URL(effectiveUrl);
        return {
            path: u.pathname,
            querystring: u.search ? u.search.slice(1) : '',
        };
    } catch {
        // Fallback: do a lightweight split
        const [pathPart, queryPart] = inputUrl.split('?');
        return {
            path: pathPart || '/',
            querystring: queryPart || '',
        };
    }
}

function extractStatusAndHeaders(res: any): { status: number; headers: Record<string, any> } {
    // Support Node http.IncomingMessage, AxiosResponse-like, or custom shapes
    const status = res?.statusCode ?? res?.status ?? 0;
    const headers = res?.headers ?? res?.getHeaders?.() ?? {};
    return { status, headers };
}

export function buildOrchestration(
    name: string,
    beforeTimestamp: Date | string | number,
    method: string,
    url: string,
    requestHeaders: Record<string, any>,
    requestContent: any,
    res: any,
    body: any,
): Orchestration {
    const { path, querystring } = parsePathAndQuery(url);
    const { status, headers } = extractStatusAndHeaders(res);

    return {
        name,
        request: {
            method,
            headers: requestHeaders,
            body: requestContent,
            timestamp: beforeTimestamp,
            path,
            querystring,
        },
        response: {
            status,
            headers,
            body,
            timestamp: new Date(),
        },
    };
}

export function buildReturnObject(
    urn: string,
    status: string,
    statusCode: number,
    headers: Record<string, any>,
    responseBody: any,
    orchestrations?: Orchestration[],
    properties?: Record<string, any>,
): ReturnObject {
    const response = {
        status: statusCode,
        headers,
        body: responseBody,
        timestamp: new Date().getTime(),
    };

    return {
        'x-mediator-urn': urn,
        status,
        response,
        orchestrations,
        properties,
    };
}

