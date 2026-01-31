import { configService } from './config.service';
import { rabbitmqService } from './rabbitmq.service';
import { jwtService } from './jwt.service';

export class PublishService {
  async publish(queueName: string, payload: any, requestId: string | null): Promise<{ status: number; body: any }> {
    const { config, queue } = await configService.findPubQueue(queueName);
    if (!queue) {
      return this.response(400, { success: false, message: 'Invalid Destination', esbBody: '' });
    }

    const properties = {
      queueServerHost: config.queueServer.host,
      queueServerPort: config.queueServer.port,
      queueServerVHOST: config.queueServer.VHOST,
      username: config.queueServer.username,
      password: config.queueServer.password,
      queueName,
    };

    const queued = await rabbitmqService.publishWithConfig(queueName, payload, properties, requestId);
    if (queued) {
      const data = {
        success: true,
        esbBody: { status: 'Your request is now queued for processing' },
        message: 'You will receive a response shortly',
      };
      return this.response(200, data);
    }

    const data = { success: false, esbBody: '', message: 'Something went wrong while queueing your request' };
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


