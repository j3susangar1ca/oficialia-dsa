/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Capa de Aplicación: Orquestador del Flujo de Trabajo Documental
 * Versión: 1.0.0-MVP
 *
 * Implementa la Inyección de Dependencias por constructor: recibe los seis
 * puertos secundarios ya resueltos por el composition root (`presentation/server.ts`)
 * y coordina el ciclo de vida completo sin conocer ningún detalle de infraestructura.
 */

import type {
  DocumentoRegistro,
  DocumentoEstado,
  MetadatosOficio,
  IngestaOrigen,
  RpaEjecucion,
} from '../contracts/types';

import type { IFileStorageProvider } from '../contracts/IFileStorageProvider';
import type { IDocumentRepository } from '../contracts/IDocumentRepository';
import type { IPdfProcessorProvider } from '../contracts/IPdfProcessorProvider';
import type { IAIExtractorProvider } from '../contracts/IAIExtractorProvider';
import type { IRpaInjectionProvider } from '../contracts/IRpaInjectionProvider';
import type { IExternalSyncProvider } from '../contracts/IExternalSyncProvider';
import type { ILocalSemanticProvider, ResultadoBusquedaSemantica } from '../contracts/ILocalSemanticProvider';

/**
 * Observador opcional de eventos de pipeline. `server.ts` inyecta aquí el
 * `DocumentEventsHub` para retransmitir el avance del orquestador por WebSocket
 * sin que la capa de aplicación conozca Fastify ni el protocolo de transporte.
 */
export interface WorkflowEventsListener {
  onDocumentEvent(documentId: string, estado: DocumentoEstado, document?: Readonly<DocumentoRegistro>): void;
  onPipelineError(documentId: string, code: string, message: string): void;
}

export class DocumentWorkflowOrchestrator {
  constructor(
    private readonly storage: IFileStorageProvider,
    private readonly repository: IDocumentRepository,
    private readonly pdfProcessor: IPdfProcessorProvider,
    private readonly aiExtractor: IAIExtractorProvider,
    private readonly rpaInjection: IRpaInjectionProvider,
    private readonly externalSync: IExternalSyncProvider,
    private readonly events?: WorkflowEventsListener,
    /**
     * Puerto 7 (P1, `docs/prd.md` §2.2) — opcional: si se omite, la indexación y
     * búsqueda semántica se saltan silenciosamente (el resto del pipeline no depende
     * de él). `server.ts` lo inyecta siempre que `ILocalSemanticProvider` esté cableado.
     */
    private readonly semanticProvider?: ILocalSemanticProvider
  ) {}

  /**
   * Flujo 1 (fase síncrona): Ingesta y Preprocesamiento
   * Recibe el archivo físico, lo sanitiza y crea el registro persistente. Devuelve el
   * registro tan pronto como el documento queda bloqueado en `02_en_proceso/` y tipado
   * en BD — sin esperar a la inferencia de Gemini.
   *
   * @remarks Desviación deliberada respecto del boceto original de contracts.md: ahí
   * este método esperaba a que concluyera la extracción por IA antes de resolver la
   * promesa. El PRD (§2.1) y el contrato REST (`POST /upload` → 202 Accepted) exigen
   * que la ruta HTTP responda de inmediato con el UUID persistido mientras la pipeline
   * continúa en segundo plano — el mismo patrón fire-and-forget que ya usa
   * `confirmHitlAndExecutePipeline` para `executeOutputWorkers`. La fase de render +
   * extracción se delega a `continueExtractionInBackground`, que notifica el resultado
   * exclusivamente por WebSocket (`WorkflowEventsListener`), consistente con el flujo 1
   * del diagrama end-to-end de contracts.md.
   */
  async ingestAndExtract(
    fileName: string,
    origen: IngestaOrigen,
    rawBuffer: Uint8Array
  ): Promise<Readonly<DocumentoRegistro>> {
    // 1. Guardar temporalmente en storage/01_entrada/
    const incomingPath = await this.storage.saveIncoming(fileName, rawBuffer);

    // 2. Preprocesamiento e inspección de integridad (PyMuPDF / Pillow)
    const inspection = await this.pdfProcessor.inspectAndSanitize(rawBuffer);
    const { sha256Hash } = inspection.metadata;

    // 3. Verificación de duplicidad por Hash SHA-256
    const existing = await this.repository.findByHash(sha256Hash);
    if (existing) {
      await this.storage.moveToError(incomingPath, 'DUPLICATE_HASH_DETECTED');
      throw new Error(`Documento duplicado detectado con hash: ${sha256Hash}`);
    }

    // 4. Crear registro en base de datos (Estado: EN_PREPROCESO)
    const record = await this.repository.create({
      nombreArchivoOriginal: fileName,
      nombreArchivoCanonico: null,
      rutaArchivoActual: incomingPath,
      rutaEspejoJson: null,
      origen,
      estado: 'EN_PREPROCESO',
      sha256Hash,
      metadatosExtraidos: null,
      metadatosValidados: null,
      preproceso: inspection.metadata,
      rpa: null,
      sheetsSync: {
        sincronizado: false,
        filaIndex: null,
        timestampSincronizacion: null,
        errorSincronizacion: null,
      },
      revisorUsuarioId: null,
    });
    this.emit(record.id, record.estado, record);

    // 5. Bloquear archivo moviéndolo a storage/02_en_proceso/ (el 4º argumento persiste
    //    el nuevo rutaArchivoActual junto con la transición de estado — ver contrato).
    const inProcessPath = await this.storage.moveToInProcess(incomingPath, record.id);
    const currentRecord = await this.repository.updateStatus(record.id, 'PENDIENTE_EXTRACCION', record.version, inProcessPath);
    this.emit(currentRecord.id, currentRecord.estado, currentRecord);

    // 6-7. Render + extracción por IA: continúa en segundo plano, no bloquea la respuesta HTTP.
    this.continueExtractionInBackground(currentRecord, inspection.sanitizedBuffer, inProcessPath).catch((err) => {
      console.error(`[BackgroundExtractionError] Fallo en extracción del documento ${record.id}:`, err);
    });

    return currentRecord;
  }

