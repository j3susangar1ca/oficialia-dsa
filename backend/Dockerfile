# SISTEMA OFICIALIA-DIGITAL-DSA — Imagen del backend (Fastify + worker Python)
#
# El README describía el despliegue solo en prosa ("systemd o pm2", sección 7) — no
# había ningún Dockerfile pese a que el sistema mezcla Node.js (orquestador) y Python
# (worker de preprocesamiento PyMuPDF/Pillow, invocado por subproceso), lo que hace que
# "instalar las dos runtimes correctamente" sea justamente el tipo de cosa que vale la
# pena empaquetar una sola vez.
#
# Base Debian ("bookworm-slim"), NO Alpine: better-sqlite3 y onnxruntime-node
# (dependencia nativa de @xenova/transformers, Puerto 7 P1) son módulos nativos —
# Alpine usa musl libc y frecuentemente carece de binarios prebuild para esa combinación,
# obligando a compilar desde código fuente (build lento y fragil). glibc de Debian tiene
# mejor cobertura de prebuilds.
#
# Playwright (RPA_MODE=playwright) es OPCIONAL: por default (RPA_MODE=stub) el sistema
# nunca lanza un navegador, así que los ~300MB+ de Chromium + dependencias del sistema no
# se instalan a menos que se pida explícitamente:
#   docker build --build-arg INSTALL_PLAYWRIGHT_BROWSERS=true -t oficialia-backend .
#
# Build (desde la raíz del monorepo — necesita el contexto completo por ser workspaces):
#   docker build -f backend/Dockerfile -t oficialia-backend .
# Run:
#   docker run -p 3000:3000 --env-file backend/.env \
#     -v $(pwd)/backend/storage:/app/backend/storage \
#     -v $(pwd)/backend/data:/app/backend/data \
#     oficialia-backend

# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Etapa 1: deps — instala TODAS las dependencias del workspace (dev incluido, se
# necesitan para compilar TypeScript) usando el lockfile del monorepo completo.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# Etapa 2: build — compila el backend y poda las devDependencies del árbol YA
# resuelto por el lockfile (más confiable que un segundo `npm install --omit=dev`
# en una etapa aparte, que podría resolver versiones ligeramente distintas).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY backend backend
RUN npm run build --workspace=backend
RUN npm prune --omit=dev
# Nota: esto también deja las dependencias de PRODUCCIÓN de frontend/ (pdfjs-dist, zod)
# en node_modules — el monorepo no aísla node_modules por workspace. No se usan en
# runtime (el backend no importa nada de frontend/), solo suman unos MB de más a la
# imagen; optimizarlo requeriría instalar cada workspace por separado desde el lockfile,
# fuera del alcance de esta primera versión del Dockerfile.

# ---------------------------------------------------------------------------
# Etapa 3: runtime — imagen final. Python 3 + venv aislado para pdf_worker.py (nunca se
# mezcla con el Python del sistema), usuario sin privilegios, healthcheck sobre /health.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ARG INSTALL_PLAYWRIGHT_BROWSERS=false
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY backend/scripts/requirements.txt backend/scripts/requirements.txt
RUN python3 -m venv /opt/pdf-worker-venv \
    && /opt/pdf-worker-venv/bin/pip install --no-cache-dir -r backend/scripts/requirements.txt
# PythonPdfProcessorAdapter invoca `spawn(env.pythonBin, [scriptPath, ...])` — apuntarlo
# al intérprete del venv aislado en vez de `python3` del sistema.
ENV PYTHON_BIN=/opt/pdf-worker-venv/bin/python3

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/dist backend/dist
COPY backend/scripts backend/scripts

# Chromium + dependencias del sistema para PlaywrightRpaAdapter (RPA_MODE=playwright) —
# omitido por default: ver el comentario de INSTALL_PLAYWRIGHT_BROWSERS arriba.
RUN if [ "$INSTALL_PLAYWRIGHT_BROWSERS" = "true" ]; then \
      npx --prefix /app playwright install --with-deps chromium; \
    fi

RUN mkdir -p backend/storage/01_entrada backend/storage/02_en_proceso \
      backend/storage/03_procesados backend/storage/04_errores backend/data \
    && groupadd --system oficialia && useradd --system --gid oficialia --home /app oficialia \
    && chown -R oficialia:oficialia /app
USER oficialia

ENV PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_ROOT=backend/storage \
    DATABASE_PATH=backend/data/oficialia.db \
    PDF_WORKER_SCRIPT_PATH=backend/scripts/pdf_worker.py

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/presentation/server.js"]
