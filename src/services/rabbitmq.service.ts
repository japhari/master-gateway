import { publishToRabbitmqWithServer } from '../rabbitHelper/publisher';
import { consumeFromRabbitmq } from '../rabbitHelper/consumer';
import { getOneMessageFromQueue } from '../rabbitHelper/rabbitmq';

export class RabbitmqService {
    async publishWithConfig(queueName: string, message: any, configs: any, requestId: string | null): Promise<boolean> {
        try {
            if (requestId) {
                message['requestId'] = requestId;
            }

            const port = isNaN(configs.queueServerPort) ? '' : ':' + configs.queueServerPort;
            let queueServer = configs.queueServerHost + port;

            if (configs.username !== undefined && configs.password !== undefined) {
                queueServer = configs.username + ':' + configs.password + '@' + queueServer;
            }
            if (configs.queueServerVHOST !== undefined) {
                queueServer = queueServer + '/' + configs.queueServerVHOST;
            }

            const queueResponse = await publishToRabbitmqWithServer(queueServer, queueName, message);
            return !!queueResponse;
        } catch (err) {
            console.error(err);
            return false;
        }
    }

    async startConsumer(queueName: string, method: string, url: string) {
        return consumeFromRabbitmq(queueName, method, url);
    }

    async consumeOne(queueName: string): Promise<{ raw: string; json?: any } | null> {
        try {
            return await getOneMessageFromQueue(queueName);
        } catch (err) {
            console.error(err);
            return null;
        }
    }
}

export const rabbitmqService = new RabbitmqService();


