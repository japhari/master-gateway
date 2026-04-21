import { getRabbitmqChannel } from './rabbitmq';
import axios from 'axios';
import { from } from 'rxjs';
import winston from 'winston';
import { sendViaGovesb } from '../govesb/govesb-client';
import { requestTrackerService } from '../services/request-tracker.service';

import * as http from 'http';
import * as https from 'https';

const loggerTag = 'RabbitHelper';
type ActiveConsumer = {
  consumerTag: string;
  method: string;
  url: string;
  apiKey?: string;
  apiKeyHeader?: string;
};
const activeConsumers = new Map<string, ActiveConsumer>();

export async function consumeFromRabbitmq(
  queueName: string,
  method: string,
  url: string,
  destinationConfig?: any,
) {

  try {
    const channel = getRabbitmqChannel();
    const targetMethod = (method || 'POST').toUpperCase();
    const targetUrl = (url || '').trim();
    const apiKey = destinationConfig?.apiKey || destinationConfig?.apiPushCode || '';
    const apiKeyHeader = destinationConfig?.apiKeyHeader || 'api-key';
    if (!targetUrl) {
      winston.warn(`[${loggerTag}] Skipping consumer setup for ${queueName}: empty channelUrl`);
      return;
    }

    const existing = activeConsumers.get(queueName);
    if (
      existing &&
      existing.method === targetMethod &&
      existing.url === targetUrl &&
      existing.apiKey === apiKey &&
      existing.apiKeyHeader === apiKeyHeader
    ) {
      winston.info(
        `[${loggerTag}] Consumer unchanged for ${queueName} -> ${targetMethod} ${targetUrl}`,
      );
      return;
    }

    if (existing?.consumerTag) {
      await channel.cancel(existing.consumerTag);
      winston.info(`[${loggerTag}] Rebinding consumer for ${queueName}`);
    }

    await channel.assertQueue(queueName);

    const consumeReply = await channel.consume(queueName, async message => {
      if (!message) return;

      let input: any;
      try {
        input = JSON.parse(message.content.toString());
      } catch {
        input = message.content.toString();
      }

      console.log(`Received Message:`, input);
      await processComsumedMessage(input, queueName, targetMethod, targetUrl, {
        apiKey,
        apiKeyHeader,
      });
      channel.ack(message);
    });

    activeConsumers.set(queueName, {
      consumerTag: consumeReply.consumerTag,
      method: targetMethod,
      url: targetUrl,
      apiKey,
      apiKeyHeader,
    });

    console.log(
      `Waiting22 for messages from ${queueName} -> ${targetMethod} ${targetUrl}...`,
    );

  } catch (error) {
    console.error('Waiting Queue Error:', error);
    throw error;
  }
}

export async function processComsumedMessage(
  message: string,
  queueName: string,
  method: string,
  url: string,
  destinationAuth?: { apiKey?: string; apiKeyHeader?: string },
) {
  if (url) {
    const requestId = extractRequestId(message);
    if (requestId) {
      requestTrackerService.markQueued({
        requestId,
        queueName,
        targetUrl: url,
        method,
      });
    }
    await sendData(
      method,
      url,
      message,
      queueName,
      requestId || undefined,
      destinationAuth,
    );
  }

}


