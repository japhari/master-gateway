import { createServer } from 'http';
import { handleRequest } from './controllers/router';
import * as appConf from './config/config.json';

export function startHttpServer(port = Number((appConf as any).httpPort || process.env.HTTP_PORT || 8085)) {
    const server = createServer((req, res) => {
        handleRequest(req, res);
    });
    server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`HTTP server listening on port ${port}`);
    });
    return server;
}


