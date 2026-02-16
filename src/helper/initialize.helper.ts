import * as apiConf from '../config/config.json';
import * as mediatorConfig from '../config/mediator.json';
import * as medUtils from 'openhim-mediator-utils';
import * as winston from 'winston';
import { consumeFromRabbitmq, createPublisherQueueToRabbit } from '../rabbitHelper/consumer';
import { initRabbitmq } from '../rabbitHelper/rabbitmq';
import { Console } from 'console';

// Ensure winston has at least a console transport to avoid memory warning
winston.configure({
    transports: [
        new (winston.transports as any).Console({
            level: 'info'
        })
    ]
});


// Config
var config: any = {}

export function start() {
    if (apiConf.register) {

        medUtils.registerMediator(apiConf.api, mediatorConfig, (err: any) => {

            if (err) {
                console.log("errrr")
                console.log(err)
                winston.error('Failed to register this mediator, check your config')
                // Graceful fallback: continue with local configuration instead of exiting
                winston.warn('Proceeding with local mediator.json configuration due to registration failure')
                setupApp().catch((e) => {
                    winston.error('Failed to setup app with local config after registration failure');
                    console.error(e);
                    process.exit(1);
                });
                return;
            }

            apiConf.api.urn = mediatorConfig.urn
            medUtils.fetchConfig(apiConf.api, (err, newConfig) => {
                winston.info('Received initial config:')
                winston.info(JSON.stringify(newConfig))
                var config = newConfig
                if (err) {
                    winston.error('Failed to fetch initial config')
                    winston.error(err.stack)
                    process.exit(1)
                } else {
                    winston.info('Successfully registered mediator!')
                    let app = setupApp()
                    if (apiConf.heartbeat) {
                        let configEmitter = medUtils.activateHeartbeat(apiConf.api)
                        configEmitter.on('config', (newConfig: any) => {
                            winston.info('Received updated config:')
                            winston.info(JSON.stringify(newConfig))
                            config = newConfig
                            winston.info(config)
                            ProcessConsumeToQueue();
                            createpublisherQueue();
                        })
                    }
                }
            })
        });
    } else {
        // Local-only run: skip OpenHIM registration and use local mediator.json
        winston.info('Starting mediator with local configuration (registration disabled)');
        setupApp().catch((e) => {
            winston.error('Failed to setup app with local config');
            console.error(e);
            process.exit(1);
        });
    }
}


export async function setupApp() {

    console.log("************ Start App Loaded***************");
    const configs: any = await getConfiguration();
    var port = (isNaN(configs.queueServer.port)) ? '' : (':' + configs.queueServer.port);
    var queueServer = configs.queueServer.host + port;

    if (configs.queueServer.username !== undefined && configs.queueServer.password !== undefined) {
        queueServer = configs.queueServer.username + ':' + configs.queueServer.password + '@' + queueServer;
    }
    if (configs.queueServer.VHOST !== undefined) {
        queueServer = queueServer + '/' + configs.queueServer.VHOST;
    }

    await initRabbitmq(queueServer);
    await ProcessConsumeToQueue();
    await createpublisherQueue();
    console.log("************ App loaded***************");
}

export function getConfiguration() {
    return new Promise(function (resolve, reject) {
        // If registration is disabled, prefer local config
        if (!apiConf.register) {
            return resolve((mediatorConfig as any).config);
        }

        medUtils.fetchConfig(apiConf.api, (error, newConfig) => {
            if (!error && newConfig) {
                resolve(newConfig);
            } else {
                // Fallback to local config when OpenHIM is unavailable
                winston.warn('Failed to fetch config from OpenHIM; falling back to local mediator.json config');
                resolve((mediatorConfig as any).config);
            }
        })

    });
}


export async function ProcessConsumeToQueue() {
    const configs: any = await getConfiguration();
    let destinations = configs.subQueues.filter((values: any) => values.queueStatus === 'RUN');


    var port = (isNaN(configs.queueServer.port)) ? '' : (':' + configs.queueServer.port);
    var queueServer = configs.queueServer.host + port;

    if (configs.queueServer.username !== undefined && configs.queueServer.password !== undefined) {
        queueServer = configs.queueServer.username + ':' + configs.queueServer.password + '@' + queueServer;
    }
    if (configs.queueServer.VHOST !== undefined) {
        queueServer = queueServer + '/' + configs.queueServer.VHOST;
    }

    for (let i = 0; i < destinations.length; i++) {
        winston.info(
            `Binding queue consumer ${destinations[i].queueName} -> ${destinations[i].channelHttpMethod || 'POST'
            } ${destinations[i].channelUrl}`,
        );
        await consumeFromRabbitmq(
            destinations[i].queueName,
            destinations[i].channelHttpMethod,
            destinations[i].channelUrl,
        );
    }
}


export async function createpublisherQueue() {
    const configs: any = await getConfiguration();
    const pubQueues = configs.pubQueues;

    for (let i = 0; i < pubQueues.length; i++) {
        createPublisherQueueToRabbit(pubQueues[i])
    }

}