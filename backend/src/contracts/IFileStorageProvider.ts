/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Abstracción de Almacenamiento de Archivos (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type { MetadatosOficio } from './types';

/**
 * Errores tipados específicos de operaciones de almacenamiento.
 * Permiten a los orquestadores manejar excepciones de E/S sin conocer el driver subyacente.
 */
export type StorageErrorCode =
  | 'FILE_NOT_FOUND'
  | 'FILE_ALREADY_EXISTS'
  | 'INVALID_FILE_NAME'
  | 'STORAGE_PERMISSION_DENIED'
  | 'DIRECTORY_CREATION_FAILED'
  | 'MIRROR_JSON_WRITE_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED';

/**
 * Representación estructurada de un fallo en la capa de almacenamiento.
 */
export interface StorageError {
  code: StorageErrorCode;
  message: string;
  targetPath?: string;
  cause?: unknown;
}

/**
 * Resultado inmutable tras la consolidación canónica en la fase final de salida.
 */
export interface CanonicalStorageResult {
  /** Ruta o URI final del archivo PDF estructurado */
  canonicalPdfPath: string;
  /** Ruta o URI del archivo JSON espejo con metadatos */
  mirrorJsonPath: string;
  /** Checksum SHA-256 verificado en la ubicación final */
  sha256Hash: string;
}

/**
 * Etapas del pipeline de almacenamiento documental.
 */
export type StorageStage = '01_entrada' | '02_en_proceso' | '03_procesados' | '04_errores';

/**
 * Descripción del Contrato: IFileStorageProvider
 * Propósito: Aislar el sistema de archivos local (storage/) y permitir la interoperabilidad
 * con volúmenes de red SMB, buckets de nube o discos locales sin impactar la lógica de negocio.
 */
export interface IFileStorageProvider {
  /**
   * Guarda un archivo recibido en la zona de ingesta temporal.
   *
   * @param fileName Nombre original del archivo.
   * @param content Buffer binario del documento.
   * @returns Ruta relativa o identificador persistido en storage/01_entrada/.
   * @throws {StorageError} Si el buffer está vacío o no hay permisos de escritura.
   * @sideEffect Escribe físicamente en el disco o volumen montado.
   */
  saveIncoming(fileName: string, content: Uint8Array): Promise<string>;

  /**
   * Mueve un archivo desde la zona de ingesta hacia la zona de trabajo bloqueado.
   *
   * @param relativeSourcePath Ruta actual del documento (ej. storage/01_entrada/archivo.pdf).
   * @param targetIdentifier Identificador único para renombrado en proceso (UUID).
   * @returns Ruta de bloqueo dentro de storage/02_en_proceso/.
   * @throws {StorageError} Si el archivo fuente no existe o está bloqueado por el SO.
   * @performance Operación atómica (rename / link) para evitar transferencias completas en disco.
   */
  moveToInProcess(relativeSourcePath: string, targetIdentifier: string): Promise<string>;

  /**
   * Consolida el documento en el repositorio cronológico canónico y genera el archivo JSON espejo.
   *
   * @param currentPath Ruta del archivo en proceso (storage/02_en_proceso/UUID.pdf).
   * @param year Año calendario para la estructura de carpetas (ej. "2026").
   * @param month Mes calendario para la estructura de carpetas (ej. "09").
   * @param canonicalFileName Nombre normalizado: YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf.
   * @param metadata Objeto inmutable con los metadatos validados en HITL para el JSON espejo.
   * @returns Estructura con las rutas definitivas del PDF y del JSON espejo generado.
   * @sideEffect Crea directorios YYYY/MM recursivamente y escribe el archivo .json adjunto.
   */
  moveToCanonical(
    currentPath: string,
    year: string,
    month: string,
    canonicalFileName: string,
    metadata: Readonly<MetadatosOficio>
  ): Promise<CanonicalStorageResult>;

  /**
   * Mueve un documento con errores críticos o fallos irrecuperables a la carpeta de aislamiento.
   *
   * @param currentPath Ubicación del documento fallido.
   * @param reason Motivo del fallo o código de error para trazabilidad.
   * @returns Ruta dentro de storage/04_errores/.
   * @sideEffect Mueve el archivo y previene reprocesamientos accidentales.
   */
  moveToError(currentPath: string, reason: string): Promise<string>;

  /**
   * Obtiene los bytes de un archivo dado su identificador o ruta.
   *
   * @param relativePath Ubicación del archivo en el storage.
   * @returns Buffer en memoria del archivo solicitado.
   * @throws {StorageError} Con código FILE_NOT_FOUND si el recurso no existe.
   * @performance Puede retornar streams en implementaciones avanzadas para archivos pesados.
   */
  readFile(relativePath: string): Promise<Uint8Array>;

  /**
   * Verifica la existencia física de un recurso en el almacenamiento.
   *
   * @param relativePath Ubicación a comprobar.
   * @returns `true` si el archivo existe y es legible, `false` en caso contrario.
   */
  exists(relativePath: string): Promise<boolean>;
}
