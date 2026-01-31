import type { AxiosResponse } from 'axios';

export interface GovesbSendOptions {
  serviceCode: string;
  payload: any;
  config?: Record<string, any>;
}

/**
 * Wrapper around govesb-connector-js (GovEsbHelper).
 *
 * The library exports `{ GovEsbHelper }` and expects raw base64 keys
 * (PKCS8 private, X.509 public) plus token/engine URLs.
 */
export async function sendViaGovesb(options: GovesbSendOptions): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GovEsbHelper }: any = require('govesb-connector-js');

  if (!GovEsbHelper || typeof GovEsbHelper !== 'function') {
    throw new Error(
      'govesb-connector-js does not export GovEsbHelper as expected. Please verify the library version.',
    );
  }

  const cfg = options.config || {};

  // Derive ESB URLs expected by GovEsbHelper:
  // - esbTokenUrl: token endpoint
  // - esbEngineUrl: base engine URL (library appends /push-request, /request, etc.)
  const esbTokenUrl =
    cfg.accessTokenUri || cfg.accessTokenUrl || cfg.esbTokenUrl;

  let esbEngineUrl: string | undefined = cfg.esbEngineUrl;
  const pushUrl: string | undefined = cfg.pushRequestUrl;

  // If only a full pushRequestUrl is provided (ending with /push-request),
  // strip the last segment so GovEsbHelper can append its own paths.
  if (!esbEngineUrl && typeof pushUrl === 'string') {
    const suffix = '/push-request';
    esbEngineUrl = pushUrl.endsWith(suffix)
      ? pushUrl.slice(0, -suffix.length)
      : pushUrl;
  }

  const helper = new GovEsbHelper({
    clientPrivateKey: cfg.clientPrivateKey,
    esbPublicKey: cfg.govesbPublicKey || cfg.esbPublicKey,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    esbTokenUrl,
    esbEngineUrl,
  });

  const format = 'json';

  // Decide between push (pushCode) and request (apiCode/connectionCode) flows.
  const isPushRequest =
    !!(options.payload &&
      (options.payload.pushCode ||
        options.payload.apiPushCode ||
        options.payload.push_code));

  const response = isPushRequest
    ? await helper.pushData(
      options.serviceCode,
      JSON.stringify(options.payload),
      format,
    )
    : await helper.requestData(
      options.serviceCode,
      JSON.stringify(options.payload),
      format,
    );

  return normalizeResponse(response);
}

function normalizeResponse(res: any): any {
  const isAxiosLike =
    res && typeof res === 'object' && 'status' in res && 'data' in res;
  if (isAxiosLike) return (res as AxiosResponse).data;
  return res;
}


