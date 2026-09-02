/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Procesamiento y Sanitización de PDF (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type { PreprocesoMetadata } from './types';

/**
 * Errores específicos del motor de procesamiento e inspección de PDFs.
 */
export type PdfProcessingErrorCode =
  | 'CORRUPTED_PDF_STRUCTURE'
  | 'PASSWORD_PROTECTED_FILE'
  | 'ZERO_BYTE_OR_EMPTY_BUFFER'
  | 'RENDERING_EXECUTION_TIMEOUT'
  | 'UNSUPPORTED_DPI_OR_DIMENSIONS'
  | 'SANITIZATION_FAILED'
  | 'WORKER_SUBPROCESS_FAULT';

/**
 * Estructura de error para fallos de preprocesamiento de documentos.
 */
export interface PdfProcessingError {
  code: PdfProcessingErrorCode;
  message: string;
  underlyingExitCode?: number;
  cause?: unknown;
}

/**
 * Opciones de renderizado para optimizar las páginas antes de la inferencia multimodal.
 */
export interface PageRenderOptions {
  /** DPI objetivo para normalizar la resolución (ej. 300 DPI) */
  targetDpi?: number;
  /** Formato de compresión de las imágenes generadas */
  format?: 'image/png' | 'image/jpeg';
  /** Límite superior de páginas a renderizar (evita desbordamiento de memoria) */
  maxPages?: number;
}

/**
 * Representación inmutable de una página renderizada y optimizada en memoria.
 */
export interface RenderedPageImage {
  /** Número de página relativo (1-indexed) */
  pageNumber: number;
  /** Buffer binario de la imagen lista para inferencia */
  imageBuffer: Uint8Array;
  /** Formato MIME de la imagen */
  mimeType: 'image/png' | 'image/jpeg';
  /** Dimensiones reales de la imagen generada */
  widthPx: number;
  heightPx: number;
  /** Densidad resultante */
  dpi: number;
}

/**
 * Resultado completo del proceso de inspección, sanitización y auditoría técnica.
 */
export interface PdfInspectionResult {
  /** Métricas técnicas requeridas por el modelo de dominio */
  metadata: PreprocesoMetadata;
  /** Buffer binario del PDF sanitizado sin streams corruptos */
  sanitizedBuffer: Uint8Array;
}

/**
 * Descripción del Contrato: IPdfProcessorProvider
 * Propósito: Aislar la invocación de herramientas de procesamiento documental de bajo nivel
 * (PyMuPDF, Pillow, subprocesos CLI), entregando buffers sanitizados e imágenes normalizadas para el LLM.
 */
export interface IPdfProcessorProvider {
  /**
   * Inspecciona la integridad estructural del documento, repara inconsistencias menores,
   * calcula las dimensiones/DPI por página y computa el hash criptográfico SHA-256.
   *
   * @param rawFileBuffer Buffer binario del archivo original sin procesar.
   * @returns Metadatos técnicos y el buffer sanitizado.
   * @throws {PdfProcessingError} Con PASSWORD_PROTECTED_FILE si el PDF requiere clave.
   * @throws {PdfProcessingError} Con CORRUPTED_PDF_STRUCTURE si el parser no puede reconstruir el árbol xref.
   * @performance Ejecuta validación en memoria y cálculos matemáticos por página.
   * @sideEffect No persiste archivos en disco de forma permanente.
   */
  inspectAndSanitize(rawFileBuffer: Uint8Array): Promise<PdfInspectionResult>;

  /**
   * Renderiza las páginas del documento como imágenes de alta resolución optimizadas
   * para el análisis visual del motor de inferencia multimodal.
   *
   * @param sanitizedBuffer Buffer del PDF previamente sanitizado.
   * @param options Configuración de DPI y formato de salida.
   * @returns Colección inmutable de buffers de imagen ordenados por número de página.
   * @performance Proceso intensivo de CPU. Se ejecuta en aislamiento para evitar bloqueos del event-loop.
   */
  renderPagesForInference(
    sanitizedBuffer: Uint8Array,
    options?: PageRenderOptions
  ): Promise<ReadonlyArray<RenderedPageImage>>;

  /**
   * Verifica de manera rápida si un buffer binario cumple con la firma de cabecera mágica de un PDF válido (%PDF-).
   *
   * @param buffer Primeros bytes del archivo para verificación preliminar.
   * @returns `true` si el archivo contiene una cabecera reconocible.
   * @performance Operación síncrona/inmediata O(1).
   */
  hasValidPdfHeader(buffer: Uint8Array): boolean;
}
