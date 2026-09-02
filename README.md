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
├── infrastructure/    Adaptadores concretos de cada puerto (ai, pdf, storage, persistence, rpa, semantic, sync)
└── presentation/       Servidor Fastify, rutas HTTP, WebSocket — composition root (DI manual)
```

| Puerto (`contracts/`) | Adaptador (`infrastructure/`) | Estado |
| --- | --- | --- |
| `IFileStorageProvider` | `LocalFileStorageAdapter` (fs/promises) | ✅ Real |
| `IDocumentRepository` | `SqliteDocumentRepository` (better-sqlite3, WAL) | ✅ Real |
| `IPdfProcessorProvider` | `PythonPdfProcessorAdapter` (spawn de `scripts/pdf_worker.py`, PyMuPDF/Pillow) | ✅ Real |
| `IAIExtractorProvider` | `GeminiAIExtractorAdapter` (`@google/genai`, Gemini 2.5 Flash) | ✅ Real |
| `IRpaInjectionProvider` | `PlaywrightRpaInjectionAdapter` (default) / `PlaywrightRpaAdapter` (`RPA_MODE=playwright`) | ✅ Real, detrás de flag — ver más abajo |
| `IExternalSyncProvider` | `GoogleSheetsExternalSyncAdapter` | ⚠️ Placeholder — requiere Service Account de Google |
| `ILocalSemanticProvider` (P1) | `LocalSemanticMatcherAdapter` (`@xenova/transformers`, `Xenova/bge-m3`) | ✅ Real, cableado — ver más abajo |

El adaptador de sincronización con Sheets, marcado como placeholder, cumple el contrato
exactamente (mismos tipos, mismos códigos de error) para que el servidor arranque y el
pipeline degrade con la sincronización marcada como fallida en vez de romperse.
Sustituirlo por una implementación real no requiere tocar el orquestador ni las rutas.

**RPA**: `presentation/server.ts` cablea `PlaywrightRpaInjectionAdapter` por defecto — un
stub honesto que nunca lanza un navegador y reporta `checkIntranetHealth() === false`.
`backend/src/infrastructure/rpa/PlaywrightRpaAdapter.ts` es la automatización real contra
`op_cucs.fwx` (selectores Webix mapeados desde `docs/rpa/webix_dump_for_qwen.json`); se
activa con `RPA_MODE=playwright` en `.env` (ver `.env.example`), tras
`npm run rpa:install-browsers` (Chromium de Playwright) y las credenciales/CVEs
institucionales. No ha sido validada contra la Intranet real — revisar selectores y
campos antes de usarla en producción.

**Búsqueda semántica local (Puerto 7, P1)**: `docs/prd.md` §2.2 la incluye como Fase
Complementaria — sugiere al capturista oficios relacionados por similitud semántica
(dependencia + remitente + asunto), complementando el match exacto por folio/hash. El
puerto vive en `backend/src/contracts/ILocalSemanticProvider.ts` (igual que los otros
6); su adaptador (`infrastructure/semantic/LocalSemanticMatcherAdapter.ts`, sobre
`@xenova/transformers` y `Xenova/bge-m3` cuantizado) se cablea siempre en
`server.ts`, reutilizando la misma conexión SQLite que `SqliteDocumentRepository`
(`embeddings_schema.sql` se ejecuta junto a `schema.sql`). Instanciarlo es barato: el
modelo ONNX (~cientos de MB) solo se descarga/carga de forma perezosa en la primera
indexación o búsqueda real, nunca al arrancar el servidor. Indexación: automática y en
segundo plano tras cada confirmación HITL (un fallo de inferencia local nunca bloquea
RPA/Sheets). Búsqueda: `GET /documents/:id/related` — nunca lanza error si el modelo
aún no está listo, degrada a `documentos: []` con `modeloEstado` explícito.

### `frontend/src/`

```
frontend/src/
├── App.svelte                       Composition root: bandeja PENDIENTE_REVISION + HitlReviewView
├── main.ts                          Entry point de Vite (monta App.svelte en #app)
└── lib/
    ├── components/HitlReviewView.svelte  Split-Screen HITL: visor PDF.js + formulario reactivo
    ├── state/documentState.svelte.ts     Estado reactivo (Runes: $state/$derived/$effect)
    ├── ws/                                Cliente WebSocket con reconexión + contrato de eventos
    ├── api/documentApiClient.ts          Cliente HTTP hacia backend/src/presentation/routes
    ├── schemas/                           Validación Zod del formulario HITL (cliente)
    └── types.ts                           Espejo estructural de backend/src/contracts/types.ts
```

> `App.svelte` llama a `DocumentApiClient.confirmDocument()` directamente en su
> `onconfirm`, en vez de `DocumentHitlState.submitConfirmation()`: `HitlReviewView`
> mantiene su propio `$state` de formulario y no escribe en `hitl.document.draft`.
> Unificar ambos (que el componente escriba vía `hitl.updateDraftField` y use
> `hitl.canSubmit`/`hitl.submitConfirmation`) sigue pendiente — ver el comentario al
> inicio de `App.svelte`.

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
npm run test            # vitest — suite de DocumentWorkflowOrchestrator
npm run rpa:install-browsers  # solo si vas a usar RPA_MODE=playwright
```

Requiere `python3` con `pymupdf` y `pillow` instalados (`pip install pymupdf pillow`)
para `scripts/pdf_worker.py`. Ver `.env.example` para todas las variables.

### Frontend

```bash
cd frontend
npm install
npm run dev      # Vite — http://localhost:5173 (VITE_API_BASE_URL apunta al backend)
npm run check    # svelte-check
npm run build    # build de producción
```

## Pipeline de almacenamiento (`backend/storage/`)

```
storage/
├── 01_entrada/      Ingesta (watchfolder / drag-drop)
├── 02_en_proceso/   Documento bloqueado durante preprocesamiento, IA y HITL
├── 03_procesados/   Repositorio canónico YYYY/MM — PDF + .json espejo
└── 04_errores/      Documentos con fallos irrecuperables
```

## Documentación de diseño

Ver [`docs/README.md`](./docs/README.md) — PRD, contratos de los 7 puertos, modelo de
dominio y el system prompt de extracción, junto con la tabla de qué archivo de código
implementa cada uno.
