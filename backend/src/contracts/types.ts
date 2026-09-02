/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Definiciones de Tipos Centralizadas y Modelo de Dominio
 * Versión: 1.0.0-MVP
 *
 * Fuente canónica: /docs/types.md. No duplicar ni redefinir
 * estos tipos fuera de este archivo — el resto de las capas (aplicación,
 * infraestructura, presentación) deben importar desde aquí.
 */

// ==========================================
// 1. ENUMERACIONES Y TIPOS DE ESTADO
// ==========================================

/** Canal por el cual ingresó el documento al sistema */
export type IngestaOrigen = 'SCANNER_ADF' | 'WEB_DRAG_DROP';

/** Procedencia institucional del oficio */
export type ProcedenciaTipo = 'HCG' | 'Ajena';

/**
 * Máquina de estados del ciclo de vida del documento
 * - PENDIENTE_PREPROCESO: Recibido en storage/01_entrada/
 * - EN_PREPROCESO: Procesamiento de imagen/sanitización con Python CLI
 * - PENDIENTE_EXTRACCION: Listo para llamada a Gemini 2.5 Flash
 * - EN_EXTRACCION: Esperando respuesta del SDK @google/genai
 * - PENDIENTE_REVISION: Esperando validación en UI Split-Screen Svelte 5
 * - EN_REVISION: Bloqueado por un capturista en HITL
 * - APROBADO_HITL: Confirmado por capturista, encolado para salida
 * - EN_RPA: Worker Playwright inyectando en op_cucs.fwx
 * - COMPLETADO: Guardado canónico, indexado en SQLite, Sheets y RPA confirmado
 * - ERROR_PREPROCESO: Fallo en PyMuPDF/Pillow (archivo corrupto, contraseña)
 * - ERROR_EXTRACCION: Fallo de API Gemini o Schema Validation Zod
 * - ERROR_RPA: Fallo de timeout/sesión en Webix Intranet (permite reintento)
 */
export type DocumentoEstado =
  | 'PENDIENTE_PREPROCESO'
  | 'EN_PREPROCESO'
  | 'PENDIENTE_EXTRACCION'
  | 'EN_EXTRACCION'
  | 'PENDIENTE_REVISION'
  | 'EN_REVISION'
  | 'APROBADO_HITL'
  | 'EN_RPA'
  | 'COMPLETADO'
  | 'ERROR_PREPROCESO'
  | 'ERROR_EXTRACCION'
  | 'ERROR_RPA';

/** Subconjunto de estados que representan un fallo terminal o reintentable. */
export const ESTADOS_ERROR: ReadonlySet<DocumentoEstado> = new Set<DocumentoEstado>([
  'ERROR_PREPROCESO',
  'ERROR_EXTRACCION',
  'ERROR_RPA',
]);

// ==========================================
// 2. MODELADO DE ENTIDADES DEL DOMINIO
// ==========================================

/**
 * Metadatos estructurados extraídos del oficio.
 * Cumple con el contrato de inferencia Zod y mapeo Webix.
 */
export interface MetadatosOficio {
  /**
   * Número de oficio o folio oficial sanitizado (sin caracteres / \ : * ? " < > |)
   * @example "DSA-2026-089-OF" o "S/N"
   */
  numeroOficio: string;

  /**
   * Fecha de emisión del oficio
   * @format ISO 8601 Calendar Date: YYYY-MM-DD
   * @example "2026-09-01"
   */
  fechaEmision: string;

  /** Origen institucional del documento */
  procedencia: ProcedenciaTipo;

  /**
   * Dependencia, departamento o secretaría emisora en mayúsculas
   * @example "DIRECCIÓN GENERAL - HOSPITAL CIVIL DE GUADALAJARA"
   */
  dependenciaArea: string;

  /**
   * Nombre completo del firmante/suscriptor del oficio en mayúsculas
   * @example "DR. JAIME AGUSTÍN GONZÁLEZ ÁLVAREZ"
   */
  remitenteNombre: string;

  /**
   * Cargo o puesto del firmante en mayúsculas
   * @default "NO ESPECIFICADO"
   */
  remitenteCargo: string;

  /**
   * Nombre completo del funcionario destinatario en mayúsculas
   * @example "MTRO. LUIS ALBERTO PÉREZ GÓMEZ"
   */
  destinatarioNombre: string;

  /**
   * Cargo del destinatario en mayúsculas
   * @default "NO ESPECIFICADO"
   */
  destinatarioCargo: string;

  /**
   * Síntesis ejecutiva del documento (1 a 3 oraciones continuas sin saltos de línea)
   */
  asunto: string;

  /**
   * Plazo legal o límite de respuesta estipulado en el documento
   * @unit Días naturales o hábiles (entero positivo)
   * @default null (Si no se especifica término perentorio)
   */
  plazoDias: number | null;

