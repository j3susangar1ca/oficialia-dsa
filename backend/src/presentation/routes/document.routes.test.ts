/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Suite de pruebas HTTP para document.routes.ts
 * Runner: Vitest + `fastify.inject()` — sin abrir un puerto real. Antes de este archivo,
 * la capa HTTP (8 rutas) no tenía ninguna cobertura: solo existían tests de la capa de
 * aplicación (DocumentWorkflowOrchestrator.test.ts), que nunca ejercitan el mapeo de
 * errores tipados -> códigos HTTP ni la validación de request/response por Zod.
 *
 * Construye un Fastify real (mismo wiring de validador/serializador/error-handler que
 * `server.ts`) con implementaciones FAKE de `orchestrator`/`repository`/`storage` — nunca
 * toca SQLite, el filesystem real, ni ningún proceso externo.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { documentRoutes } from './document.routes';
import {
  PdfPreprocessFailedError,
  type DocumentWorkflowOrchestrator,
} from '../../application/DocumentWorkflowOrchestrator';
import type { IDocumentRepository } from '../../contracts/IDocumentRepository';
import type { IFileStorageProvider } from '../../contracts/IFileStorageProvider';
import type { DocumentoRegistro } from '../../contracts/types';

// --------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------

const nowIso = '2026-09-01T14:30:00.000Z';

function buildDocument(overrides: Partial<DocumentoRegistro> = {}): DocumentoRegistro {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    nombreArchivoOriginal: 'SCAN_20260901_0042.pdf',
    nombreArchivoCanonico: null,
    rutaArchivoActual: 'storage/02_en_proceso/doc-1.pdf',
    rutaEspejoJson: null,
    origen: 'WEB_DRAG_DROP',
    estado: 'PENDIENTE_REVISION',
    sha256Hash: 'a'.repeat(64),
    metadatosExtraidos: null,
    metadatosValidados: null,
    preproceso: null,
    rpa: null,
    sheetsSync: { sincronizado: false, filaIndex: null, timestampSincronizacion: null, errorSincronizacion: null },
    revisorUsuarioId: null,
    fechaIngesta: nowIso,
    fechaValidacionHitl: null,
    fechaFinalizacion: null,
    updatedAt: nowIso,
    version: 1,
    ...overrides,
  };
}

