/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Suite de pruebas unitarias / integración para DocumentWorkflowOrchestrator
 * Runner: Vitest
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { DocumentWorkflowOrchestrator } from './DocumentWorkflowOrchestrator';

import type {
  DocumentoRegistro,
  MetadatosOficio,
  PreprocesoMetadata,
  RpaEjecucion,
  GoogleSheetsSync,
  DocumentoEstado
} from '../contracts/types';

import type { IFileStorageProvider } from '../contracts/IFileStorageProvider';
import type {
  IDocumentRepository,
  RepositoryErrorCode
} from '../contracts/IDocumentRepository';
import type { IPdfProcessorProvider } from '../contracts/IPdfProcessorProvider';
import type { IAIExtractorProvider } from '../contracts/IAIExtractorProvider';
import type { IRpaInjectionProvider } from '../contracts/IRpaInjectionProvider';
import type { IExternalSyncProvider } from '../contracts/IExternalSyncProvider';

// Soporte para entornos donde crypto.randomUUID no esté globalmente disponible.
if (!(globalThis as any).crypto?.randomUUID) {
  vi.stubGlobal('crypto', { randomUUID });
}

type Mocked<T> = {
  [K in keyof T]: ReturnType<typeof vi.fn>;
};

class RepositoryError extends Error {
  constructor(
    public readonly code: RepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

// --------------------------------------------------------------------
// Fixtures de dominio
// --------------------------------------------------------------------

const nowIso = '2026-09-01T14:30:00.000Z';

const validMetadata: MetadatosOficio = {
  numeroOficio: 'DSA-1042-2026',
  fechaEmision: '2026-09-01',
  procedencia: 'HCG',
  dependenciaArea: 'DIRECCIÓN GENERAL HCG',
  remitenteNombre: 'DR. JAIME AGUSTÍN GONZÁLEZ ÁLVAREZ',
  remitenteCargo: 'DIRECTOR GENERAL',
  destinatarioNombre: 'MTRO. LUIS ALBERTO PÉREZ GÓMEZ',
  destinatarioCargo: 'DIRECTOR DE SERVICIOS ADMINISTRATIVOS',
  asunto:
    'SOLICITUD DE DICTAMEN TÉCNICO Y FINANCIERO PARA LA ADQUISICIÓN DE EQUIPO MÉDICO DE ALTA ESPECIALIDAD CORRESPONDIENTE AL EJERCICIO FISCAL 2026.',
  plazoDias: 5,
  contieneDatosSensibles: false
};

const preproceso: PreprocesoMetadata = {
  pageCount: 2,
  fileSizeBytes: 1_548_230,
  sha256Hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
  paginas: [
    { pageNumber: 1, widthPx: 2480, heightPx: 3508, dpi: 300 },
    { pageNumber: 2, widthPx: 2480, heightPx: 3508, dpi: 300 }
  ],
  processingDurationMs: 420,
  isSanitized: true
};

const sheetsSuccess: GoogleSheetsSync = {
  sincronizado: true,
  filaIndex: 142,
  timestampSincronizacion: '2026-09-01T14:35:12.800Z',
  errorSincronizacion: null
};

const rpaSuccess: RpaEjecucion = {
  id: 'f5b61a9c-0123-4e89-b123-cba987654321',
  documentoId: 'doc-1',
  folioAcuseInstitucional: 'HCG-OP-2026-009821',
  fechaEjecucion: '2026-09-01T14:35:10.120Z',
  duracionMs: 4150,
  capturaAcusePath: 'storage/03_procesados/2026/09/acuse_f5b61a9c.png',
  intentos: 1,
  mensajeError: null,
  exitoso: true
};

const canonicalStorageResult = {
  canonicalPdfPath:
    'storage/03_procesados/2026/09/2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.pdf',
  mirrorJsonPath:
    'storage/03_procesados/2026/09/2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.json',
  sha256Hash: preproceso.sha256Hash
};

const buildDocument = (
  overrides: Partial<DocumentoRegistro> = {}
): DocumentoRegistro => ({
  id: 'doc-1',
  nombreArchivoOriginal: 'SCAN_20260901_0042.pdf',
  nombreArchivoCanonico: null,
  rutaArchivoActual: 'storage/01_entrada/SCAN_20260901_0042.pdf',
  rutaEspejoJson: null,
  origen: 'SCANNER_ADF',
  estado: 'EN_PREPROCESO',
  sha256Hash: preproceso.sha256Hash,
  metadatosExtraidos: null,
  metadatosValidados: null,
  preproceso: null,
  rpa: null,
  sheetsSync: {
    sincronizado: false,
    filaIndex: null,
    timestampSincronizacion: null,
    errorSincronizacion: null
  },
  revisorUsuarioId: null,
  fechaIngesta: nowIso,
  fechaValidacionHitl: null,
  fechaFinalizacion: null,
  updatedAt: nowIso,
  version: 1,
  ...overrides
});

// --------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------

describe('DocumentWorkflowOrchestrator', () => {
  let orchestrator: DocumentWorkflowOrchestrator;

  let storage: Mocked<IFileStorageProvider>;
  let repository: Mocked<IDocumentRepository>;
  let pdfProcessor: Mocked<IPdfProcessorProvider>;
  let aiExtractor: Mocked<IAIExtractorProvider>;
  let rpa: Mocked<IRpaInjectionProvider>;
  let externalSync: Mocked<IExternalSyncProvider>;

  const pdfBuffer = new Uint8Array([1, 2, 3]);

  beforeEach(() => {
    vi.clearAllMocks();

    // ----------------------------------------------------------------
    // Mock IFileStorageProvider
    // ----------------------------------------------------------------
    storage = {
      saveIncoming: vi.fn(),
      moveToInProcess: vi.fn(),
      moveToCanonical: vi.fn(),
      moveToError: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn()
    };

    storage.saveIncoming.mockResolvedValue('storage/01_entrada/file.pdf');
    storage.moveToInProcess.mockResolvedValue('storage/02_en_proceso/doc-1.pdf');
    storage.moveToCanonical.mockResolvedValue(canonicalStorageResult);
    storage.moveToError.mockResolvedValue('storage/04_errores/file.pdf');
    storage.readFile.mockResolvedValue(new Uint8Array([9]));
    storage.exists.mockResolvedValue(true);

    // ----------------------------------------------------------------
    // Mock IDocumentRepository
    // ----------------------------------------------------------------
    repository = {
      create: vi.fn(),
      findById: vi.fn(),
      findByHash: vi.fn(),
      findByFolio: vi.fn(),
      findMany: vi.fn(),
      updateStatus: vi.fn(),
      updatePreprocessMetadata: vi.fn(),
      updateExtractedMetadata: vi.fn(),
      updateHitlValidation: vi.fn(),
      updateRpaExecution: vi.fn(),
      updateSheetsSync: vi.fn()
    };

    repository.create.mockImplementation(async (dto: Partial<DocumentoRegistro>) =>
      buildDocument({
        ...dto,
        id: 'doc-1',
        version: 1,
        fechaIngesta: nowIso,
        updatedAt: nowIso
      })
    );

    repository.findById.mockResolvedValue(null);
    repository.findByHash.mockResolvedValue(null);
    repository.findByFolio.mockResolvedValue(null);
    repository.findMany.mockResolvedValue([]);

    repository.updateStatus.mockImplementation(
      async (id: string, estado: DocumentoEstado, version: number) =>
        buildDocument({
          id,
          estado,
          version: version + 1
        })
    );

    repository.updatePreprocessMetadata.mockImplementation(
      async (
        id: string,
        preprocess: PreprocesoMetadata,
        nextStatus: DocumentoEstado,
        version: number
      ) =>
        buildDocument({
          id,
          preproceso: preprocess,
          estado: nextStatus,
          version: version + 1
        })
    );

    repository.updateExtractedMetadata.mockImplementation(
      async (
        id: string,
        extractedMetadata: MetadatosOficio,
        nextStatus: DocumentoEstado,
        version: number
      ) =>
        buildDocument({
          id,
          metadatosExtraidos: extractedMetadata,
          estado: nextStatus,
          version: version + 1
        })
    );

    repository.updateHitlValidation.mockImplementation(
      async (
        id: string,
        validatedMetadata: MetadatosOficio,
        canonicalName: string,
        mirrorJsonPath: string,
        userId: string,
        version: number
      ) =>
        buildDocument({
          id,
          metadatosValidados: validatedMetadata,
          nombreArchivoCanonico: canonicalName,
          rutaEspejoJson: mirrorJsonPath,
          revisorUsuarioId: userId,
          estado: 'APROBADO_HITL',
          fechaValidacionHitl: nowIso,
          version: version + 1
        })
    );

    repository.updateRpaExecution.mockImplementation(
      async (
        id: string,
        rpaExecution: RpaEjecucion,
        finalStatus: DocumentoEstado,
        version: number
      ) =>
        buildDocument({
          id,
          rpa: rpaExecution,
          estado: finalStatus,
          version: version + 1
        })
    );

    repository.updateSheetsSync.mockImplementation(
      async (id: string, sync: GoogleSheetsSync, version: number) =>
        buildDocument({
          id,
          sheetsSync: sync,
          version: version + 1
        })
    );

    // ----------------------------------------------------------------
    // Mock IPdfProcessorProvider
    // ----------------------------------------------------------------
    pdfProcessor = {
      inspectAndSanitize: vi.fn(),
      renderPagesForInference: vi.fn(),
      hasValidPdfHeader: vi.fn()
    };

    pdfProcessor.inspectAndSanitize.mockResolvedValue({
      metadata: preproceso,
      sanitizedBuffer: new Uint8Array([4, 5, 6])
    });

    pdfProcessor.renderPagesForInference.mockResolvedValue([]);
    pdfProcessor.hasValidPdfHeader.mockReturnValue(true);

    // ----------------------------------------------------------------
    // Mock IAIExtractorProvider
    // ----------------------------------------------------------------
    aiExtractor = {
      extractFromPages: vi.fn(),
      ping: vi.fn()
    };

    aiExtractor.extractFromPages.mockResolvedValue({
      metadata: validMetadata,
      telemetry: {
        promptTokens: 1200,
        completionTokens: 450,
        latencyMs: 980,
        modelVersion: 'gemini-2.5-flash'
      }
    });

    aiExtractor.ping.mockResolvedValue(true);

    // ----------------------------------------------------------------
    // Mock IRpaInjectionProvider
    // ----------------------------------------------------------------
    rpa = {
      injectDocument: vi.fn(),
      retryInjection: vi.fn(),
      checkIntranetHealth: vi.fn()
    };

    rpa.injectDocument.mockResolvedValue(rpaSuccess);
    rpa.retryInjection.mockResolvedValue(rpaSuccess);
    rpa.checkIntranetHealth.mockResolvedValue(true);

    // ----------------------------------------------------------------
    // Mock IExternalSyncProvider
    // ----------------------------------------------------------------
    externalSync = {
      appendDocumentRow: vi.fn(),
      updateRowRpaStatus: vi.fn(),
      appendBatchRows: vi.fn(),
      checkConnection: vi.fn()
    };

    externalSync.appendDocumentRow.mockResolvedValue(sheetsSuccess);
    externalSync.updateRowRpaStatus.mockResolvedValue(sheetsSuccess);
    externalSync.appendBatchRows.mockResolvedValue([]);
    externalSync.checkConnection.mockResolvedValue(true);

    orchestrator = new DocumentWorkflowOrchestrator(
      storage as unknown as IFileStorageProvider,
      repository as unknown as IDocumentRepository,
      pdfProcessor as unknown as IPdfProcessorProvider,
      aiExtractor as unknown as IAIExtractorProvider,
      rpa as unknown as IRpaInjectionProvider,
      externalSync as unknown as IExternalSyncProvider
    );

    // Silencia el console.error del orquestador durante el escenario de duplicado /
    // fallo RPA sin necesitar aserciones sobre el spy en sí.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Escenario exitoso: ingesta + extracción => PENDIENTE_REVISION
  // ------------------------------------------------------------------

  it('debe ingerir un PDF y dejar el documento en PENDIENTE_EXTRACCION, extrayendo metadatos con IA en segundo plano hasta PENDIENTE_REVISION', async () => {
    // `ingestAndExtract` resuelve tan pronto el documento queda bloqueado en
    // 02_en_proceso/ y tipado en BD (PENDIENTE_EXTRACCION) — ver el docstring de
    // `DocumentWorkflowOrchestrator.ingestAndExtract` sobre la desviación deliberada
    // respecto al boceto síncrono original. El render + extracción por Gemini continúa
    // en `continueExtractionInBackground` (fire-and-forget) y se observa aquí vía
    // `vi.waitFor` sobre las mismas mutaciones que dispararía el WebSocket en producción.
    const result = await orchestrator.ingestAndExtract(
      'SCAN_20260901_0042.pdf',
      'SCANNER_ADF',
      pdfBuffer
    );

    expect(result.estado).toBe('PENDIENTE_EXTRACCION');
    expect(result.metadatosExtraidos).toBeNull();

    expect(storage.saveIncoming).toHaveBeenCalledWith('SCAN_20260901_0042.pdf', pdfBuffer);
    expect(pdfProcessor.inspectAndSanitize).toHaveBeenCalledWith(pdfBuffer);
    expect(repository.findByHash).toHaveBeenCalledWith(preproceso.sha256Hash);
    expect(repository.create).toHaveBeenCalled();

    await vi.waitFor(() => expect(aiExtractor.extractFromPages).toHaveBeenCalledTimes(1));

    expect(aiExtractor.extractFromPages).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        contextYear: expect.any(Number)
      })
    );

    await vi.waitFor(() => expect(repository.updateExtractedMetadata).toHaveBeenCalledTimes(1));

    expect(repository.updateExtractedMetadata).toHaveBeenCalledWith(
      'doc-1',
      validMetadata,
      'PENDIENTE_REVISION',
      expect.any(Number)
    );
  });

  // ------------------------------------------------------------------
  // Escenario duplicado: findByHash devuelve existente => no IA
  // ------------------------------------------------------------------

  it('debe rechazar documentos duplicados por hash sin invocar IA ni crear registro', async () => {
    // El contrato expone findByHash; funcionalmente equivale a existsByHash.
    repository.findByHash.mockResolvedValue(buildDocument({ id: 'documento-existente' }));

    await expect(
      orchestrator.ingestAndExtract('SCAN_20260901_0042.pdf', 'SCANNER_ADF', pdfBuffer)
    ).rejects.toThrow(/duplicado/i);

    expect(storage.moveToError).toHaveBeenCalledWith(
      'storage/01_entrada/file.pdf',
      'DUPLICATE_HASH_DETECTED'
    );

    expect(repository.create).not.toHaveBeenCalled();
    expect(aiExtractor.extractFromPages).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Escenario HITL -> RPA -> Sheets exitoso
  // ------------------------------------------------------------------

  it('debe confirmar HITL, mover a canónico, ejecutar RPA exitosamente y sincronizar Sheets', async () => {
    const pendingDoc = buildDocument({
      id: 'doc-1',
      estado: 'PENDIENTE_REVISION',
      version: 2,
      rutaArchivoActual: 'storage/02_en_proceso/doc-1.pdf',
      metadatosExtraidos: validMetadata
    });

    const approvedDoc = buildDocument({
      ...pendingDoc,
      estado: 'APROBADO_HITL',
      version: 3,
      metadatosValidados: validMetadata,
      nombreArchivoCanonico: '2026-09-01__DSA-1042-2026__REMITENTE.pdf',
      rutaEspejoJson: canonicalStorageResult.mirrorJsonPath
    });

    const enRpaDoc = buildDocument({
      ...approvedDoc,
      estado: 'EN_RPA',
      version: 4
    });

    repository.findById.mockResolvedValue(pendingDoc);
    repository.updateHitlValidation.mockResolvedValue(approvedDoc);
    repository.updateStatus.mockResolvedValue(enRpaDoc);

    const returned = await orchestrator.confirmHitlAndExecutePipeline(
      'doc-1',
      validMetadata,
      'USR-CAPTURISTA-01',
      2
    );

    expect(returned.estado).toBe('EN_RPA');

    expect(storage.moveToCanonical).toHaveBeenCalledWith(
      pendingDoc.rutaArchivoActual,
      '2026',
      '09',
      expect.any(String),
      validMetadata
    );

    await vi.waitFor(() => expect(rpa.injectDocument).toHaveBeenCalledTimes(1), {
      timeout: 2000
    });

    await vi.waitFor(
      () => expect(repository.updateRpaExecution).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    await vi.waitFor(
      () => expect(externalSync.appendDocumentRow).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    await vi.waitFor(
      () => expect(repository.updateSheetsSync).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    expect(rpa.injectDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        metadata: validMetadata,
        canonicalPdfPath: canonicalStorageResult.canonicalPdfPath
      })
    );

    expect(repository.updateRpaExecution).toHaveBeenCalledWith(
      'doc-1',
      rpaSuccess,
      'COMPLETADO',
      expect.any(Number)
    );

    expect(externalSync.appendDocumentRow).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        metadata: validMetadata
      })
    );

    expect(repository.updateSheetsSync).toHaveBeenCalledWith(
      'doc-1',
      sheetsSuccess,
      expect.any(Number)
    );
  });

  // ------------------------------------------------------------------
  // Escenario de concurrencia: conflicto de versión en HITL
  // ------------------------------------------------------------------

  it('debe propagar CONCURRENCY_VERSION_CONFLICT si otro capturista modificó el documento', async () => {
    const pendingDoc = buildDocument({
      id: 'doc-1',
      estado: 'PENDIENTE_REVISION',
      version: 2,
      rutaArchivoActual: 'storage/02_en_proceso/doc-1.pdf',
      metadatosExtraidos: validMetadata
    });

    repository.findById.mockResolvedValue(pendingDoc);

    repository.updateHitlValidation.mockRejectedValue(
      new RepositoryError(
        'CONCURRENCY_VERSION_CONFLICT',
        'El documento fue modificado por otro capturista.'
      )
    );

    await expect(
      orchestrator.confirmHitlAndExecutePipeline('doc-1', validMetadata, 'USR-02', 2)
    ).rejects.toMatchObject({
      code: 'CONCURRENCY_VERSION_CONFLICT'
    });

    expect(storage.moveToCanonical).toHaveBeenCalled();
    expect(rpa.injectDocument).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Escenario resiliencia RPA: primer intento falla, segundo succeeds
  // ------------------------------------------------------------------

  it('debe permitir reintento RPA tras ERROR_RPA y completar el documento en el segundo intento', async () => {
    const failedRpa: RpaEjecucion = {
      id: 'rpa-failed',
      documentoId: 'doc-error',
      folioAcuseInstitucional: null,
      fechaEjecucion: nowIso,
      duracionMs: 30_000,
      capturaAcusePath: null,
      intentos: 1,
      mensajeError: 'TimeoutError: Target closed',
      exitoso: false
    };

    const successSecondRpa: RpaEjecucion = {
      ...failedRpa,
      id: 'rpa-success',
      intentos: 2,
      mensajeError: null,
      exitoso: true,
      folioAcuseInstitucional: 'HCG-OP-2026-009821'
    };

    const errorDoc = buildDocument({
      id: 'doc-error',
      estado: 'ERROR_RPA',
      version: 5,
      rutaArchivoActual: 'storage/03_procesados/2026/09/canonical.pdf',
      nombreArchivoCanonico: '2026-09-01__DSA-1042-2026__REMITENTE.pdf',
      metadatosValidados: validMetadata,
      rpa: failedRpa
    });

    const enRpaDoc1 = buildDocument({
      ...errorDoc,
      estado: 'EN_RPA',
      version: 6
    });

    const afterFailDoc = buildDocument({
      ...errorDoc,
      estado: 'ERROR_RPA',
      version: 7,
      rpa: failedRpa
    });

    const enRpaDoc2 = buildDocument({
      ...afterFailDoc,
      estado: 'EN_RPA',
      version: 8
    });

    const afterSuccessDoc = buildDocument({
      ...afterFailDoc,
      estado: 'COMPLETADO',
      version: 9,
      rpa: successSecondRpa
    });

    repository.findById
      .mockResolvedValueOnce(errorDoc)
      .mockResolvedValueOnce(afterFailDoc);

    repository.updateStatus
      .mockResolvedValueOnce(enRpaDoc1)
      .mockResolvedValueOnce(enRpaDoc2);

    repository.updateRpaExecution
      .mockResolvedValueOnce(afterFailDoc)
      .mockResolvedValueOnce(afterSuccessDoc);

    rpa.injectDocument
      .mockRejectedValueOnce(new Error('TimeoutError: Target closed'))
      .mockResolvedValueOnce(successSecondRpa);

    // Primer reintento: falla RPA
    await orchestrator.retryRpaExecution('doc-error', 5);

    await vi.waitFor(
      () => expect(repository.updateRpaExecution).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    expect(repository.updateRpaExecution).toHaveBeenNthCalledWith(
      1,
      'doc-error',
      expect.objectContaining({
        exitoso: false,
        mensajeError: expect.stringContaining('TimeoutError')
      }),
      'ERROR_RPA',
      6
    );

    // Segundo reintento: RPA exitoso
    await orchestrator.retryRpaExecution('doc-error', 7);

    await vi.waitFor(
      () => expect(repository.updateRpaExecution).toHaveBeenCalledTimes(2),
      { timeout: 2000 }
    );

    expect(rpa.injectDocument).toHaveBeenCalledTimes(2);

    expect(repository.updateRpaExecution).toHaveBeenNthCalledWith(
      2,
      'doc-error',
      successSecondRpa,
      'COMPLETADO',
      8
    );

    await vi.waitFor(
      () => expect(externalSync.appendDocumentRow).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    await vi.waitFor(
      () => expect(repository.updateSheetsSync).toHaveBeenCalledTimes(1),
      { timeout: 2000 }
    );

    expect(externalSync.appendDocumentRow).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-error',
        metadata: validMetadata
      })
    );
  });
});