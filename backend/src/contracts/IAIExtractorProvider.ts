/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Extracción Inteligente de Metadatos por IA (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type { MetadatosOficio } from './types';
import type { RenderedPageImage } from './IPdfProcessorProvider';

/**
 * Errores controlados del motor de inferencia multimodal y validación de esquema.
 */
export type AIExtractionErrorCode =
  | 'MODEL_RATE_LIMIT_EXCEEDED'
  | 'INFERENCE_TIMEOUT'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SAFETY_CONTENT_BLOCKED'
  | 'MALFORMED_JSON_RESPONSE'
  | 'AI_SERVICE_UNAVAILABLE'
  | 'DOCUMENT_UNREADABLE_OR_EMPTY';

/**
 * Representación estructurada de un fallo durante la fase de extracción por IA.
 */
export interface AIExtractionError {
  code: AIExtractionErrorCode;
  message: string;
  rawResponse?: string;
  validationIssues?: Array<{ path: string; message: string }>;
  cause?: unknown;
}

/**
 * Metadatos contextuales o pistas opcionales para guiar la inferencia sin acoplar el prompt.
 */
export interface ExtractionHints {
  /** Sugerencia de procedencia preliminar si se conoce por el canal de ingesta */
  defaultProcedencia?: 'HCG' | 'Ajena';
  /** Año de contexto de emisión para desambiguar fechas borrosas */
  contextYear?: number;
}

/**
 * Métricas de consumo y latencia de la llamada al motor de inferencia.
 */
export interface ExtractionTelemetry {
  /** Tokens de entrada consumidos (imágenes y texto de sistema) */
  promptTokens: number;
  /** Tokens de salida generados en el JSON */
  completionTokens: number;
  /** Latencia de la solicitud HTTP en milisegundos */
  latencyMs: number;
  /** Identificador del modelo subyacente que resolvió la inferencia */
  modelVersion: string;
}

/**
 * Envoltorio inmutable del resultado de la inferencia junto a su telemetría.
 */
export interface ExtractionResult {
  /** Metadatos estructurados validados contra el contrato estricto de dominio */
  metadata: Readonly<MetadatosOficio>;
  /** Métricas de consumo del modelo */
  telemetry: ExtractionTelemetry;
}

/**
 * Descripción del Contrato: IAIExtractorProvider
 * Propósito: Abstraer el motor de visión e inferencia multimodal (LLM) y la validación de esquemas Zod,
 * permitiendo cambiar el proveedor de IA o actualizar el modelo sin modificar los casos de uso.
 */
export interface IAIExtractorProvider {
  /**
   * Extrae los metadatos de un oficio procesando las imágenes renderizadas de sus páginas.
   *
   * @param pages Colección de imágenes de alta resolución del documento.
   * @param hints Parámetros opcionales para guiar la interpretación de la IA.
   * @returns Resultado tipado inmutable que cumple con MetadatosOficio y su telemetría.
   * @throws {AIExtractionError} Con SCHEMA_VALIDATION_FAILED si el JSON generado no cumple el esquema Zod.
   * @throws {AIExtractionError} Con MODEL_RATE_LIMIT_EXCEEDED ante saturación de cuota de API.
   * @throws {AIExtractionError} Con INFERENCE_TIMEOUT si la llamada excede el tiempo límite de red.
   * @performance Depende de la latencia de red del proveedor y del número de páginas enviadas.
   * @sideEffect No persiste datos en servidores externos (conexión en tránsito sin retención).
   */
  extractFromPages(pages: ReadonlyArray<RenderedPageImage>, hints?: ExtractionHints): Promise<ExtractionResult>;

  /**
   * Realiza un diagnóstico de disponibilidad y conectividad con el proveedor de IA.
   *
   * @returns `true` si el servicio está operativo y cuenta con cuota disponible.
   * @performance Útil para health-checks y circuit breakers en el orquestador.
   */
  ping(): Promise<boolean>;
}
