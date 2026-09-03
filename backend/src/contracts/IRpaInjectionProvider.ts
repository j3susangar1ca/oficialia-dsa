/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Inyección Automatizada y Captura de Acuses (Puerto Secundario)
 * Versión: 1.0.0-MVP
 */

import type { MetadatosOficio, RpaEjecucion } from './types';

/**
 * Errores controlados específicos de la automatización web y navegación en la Intranet.
 */
export type RpaErrorCode =
  | 'INTRANET_AUTH_FAILED'
  | 'SESSION_EXPIRED'
  | 'WEBIX_FORM_TIMEOUT'
  | 'FILE_UPLOAD_FAILED'
  | 'CONFIRMATION_FOLIO_NOT_FOUND'
  | 'TARGET_CLOSED_OR_CRASHED'
  | 'INTRANET_UNREACHABLE_OR_OFFLINE';

/**
 * Representación estructurada de un fallo en la ejecución RPA.
 */
export interface RpaExecutionError {
  code: RpaErrorCode;
  message: string;
  screenshotErrorPath?: string;
  attemptCount: number;
  durationMs: number;
  cause?: unknown;
}

/**
 * Opciones de ejecución y configuración de resiliencia para el worker de automatización.
 */
export interface RpaExecutionOptions {
  /** Límite de tiempo máximo para la sesión completa de automatización en milisegundos */
  timeoutMs?: number;
  /** Cantidad máxima de reintentos automáticos permitidos ante fallas transitorias */
  maxRetries?: number;
  /** Bandera para habilitar ejecución en modo visible (útil para debugging en staging) */
  headless?: boolean;
}

/**
 * Payload requerido para realizar la inyección en el módulo institucional.
 */
export interface RpaInjectionPayload {
  /** Identificador único del documento en el sistema */
  documentId: string;
  /** Metadatos definitivos validados durante la fase HITL */
  metadata: Readonly<MetadatosOficio>;
  /** Ruta física o URI accesible al archivo PDF canónico estandarizado */
  canonicalPdfPath: string;
}

/**
 * Descripción del Contrato: IRpaInjectionProvider
 * Propósito: Abstraer el motor de automatización (Playwright) y la interacción con la interfaz
 * legacy Webix (op_cucs.fwx), permitiendo inyectar metadatos, adjuntar el archivo y capturar el acuse.
 */
export interface IRpaInjectionProvider {
  /**
   * Inyecta los metadatos de un oficio en el formulario Webix, adjunta el PDF y captura el acuse.
   *
   * @param payload Datos del documento, metadatos estructurados y ruta del PDF final.
   * @param options Parámetros de timeout, reintentos y configuración del navegador.
   * @returns Resultado inmutable de la ejecución RPA con el folio oficial o detalles del intento.
   * @throws {RpaExecutionError} Si se superan los reintentos o el formulario no responde.
   * @performance Proceso asíncrono intensivo en I/O de red y memoria (gestión de navegador headless).
   * @sideEffect Crea un nuevo registro en la base de datos de la Intranet y guarda la captura del acuse.
   */
  injectDocument(payload: RpaInjectionPayload, options?: RpaExecutionOptions): Promise<Readonly<RpaEjecucion>>;

  /**
   * Ejecuta un reintento manual de inyección para documentos en estado de error previo.
   *
   * @param previousExecutionId Identificador UUID de la ejecución RPA previa fallida.
   * @param payload Nuevos datos o reenvío del payload original.
   * @param options Opciones de ejecución.
   * @returns Resultado del nuevo intento con el contador de reintentos incrementado.
   */
  retryInjection(
    previousExecutionId: string,
    payload: RpaInjectionPayload,
    options?: RpaExecutionOptions
  ): Promise<Readonly<RpaEjecucion>>;

  /**
   * Valida la conectividad con la Intranet y el estado de la sesión activa del usuario institucional.
   *
   * @returns `true` si el portal Webix responde y la autenticación es válida.
   * @performance Llamada ligera para health-checks y prevención de fallos antes de encolar.
   */
  checkIntranetHealth(): Promise<boolean>;
}
