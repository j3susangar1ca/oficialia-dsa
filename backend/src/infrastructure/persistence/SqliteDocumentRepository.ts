/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Persistencia SQLite (WAL) con better-sqlite3
 * Implementación del puerto secundario IDocumentRepository sobre el esquema de `schema.sql`
 * (tablas `documentos`, `preproceso_metadata`, `rpa_ejecuciones`, `google_sheets_sync`).
 *
 * Versión: 1.0.0-MVP
 * Runtime: Node.js 22 LTS · TypeScript 5.x (modo estricto) · better-sqlite3 (síncrono)
 *
 * Decisiones de diseño:
 *  - Control de concurrencia optimista: toda mutación ejecuta
 *    `UPDATE documentos SET version = version + 1, ... WHERE id = ? AND version = ?`.
 *    Si `changes === 0`, se distingue DOCUMENT_NOT_FOUND (el id no existe) de
 *    CONCURRENCY_VERSION_CONFLICT (el id existe con otra versión), tal como exige el contrato.
 *  - `numero_oficio` se desnormaliza en `documentos` en cada escritura de metadatos
 *    (extraídos o validados) para soportar `findByFolio` con índice B-Tree, conforme
 *    a la regla de consistencia documentada en schema.sql.
 *  - Las tablas satélite 1:1 (`preproceso_metadata`, `rpa_ejecuciones`, `google_sheets_sync`)
 *    se escriben con `INSERT ... ON CONFLICT(documento_id) DO UPDATE` dentro de la MISMA
 *    transacción sincrónica que la actualización versionada de `documentos`, garantizando
 *    atomicidad (better-sqlite3 es síncrono: no hay interleaving entre el chequeo de
 *    versión y la escritura satélite).
 *  - `rutaArchivoActual` se recalcula en `updateHitlValidation` a partir de `mirrorJsonPath`
 *    (mismo directorio, extensión .pdf en vez de .json — invariante que establece
 *    `LocalFileStorageAdapter.moveToCanonical`), porque el contrato de la firma no recibe
 *    `canonicalPdfPath` explícitamente y los flujos de reintento de RPA dependen de que
 *    `rutaArchivoActual` ya apunte al PDF canónico tras la validación HITL.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  CreateDocumentRecordDTO,
  DocumentQueryFilters,
  IDocumentRepository,
  RepositoryError,
  RepositoryErrorCode,
} from '../../contracts/IDocumentRepository';
import type {
  DocumentoEstado,
  DocumentoRegistro,
  GoogleSheetsSync,
  MetadatosOficio,
  PreprocesoMetadata,
  RpaEjecucion,
} from '../../contracts/types';

export class SqliteRepositoryError extends Error implements RepositoryError {
  public readonly code: RepositoryErrorCode;
  public readonly documentId?: string;
  public readonly currentVersion?: number;
  public readonly expectedVersion?: number;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    attributes: { documentId?: string; currentVersion?: number; expectedVersion?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: attributes.cause });
    this.name = 'SqliteRepositoryError';
    this.code = code;
    this.documentId = attributes.documentId;
    this.currentVersion = attributes.currentVersion;
    this.expectedVersion = attributes.expectedVersion;
  }
}

// ---------------------------------------------------------------------------
// Filas crudas (snake_case) tal como las devuelve better-sqlite3
// ---------------------------------------------------------------------------

interface DocumentoRow {
  id: string;
  nombre_archivo_original: string;
  nombre_archivo_canonico: string | null;
  ruta_archivo_actual: string;
  ruta_espejo_json: string | null;
  origen: DocumentoRegistro['origen'];
  estado: DocumentoEstado;
  sha256_hash: string;
  numero_oficio: string | null;
  metadatos_extraidos: string | null;
  metadatos_validados: string | null;
  revisor_usuario_id: string | null;
  fecha_ingesta: string;
  fecha_validacion_hitl: string | null;
  fecha_finalizacion: string | null;
  updated_at: string;
  version: number;
}