export async function sendData(
  method: string,
  url: string,
  payload: any,
  sourceQueue?: string,
  requestId?: string,
  destinationAuth?: { apiKey?: string; apiKeyHeader?: string },
) {
  winston.info(`Sending request to ${url}`);

  // GOVESB integration: if URL uses "govesb:" scheme, route via govesb-connector-js
  if (typeof url === 'string' && url.startsWith('govesb:')) {
    const serviceCode = url.replace(/^govesb:/, '').trim();
    try {
      const data = await sendViaGovesb({
        serviceCode,
        payload,
        config: {},
      });
      winston.info(`Response from GOVESB for ${serviceCode}`);
      if (requestId) {
        requestTrackerService.markForwarded(requestId, { targetUrl: url, method });
      }
      return data;
    } catch (error: any) {
      winston.error(`Error during GOVESB request for ${serviceCode}`);
      const failedError = extractForwardingError(error, 'GOVESB request failed');
      winston.error(failedError.message);
      if (requestId) {
        requestTrackerService.markFailed(requestId, failedError, {
          targetUrl: url,
          method,
        });
      }
      if (sourceQueue) {
        // Best-effort: move failed message to a companion failed queue.
        await sendToFailedQueue(sourceQueue, payload, url, error);
      }
      return null;
    }
  }


  let serviceCode = '';
  if (url.includes('ffars-muse')) serviceCode = 'SRVC019';
  if (url.includes('planrep-to-muse-data')) serviceCode = 'SRVC0048';
  if (url.includes('planrep-to-npmis-objective')) serviceCode = 'SRVC0050';
  if (url.includes('planrep-to-npmis-budget')) serviceCode = 'SRVC0051';
  if (url.includes('planrep-to-npmis-response')) serviceCode = 'SRVC0049';
  if (url.includes('planrep-to-muse-budget-cancellation')) serviceCode = 'SRVC0048';

  // Multipart pass-through: caller sent multipart/form-data upstream, we
  // preserved the raw bytes + Content-Type (with boundary) in the queue
  // envelope. Re-post the exact bytes so the destination receives the
  // original multipart body (attachments included).
  const multipart = payload && typeof payload === 'object' ? (payload as any).__multipart : null;
  const isMultipart =
    multipart &&
    typeof multipart === 'object' &&
    typeof multipart.bodyBase64 === 'string' &&
    typeof multipart.contentType === 'string';

  if (isMultipart) {
    const axiosInstance = axios.create({
      httpAgent: new http.Agent({ keepAlive: true, timeout: 300000 }),
      httpsAgent: new https.Agent({ keepAlive: true, timeout: 300000 }),
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
    });

    const originalContentType: string = multipart.contentType;
    const rawBody = Buffer.from(multipart.bodyBase64, 'base64');
    const bodyToSend = requestId
      ? injectRequestIdPart(rawBody, originalContentType, requestId)
      : rawBody;

    try {
      const reqMethod = (method || 'POST').toUpperCase();
      const res = await axiosInstance.request({
        method: reqMethod,
        url,
        data: bodyToSend,
        headers: {
          Accept: 'application/json',
          'Content-Type': originalContentType,
          'Content-Length': String(bodyToSend.length),
          'service-code': serviceCode,
          ...(requestId ? { 'x-request-id': requestId } : {}),
          ...(destinationAuth?.apiKey
            ? { [destinationAuth.apiKeyHeader || 'api-key']: destinationAuth.apiKey }
            : {}),
        },
        transformRequest: [(d) => d],
      });
      winston.info(`Response from ${url} with status ${res.status}`);
      if (requestId) {
        requestTrackerService.markForwarded(requestId, { targetUrl: url, method: reqMethod });
      }
      return res.data;
    } catch (error: any) {
      winston.error(`Error during multipart forwarding to ${url}`);
      const failedError = extractForwardingError(error, 'Multipart forwarding failed');
      winston.error(`Forwarding error: ${failedError.code || ''} ${failedError.message}`);
      if (requestId) {
        requestTrackerService.markFailed(requestId, failedError, { targetUrl: url, method });
      }
      if (sourceQueue) {
        await sendToFailedQueue(sourceQueue, payload, url, error);
      }
      return null;
    }
  }

  const axiosInstance = axios.create({
    httpAgent: new http.Agent({
      keepAlive: true,
      timeout: 300000
    }),
    httpsAgent: new https.Agent({
      keepAlive: true,
      timeout: 300000
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'accept-encoding': 'gzip,deflate',
      'service-code': serviceCode,
      ...(destinationAuth?.apiKey
        ? { [destinationAuth.apiKeyHeader || 'api-key']: destinationAuth.apiKey }
        : {}),
    },
    timeout: 300000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    decompress: true,
  });

  try {
    const reqMethod = (method || 'POST').toUpperCase();
    const jsonPayload = stripMultipartEnvelope(payload);
    const res = await axiosInstance.request({
      method: reqMethod,
      url,
      data: jsonPayload,
    });
    winston.info(`Response from ${url} with status ${res.status}`);
    if (requestId) {
      requestTrackerService.markForwarded(requestId, { targetUrl: url, method: reqMethod });
    }
    return res.data;
  } catch (error: any) {
    winston.error(`Error during request to ${url}`);
    const failedError = extractForwardingError(error, 'HTTP forwarding failed');
    winston.error(`Forwarding error: ${failedError.code || ''} ${failedError.message}`);
    if (requestId) {
      requestTrackerService.markFailed(requestId, failedError, {
        targetUrl: url,
        method,
      });
    }
    if (sourceQueue) {
      // Best-effort: move failed message to a companion failed queue.
      await sendToFailedQueue(sourceQueue, payload, url, error);
    }
    // Do not rethrow; swallow the error so the worker continues running.
    return null;
  }
}

function extractRequestId(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.requestId ?? payload?.data?.requestId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function stripMultipartEnvelope(payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!('__multipart' in payload)) return payload;
  const { __multipart, ...rest } = payload as Record<string, any>;
  return rest;
}

/**
 * Insert a `requestId` text part into an existing multipart/form-data body
 * just before the closing boundary, so the destination receives the request
 * id alongside the original form fields and files.
 */
function injectRequestIdPart(
  rawBody: Buffer,
  contentType: string,
  requestId: string,
): Buffer {
  const boundaryMatch = /boundary=("([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[2] || boundaryMatch?.[3] || '').trim();
  if (!boundary) return rawBody;

  const closingMarker = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const closingIdx = rawBody.lastIndexOf(closingMarker);
  if (closingIdx < 0) return rawBody;

  const newPart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="requestId"\r\n\r\n` +
      `${requestId}\r\n`,
    'utf8',
  );

  return Buffer.concat([
    rawBody.slice(0, closingIdx + 2), // keep preceding CRLF
    newPart,
    rawBody.slice(closingIdx + 2),
  ]);
}

function extractForwardingError(
  error: any,
  fallbackMessage: string,
): { code?: string; message: string; status?: number } {
  const responseData = error?.response?.data;
  const responseMessage =
    (typeof responseData?.message === 'string' && responseData.message) ||
    (typeof responseData?.error === 'string' && responseData.error) ||
    (typeof responseData?.data?.message === 'string' && responseData.data.message) ||
    '';

  return {
    code: error?.code,
    status: error?.response?.status,
    message: responseMessage || error?.message || fallbackMessage,
  };
}

/**
 * Publish a failed message to a dedicated failed queue so it is not lost.
 * Queue name pattern: <SOURCE_QUEUE>_FAILED.
 */
async function sendToFailedQueue(
  sourceQueue: string,
  payload: any,
  url: string,
  error: any,
): Promise<void> {
  const failedQueue = `${sourceQueue}_FAILED`;
  try {
    const channel = getRabbitmqChannel();
    await channel.assertQueue(failedQueue);
    const derivedError = extractForwardingError(error, 'Forwarding request failed');
    const body = {
      sourceQueue,
      failedAt: new Date().toISOString(),
      targetUrl: url,
      error: derivedError,
      payload,
    };
    channel.sendToQueue(
      failedQueue,
      Buffer.from(JSON.stringify(body), 'utf8'),
      { persistent: true },
    );
    winston.warn(
      `Message moved to failed queue ${failedQueue} due to forwarding error`,
    );
  } catch (e: any) {
    winston.error(
      `Failed to publish message to failed queue ${failedQueue}: ${e?.message || e
      }`,
    );
  }
}


export async function sendData_2(method: string, url: string, data: any) {
  let serviceCode = '';
  if (url.includes('ffars-muse')) serviceCode = 'SRVC019';
  if (url.includes('planrep-to-muse-data')) serviceCode = 'SRVC0048';
  if (url.includes('planrep-to-npmis-objective')) serviceCode = 'SRVC0050';
  if (url.includes('planrep-to-npmis-budget')) serviceCode = 'SRVC0051';
  if (url.includes('planrep-to-npmis-response')) serviceCode = 'SRVC0049';
  if (url.includes('planrep-to-muse-budget-cancellation')) serviceCode = 'SRVC0048';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'service-code': serviceCode,
    // Explicitly remove unwanted headers
    'User-Agent': undefined,
    'Content-Length': undefined,
    'Accept-Encoding': undefined,
    'Connection': undefined,
    'X-Forwarded-For': undefined,
    'X-Forwarded-Host': undefined
  };



  try {
    const response = await axios({
      method: "POST",
      url,
      data,
      headers,
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
      validateStatus: () => true,
    });

    winston.info(`[${loggerTag}] Response from ${url}: is ${response.status}`);
    return response;
  } catch (error: any) {
    winston.error(`[${loggerTag}] Error sending data to ${url}: ${error.message}`);
    throw error;
  }
}



export async function createPublisherQueueToRabbit(queueName: string) {
  try {
    const channel = getRabbitmqChannel();
    await channel.assertQueue(queueName);
  } catch (ex) {
    console.error(ex);
  }

}
