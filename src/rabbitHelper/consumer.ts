import { getRabbitmqChannel } from './rabbitmq';
import axios from 'axios';
import { from } from 'rxjs';
import winston from 'winston';
import { sendViaGovesb } from '../govesb/govesb-client';

import * as http from 'http';
import * as https from 'https';

const loggerTag = 'RabbitHelper';

export async function consumeFromRabbitmq(queueName: string, method: string, url: string) {

  try {

    const channel = getRabbitmqChannel();
    await channel.assertQueue(queueName);
    await channel.consume(queueName, message => {
      const input = JSON.parse(message.content.toString());
      console.log(`Received Message:`, input);
      processComsumedMessage(input, queueName, method, url);
      channel.ack(message);
    });
    console.log(`Waiting22 for messages from ${queueName}...`);

  } catch (error) {
    console.error('Waiting Queue Error:', error);
    throw error;
  }
}

export function processComsumedMessage(message: string, queueName: string, method: string, url: string) {
  if (url) {
    // Fire-and-forget HTTP/GOVESB forwarding; log errors without crashing the worker.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    sendData('POST', url, message, queueName);
  }

}


export async function sendData(
  method: string,
  url: string,
  payload: any,
  sourceQueue?: string,
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
      return data;
    } catch (error: any) {
      winston.error(`Error during GOVESB request for ${serviceCode}`);
      winston.error(error?.message || error);
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
    },
    timeout: 300000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    decompress: true,
  });

  try {
    const res = await axiosInstance.post(url, payload);
    winston.info(`Response from ${url}`);
    return res.data;
  } catch (error: any) {
    winston.error(`Error during request to ${url}`);
    winston.error(
      `Forwarding error: ${error?.code || ''} ${error?.message || error}`,
    );
    if (sourceQueue) {
      // Best-effort: move failed message to a companion failed queue.
      await sendToFailedQueue(sourceQueue, payload, url, error);
    }
    // Do not rethrow; swallow the error so the worker continues running.
    return null;
  }
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
    const body = {
      sourceQueue,
      failedAt: new Date().toISOString(),
      targetUrl: url,
      error: {
        code: error?.code,
        message: error?.message || String(error),
        status: error?.response?.status,
      },
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
