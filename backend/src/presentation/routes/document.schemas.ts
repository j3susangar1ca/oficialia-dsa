/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Esquemas Zod de Request/Reply — Rutas de Documentos
 * Versión: 1.0.0-MVP
 *
 * Consumidos por `document.routes.ts` a través de `FastifyTypeProviderZod`: Fastify
 * valida el request contra estos esquemas ANTES de que el handler se ejecute, y
 * serializa la respuesta usando el esquema de reply correspondiente (fast-json-stringify),
 * sin necesidad de tipar manualmente cada `FastifyRequest`/`FastifyReply`.
 */

import { z } from 'zod';

import { MetadatosOficioSchema } from '../../contracts/schemas/metadatosOficio.schema';

// ---------------------------------------------------------------------------
// Fragmentos reutilizables
// ---------------------------------------------------------------------------

const PaginaDimensionSchema = z.object({
  pageNumber: z.number().int().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  dpi: z.number().int().positive(),
});

const PreprocesoMetadataSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  fileSizeBytes: z.number().int().nonnegative(),
  sha256Hash: z.string().length(64),
  paginas: z.array(PaginaDimensionSchema),
  processingDurationMs: z.number().int().nonnegative(),
  isSanitized: z.boolean(),
});

const RpaEjecucionSchema = z.object({
  id: z.string().uuid(),
  documentoId: z.string().uuid(),
  folioAcuseInstitucional: z.string().nullable(),
  fechaEjecucion: z.string(),
  duracionMs: z.number().int().nonnegative(),
  capturaAcusePath: z.string().nullable(),
  intentos: z.number().int().nonnegative(),
  mensajeError: z.string().nullable(),
  exitoso: z.boolean(),
});

const GoogleSheetsSyncSchema = z.object({
  sincronizado: z.boolean(),
  filaIndex: z.number().int().positive().nullable(),
  timestampSincronizacion: z.string().nullable(),
  errorSincronizacion: z.string().nullable(),
});

/**
 * Reply canónico de `DocumentoRegistro`. Los campos `metadatos*` reutilizan
 * `MetadatosOficioSchema` en modo salida (sin `.default()` obligatorio: ya vienen
 * normalizados desde el dominio, por eso se envuelven en `.nullable()` directamente).
 */
export const DocumentoRegistroReplySchema = z.object({
  id: z.string().uuid(),
  nombreArchivoOriginal: z.string(),
  nombreArchivoCanonico: z.string().nullable(),
  rutaArchivoActual: z.string(),
  rutaEspejoJson: z.string().nullable(),
  origen: z.enum(['SCANNER_ADF', 'WEB_DRAG_DROP']),
  estado: z.enum([
    'PENDIENTE_PREPROCESO',
    'EN_PREPROCESO',
    'PENDIENTE_EXTRACCION',
    'EN_EXTRACCION',
    'PENDIENTE_REVISION',
    'EN_REVISION',
    'APROBADO_HITL',
    'EN_RPA',
    'COMPLETADO',
    'ERROR_PREPROCESO',
    'ERROR_EXTRACCION',
    'ERROR_RPA',
  ]),
  sha256Hash: z.string().length(64),
  metadatosExtraidos: MetadatosOficioSchema.nullable(),
  metadatosValidados: MetadatosOficioSchema.nullable(),
  preproceso: PreprocesoMetadataSchema.nullable(),
  rpa: RpaEjecucionSchema.nullable(),
  sheetsSync: GoogleSheetsSyncSchema,
  revisorUsuarioId: z.string().nullable(),
  fechaIngesta: z.string(),
  fechaValidacionHitl: z.string().nullable(),
  fechaFinalizacion: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

export const ErrorReplySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// POST /documents/upload
// ---------------------------------------------------------------------------

export const UploadQuerystringSchema = z.object({
  /** Canal de ingesta declarado por el cliente; por defecto WEB_DRAG_DROP (subida vía UI). */
  origen: z.enum(['SCANNER_ADF', 'WEB_DRAG_DROP']).default('WEB_DRAG_DROP'),
});

export const UploadAcceptedReplySchema = z.object({
  documentId: z.string().uuid(),
  status: z.literal('ACCEPTED'),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// POST /documents/:id/confirm
// ---------------------------------------------------------------------------

export const DocumentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const ConfirmDocumentBodySchema = z.object({
  /** Metadatos finales tal como los dejó el capturista en el panel derecho del Split-Screen. */
  metadata: MetadatosOficioSchema,
  /** Identificador del capturista autenticado que autoriza el registro. */
  userId: z.string().min(1),
  /** Versión leída por el cliente al abrir el documento (concurrencia optimista). */
  expectedVersion: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// POST /documents/:id/retry-rpa
// ---------------------------------------------------------------------------

export const RetryRpaBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// GET /documents (bandeja de trabajo)
// ---------------------------------------------------------------------------

export const ListDocumentsQuerystringSchema = z.object({
  estado: DocumentoRegistroReplySchema.shape.estado.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const ListDocumentsReplySchema = z.array(DocumentoRegistroReplySchema);
