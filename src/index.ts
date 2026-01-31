import { start } from './helper/initialize.helper';
import { startHttpServer } from './server';

async function bootstrap() {
  try {
    await start();
    startHttpServer();
    // Keep process alive
    setInterval(() => { }, 1 << 30);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to start mediator', err);
    process.exit(1);
  }
}

bootstrap();