  /**
   * Continuación asíncrona del Flujo 1: renderiza páginas, invoca al extractor de IA y
   * deja el documento en PENDIENTE_REVISION (o ERROR_EXTRACCION) para el capturista.
   */
  private async continueExtractionInBackground(
    record: DocumentoRegistro,
    sanitizedBuffer: Uint8Array,
    inProcessPath: string
  ): Promise<void> {
    let currentRecord = record;
    try {
      const renderedPages = await this.pdfProcessor.renderPagesForInference(sanitizedBuffer, {
        targetDpi: 300,
        maxPages: 10,
      });

      currentRecord = await this.repository.updateStatus(currentRecord.id, 'EN_EXTRACCION', currentRecord.version);
      this.emit(currentRecord.id, currentRecord.estado, currentRecord);

      const extraction = await this.aiExtractor.extractFromPages(renderedPages, {
        contextYear: new Date().getFullYear(),
      });

      // Persistir metadatos inferidos y poner a disposición del capturista en HITL
      const readyForReview = await this.repository.updateExtractedMetadata(
        currentRecord.id,
        extraction.metadata,
        'PENDIENTE_REVISION',
        currentRecord.version
      );
      this.emit(readyForReview.id, readyForReview.estado, readyForReview);
    } catch (error) {
      // `moveToError` MUEVE físicamente el archivo a storage/04_errores/ — hay que
      // persistir esa nueva ruta (4º argumento) o `rutaArchivoActual` queda apuntando al
      // path viejo en 02_en_proceso/, ya inexistente: GET /:id/file (visor PDF) y
      // `retryExtraction` (abajo) fallarían al intentar leer un archivo que ya no está ahí.
      const errorPath = await this.storage.moveToError(inProcessPath, 'EXTRACTION_PIPELINE_ERROR');
      const errored = await this.repository.updateStatus(
        currentRecord.id,
        'ERROR_EXTRACCION',
        currentRecord.version,
        errorPath
      );
      this.emit(errored.id, errored.estado, errored);
      this.events?.onPipelineError(
        currentRecord.id,
        'ERROR_EXTRACCION',
        error instanceof Error ? error.message : 'Fallo desconocido en la extracción de metadatos'
      );
    }
  }

