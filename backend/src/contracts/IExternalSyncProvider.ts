/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Sincronización Externa e Indexación de Términos (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type { GoogleSheetsSync, MetadatosOficio, RpaEjecucion } from './types';

/**
 * Errores específicos del canal de sincronización con tableros y hojas externas.
 */
export type ExternalSyncErrorCode =
  | 'GOOGLE_AUTH_FAILED'
  | 'SPREADSHEET_NOT_FOUND'
  | 'WORKSHEET_TAB_NOT_FOUND'
  | 'RATE_LIMIT_QUOTA_EXCEEDED'
  | 'APPEND_ROW_FAILED'
  | 'EXTERNAL_SERVICE_UNAVAILABLE'
  | 'INVALID_RANGE_SPECIFICATION';

/**
 * Representación estructurada de una excepción en la sincronización externa.
 */
export interface ExternalSyncError {
  code: ExternalSyncErrorCode;
  message: string;
  spreadsheetId?: string;
  rowAttempted?: number;
  cause?: unknown;
}

/**
 * Datos requeridos para tabular el oficio en el tablero central de control.
 */
export interface DocumentSyncPayload {
  /** Identificador único global del registro documental */
  documentId: string;
  /** Nombre normalizado final del archivo en disco */
  canonicalFileName: string;
  /** Metadatos confirmados en la fase HITL */
  metadata: Readonly<MetadatosOficio>;
  /** Información de confirmación institucional del RPA (si ya fue completado) */
  rpaExecution?: Readonly<RpaEjecucion> | null;
  /** Timestamp UTC de finalización o ingesta */
  timestamp: string;
}

/**
 * Descripción del Contrato: IExternalSyncProvider
 * Propósito: Abstraer la conexión con servicios de tableros externos (Google Sheets API v4),
 * desacoplando la autenticación por Service Account y el formateo de celdas de la lógica central.
 */
export interface IExternalSyncProvider {
  /**
   * Inserta una nueva fila en el tablero de control de la DSA para seguimiento de términos y plazos.
   *
   * @param payload Información del documento y metadatos validados.
   * @returns Registro inmutable del estado de sincronización con el índice de fila asignado.
   * @throws {ExternalSyncError} Con RATE_LIMIT_QUOTA_EXCEEDED o APPEND_ROW_FAILED ante fallos de API.
   * @performance Ejecuta una llamada HTTP remota (REST v4). Debe ejecutarse de manera asíncrona.
   * @sideEffect Inserta una fila al final de la hoja de cálculo configurada.
   */
  appendDocumentRow(payload: DocumentSyncPayload): Promise<Readonly<GoogleSheetsSync>>;

  /**
   * Actualiza el estatus o número de folio institucional en una fila previamente sincronizada.
   *
   * @param rowIndex Número de fila en la hoja de cálculo (1-indexed).
   * @param rpaData Datos generados por la automatización Playwright (acuse, folio).
   * @returns Estado de sincronización actualizado.
   * @throws {ExternalSyncError} Si el índice de fila está fuera de rango o el servicio no responde.
   */
  updateRowRpaStatus(
    rowIndex: number,
    rpaData: Readonly<RpaEjecucion>
  ): Promise<Readonly<GoogleSheetsSync>>;

  /**
   * Realiza una sincronización por lote de múltiples documentos pendientes.
   *
   * @param payloads Colección de registros listos para exportación.
   * @returns Colección de resultados con índices de fila correspondientes.
   * @performance Optimiza cuota de red agrupando inserciones en una sola solicitud batch.
   */
  appendBatchRows(
    payloads: ReadonlyArray<DocumentSyncPayload>
  ): Promise<ReadonlyArray<GoogleSheetsSync>>;

  /**
   * Verifica la validez de las credenciales de servicio y el acceso a la hoja designada.
   *
   * @returns `true` si la conexión con la API y la hoja de cálculo está activa.
   */
  checkConnection(): Promise<boolean>;
}
