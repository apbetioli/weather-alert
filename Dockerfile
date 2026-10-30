FROM oven/bun:1-slim AS base
WORKDIR /app

# Install dependencies into temp directory to cache layer
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Production runner image
FROM base AS runner
WORKDIR /app

# Copy production node_modules and project source files
COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

# Expose Bull Board UI port
EXPOSE 3000

ENV NODE_ENV=production

# Run database migrations automatically before starting the app
CMD ["sh", "-c", "bun run src/db/migrate.ts && bun run src/index.ts"]
