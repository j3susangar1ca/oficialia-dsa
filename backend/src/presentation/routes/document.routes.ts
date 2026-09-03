/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Rutas HTTP de Documentos (Fastify, composición funcional — sin decoradores)
 * Versión: 1.0.0-MVP
 *
 * Cada ruta es un handler puro que:
 *   1. Recibe request/reply ya validados y tipados por `FastifyTypeProviderZod`
 *      (los esquemas de `document.schemas.ts` corren ANTES del handler).
 *   2. Delega toda la lógica de negocio al `DocumentWorkflowOrchestrator` inyectado.
 *   3. Traduce errores tipados del dominio (RepositoryError, StorageError, …) a códigos
 *      HTTP — la única responsabilidad de presentación que le corresponde a esta capa.
 *
 * Las dependencias (orquestador, repositorio, límites) se reciben como argumento del
 * plugin (`opts`), NUNCA vía decorador (`fastify.decorate`) — Inyección de Dependencias
 * explícita por composición, conforme a la restricción del enunciado.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  PdfPreprocessFailedError,
  type DocumentWorkflowOrchestrator,
} from '../../application/DocumentWorkflowOrchestrator';
import type { IDocumentRepository, RepositoryErrorCode } from '../../contracts/IDocumentRepository';
import type { IFileStorageProvider } from '../../contracts/IFileStorageProvider';
import type { DocumentoRegistro } from '../../contracts/types';
import {
  ConfirmDocumentBodySchema,
  DocumentIdParamsSchema,
  DocumentoRegistroReplySchema,
  ErrorReplySchema,
  ListDocumentsQuerystringSchema,
  ListDocumentsReplySchema,
  PreprocessFailedReplySchema,
  RelatedDocumentsQuerystringSchema,
  RelatedDocumentsReplySchema,
  RetryExtractionBodySchema,
  RetryPreprocessBodySchema,
  RetryRpaBodySchema,
  UploadAcceptedReplySchema,
  UploadQuerystringSchema,
} from './document.schemas';

export interface DocumentRoutesOptions {
  orchestrator: DocumentWorkflowOrchestrator;
  repository: IDocumentRepository;
  storage: IFileStorageProvider;
  /** Límite duro de tamaño de archivo (bytes), coherente con el límite de @fastify/multipart. */
  maxUploadBytes: number;
}

const REPOSITORY_ERROR_STATUS: Record<RepositoryErrorCode, 404 | 409 | 500 | 503> = {
  DOCUMENT_NOT_FOUND: 404,
  DUPLICATE_DOCUMENT_HASH: 409,
  DUPLICATE_FOLIO_REGISTERED: 409,
  CONCURRENCY_VERSION_CONFLICT: 409,
  PERSISTENCE_TRANSACTION_FAILED: 500,
  DATABASE_BUSY_TIMEOUT: 503,
};

/** Type guard estructural: no depende de la clase concreta del adaptador SQLite. */
function isTypedRepositoryError(error: unknown): error is { code: RepositoryErrorCode; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code in REPOSITORY_ERROR_STATUS
  );
}