/** Construye un cuerpo multipart/form-data mínimo con un único campo de archivo. */
function buildMultipartUpload(opts: { filename: string; content: Buffer; mimetype?: string }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----oficialiaTestBoundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\nContent-Type: ${
        opts.mimetype ?? 'application/pdf'
      }\r\n\r\n`
    ),
    opts.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('document.routes', () => {
  let app: FastifyInstance;
  let orchestrator: {
    ingestAndExtract: ReturnType<typeof vi.fn>;
    confirmHitlAndExecutePipeline: ReturnType<typeof vi.fn>;
    retryRpaExecution: ReturnType<typeof vi.fn>;
    retryExtraction: ReturnType<typeof vi.fn>;
    retryPreprocess: ReturnType<typeof vi.fn>;
    findRelatedDocuments: ReturnType<typeof vi.fn>;
  };
  let repository: { findMany: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let storage: { readFile: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    orchestrator = {
      ingestAndExtract: vi.fn(),
      confirmHitlAndExecutePipeline: vi.fn(),
      retryRpaExecution: vi.fn(),
      retryExtraction: vi.fn(),
      retryPreprocess: vi.fn(),
      findRelatedDocuments: vi.fn(),
    };
    repository = { findMany: vi.fn(), findById: vi.fn() };
    storage = { readFile: vi.fn() };

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Mismo orden que server.ts: el errorHandler DEBE registrarse antes de las rutas —
    // ver el comentario extenso en server.ts sobre por qué (encapsulación de contexto
    // de Fastify al `register()`).
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      reply.code(statusCode).send({
        error: statusCode >= 500 ? 'Error interno del servidor' : error.message,
        code: (error as { code?: string }).code ?? 'INTERNAL_ERROR',
      });
    });

    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
    await app.register(documentRoutes, {
      orchestrator: orchestrator as unknown as DocumentWorkflowOrchestrator,
      repository: repository as unknown as IDocumentRepository,
      storage: storage as unknown as IFileStorageProvider,
      maxUploadBytes: 1024 * 1024, // 1 MiB — deliberadamente bajo para probar 413 sin payloads gigantes
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // GET /documents
  // ------------------------------------------------------------------
  describe('GET /documents', () => {
    it('devuelve 200 con la lista que retorna el repositorio', async () => {
      const docs = [buildDocument(), buildDocument({ id: '22222222-2222-4222-8222-222222222222' })];
      repository.findMany.mockResolvedValue(docs);

      const res = await app.inject({ method: 'GET', url: '/documents?estado=PENDIENTE_REVISION&limit=10&offset=0' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ estado: 'PENDIENTE_REVISION', limit: 10, offset: 0 })
      );
    });

    it('acepta el filtro `estados` como CSV y lo transforma en arreglo', async () => {
      repository.findMany.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/documents?estados=ERROR_PREPROCESO,ERROR_EXTRACCION,ERROR_RPA',
      });

      expect(res.statusCode).toBe(200);
      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ estados: ['ERROR_PREPROCESO', 'ERROR_EXTRACCION', 'ERROR_RPA'] })
      );
    });

    it('rechaza un `estado` fuera del enum con 400 (validación Zod del querystring)', async () => {
      const res = await app.inject({ method: 'GET', url: '/documents?estado=ESTADO_INVENTADO' });
      expect(res.statusCode).toBe(400);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // GET /documents/:id
  // ------------------------------------------------------------------
  describe('GET /documents/:id', () => {
    it('devuelve 200 con el documento cuando existe', async () => {
      const doc = buildDocument();
      repository.findById.mockResolvedValue(doc);

      const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}` });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(doc.id);
    });

    it('devuelve 404 con DOCUMENT_NOT_FOUND cuando no existe', async () => {
      repository.findById.mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/documents/11111111-1111-4111-8111-111111111111' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Documento no encontrado', code: 'DOCUMENT_NOT_FOUND' });
    });

    it('rechaza un id que no es UUID con 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/documents/no-es-un-uuid' });
      expect(res.statusCode).toBe(400);
      expect(repository.findById).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // GET /documents/:id/file
  // ------------------------------------------------------------------
  describe('GET /documents/:id/file', () => {
    it('devuelve el PDF como application/pdf', async () => {
      const doc = buildDocument();
      repository.findById.mockResolvedValue(doc);
      storage.readFile.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

      const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}/file` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(storage.readFile).toHaveBeenCalledWith(doc.rutaArchivoActual);
    });

    it('devuelve 404 sin tocar storage cuando el documento no existe', async () => {
      repository.findById.mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/documents/11111111-1111-4111-8111-111111111111/file' });

      expect(res.statusCode).toBe(404);
      expect(storage.readFile).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // POST /documents/upload
  // ------------------------------------------------------------------
  describe('POST /documents/upload', () => {
    it('202 + documentId cuando la ingesta tiene éxito', async () => {
      const doc = buildDocument({ estado: 'PENDIENTE_EXTRACCION' });
      orchestrator.ingestAndExtract.mockResolvedValue(doc);
      const { body, contentType } = buildMultipartUpload({
        filename: 'oficio.pdf',
        content: Buffer.from('%PDF-1.4 x'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload?origen=WEB_DRAG_DROP',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ documentId: doc.id, status: 'ACCEPTED', message: expect.any(String) });
      expect(orchestrator.ingestAndExtract).toHaveBeenCalledWith('oficio.pdf', 'WEB_DRAG_DROP', expect.any(Buffer));
    });

    it('400 cuando no se envía ningún archivo (multipart vacío)', async () => {
      const boundary = '----vacio';
      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(`--${boundary}--\r\n`),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('NO_FILE');
    });

    it('400 cuando el archivo no es PDF (ni por mimetype ni por extensión)', async () => {
      const { body, contentType } = buildMultipartUpload({
        filename: 'foto.png',
        content: Buffer.from('no importa'),
        mimetype: 'image/png',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_MIME_TYPE');
      expect(orchestrator.ingestAndExtract).not.toHaveBeenCalled();
    });

    it('413 cuando el archivo excede el límite configurado', async () => {
      // Nota: el límite lo aplica primero @fastify/multipart (`limits.fileSize`, cableado
      // en server.ts al mismo `env.maxUploadBytes`) — su propio error
      // (FST_REQ_FILE_TOO_LARGE) llega ANTES que el chequeo manual
      // `buffer.byteLength > maxUploadBytes` del handler, que en la práctica nunca se
      // alcanza mientras ambos límites compartan el mismo valor. Se prueba el
      // comportamiento observable (413), no el código de error interno de la librería.
      const { body, contentType } = buildMultipartUpload({
        filename: 'grande.pdf',
        content: Buffer.alloc(2 * 1024 * 1024, 'x'), // 2 MiB > el límite de 1 MiB del beforeEach
      });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(413);
      expect(orchestrator.ingestAndExtract).not.toHaveBeenCalled();
    });

    it('422 PDF_PREPROCESS_FAILED con el documentId cuando el orquestador lanza PdfPreprocessFailedError', async () => {
      orchestrator.ingestAndExtract.mockRejectedValue(
        new PdfPreprocessFailedError('33333333-3333-4333-8333-333333333333', 'Estructura de PDF corrupta')
      );
      const { body, contentType } = buildMultipartUpload({ filename: 'corrupto.pdf', content: Buffer.from('basura') });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: expect.stringContaining('Estructura de PDF corrupta'),
        code: 'PDF_PREPROCESS_FAILED',
        details: { documentId: '33333333-3333-4333-8333-333333333333' },
      });
    });

    it('409 DUPLICATE_DOCUMENT_HASH cuando el orquestador rechaza por duplicado', async () => {
      orchestrator.ingestAndExtract.mockRejectedValue(new Error('Documento duplicado detectado con hash: abc123'));
      const { body, contentType } = buildMultipartUpload({
        filename: 'repetido.pdf',
        content: Buffer.from('%PDF-1.4'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_DOCUMENT_HASH');
    });

    it('un error inesperado del orquestador cae al errorHandler global (500, sin filtrar el mensaje interno)', async () => {
      orchestrator.ingestAndExtract.mockRejectedValue(new Error('ENOSPC: no space left on device'));
      const { body, contentType } = buildMultipartUpload({ filename: 'x.pdf', content: Buffer.from('%PDF-1.4') });

      const res = await app.inject({
        method: 'POST',
        url: '/documents/upload',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Error interno del servidor');
      expect(res.json().error).not.toContain('ENOSPC');
    });
  });

  // ------------------------------------------------------------------
  // POST /documents/:id/confirm
  // ------------------------------------------------------------------
  describe('POST /documents/:id/confirm', () => {
    const validMetadata = {
      numeroOficio: 'DSA-1042-2026',
      fechaEmision: '2026-09-01',
      procedencia: 'HCG' as const,
      dependenciaArea: 'DIRECCIÓN GENERAL HCG',
      remitenteNombre: 'DR. JAIME GONZÁLEZ',
      destinatarioNombre: 'MTRO. LUIS PÉREZ',
      asunto: 'SOLICITUD DE DICTAMEN TÉCNICO.',
      plazoDias: 5,
      contieneDatosSensibles: false,
    };

    it('200 con el documento actualizado en el flujo feliz', async () => {
      const doc = buildDocument({ estado: 'APROBADO_HITL', version: 2 });
      orchestrator.confirmHitlAndExecutePipeline.mockResolvedValue(doc);

      const res = await app.inject({
        method: 'POST',
        url: `/documents/${doc.id}/confirm`,
        payload: { metadata: validMetadata, userId: 'USR-01', expectedVersion: 1 },
      });

      expect(res.statusCode).toBe(200);
      // El body pasa por MetadatosOficioSchema (validatorCompiler) antes del handler,
      // que rellena remitenteCargo/destinatarioCargo con su default ("NO ESPECIFICADO")
      // — match parcial en vez de igualdad exacta para no acoplar el test a ese detalle.
      expect(orchestrator.confirmHitlAndExecutePipeline).toHaveBeenCalledWith(
        doc.id,
        expect.objectContaining({ numeroOficio: 'DSA-1042-2026', asunto: validMetadata.asunto }),
        'USR-01',
        1
      );
    });

    it('409 CONCURRENCY_VERSION_CONFLICT cuando el orquestador lanza ese RepositoryError tipado', async () => {
      orchestrator.confirmHitlAndExecutePipeline.mockRejectedValue(
        Object.assign(new Error('El documento fue modificado por otro capturista'), {
          code: 'CONCURRENCY_VERSION_CONFLICT',
        })
      );

      const res = await app.inject({
        method: 'POST',
        url: '/documents/11111111-1111-4111-8111-111111111111/confirm',
        payload: { metadata: validMetadata, userId: 'USR-01', expectedVersion: 1 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONCURRENCY_VERSION_CONFLICT');
    });

    it('400 cuando el body no cumple el schema Zod (falta un campo requerido)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/documents/11111111-1111-4111-8111-111111111111/confirm',
        payload: { metadata: { ...validMetadata, numeroOficio: undefined }, userId: 'USR-01', expectedVersion: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(orchestrator.confirmHitlAndExecutePipeline).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // POST /documents/:id/retry-rpa, retry-extraction, retry-preprocess
  // — misma forma de contrato en las tres; se prueban en tabla.
  // ------------------------------------------------------------------
  describe.each([
    { url: 'retry-rpa', orchestratorMethod: 'retryRpaExecution' as const, invalidStateFragment: 'ERROR_RPA' },
    {
      url: 'retry-extraction',
      orchestratorMethod: 'retryExtraction' as const,
      invalidStateFragment: 'ERROR_EXTRACCION',
    },
    {
      url: 'retry-preprocess',
      orchestratorMethod: 'retryPreprocess' as const,
      invalidStateFragment: 'ERROR_PREPROCESO',
    },
  ])('POST /documents/:id/$url', ({ url, orchestratorMethod, invalidStateFragment }) => {
    it('200 con el documento actualizado en el flujo feliz', async () => {
      const doc = buildDocument({ version: 2 });
      orchestrator[orchestratorMethod].mockResolvedValue(doc);

      const res = await app.inject({
        method: 'POST',
        url: `/documents/${doc.id}/${url}`,
        payload: { expectedVersion: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(orchestrator[orchestratorMethod]).toHaveBeenCalledWith(doc.id, 1);
    });

    it('409 INVALID_STATE_FOR_RETRY cuando el documento no está en el estado esperado', async () => {
      orchestrator[orchestratorMethod].mockRejectedValue(
        new Error(`El documento no está en estado ${invalidStateFragment} (Estado actual: COMPLETADO)`)
      );

      const res = await app.inject({
        method: 'POST',
        url: `/documents/11111111-1111-4111-8111-111111111111/${url}`,
        payload: { expectedVersion: 1 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_STATE_FOR_RETRY');
    });

    it('400 cuando expectedVersion no es un entero positivo', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/documents/11111111-1111-4111-8111-111111111111/${url}`,
        payload: { expectedVersion: 0 },
      });
      expect(res.statusCode).toBe(400);
      expect(orchestrator[orchestratorMethod]).not.toHaveBeenCalled();
    });
  });

  it('retry-preprocess: 422 PDF_PREPROCESS_FAILED cuando el archivo sigue corrupto tras reintentar', async () => {
    orchestrator.retryPreprocess.mockRejectedValue(
      new PdfPreprocessFailedError('11111111-1111-4111-8111-111111111111', 'Sigue corrupto')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/documents/11111111-1111-4111-8111-111111111111/retry-preprocess',
      payload: { expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('PDF_PREPROCESS_FAILED');
  });

  // ------------------------------------------------------------------
  // GET /documents/:id/related — nunca debe fallar aunque el puerto semántico no esté listo
  // ------------------------------------------------------------------
  describe('GET /documents/:id/related', () => {
    it('200 con el resultado de degradación cuando el modelo aún no está listo', async () => {
      orchestrator.findRelatedDocuments.mockResolvedValue({
        documentos: [],
        totalVectoresComparados: 0,
        duracionMs: 0,
        modeloEstado: 'CARGANDO',
      });

      const res = await app.inject({ method: 'GET', url: '/documents/11111111-1111-4111-8111-111111111111/related' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        documentos: [],
        totalVectoresComparados: 0,
        duracionMs: 0,
        modeloEstado: 'CARGANDO',
      });
    });
  });
});