  /**
   * Flujo 2 y 3: Confirmación HITL, Archivo Canónico, Disparo de RPA y Google Sheets Sync
   * Transiciona el estado tras la validación humana, mueve el PDF canónico y encola la salida.
   */
  async confirmHitlAndExecutePipeline(
    documentId: string,
    validatedMetadata: MetadatosOficio,
    userId: string,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const document = await this.repository.findById(documentId);
    if (!document) throw new Error(`Documento no encontrado: ${documentId}`);

    // 1. Construir la nomenclatura canónica obligatoria: YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf
    const datePrefix = validatedMetadata.fechaEmision;
    const cleanFolio = validatedMetadata.numeroOficio.replace(/[\/\\:*?"<>|]/g, '-');
    const cleanSender = validatedMetadata.remitenteNombre.substring(0, 30).trim().replace(/\s+/g, '_');
    const canonicalFileName = `${datePrefix}__${cleanFolio}__${cleanSender}.pdf`;

    const [year, month] = datePrefix.split('-');
    if (!year || !month) {
      throw new Error(`fechaEmision inválida para construir la ruta canónica: ${datePrefix}`);
    }

    // 2. Mover a storage/03_procesados/YYYY/MM/ y crear JSON espejo
    const storageResult = await this.storage.moveToCanonical(
      document.rutaArchivoActual,
      year,
      month,
      canonicalFileName,
      validatedMetadata
    );

    // 3. Actualizar registro a estado APROBADO_HITL / EN_RPA en BD
    let currentRecord = await this.repository.updateHitlValidation(
      documentId,
      validatedMetadata,
      canonicalFileName,
      storageResult.mirrorJsonPath,
      userId,
      expectedVersion
    );
    this.emit(currentRecord.id, currentRecord.estado, currentRecord);

    currentRecord = await this.repository.updateStatus(documentId, 'EN_RPA', currentRecord.version);
    this.emit(currentRecord.id, currentRecord.estado, currentRecord);

    // 4. Ejecutar Pipeline de Salida de forma asíncrona (RPA + Sheets)
    this.executeOutputWorkers(currentRecord, storageResult.canonicalPdfPath).catch((err) => {
      console.error(`[BackgroundWorkerError] Fallo en pipeline de salida del documento ${documentId}:`, err);
    });

    // 5. Indexación semántica en segundo plano (Puerto 7, P1 — no bloqueante: un fallo
    //    de inferencia local nunca debe impedir que el documento llegue a RPA/Sheets).
    this.indexForSemanticSearch(documentId, validatedMetadata).catch((err) => {
      console.error(`[SemanticIndexError] Fallo al indexar el documento ${documentId}:`, err);
    });

    return currentRecord;
  }

  /** Puerto 7 (P1) — indexa dependencia/remitente/asunto para búsqueda semántica posterior. */
  private async indexForSemanticSearch(documentId: string, metadata: MetadatosOficio): Promise<void> {
    if (!this.semanticProvider) return;
    await this.semanticProvider.indexDocument(documentId, {
      dependenciaArea: metadata.dependenciaArea,
      remitenteNombre: metadata.remitenteNombre,
      asunto: metadata.asunto,
    });
  }

  /**
   * Puerto 7 (P1) — sugiere oficios relacionados por similitud semántica al documento
   * dado (usa sus metadatos validados o, en su defecto, los extraídos por IA). Nunca
   * lanza: si el puerto no está cableado o el modelo aún no está listo, retorna un
   * resultado vacío (mismo contrato de degradación que `ILocalSemanticProvider.searchSimilar`).
   */
  async findRelatedDocuments(
    documentId: string,
    options?: { limite?: number; umbralVinculacion?: number }
  ): Promise<ResultadoBusquedaSemantica> {
    if (!this.semanticProvider) {
      return { documentos: [], totalVectoresComparados: 0, duracionMs: 0, modeloEstado: 'NO_INICIALIZADO' };
    }

    const document = await this.repository.findById(documentId);
    const metadata = document?.metadatosValidados ?? document?.metadatosExtraidos;
    if (!document || !metadata) {
      return { documentos: [], totalVectoresComparados: 0, duracionMs: 0, modeloEstado: this.semanticProvider.modeloEstado };
    }

    return this.semanticProvider.searchSimilar({
      textoConsulta: `${metadata.dependenciaArea} ${metadata.remitenteNombre} ${metadata.asunto}`,
      excluirDocumentoId: documentId,
      limite: options?.limite,
      umbralVinculacion: options?.umbralVinculacion,
    });
  }

  /**
   * Pipeline de Salida en Segundo Plano: Automatización Playwright y Google Sheets API v4
   */
  private async executeOutputWorkers(document: DocumentoRegistro, canonicalPdfPath: string): Promise<void> {
    let currentVersion = document.version;

    // A. Inyección RPA en Intranet (op_cucs.fwx)
    let rpaResult: RpaEjecucion;
    let finalStatus: DocumentoEstado = 'COMPLETADO';

    try {
      rpaResult = await this.rpaInjection.injectDocument({
        documentId: document.id,
        metadata: document.metadatosValidados!,
        canonicalPdfPath,
      });
    } catch (error: unknown) {
      finalStatus = 'ERROR_RPA';
      rpaResult = {
        id: crypto.randomUUID(),
        documentoId: document.id,
        folioAcuseInstitucional: null,
        fechaEjecucion: new Date().toISOString(),
        duracionMs: 0,
        capturaAcusePath: null,
        intentos: 1,
        mensajeError: error instanceof Error ? error.message : 'Fallo desconocido en worker Playwright',
        exitoso: false,
      };
    }

    const updatedAfterRpa = await this.repository.updateRpaExecution(document.id, rpaResult, finalStatus, currentVersion);
    currentVersion = updatedAfterRpa.version;
    this.emit(updatedAfterRpa.id, updatedAfterRpa.estado, updatedAfterRpa);
    if (finalStatus === 'ERROR_RPA') {
      this.events?.onPipelineError(document.id, 'ERROR_RPA', rpaResult.mensajeError ?? 'Fallo en la inyección RPA');
    }

    // B. Sincronización con Tablero de Control de Términos (Google Sheets)
    if (finalStatus === 'COMPLETADO') {
      try {
        const syncResult = await this.externalSync.appendDocumentRow({
          documentId: document.id,
          canonicalFileName: document.nombreArchivoCanonico!,
          metadata: document.metadatosValidados!,
          rpaExecution: rpaResult,
          timestamp: new Date().toISOString(),
        });

        const updated = await this.repository.updateSheetsSync(document.id, syncResult, currentVersion);
        this.emit(updated.id, updated.estado, updated);
      } catch (sheetsError: unknown) {
        const updated = await this.repository.updateSheetsSync(
          document.id,
          {
            sincronizado: false,
            filaIndex: null,
            timestampSincronizacion: null,
            errorSincronizacion:
              sheetsError instanceof Error ? sheetsError.message : 'Fallo al tabular en Google Sheets',
          },
          currentVersion
        );
        this.emit(updated.id, updated.estado, updated);
      }
    }
  }

  /**
   * Flujo de Reintento: Permite reejecutar el RPA de documentos en ERROR_RPA sin reescanear ni reextraer.
   */
  async retryRpaExecution(documentId: string, expectedVersion: number): Promise<Readonly<DocumentoRegistro>> {
    const document = await this.repository.findById(documentId);
    if (!document) throw new Error(`Documento no encontrado: ${documentId}`);
    if (document.estado !== 'ERROR_RPA') {
      throw new Error(`El documento no está en estado ERROR_RPA (Estado actual: ${document.estado})`);
    }

    const currentRecord = await this.repository.updateStatus(documentId, 'EN_RPA', expectedVersion);
    this.emit(currentRecord.id, currentRecord.estado, currentRecord);

    this.executeOutputWorkers(currentRecord, currentRecord.rutaArchivoActual).catch((err) => {
      console.error(`[BackgroundRetryError] Fallo en reintento RPA del documento ${documentId}:`, err);
    });

    return currentRecord;
  }

  /**
   * Flujo de Reintento: reejecuta render + extracción IA para documentos en
   * ERROR_EXTRACCION, sin re-solicitar el archivo (ya está sanitizado en
   * storage/04_errores/, movido ahí por `continueExtractionInBackground`). Antes de esta
   * entrega, un documento que llegaba a ERROR_EXTRACCION (p. ej. por timeout de Gemini)
   * quedaba varado sin ninguna vía de recuperación salvo volver a subir el PDF a mano.
   */
  async retryExtraction(documentId: string, expectedVersion: number): Promise<Readonly<DocumentoRegistro>> {
    const document = await this.repository.findById(documentId);
    if (!document) throw new Error(`Documento no encontrado: ${documentId}`);
    if (document.estado !== 'ERROR_EXTRACCION') {
      throw new Error(`El documento no está en estado ERROR_EXTRACCION (Estado actual: ${document.estado})`);
    }

    // Vuelve a colocar el archivo en 02_en_proceso/ (venía de 04_errores/ tras el fallo previo).
    const inProcessPath = await this.storage.moveToInProcess(document.rutaArchivoActual, documentId);
    const currentRecord = await this.repository.updateStatus(
      documentId,
      'PENDIENTE_EXTRACCION',
      expectedVersion,
      inProcessPath
    );
    this.emit(currentRecord.id, currentRecord.estado, currentRecord);

    const sanitizedBuffer = await this.storage.readFile(inProcessPath);
    this.continueExtractionInBackground(currentRecord, sanitizedBuffer, inProcessPath).catch((err) => {
      console.error(`[BackgroundRetryError] Fallo en reintento de extracción del documento ${documentId}:`, err);
    });

    return currentRecord;
  }

  private emit(documentId: string, estado: DocumentoEstado, document?: Readonly<DocumentoRegistro>): void {
    this.events?.onDocumentEvent(documentId, estado, document);
  }
}
