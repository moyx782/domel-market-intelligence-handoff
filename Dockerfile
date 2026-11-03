# Production image for the trusted-network demo: one process serves the API and
# the built frontend. Secrets are provided at runtime (env_file / -e), never baked in.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    LOCAL_API_BIND=0.0.0.0 \
    LOCAL_API_PORT=8788 \
    SERVE_STATIC=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY supabase ./supabase
COPY seed ./seed
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8788/health >/dev/null || exit 1
CMD ["node", "server/local-api.mjs"]
