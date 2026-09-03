# SISTEMA OFICIALIA-DIGITAL-DSA — Imagen del frontend (Svelte 5 estático + Nginx)
#
# Vite hornea `VITE_API_BASE_URL` en el bundle en tiempo de BUILD (no de arranque del
# contenedor) — hay que pasarlo como build arg apuntando a donde el navegador del
# capturista pueda alcanzar al backend (LAN hospitalaria, prd.md §2), no `localhost`.
#
# Build (desde la raíz del monorepo — necesita el contexto completo por ser workspaces):
#   docker build -f frontend/Dockerfile \
#     --build-arg VITE_API_BASE_URL=http://oficialia-backend.hcg.local:3000 \
#     -t oficialia-frontend .
# Run:
#   docker run -p 8080:80 oficialia-frontend

# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace=frontend

FROM nginx:1.27-alpine AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
