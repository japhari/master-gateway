import { getRabbitmqChannel } from './rabbitmq';
import * as amqp from 'amqplib';

export async function publishToRabbitmq(queueName, message) {

    try {

         const msgBuffer = Buffer.from(JSON.stringify(message));
         const channel = getRabbitmqChannel();
         await channel.assertQueue(queueName);
         await channel.sendToQueue(queueName, msgBuffer);
         console.log(`Sent message to ${queueName}`);
        
    } catch (error) {
         console.error('publishToRabbitmq Queue Error:', error);
         throw error; 
    }
}

export async function publishToRabbitmqWithServer(queueServer: string, queueName: string, message: any) {
    const msgBuffer = Buffer.from(JSON.stringify(message));
    let connection: amqp.Connection | undefined;
    let channel: amqp.Channel | undefined;
    try {
        connection = await amqp.connect('amqp://' + queueServer);
        channel = await connection.createChannel();
        await channel.assertQueue(queueName);
        await channel.sendToQueue(queueName, msgBuffer);
        console.log(`Sending message to ${queueName} queue`);
        await channel.close();
        await connection.close();
        return true;
    } catch (error) {
        console.error('publishToRabbitmqWithServer Error:', error);
        try { await channel?.close(); } catch {}
        try { await connection?.close(); } catch {}
        return false;
    }
}