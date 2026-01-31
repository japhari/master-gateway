## Master Mediator (Node.js)

A Node.js mediator for OpenHIM integration that consumes RabbitMQ queues and forwards payloads to downstream systems. This project is based on the existing Muungano mediator, with optional routing via Government ESB using `govesb-connector-js`.

### Prerequisites

- Node.js 18+ and npm
- RabbitMQ accessible to the mediator
- OpenHIM (for mediator registration and config fetching)

### Install

```bash
npm install
```

If you encounter peer dependency conflicts, ensure `@nestjs/config` is `^4.x` (compatible with NestJS 11) and run:

```bash
npm install
```

### Configure

- `src/config/config.json`
  - OpenHIM credentials (`api`), mediator registration flags, and `httpPort` (the listener used by `src/server.ts`).
- `src/config/mediator.json`
  - **`queueServer`** → consumed by `rabbitmqService` / `publishService` when asserting queues.
  - **`subQueues`** → determines which queues are consumed; `channelUrl` may use `http`/`https` or the special `govesb:` scheme.
  - **`pubQueues`** → allow-list checked by `publishService.publish()`.
  - **`synchronousPath`** → routes for `/govesbmediator/:path` and `/getRequestFromGovesb/:path` handled by `synchronousService`.
  - **`synchronousPathTwo`** → GOVESB push-code mappings resolved by `govesbService.sendWithPushCode()` and endpoint `/sendToExternalSystemWithPushCode/:path`.
  - **`synchronousPullRequest`** → GOVESB connection-code mappings used by `/sendToExternalSystemWithConnectionCode/:path`.
  - **`adxServerPair` / `customAdxServerPair`** → available to ADX/DHIS integrations under `src/services`.
  - To route a consumed message through GOVESB, set a subscription `channelUrl` to the `govesb:` scheme, e.g. `"channelUrl": "govesb:SRVC0048"`.
  - **`govesb` (GovESB credentials)**:
    - **`clientPrivateKey` / `clientPublicKey` / `govesbPublicKey`**: paste the **raw base64 or PEM** values exactly as shown in the GOVESB UI (no file paths).
    - **`clientId` / `clientSecret`**: OAuth client credentials for GOVESB.
    - **`accessTokenUri` / `pushRequestUrl` / `responseRequestUrl` / `asyncRequestUrl`**: GOVESB demo/live URLs.
    - EC keys are validated at startup; **`prime256v1` and `secp256k1`** curves are supported.

### Project Layout

```
src/
  controllers/router.ts     # HTTP routes wired to services
  server.ts                 # creates the HTTP server using config.httpPort
  services/
    config.service.ts       # loads mediator.json via OpenHIM fetch
    publish.service.ts      # handles pubQueues + RabbitMQ publishing
    synchronous.service.ts  # synchronousPath GET/POST orchestration
    govesb.service.ts       # push-code / connection-code + govesb scheme
    http.service.ts         # shared axios helpers (was http/app.service.ts)
    ...                     # dhis2/adxserver/rabbitmq/jwt helpers
  helper/, rabbitHelper/, govesb/  # existing worker utilities
```

Each service reads from `configService` ensuring mediator configuration changes flow through a single place. Update `mediator.json` and restart the mediator to propagate new routes/queues.

### Run

```bash
# development (ts-node)
npm run start:dev

# build + run
npm run build && npm start
```

### Deployment

- **Non‑Docker deployment (bare metal / VM)**:

  - One‑shot helper script:

  ```bash
  chmod +x deploy.sh
  ./deploy.sh
  ```

  - This will:
    - Run `npm ci`
    - Build the TypeScript sources
    - Start the mediator with `NODE_ENV=production` and `npm run start:prod` on port `8090`.
  - For real production, wire `node dist/index.js` into a process manager (systemd, pm2, supervisord, etc.).

- **Docker deployment**:

  - Build and run just the mediator:

  ```bash
  docker build -t master-mediator .
  docker run --rm -p 8090:8090 master-mediator
  ```

  - With external RabbitMQ via `docker-compose`:

  ```bash
  docker compose up --build
  ```

  - RabbitMQ is expected to be installed outside this compose stack (on the host or elsewhere).  
    Set `queueServer.host` in `src/config/mediator.json` to a hostname reachable **from inside the container**, for example:
    - `host.docker.internal` if RabbitMQ runs on the Docker host.
    - A LAN IP or DNS name if RabbitMQ is remote.

### GOVESB Integration

- Library: `govesb-connector-js` (already added as a dependency).
- If this package is hosted in a private registry, configure your `.npmrc` with the appropriate registry and auth token before installing. The dependency is marked as optional; if it is not available, normal HTTP routing will continue to work, but `govesb:` URLs will fail at runtime.
- The wrapper in `src/govesb/govesb-client.ts`:
  - Instantiates `GovEsbHelper` with values from `govesb.service.ts` / config.
  - Builds `esbTokenUrl` from `accessTokenUri` and derives `esbEngineUrl` from `pushRequestUrl` (stripping `/push-request`).
  - Uses **`pushData`** for payloads containing a `pushCode`, otherwise uses **`requestData`** for API/connection-code flows.
  - Returns the verified GOVESB payload if the signature is valid; if verification fails it falls back to the raw ESB response so you can see the exact error from GOVESB.
