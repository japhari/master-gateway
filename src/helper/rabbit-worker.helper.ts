import { publishToRabbitmqWithServer } from '../rabbitHelper/publisher';

export async function ProcessPublishToQueue(queueName, message, configs, requestId) {

    try {

        message["requestId"] = requestId

        var port = (isNaN(configs.queueServerPort)) ? '' : (':' + configs.queueServerPort);
        var queueServer = configs.queueServerHost + port;

        if (configs.username !== undefined && configs.password !== undefined) {
            queueServer = configs.username + ':' + configs.password + '@' + queueServer;
        }
        if (configs.queueServerVHOST !== undefined) {
            queueServer = queueServer + '/' + configs.queueServerVHOST;
        }

        let queueResponse = await publishToRabbitmqWithServer(queueServer, queueName, message);
        if (queueResponse) {
            return true;
        } else {
            return false;
        }

    } catch (ex) {
        console.error(ex);
        return false;
    }
}


