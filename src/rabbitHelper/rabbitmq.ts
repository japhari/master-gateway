import * as amqp from 'amqplib';

let connection: amqp.Connection;
let channel: amqp.Channel;

export async function initRabbitmq(queueServer: string) {
    connection = await amqp.connect('amqp://' + queueServer);
    channel = await connection.createChannel();
    return channel;
}

export function getRabbitmqChannel() {
    if (!channel) {
        throw new Error('Channel not initialized. Call initRabbitmq first.');
    }
    return channel;
}

export async function closeRabbitmqConnection() {
    await channel?.close();
    await connection?.close();
}

/**
 * Fetch a single message from a queue for debugging/inspection.
 * Uses a non-blocking get with noAck=true so the message is removed once read.
 */
export async function getOneMessageFromQueue(
    queueName: string,
): Promise<{ raw: string; json?: any } | null> {
    const ch = getRabbitmqChannel();
    await ch.assertQueue(queueName);
    const msg = await ch.get(queueName, { noAck: true });
    if (!msg) {
        return null;
    }
    const raw = msg.content.toString('utf8');
    try {
        return { raw, json: JSON.parse(raw) };
    } catch {
        return { raw };
    }
}