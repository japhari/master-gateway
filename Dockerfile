FROM node:20.14.0-alpine AS node20

FROM node20 AS build

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy sources and build
COPY tsconfig*.json ./
COPY src ./src
COPY eslint.config.mjs ./eslint.config.mjs
RUN npm run build

# -----------------------------------------------------------------------------
# Runtime image
# -----------------------------------------------------------------------------
FROM node20

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled app
COPY --from=build /app/dist ./dist

# Copy configuration (JSON files are consumed at runtime)
COPY src/config ./src/config

EXPOSE 8090

CMD ["node", "dist/index.js"]