  /**
   * Bandera que determina si el documento contiene datos personales sensibles / LGPDPPSO
   */
  contieneDatosSensibles: boolean;
}

/**
 * Dimensiones y resolución por página del documento
 */
export interface PaginaDimension {
  /** Número de página relativo (1-indexed) */
  pageNumber: number;
  /** Ancho en píxeles @unit px */
  widthPx: number;
  /** Alto en píxeles @unit px */
  heightPx: number;
  /** Densidad de escaneo @unit DPI */
  dpi: number;
}

/**
 * Auditoría técnica del preprocesamiento por el worker Python (PyMuPDF + Pillow)
 */
export interface PreprocesoMetadata {
  /** Cantidad total de páginas procesadas @unit páginas */
  pageCount: number;
  /** Tamaño del archivo procesado @unit bytes */
  fileSizeBytes: number;
  /** Hash criptográfico para integridad y deduplicación @format SHA-256 Hex 64 chars */
  sha256Hash: string;
  /** Dimensiones técnicas extraídas de cada página */
  paginas: PaginaDimension[];
  /** Tiempo consumido por el script CLI en Python @unit milisegundos (ms) */
  processingDurationMs: number;
  /** Bandera de sanitización de PDF exitosa */
  isSanitized: boolean;
}

/**
 * Resultado y trazabilidad de la ejecución RPA en Webix Intranet (`op_cucs.fwx`)
 */
export interface RpaEjecucion {
  /** Identificador único de la corrida RPA @format UUID v4 */
  id: string;
  /** Referencia foránea al documento procesado @format UUID v4 */
  documentoId: string;
  /** Folio único institucional devuelto por el módulo op_cucs.fwx */
  folioAcuseInstitucional: string | null;
  /** Marca de tiempo del intento @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  fechaEjecucion: string;
  /** Duración de la sesión de Playwright @unit milisegundos (ms) */
  duracionMs: number;
  /** Ruta local a la captura del acuse @example "storage/03_procesados/2026/09/acuse_UUID.png" */
  capturaAcusePath: string | null;
  /** Contador de reintentos realizados ante fallos de red o sesión */
  intentos: number;
  /** Mensaje de error detallado en caso de fallo */
  mensajeError: string | null;
  /** Indica si la inyección y extracción de acuse fue satisfactoria */
  exitoso: boolean;
}

/**
 * Estado de sincronización hacia Google Sheets (Tablero de Control DSA)
 */
export interface GoogleSheetsSync {
  /** Estado de sincronización */
  sincronizado: boolean;
  /** Índice de la fila asignada en la hoja de cálculo (1-indexed) */
  filaIndex: number | null;
  /** Fecha y hora de sincronización @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  timestampSincronizacion: string | null;
  /** Detalle del error si falló la API de Google */
  errorSincronizacion: string | null;
}

/**
 * Registro raíz persistido en SQLite (WAL) y administrado en el Frontend Svelte 5
 */
export interface DocumentoRegistro {
  /** Identificador único global del registro @format UUID v4 */
  id: string;

  /** Nombre original del archivo al momento de la ingesta */
  nombreArchivoOriginal: string;

  /**
   * Nombre estandarizado según nomenclatura canónica: YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf
   * @default null (Se asigna tras la validación HITL)
   */
  nombreArchivoCanonico: string | null;

  /** Ruta absoluta o relativa actual en el sistema de archivos */
  rutaArchivoActual: string;

  /**
   * Ruta del archivo JSON espejo generado junto al PDF canónico
   * @default null
   */
  rutaEspejoJson: string | null;

  /** Mecanismo de entrada */
  origen: IngestaOrigen;

  /** Estado actual del ciclo de vida del documento */
  estado: DocumentoEstado;

  /** Huella digital del documento original para control de duplicados @format SHA-256 */
  sha256Hash: string;

  /** Metadatos generados preliminarmente por Gemini 2.5 Flash */
  metadatosExtraidos: MetadatosOficio | null;

  /** Metadatos confirmados o editados por el capturista en HITL */
  metadatosValidados: MetadatosOficio | null;

  /** Métricas del worker de preprocesamiento */
  preproceso: PreprocesoMetadata | null;

  /** Registro de ejecución de Playwright */
  rpa: RpaEjecucion | null;

  /** Estado de exportación a Google Sheets */
  sheetsSync: GoogleSheetsSync;

  /** Identificador del capturista que autorizó el documento en HITL */
  revisorUsuarioId: string | null;

  /** Marca de tiempo de recepción @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  fechaIngesta: string;

  /** Marca de tiempo de validación HITL @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  fechaValidacionHitl: string | null;

  /** Marca de tiempo de término de ciclo @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  fechaFinalizacion: string | null;

  /** Marca de tiempo de última actualización @format ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ */
  updatedAt: string;

  /** Control de concurrencia optimista @unit Versión incremental */
  version: number;
}