- Usage patterns exposed by the HTTP controller:
  - `POST /govesb/:serviceCode` → sends to the given GOVESB service code directly.
  - `POST /govesbmediator/:path` and `GET /getRequestFromGovesb/:path` → use `synchronousPath` definitions (payloads must include signed envelopes).
  - `POST /sendToExternalSystemWithPushCode/:path` → maps `path` to `synchronousPathTwo` entry (`apiPushCode`/`apiCode` injected automatically).
  - `POST /sendToExternalSystemWithConnectionCode/:path` → maps `path` to `synchronousPullRequest` entry (`apiCode`/`connectionCode` injected automatically).
- Implementation detail:
  - GOVESB client wrapper lives in `src/services/govesb.service.ts` (uses `src/govesb/govesb-client.ts` under the hood).
  - RabbitMQ/GOVESB routing is centralized in `src/services` instead of scattered helpers.

#### GOVESB environment variables (override config)

At runtime, the following **env vars override** values from `mediator.json`:

- **`CLIENT_PRIVATE_KEY`**, **`GOVESB_PUBLIC_KEY`**, **`CLIENT_ID`**, **`CLIENT_SECRET`**
- **`ACCESS_TOKEN_URL`** or **`ACCESS_TOKEN_URI`**, **`PUSH_REQUEST`**, **`RESPONSE_REQUEST`**, **`ASYNC_REQUEST`**

Example:

```bash
export CLIENT_ID='40522034-be6a-11f0-956b-0925b481a971'
export CLIENT_SECRET='YOUR_SECRET'
export CLIENT_PRIVATE_KEY='MD4CQA...=='          # base64 or PEM
export GOVESB_PUBLIC_KEY='MFYwEA...=='           # base64 or PEM
export ACCESS_TOKEN_URL='https://esbdemo.gov.go.tz/gw/govesb-uaa/oauth/token'
export PUSH_REQUEST='https://esbdemo.gov.go.tz/engine/esb/push-request'
export RESPONSE_REQUEST='https://esbdemo.gov.go.tz/engine/esb/request'
export ASYNC_REQUEST='https://esbdemo.gov.go.tz/engine/esb/async'
```

#### GOVESB example calls

```bash
# Direct service-code call
curl -X POST http://localhost:8090/govesb/SRVC0048 \
  -H 'Content-Type: application/json' \
  -d '{"data":"example"}'

# Push-code mapping (uses synchronousPathTwo)
curl -X POST http://localhost:8090/sendToExternalSystemWithPushCode/tp-to-brela \
  -H 'Content-Type: application/json' \
  -d '{"data":"example"}'

# Connection-code mapping (uses synchronousPullRequest)
curl -X POST http://localhost:8090/sendToExternalSystemWithConnectionCode/basata_govesb \
  -H 'Content-Type: application/json' \
  -d '{"data":"example"}'
```

### Notes

- The mediator registers with OpenHIM at startup and fetches runtime configuration (queues, endpoints).
- Ensure `queueServer` is reachable and credentials are correct in `mediator.json`.

### RabbitMQ usage examples

- **Publish to a queue** (valid only if the queue name is in `pubQueues`):

```bash
curl -X POST http://localhost:8090/publish/TEST_QUEUE \
  -H 'Content-Type: application/json' \
  -d '{"hello":"rabbit","time":"now"}'
```

- **Subscribe and forward**:
  - Add a `subQueues` entry with `"queueStatus": "RUN"` and a `channelUrl`:
    - HTTP target: `"channelUrl": "http://localhost:5001/test-queue"`
    - GOVESB target: `"channelUrl": "govesb:SRVC0048"`
  - The consumer in `rabbitHelper/consumer.ts` will log `Received Message:` and forward the payload accordingly.

- **Failed-delivery handling**:
  - When forwarding from a subscription queue to HTTP/GOVESB fails (for example, `ECONNREFUSED` because the target is down), the original message is moved to a **failed queue** named `<SOURCE_QUEUE>_FAILED` (e.g. `TEST_QUEUE_FAILED`) instead of being lost.
  - The failed message envelope includes: `sourceQueue`, `failedAt`, `targetUrl`, a minimal `error` object, and the original `payload`.
  - You can inspect failed messages via the debug API:

```bash
curl -s http://localhost:8090/queue/TEST_QUEUE_FAILED/consume-one | jq .
```

- **Debug consumption API**:
  - `GET /queue/:queue/consume-one` performs a non-blocking `basic.get` with `noAck=true` and returns:
    - `success: true`, `message: "Message consumed"`, `esbBody` as parsed JSON (if possible), plus `raw` string.
    - If the queue is empty: `success: true`, `message: "No messages available"`, `esbBody: null`.

### Testing

```bash
npm run test
npm run test:e2e
npm run test:cov
```