export const documentRoutes: FastifyPluginAsync<DocumentRoutesOptions> = async (fastify, opts) => {
  const { orchestrator, repository, storage, maxUploadBytes } = opts;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------
  // GET /documents — bandeja de trabajo (filtros por estado, paginación)
  // -------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/documents',
    schema: {
      querystring: ListDocumentsQuerystringSchema,
      response: { 200: ListDocumentsReplySchema },
    },
    handler: async (request, reply) => {
      const { estado, estados, limit, offset } = request.query;
      const documents = await repository.findMany({ estado, estados, limit, offset });
      return reply.code(200).send(documents as DocumentoRegistro[]);
    },
  });

  // -------------------------------------------------------------------
  // GET /documents/:id — detalle para hidratar el Split-Screen HITL
  // -------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/documents/:id',
    schema: {
      params: DocumentIdParamsSchema,
      response: { 200: DocumentoRegistroReplySchema, 404: ErrorReplySchema },
    },
    handler: async (request, reply) => {
      const document = await repository.findById(request.params.id);
      if (!document) {
        return reply.code(404).send({ error: 'Documento no encontrado', code: 'DOCUMENT_NOT_FOUND' });
      }
      return reply.code(200).send(document as DocumentoRegistro);
    },
  });

  // -------------------------------------------------------------------
  // GET /documents/:id/related — oficios relacionados por similitud semántica
  // (Puerto 7, ILocalSemanticProvider, P1 — ver docs/prd.md §2.2). Nunca lanza
  // ERROR_INFERENCIA/arranque-en-frío al cliente: degrada a `documentos: []`.
  // -------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/documents/:id/related',
    schema: {
      params: DocumentIdParamsSchema,
      querystring: RelatedDocumentsQuerystringSchema,
      response: { 200: RelatedDocumentsReplySchema },
    },
    handler: async (request, reply) => {
      const result = await orchestrator.findRelatedDocuments(request.params.id, request.query);
      return reply.code(200).send(result);
    },
  });

  // -------------------------------------------------------------------
  // GET /documents/:id/file — bytes del PDF para el visor pdf.js del Split-Screen
  // -------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/documents/:id/file',
    schema: {
      params: DocumentIdParamsSchema,
      // Sin `response` schema: el cuerpo es un binario PDF, no JSON — fast-json-stringify
      // no debe intentar serializarlo.
    },
    handler: async (request, reply) => {
      const document = await repository.findById(request.params.id);
      if (!document) {
        return reply.code(404).send({ error: 'Documento no encontrado', code: 'DOCUMENT_NOT_FOUND' });
      }
      const bytes = await storage.readFile(document.rutaArchivoActual);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Cache-Control', 'private, max-age=60')
        .send(Buffer.from(bytes));
    },
  });

  // -------------------------------------------------------------------
  // POST /documents/upload — recepción de oficio, arranque de pipeline asíncrona
  // -------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/documents/upload',
    schema: {
      querystring: UploadQuerystringSchema,
      response: {
        202: UploadAcceptedReplySchema,
        400: ErrorReplySchema,
        409: ErrorReplySchema,
        413: ErrorReplySchema,
        422: PreprocessFailedReplySchema,
      },
    },
    handler: async (request, reply) => {
      const filePart = await request.file();
      if (!filePart) {
        return reply
          .code(400)
          .send({ error: 'No se recibió ningún archivo (campo multipart esperado).', code: 'NO_FILE' });
      }
      if (filePart.mimetype !== 'application/pdf' && !filePart.filename.toLowerCase().endsWith('.pdf')) {
        return reply.code(400).send({ error: 'Solo se aceptan oficios en formato PDF.', code: 'INVALID_MIME_TYPE' });
      }

      const buffer = await filePart.toBuffer();
      if (buffer.byteLength === 0) {
        return reply.code(400).send({ error: 'El archivo recibido está vacío.', code: 'EMPTY_FILE' });
      }
      if (buffer.byteLength > maxUploadBytes) {
        return reply
          .code(413)
          .send({ error: `El archivo excede el límite de ${maxUploadBytes} bytes.`, code: 'FILE_TOO_LARGE' });
      }

      try {
        const record = await orchestrator.ingestAndExtract(filePart.filename, request.query.origen, buffer);
        return reply.code(202).send({
          documentId: record.id,
          status: 'ACCEPTED' as const,
          message: 'Oficio recibido. La extracción de metadatos continúa en segundo plano (ver WebSocket).',
        });
      } catch (error) {
        request.log.error({ err: error }, 'Fallo al ingerir oficio');
        if (error instanceof PdfPreprocessFailedError) {
          // El registro ERROR_PREPROCESO ya quedó persistido y el archivo aislado en
          // storage/04_errores/ (ver DocumentWorkflowOrchestrator.recordPreprocessFailure)
          // — se devuelve 422 con el documentId para que la UI navegue directo a él en
          // vez de mostrar solo un mensaje de error suelto.
          return reply
            .code(422)
            .send({ error: error.message, code: 'PDF_PREPROCESS_FAILED', details: { documentId: error.documentId } });
        }
        if (error instanceof Error && /duplicado/i.test(error.message)) {
          return reply.code(409).send({ error: error.message, code: 'DUPLICATE_DOCUMENT_HASH' });
        }
        throw error; // delegado al errorHandler global (500)
      }
    },
  });

  // -------------------------------------------------------------------
  // POST /documents/:id/confirm — validación HITL final + disparo de RPA
  // -------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/documents/:id/confirm',
    schema: {
      params: DocumentIdParamsSchema,
      body: ConfirmDocumentBodySchema,
      response: {
        200: DocumentoRegistroReplySchema,
        404: ErrorReplySchema,
        409: ErrorReplySchema,
        500: ErrorReplySchema,
        503: ErrorReplySchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const { metadata, userId, expectedVersion } = request.body;

      try {
        const updated = await orchestrator.confirmHitlAndExecutePipeline(id, metadata, userId, expectedVersion);
        return reply.code(200).send(updated as DocumentoRegistro);
      } catch (error) {
        if (isTypedRepositoryError(error)) {
          return reply.code(REPOSITORY_ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
        }
        if (error instanceof Error && /no encontrado/i.test(error.message)) {
          return reply.code(404).send({ error: error.message, code: 'DOCUMENT_NOT_FOUND' });
        }
        throw error;
      }
    },
  });

  // -------------------------------------------------------------------
  // POST /documents/:id/retry-rpa — reintento de inyección tras ERROR_RPA
  // -------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/documents/:id/retry-rpa',
    schema: {
      params: DocumentIdParamsSchema,
      body: RetryRpaBodySchema,
      response: {
        200: DocumentoRegistroReplySchema,
        404: ErrorReplySchema,
        409: ErrorReplySchema,
        500: ErrorReplySchema,
        503: ErrorReplySchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const { expectedVersion } = request.body;

      try {
        const updated = await orchestrator.retryRpaExecution(id, expectedVersion);
        return reply.code(200).send(updated as DocumentoRegistro);
      } catch (error) {
        if (isTypedRepositoryError(error)) {
          return reply.code(REPOSITORY_ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
        }
        if (error instanceof Error && /no encontrado|no está en estado ERROR_RPA/i.test(error.message)) {
          return reply.code(409).send({ error: error.message, code: 'INVALID_STATE_FOR_RETRY' });
        }
        throw error;
      }
    },
  });

  // -------------------------------------------------------------------
  // POST /documents/:id/retry-extraction — reintento de render + extracción IA
  // tras ERROR_EXTRACCION (p. ej. timeout de Gemini) — antes no existía ninguna
  // vía de recuperación para este estado más que volver a subir el PDF a mano.
  // -------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/documents/:id/retry-extraction',
    schema: {
      params: DocumentIdParamsSchema,
      body: RetryExtractionBodySchema,
      response: {
        200: DocumentoRegistroReplySchema,
        404: ErrorReplySchema,
        409: ErrorReplySchema,
        500: ErrorReplySchema,
        503: ErrorReplySchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const { expectedVersion } = request.body;

      try {
        const updated = await orchestrator.retryExtraction(id, expectedVersion);
        return reply.code(200).send(updated as DocumentoRegistro);
      } catch (error) {
        if (isTypedRepositoryError(error)) {
          return reply.code(REPOSITORY_ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
        }
        if (error instanceof Error && /no encontrado|no está en estado ERROR_EXTRACCION/i.test(error.message)) {
          return reply.code(409).send({ error: error.message, code: 'INVALID_STATE_FOR_RETRY' });
        }
        throw error;
      }
    },
  });

  // -------------------------------------------------------------------
  // POST /documents/:id/retry-preprocess — reintento de PyMuPDF/Pillow tras
  // ERROR_PREPROCESO (PDF corrupto o con contraseña). Simetría con retry-extraction y
  // retry-rpa: antes de esta ruta, ERROR_PREPROCESO no tenía ninguna vía de
  // recuperación más que volver a subir el archivo desde cero (perdiendo el registro
  // aislado en storage/04_errores/).
  // -------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/documents/:id/retry-preprocess',
    schema: {
      params: DocumentIdParamsSchema,
      body: RetryPreprocessBodySchema,
      response: {
        200: DocumentoRegistroReplySchema,
        404: ErrorReplySchema,
        409: ErrorReplySchema,
        422: PreprocessFailedReplySchema,
        500: ErrorReplySchema,
        503: ErrorReplySchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const { expectedVersion } = request.body;

      try {
        const updated = await orchestrator.retryPreprocess(id, expectedVersion);
        return reply.code(200).send(updated as DocumentoRegistro);
      } catch (error) {
        if (error instanceof PdfPreprocessFailedError) {
          return reply
            .code(422)
            .send({ error: error.message, code: 'PDF_PREPROCESS_FAILED', details: { documentId: error.documentId } });
        }
        if (isTypedRepositoryError(error)) {
          return reply.code(REPOSITORY_ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
        }
        if (error instanceof Error && /no encontrado|no está en estado ERROR_PREPROCESO/i.test(error.message)) {
          return reply.code(409).send({ error: error.message, code: 'INVALID_STATE_FOR_RETRY' });
        }
        throw error;
      }
    },
  });
};
