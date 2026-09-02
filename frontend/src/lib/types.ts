/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Subconjunto de tipos de dominio espejados desde `backend/src/contracts/types.ts`.
 * Versión: 1.0.0-MVP
 *
 * No existe todavía un paquete compartido en el monorepo (backend y frontend son dos
 * proyectos npm independientes), así que esta copia estructural es intencional. Si se
 * introduce un workspace compartido, este archivo debe eliminarse en favor de un import
 * real a `@oficialia/contracts`.
 */

export type IngestaOrigen = 'SCANNER_ADF' | 'WEB_DRAG_DROP';
export type ProcedenciaTipo = 'HCG' | 'Ajena';

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

export interface MetadatosOficio {
  numeroOficio: string;
  fechaEmision: string;
  procedencia: ProcedenciaTipo;
  dependenciaArea: string;
  remitenteNombre: string;
  remitenteCargo: string;
  destinatarioNombre: string;
  destinatarioCargo: string;
  asunto: string;
  plazoDias: number | null;
  contieneDatosSensibles: boolean;
}

export interface PaginaDimension {
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  dpi: number;
}

export interface PreprocesoMetadata {
  pageCount: number;
  fileSizeBytes: number;
  sha256Hash: string;
  paginas: PaginaDimension[];
  processingDurationMs: number;
  isSanitized: boolean;
}

export interface RpaEjecucion {
  id: string;
  documentoId: string;
  folioAcuseInstitucional: string | null;
  fechaEjecucion: string;
  duracionMs: number;
  capturaAcusePath: string | null;
  intentos: number;
  mensajeError: string | null;
  exitoso: boolean;
}

export interface GoogleSheetsSync {
  sincronizado: boolean;
  filaIndex: number | null;
  timestampSincronizacion: string | null;
  errorSincronizacion: string | null;
}

export interface DocumentoRegistro {
  id: string;
  nombreArchivoOriginal: string;
  nombreArchivoCanonico: string | null;
  rutaArchivoActual: string;
  rutaEspejoJson: string | null;
  origen: IngestaOrigen;
  estado: DocumentoEstado;
  sha256Hash: string;
  metadatosExtraidos: MetadatosOficio | null;
  metadatosValidados: MetadatosOficio | null;
  preproceso: PreprocesoMetadata | null;
  rpa: RpaEjecucion | null;
  sheetsSync: GoogleSheetsSync;
  revisorUsuarioId: string | null;
  fechaIngesta: string;
  fechaValidacionHitl: string | null;
  fechaFinalizacion: string | null;
  updatedAt: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Puerto 7 (ILocalSemanticProvider, P1 — ver docs/prd.md §2.2 / docs/contracts.md)
// ---------------------------------------------------------------------------

export type ModeloEstado = 'NO_INICIALIZADO' | 'CARGANDO' | 'LISTO' | 'ERROR_INFERENCIA';

export interface DocumentoRelacionado {
  documentoId: string;
  nombreArchivoCanonico: string | null;
  numeroOficio: string | null;
  dependenciaArea: string | null;
  asunto: string | null;
  similitudScore: number;
  esCandidatoVinculacion: boolean;
}

export interface RelatedDocumentsResult {
  documentos: DocumentoRelacionado[];
  totalVectoresComparados: number;
  duracionMs: number;
  modeloEstado: ModeloEstado;
}

/** Estados en los que el pipeline de salida sigue corriendo en el servidor: la UI se bloquea. */
export const LOCKED_STATES: ReadonlySet<DocumentoEstado> = new Set<DocumentoEstado>(['APROBADO_HITL', 'EN_RPA']);

/** Estados en los que el capturista puede editar y confirmar el formulario HITL. */
export const EDITABLE_STATES: ReadonlySet<DocumentoEstado> = new Set<DocumentoEstado>([
  'PENDIENTE_REVISION',
  'EN_REVISION',
  'ERROR_RPA', // edición no, pero permite reintentar sin bloquear la lectura
]);
