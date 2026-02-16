import { configService } from './config.service';
import { rabbitmqService } from './rabbitmq.service';
import { jwtService } from './jwt.service';
import { randomUUID } from 'crypto';
import { requestTrackerService } from './request-tracker.service';

export class PublishService {
  async publish(queueName: string, payload: any, requestId: string | null): Promise<{ status: number; body: any }> {
    const effectiveRequestId = requestId?.trim() || randomUUID();
    const { config, queue } = await configService.findPubQueue(queueName);
    if (!queue) {
      return this.response(400, {
        success: false,
        message: 'Invalid destination queue',
        requestId: effectiveRequestId,
        esbBody: '',
      });
    }

    const properties = {
      queueServerHost: config.queueServer.host,
      queueServerPort: config.queueServer.port,
      queueServerVHOST: config.queueServer.VHOST,
      username: config.queueServer.username,
      password: config.queueServer.password,
      queueName,
    };

    const queued = await rabbitmqService.publishWithConfig(
      queueName,
      payload,
      properties,
      effectiveRequestId,
    );
    if (queued) {
      requestTrackerService.markQueued({
        requestId: effectiveRequestId,
        queueName,
      });
      const data = {
        success: true,
        requestId: effectiveRequestId,
        status: 'QUEUED',
        trackingPath: `/request-status/${effectiveRequestId}`,
        esbBody: {
          status: 'Your request is now queued for processing',
        },
        message: 'Request accepted and queued. Use requestId to track progress.',
      };
      return this.response(200, data);
    }

    requestTrackerService.markFailed(effectiveRequestId, {
      code: 'QUEUE_PUBLISH_FAILED',
      message: 'Failed to publish request to queue',
    });
    const data = {
      success: false,
      requestId: effectiveRequestId,
      status: 'FAILED',
      esbBody: '',
      message: 'Something went wrong while queueing your request',
    };
    return this.response(500, data);
  }

  private response(status: number, data: any) {
    return {
      status,
      body: {
        data,
        signature: jwtService.signPayload(data),
      },
    };
  }
}

export const publishService = new PublishService();


