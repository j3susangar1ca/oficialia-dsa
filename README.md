# Oficialia-Digital-DSA

Middleware de digitalización, extracción por IA y RPA para la Oficialía de Partes de la
División de Servicios Administrativos (DSA) — Hospital Civil de Guadalajara.

Automatiza la ingesta de oficios (PDF), su preprocesamiento, la extracción estructurada
de metadatos con Gemini 2.5 Flash, la validación humana (HITL) en una UI Split-Screen, el
archivado canónico y la inyección automatizada en la Intranet institucional
(`op_cucs.fwx`) vía Playwright. Ver [`docs/prd.md`](./docs/prd.md) para el alcance
completo y los guardrails del proyecto.

## Estructura del repositorio

```
.
├── backend/    Servidor Fastify + Clean Architecture (Node.js 22 / TypeScript)
├── frontend/   UI Split-Screen HITL (Svelte 5 + Runes)
└── docs/       Especificación de diseño (PRD, contratos, tipos, system prompt) — ver docs/README.md
```

### `backend/` — Clean Architecture

```
backend/src/
├── contracts/        Puertos secundarios + tipos de dominio (fuente de verdad, ver docs/types.md y docs/contracts.md)
├── application/       DocumentWorkflowOrchestrator — casos de uso, sin detalles de infraestructura
├── infrastructure/    Adaptadores concretos de cada puerto (ai, pdf, storage, persistence, rpa, sync)
└── presentation/       Servidor Fastify, rutas HTTP, WebSocket — composition root (DI manual)
```

| Puerto (`contracts/`) | Adaptador (`infrastructure/`) | Estado |
| --- | --- | --- |
| `IFileStorageProvider` | `LocalFileStorageAdapter` (fs/promises) | ✅ Real |
| `IDocumentRepository` | `SqliteDocumentRepository` (better-sqlite3, WAL) | ✅ Real |
| `IPdfProcessorProvider` | `PythonPdfProcessorAdapter` (spawn de `scripts/pdf_worker.py`, PyMuPDF/Pillow) | ✅ Real |
| `IAIExtractorProvider` | `GeminiAIExtractorAdapter` (`@google/genai`, Gemini 2.5 Flash) | ✅ Real |
| `IRpaInjectionProvider` | `PlaywrightRpaInjectionAdapter` | ⚠️ Placeholder — ver docstring del archivo y `docs/rpa/webix_dump_for_qwen.json` |
| `IExternalSyncProvider` | `GoogleSheetsExternalSyncAdapter` | ⚠️ Placeholder — requiere Service Account de Google |

Los dos adaptadores marcados como placeholder cumplen el contrato exactamente (mismos
tipos, mismos códigos de error) para que el servidor arranque y el pipeline degrade con
errores tipados (`ERROR_RPA`, sincronización marcada como fallida) en vez de romperse.
Sustituirlos por una implementación real no requiere tocar el orquestador ni las rutas.

### `frontend/src/lib/`

```
frontend/src/lib/
├── state/documentState.svelte.ts   Estado reactivo del Split-Screen HITL (Runes: $state/$derived/$effect)
├── ws/                              Cliente WebSocket con reconexión + contrato de eventos
├── api/documentApiClient.ts        Cliente HTTP hacia backend/src/presentation/routes
├── schemas/                         Validación Zod del formulario HITL (cliente)
└── types.ts                         Espejo estructural de backend/src/contracts/types.ts
```

> `backend` y `frontend` son dos paquetes npm independientes (no hay workspace de tipos
> compartido todavía); los archivos espejados en `frontend/src/lib/{types.ts,ws/events.ts}`
> llevan una nota explicando por qué existen duplicados y qué mantener sincronizado.

## Desarrollo

### Backend

```bash
cd backend
npm install
cp .env.example .env   # completar GEMINI_API_KEY como mínimo
npm run dev             # tsx watch — http://localhost:3000
npm run typecheck
```

Requiere `python3` con `pymupdf` y `pillow` instalados (`pip install pymupdf pillow`)
para `scripts/pdf_worker.py`. Ver `.env.example` para todas las variables.

### Frontend

```bash
cd frontend
npm install
npm run check   # svelte-check sobre el store de runes
```

Este paquete contiene por ahora solo la capa de estado/datos (`src/lib/`); la UI Split-
Screen (visor `pdf.js` + formulario) es la siguiente entrega y se construirá como
componentes `.svelte` sobre `documentState.svelte.ts`.

## Pipeline de almacenamiento (`backend/storage/`)

```
storage/
├── 01_entrada/      Ingesta (watchfolder / drag-drop)
├── 02_en_proceso/   Documento bloqueado durante preprocesamiento, IA y HITL
├── 03_procesados/   Repositorio canónico YYYY/MM — PDF + .json espejo
└── 04_errores/      Documentos con fallos irrecuperables
```

## Documentación de diseño

Ver [`docs/README.md`](./docs/README.md) — PRD, contratos de los 6 puertos, modelo de
dominio y el system prompt de extracción, junto con la tabla de qué archivo de código
implementa cada uno.
