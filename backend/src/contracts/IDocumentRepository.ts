/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Repositorio de Persistencia Documental (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type {
  DocumentoRegistro,
  DocumentoEstado,
  MetadatosOficio,
  PreprocesoMetadata,
  RpaEjecucion,
  GoogleSheetsSync,
} from './types';

/**
 * Errores controlados de la capa de persistencia.
 * Desacoplan las excepciones SQL/ORM del dominio.
 */
export type RepositoryErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'DUPLICATE_DOCUMENT_HASH'
  | 'DUPLICATE_FOLIO_REGISTERED'
  | 'CONCURRENCY_VERSION_CONFLICT'
  | 'PERSISTENCE_TRANSACTION_FAILED'
  | 'DATABASE_BUSY_TIMEOUT';

/**
 * Estructura de error especializada para persistencia.
 */
export interface RepositoryError {
  code: RepositoryErrorCode;
  message: string;
  documentId?: string;
  currentVersion?: number;
  expectedVersion?: number;
  cause?: unknown;
}

/**
 * Filtros de consulta agnósticos para indexación y bandejas de trabajo.
 */
export interface DocumentQueryFilters {
  /** Filtrado por estado transaccional */
  estado?: DocumentoEstado;
  /** Filtrado por múltiples estados simultáneamente */
  estados?: DocumentoEstado[];
  /** Filtrado por emisor o procedencia */
  procedencia?: 'HCG' | 'Ajena';
  /** Búsqueda por folio de oficio */
  numeroOficio?: string;
  /** Rango de fechas de ingesta (ISO 8601) */
  fechaDesde?: string;
  fechaHasta?: string;
  /** Paginación */
  limit?: number;
  offset?: number;
}

/**
 * DTO para la creación inicial de un registro documental.
 */
export type CreateDocumentRecordDTO = Omit<
  DocumentoRegistro,
  'id' | 'version' | 'updatedAt' | 'fechaIngesta' | 'fechaValidacionHitl' | 'fechaFinalizacion'
>;

/**
 * Descripción del Contrato: IDocumentRepository
 * Propósito: Gestionar el ciclo de vida del estado transaccional de los documentos,
 * garantizando integridad atómica, control de concurrencia optimista y desacoplamiento del motor SQL.
 */
export interface IDocumentRepository {
  /**
   * Persiste un nuevo registro documental con control atómico de unicidad por hash.
   *
   * @param document Datos base de ingesta del documento.
   * @returns Registro persistido con UUID v4, version = 1 y marcas de tiempo inicializadas.
   * @throws {RepositoryError} Con código DUPLICATE_DOCUMENT_HASH si el hash SHA-256 ya existe.
   * @sideEffect Inserta una fila en la base de datos principal.
   */
  create(document: CreateDocumentRecordDTO): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Obtiene un registro por su identificador único (UUID).
   *
   * @param id Identificador único del registro.
   * @returns El registro documental o `null` si no existe.
   * @performance Búsqueda indexada por Primary Key (O(1)).
   */
  findById(id: string): Promise<Readonly<DocumentoRegistro> | null>;

  /**
   * Busca un documento por su huella criptográfica SHA-256 para prevenir ingestas duplicadas.
   *
   * @param sha256Hash Checksum de 64 caracteres en formato hexadecimal.
   * @returns El registro coincidente o `null` si es inédito.
   * @performance Búsqueda con índice único en B-Tree.
   */
  findByHash(sha256Hash: string): Promise<Readonly<DocumentoRegistro> | null>;

  /**
   * Busca si un número de oficio ya fue procesado con anterioridad.
   *
   * @param numeroOficio Folio oficial sanitizado.
   * @returns El registro coincidente o `null`.
   */
  findByFolio(numeroOficio: string): Promise<Readonly<DocumentoRegistro> | null>;

  /**
   * Consulta documentos según filtros específicos (bandejas HITL, reportes, colas de trabajo).
   *
   * @param filters Criterios de filtrado y paginación.
   * @returns Colección inmutable de documentos ordenados cronológicamente por fechaIngesta.
   */
  findMany(filters: DocumentQueryFilters): Promise<ReadonlyArray<DocumentoRegistro>>;

  /**
   * Actualiza el estado transaccional simple con validación de concurrencia optimista.
   *
   * @param id Identificador único del documento.
   * @param newStatus Nuevo estado de la máquina de estados.
   * @param expectedVersion Versión esperada del registro antes del cambio.
   * @param newCurrentPath Extensión NO presente en el boceto original de contracts.md:
   *   cuando la transición de estado coincide con un movimiento físico del archivo que
   *   NO es la consolidación canónica (p. ej. `storage/01_entrada/` → `storage/02_en_proceso/`
   *   al entrar a PENDIENTE_EXTRACCION), no existe otro método del contrato para persistir
   *   el nuevo `rutaArchivoActual` — `updateHitlValidation` solo cubre la consolidación
   *   final. Parámetro opcional para no romper compatibilidad con las llamadas de 3
   *   argumentos ya descritas en el diagrama de secuencia.
   * @returns Documento actualizado con version incrementada (+1).
   * @throws {RepositoryError} Con código CONCURRENCY_VERSION_CONFLICT si version != expectedVersion.
   */
  updateStatus(
    id: string,
    newStatus: DocumentoEstado,
    expectedVersion: number,
    newCurrentPath?: string
  ): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Guarda los metadatos técnicos generados por el worker de preprocesamiento.
   *
   * @param id Identificador único del documento.
   * @param preprocess Métricas técnicas de PyMuPDF y Pillow.
   * @param nextStatus Estado subsiguiente (ej. PENDIENTE_EXTRACCION).
   * @param expectedVersion Versión esperada para control optimista.
   * @returns Documento actualizado.
   * @throws {RepositoryError} Si ocurre un conflicto de versión.
   */
  updatePreprocessMetadata(
    id: string,
    preprocess: PreprocesoMetadata,
    nextStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Almacena los metadatos estructurados inferidos por la IA.
   *
   * @param id Identificador único del documento.
   * @param extractedMetadata Metadatos obtenidos de la inferencia.
   * @param nextStatus Estado resultante (ej. PENDIENTE_REVISION).
   * @param expectedVersion Versión esperada.
   * @returns Documento actualizado.
   */
  updateExtractedMetadata(
    id: string,
    extractedMetadata: MetadatosOficio,
    nextStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Persiste la validación humana (HITL), asignando la nomenclatura canónica y el revisor.
   *
   * @param id Identificador único del documento.
   * @param validatedMetadata Metadatos definitivos confirmados por el usuario.
   * @param canonicalName Nombre estandarizado YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf.
   * @param mirrorJsonPath Ruta física del archivo JSON espejo.
   * @param userId Identificador del capturista que autorizó la operación.
   * @param expectedVersion Versión esperada.
   * @returns Documento actualizado en estado APROBADO_HITL o EN_RPA.
   * @sideEffect Establece fechaValidacionHitl con timestamp UTC actual.
   */
  updateHitlValidation(
    id: string,
    validatedMetadata: MetadatosOficio,
    canonicalName: string,
    mirrorJsonPath: string,
    userId: string,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Registra el resultado de la inyección RPA en la Intranet y consolida el ciclo de vida.
   *
   * @param id Identificador único del documento.
   * @param rpa Resultado detallado de la automatización Playwright.
   * @param finalStatus Estado final (COMPLETADO o ERROR_RPA).
   * @param expectedVersion Versión esperada.
   * @returns Documento actualizado.
   * @sideEffect Si finalStatus es COMPLETADO, establece fechaFinalizacion.
   */
  updateRpaExecution(
    id: string,
    rpa: RpaEjecucion,
    finalStatus: DocumentoEstado,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>>;

  /**
   * Actualiza el estado de sincronización hacia el tablero central de control externo.
   *
   * @param id Identificador único del documento.
   * @param sheetsSync Información de la fila y timestamp de sincronización.
   * @param expectedVersion Versión esperada.
   * @returns Documento actualizado.
   */
  updateSheetsSync(
    id: string,
    sheetsSync: GoogleSheetsSync,
    expectedVersion: number
  ): Promise<Readonly<DocumentoRegistro>>;
}