interface PreprocesoRow {
  page_count: number;
  file_size_bytes: number;
  sha256_hash: string;
  paginas: string;
  processing_duration_ms: number;
  is_sanitized: number;
}

interface RpaRow {
  id: string;
  documento_id: string;
  folio_acuse_institucional: string | null;
  fecha_ejecucion: string;
  duracion_ms: number;
  captura_acuse_path: string | null;
  intentos: number;
  mensaje_error: string | null;
  exitoso: number;
}

interface SheetsRow {
  sincronizado: number;
  fila_index: number | null;
  timestamp_sincronizacion: string | null;
  error_sincronizacion: string | null;
}

export interface SqliteDocumentRepositoryOptions {
  /** Ruta al archivo .sqlite (por defecto: `<cwd>/data/oficialia.db`). */
  databasePath?: string;
  /** Ruta al DDL (`schema.sql`); se ejecuta al abrir la conexión si las tablas no existen. */
  schemaPath?: string;
  /**
   * Ruta al DDL del puerto 7 (`embeddings_schema.sql` — tabla `documentos_embeddings`,
   * ver `docs/contracts.md` §"Puerto 7"). Se ejecuta sobre la misma conexión/archivo
   * .db, después de `schema.sql` (depende de `documentos` vía FK). `null` desactiva su
   * ejecución (p. ej. en tests que no necesitan el puerto semántico).
   */
  embeddingsSchemaPath?: string | null;
}

export class SqliteDocumentRepository implements IDocumentRepository {
  private readonly db: Database.Database;

  constructor(options: SqliteDocumentRepositoryOptions = {}) {
    const databasePath = options.databasePath ?? path.resolve(process.cwd(), 'data', 'oficialia.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    this.db = new Database(databasePath);
    const schemaPath = options.schemaPath ?? path.resolve(__dirname, 'schema.sql');
    this.db.exec(fs.readFileSync(schemaPath, 'utf-8'));

    const embeddingsSchemaPath =
      options.embeddingsSchemaPath === null ? null : (options.embeddingsSchemaPath ?? path.resolve(__dirname, 'embeddings_schema.sql'));
    if (embeddingsSchemaPath) {
      this.db.exec(fs.readFileSync(embeddingsSchemaPath, 'utf-8'));
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Expone la conexión better-sqlite3 subyacente para que el composition root
   * (`presentation/server.ts`) pueda inyectarla en `LocalSemanticMatcherAdapter`
   * (puerto `ILocalSemanticProvider`, P1) sin abrir una segunda conexión al mismo
   * archivo .db — better-sqlite3 es síncrono y de un solo hilo por conexión.
   */
  getRawDatabase(): Database.Database {
    return this.db;
  }

  async create(document: CreateDocumentRecordDTO): Promise<Readonly<DocumentoRegistro>> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const numeroOficio = document.metadatosExtraidos?.numeroOficio ?? document.metadatosValidados?.numeroOficio ?? null;

    const insert = this.db.transaction(() => {
      try {
        this.db
          .prepare(
            `INSERT INTO documentos (
              id, nombre_archivo_original, nombre_archivo_canonico, ruta_archivo_actual,
              ruta_espejo_json, origen, estado, sha256_hash, numero_oficio,
              metadatos_extraidos, metadatos_validados, revisor_usuario_id,
              fecha_ingesta, fecha_validacion_hitl, fecha_finalizacion, updated_at, version
            ) VALUES (
              @id, @nombreArchivoOriginal, @nombreArchivoCanonico, @rutaArchivoActual,
              @rutaEspejoJson, @origen, @estado, @sha256Hash, @numeroOficio,
              @metadatosExtraidos, @metadatosValidados, @revisorUsuarioId,
              @fechaIngesta, NULL, NULL, @updatedAt, 1
            )`
          )
          .run({
            id,
            nombreArchivoOriginal: document.nombreArchivoOriginal,
            nombreArchivoCanonico: document.nombreArchivoCanonico,
            rutaArchivoActual: document.rutaArchivoActual,
            rutaEspejoJson: document.rutaEspejoJson,
            origen: document.origen,
            estado: document.estado,
            sha256Hash: document.sha256Hash,
            numeroOficio,
            metadatosExtraidos: document.metadatosExtraidos ? JSON.stringify(document.metadatosExtraidos) : null,
            metadatosValidados: document.metadatosValidados ? JSON.stringify(document.metadatosValidados) : null,
            revisorUsuarioId: document.revisorUsuarioId,
            fechaIngesta: now,
            updatedAt: now,
          });
      } catch (cause) {
        if (this.isUniqueConstraintViolation(cause, 'sha256_hash')) {
          throw new SqliteRepositoryError('DUPLICATE_DOCUMENT_HASH', `Ya existe un documento con hash ${document.sha256Hash}.`, {
            cause,
          });
        }
        throw new SqliteRepositoryError('PERSISTENCE_TRANSACTION_FAILED', 'No se pudo insertar el documento.', { cause });
      }

      if (document.preproceso) {
        this.upsertPreproceso(id, document.preproceso);
      }
      this.upsertSheetsSync(id, document.sheetsSync);
    });

    insert();
    return this.mustFindById(id);
  }

  async findById(id: string): Promise<Readonly<DocumentoRegistro> | null> {
    const row = this.db.prepare<{ id: string }, DocumentoRow>('SELECT * FROM documentos WHERE id = @id').get({ id });
    return row ? this.assemble(row) : null;
  }

  async findByHash(sha256Hash: string): Promise<Readonly<DocumentoRegistro> | null> {
    const row = this.db
      .prepare<{ sha256Hash: string }, DocumentoRow>('SELECT * FROM documentos WHERE sha256_hash = @sha256Hash')
      .get({ sha256Hash });
    return row ? this.assemble(row) : null;
  }

  async findByFolio(numeroOficio: string): Promise<Readonly<DocumentoRegistro> | null> {
    const row = this.db
      .prepare<{ numeroOficio: string }, DocumentoRow>('SELECT * FROM documentos WHERE numero_oficio = @numeroOficio')
      .get({ numeroOficio });
    return row ? this.assemble(row) : null;
  }

  async findMany(filters: DocumentQueryFilters): Promise<ReadonlyArray<DocumentoRegistro>> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.estado) {
      clauses.push('estado = @estado');
      params.estado = filters.estado;
    }
    if (filters.estados && filters.estados.length > 0) {
      const placeholders = filters.estados.map((_, i) => `@estado${i}`);
      clauses.push(`estado IN (${placeholders.join(', ')})`);
      filters.estados.forEach((estado, i) => {
        params[`estado${i}`] = estado;
      });
    }
    if (filters.numeroOficio) {
      clauses.push('numero_oficio = @numeroOficio');
      params.numeroOficio = filters.numeroOficio;
    }
    if (filters.fechaDesde) {
      clauses.push('fecha_ingesta >= @fechaDesde');
      params.fechaDesde = filters.fechaDesde;
    }
    if (filters.fechaHasta) {
      clauses.push('fecha_ingesta <= @fechaHasta');
      params.fechaHasta = filters.fechaHasta;
    }
    // `procedencia` vive dentro del JSON de metadatos (extraídos o validados);
    // se filtra vía json_extract ya que no está desnormalizada en columna propia.
    if (filters.procedencia) {
      clauses.push(
        "(json_extract(metadatos_validados, '$.procedencia') = @procedencia OR json_extract(metadatos_extraidos, '$.procedencia') = @procedencia)"
      );
      params.procedencia = filters.procedencia;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const rows = this.db
      .prepare<Record<string, unknown>, DocumentoRow>(
        `SELECT * FROM documentos ${where} ORDER BY fecha_ingesta ASC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset });

    return rows.map((row) => this.assemble(row));
  }

  async updateStatus(
    id: string,
    newStatus: DocumentoEstado,
    expectedVersion: number,
    newCurrentPath?: string
  ): Promise<Readonly<DocumentoRegistro>> {
    const run = this.db.transaction(() => {
      if (newCurrentPath !== undefined) {
        this.applyVersionedUpdate(id, expectedVersion, 'estado = @estado, ruta_archivo_actual = @rutaArchivoActual', {
          estado: newStatus,
          rutaArchivoActual: newCurrentPath,
        });
      } else {
        this.applyVersionedUpdate(id, expectedVersion, 'estado = @estado', { estado: newStatus });
      }
    });
    run();
    return this.mustFindById(id);
  }

  async updatePreprocessMetadata(
    id: string,
    preprocess: PreprocesoMetadata,
    nextStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const run = this.db.transaction(() => {
      this.applyVersionedUpdate(id, expectedVersion, 'estado = @estado', { estado: nextStatus });
      this.upsertPreproceso(id, preprocess);
    });
    run();
    return this.mustFindById(id);
  }

  async updateExtractedMetadata(
    id: string,
    extractedMetadata: MetadatosOficio,
    nextStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const run = this.db.transaction(() => {
      this.applyVersionedUpdate(
        id,
        expectedVersion,
        'estado = @estado, metadatos_extraidos = @metadatosExtraidos, numero_oficio = @numeroOficio',
        {
          estado: nextStatus,
          metadatosExtraidos: JSON.stringify(extractedMetadata),
          numeroOficio: extractedMetadata.numeroOficio,
        }
      );
    });
    run();
    return this.mustFindById(id);
  }

  async updateHitlValidation(
    id: string,
    validatedMetadata: MetadatosOficio,
    canonicalName: string,
    mirrorJsonPath: string,
    userId: string,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const canonicalPdfPath = mirrorJsonPath.replace(/\.json$/i, '.pdf');
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      this.applyVersionedUpdate(
        id,
        expectedVersion,
        `estado = @estado,
         metadatos_validados = @metadatosValidados,
         numero_oficio = @numeroOficio,
         nombre_archivo_canonico = @nombreArchivoCanonico,
         ruta_archivo_actual = @rutaArchivoActual,
         ruta_espejo_json = @rutaEspejoJson,
         revisor_usuario_id = @revisorUsuarioId,
         fecha_validacion_hitl = @fechaValidacionHitl`,
        {
          estado: 'APROBADO_HITL' satisfies DocumentoEstado,
          metadatosValidados: JSON.stringify(validatedMetadata),
          numeroOficio: validatedMetadata.numeroOficio,
          nombreArchivoCanonico: canonicalName,
          rutaArchivoActual: canonicalPdfPath,
          rutaEspejoJson: mirrorJsonPath,
          revisorUsuarioId: userId,
          fechaValidacionHitl: now,
        }
      );
    });
    run();
    return this.mustFindById(id);
  }

  async updateRpaExecution(
    id: string,
    rpa: RpaEjecucion,
    finalStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      this.applyVersionedUpdate(
        id,
        expectedVersion,
        `estado = @estado, fecha_finalizacion = @fechaFinalizacion`,
        { estado: finalStatus, fechaFinalizacion: finalStatus === 'COMPLETADO' ? now : null }
      );
      this.db
        .prepare(
          `INSERT INTO rpa_ejecuciones (
            id, documento_id, folio_acuse_institucional, fecha_ejecucion, duracion_ms,
            captura_acuse_path, intentos, mensaje_error, exitoso
          ) VALUES (@id, @documentoId, @folio, @fechaEjecucion, @duracionMs, @capturaAcusePath, @intentos, @mensajeError, @exitoso)
          ON CONFLICT(documento_id) DO UPDATE SET
            folio_acuse_institucional = excluded.folio_acuse_institucional,
            fecha_ejecucion = excluded.fecha_ejecucion,
            duracion_ms = excluded.duracion_ms,
            captura_acuse_path = excluded.captura_acuse_path,
            intentos = excluded.intentos,
            mensaje_error = excluded.mensaje_error,
            exitoso = excluded.exitoso`
        )
        .run({
          id: rpa.id,
          documentoId: id,
          folio: rpa.folioAcuseInstitucional,
          fechaEjecucion: rpa.fechaEjecucion,
          duracionMs: rpa.duracionMs,
          capturaAcusePath: rpa.capturaAcusePath,
          intentos: rpa.intentos,
          mensajeError: rpa.mensajeError,
          exitoso: rpa.exitoso ? 1 : 0,
        });
    });
    run();
    return this.mustFindById(id);
  }

  async updateSheetsSync(
    id: string,
    sheetsSync: GoogleSheetsSync,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>> {
    const run = this.db.transaction(() => {
      this.applyVersionedUpdate(id, expectedVersion, 'estado = estado', {});
      this.upsertSheetsSync(id, sheetsSync);
    });
    run();
    return this.mustFindById(id);
  }

  // ---------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------

  /**
   * Aplica una actualización versionada sobre `documentos`. Lanza CONCURRENCY_VERSION_CONFLICT
   * o DOCUMENT_NOT_FOUND según corresponda cuando `changes === 0`. Debe invocarse siempre
   * dentro de una `db.transaction(...)` para mantener atomicidad con las tablas satélite.
   */
  private applyVersionedUpdate(id: string, expectedVersion: number, setClause: string, params: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE documentos SET ${setClause}, version = version + 1, updated_at = @updatedAt WHERE id = @id AND version = @expectedVersion`
      )
      .run({ ...params, id, expectedVersion, updatedAt: now });

    if (result.changes === 0) {
      const existing = this.db
        .prepare<{ id: string }, { version: number }>('SELECT version FROM documentos WHERE id = @id')
        .get({ id });

      if (!existing) {
        throw new SqliteRepositoryError('DOCUMENT_NOT_FOUND', `Documento no encontrado: ${id}`, { documentId: id });
      }
      throw new SqliteRepositoryError(
        'CONCURRENCY_VERSION_CONFLICT',
        `Conflicto de concurrencia en el documento ${id}: versión esperada ${expectedVersion}, actual ${existing.version}.`,
        { documentId: id, currentVersion: existing.version, expectedVersion }
      );
    }
  }

  private upsertPreproceso(documentoId: string, preprocess: PreprocesoMetadata): void {
    this.db
      .prepare(
        `INSERT INTO preproceso_metadata (
          documento_id, page_count, file_size_bytes, sha256_hash, paginas, processing_duration_ms, is_sanitized
        ) VALUES (@documentoId, @pageCount, @fileSizeBytes, @sha256Hash, @paginas, @processingDurationMs, @isSanitized)
        ON CONFLICT(documento_id) DO UPDATE SET
          page_count = excluded.page_count,
          file_size_bytes = excluded.file_size_bytes,
          sha256_hash = excluded.sha256_hash,
          paginas = excluded.paginas,
          processing_duration_ms = excluded.processing_duration_ms,
          is_sanitized = excluded.is_sanitized`
      )
      .run({
        documentoId,
        pageCount: preprocess.pageCount,
        fileSizeBytes: preprocess.fileSizeBytes,
        sha256Hash: preprocess.sha256Hash,
        paginas: JSON.stringify(preprocess.paginas),
        processingDurationMs: preprocess.processingDurationMs,
        isSanitized: preprocess.isSanitized ? 1 : 0,
      });
  }

  private upsertSheetsSync(documentoId: string, sheetsSync: GoogleSheetsSync): void {
    this.db
      .prepare(
        `INSERT INTO google_sheets_sync (
          documento_id, sincronizado, fila_index, timestamp_sincronizacion, error_sincronizacion, actualizado_en
        ) VALUES (@documentoId, @sincronizado, @filaIndex, @timestamp, @error, @actualizadoEn)
        ON CONFLICT(documento_id) DO UPDATE SET
          sincronizado = excluded.sincronizado,
          fila_index = excluded.fila_index,
          timestamp_sincronizacion = excluded.timestamp_sincronizacion,
          error_sincronizacion = excluded.error_sincronizacion,
          actualizado_en = excluded.actualizado_en`
      )
      .run({
        documentoId,
        sincronizado: sheetsSync.sincronizado ? 1 : 0,
        filaIndex: sheetsSync.filaIndex,
        timestamp: sheetsSync.timestampSincronizacion,
        error: sheetsSync.errorSincronizacion,
        actualizadoEn: new Date().toISOString(),
      });
  }

  private mustFindById(id: string): Readonly<DocumentoRegistro> {
    const row = this.db.prepare<{ id: string }, DocumentoRow>('SELECT * FROM documentos WHERE id = @id').get({ id });
    if (!row) {
      throw new SqliteRepositoryError('DOCUMENT_NOT_FOUND', `Documento no encontrado tras la escritura: ${id}`, { documentId: id });
    }
    return this.assemble(row);
  }

  private assemble(row: DocumentoRow): Readonly<DocumentoRegistro> {
    const preproceso = this.db
      .prepare<{ id: string }, PreprocesoRow>('SELECT * FROM preproceso_metadata WHERE documento_id = @id')
      .get({ id: row.id });
    const rpa = this.db.prepare<{ id: string }, RpaRow>('SELECT * FROM rpa_ejecuciones WHERE documento_id = @id').get({ id: row.id });
    const sheets = this.db
      .prepare<{ id: string }, SheetsRow>('SELECT * FROM google_sheets_sync WHERE documento_id = @id')
      .get({ id: row.id });

    const document: DocumentoRegistro = {
      id: row.id,
      nombreArchivoOriginal: row.nombre_archivo_original,
      nombreArchivoCanonico: row.nombre_archivo_canonico,
      rutaArchivoActual: row.ruta_archivo_actual,
      rutaEspejoJson: row.ruta_espejo_json,
      origen: row.origen,
      estado: row.estado,
      sha256Hash: row.sha256_hash,
      metadatosExtraidos: row.metadatos_extraidos ? (JSON.parse(row.metadatos_extraidos) as MetadatosOficio) : null,
      metadatosValidados: row.metadatos_validados ? (JSON.parse(row.metadatos_validados) as MetadatosOficio) : null,
      preproceso: preproceso
        ? {
            pageCount: preproceso.page_count,
            fileSizeBytes: preproceso.file_size_bytes,
            sha256Hash: preproceso.sha256_hash,
            paginas: JSON.parse(preproceso.paginas),
            processingDurationMs: preproceso.processing_duration_ms,
            isSanitized: preproceso.is_sanitized === 1,
          }
        : null,
      rpa: rpa
        ? {
            id: rpa.id,
            documentoId: rpa.documento_id,
            folioAcuseInstitucional: rpa.folio_acuse_institucional,
            fechaEjecucion: rpa.fecha_ejecucion,
            duracionMs: rpa.duracion_ms,
            capturaAcusePath: rpa.captura_acuse_path,
            intentos: rpa.intentos,
            mensajeError: rpa.mensaje_error,
            exitoso: rpa.exitoso === 1,
          }
        : null,
      sheetsSync: sheets
        ? {
            sincronizado: sheets.sincronizado === 1,
            filaIndex: sheets.fila_index,
            timestampSincronizacion: sheets.timestamp_sincronizacion,
            errorSincronizacion: sheets.error_sincronizacion,
          }
        : { sincronizado: false, filaIndex: null, timestampSincronizacion: null, errorSincronizacion: null },
      revisorUsuarioId: row.revisor_usuario_id,
      fechaIngesta: row.fecha_ingesta,
      fechaValidacionHitl: row.fecha_validacion_hitl,
      fechaFinalizacion: row.fecha_finalizacion,
      updatedAt: row.updated_at,
      version: row.version,
    };

    return Object.freeze(document);
  }

  private isUniqueConstraintViolation(cause: unknown, column: string): boolean {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.includes('UNIQUE constraint failed') && message.includes(column);
  }
}
