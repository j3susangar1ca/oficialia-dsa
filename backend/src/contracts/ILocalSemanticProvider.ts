/**
 * CONTRATOS DE BÚSQUEDA SEMÁNTICA LOCAL
 * Sistema: Oficialia-Digital-DSA
 * Modelo: Xenova/bge-m3 (ONNX Runtime, cuantizado)
 * Versión: 1.0.0
 *
 * Cumplimiento: LGPDPPSO — Procesamiento 100% local, sin llamadas a APIs externas.
 *
 * Puerto secundario nº 7, añadido en Fase Complementaria P1 (ver `docs/prd.md` §2.2 y
 * `docs/contracts.md` §"Puerto 7"): búsqueda y vinculación semántica de oficios
 * relacionados, complementaria a la detección exacta por folio/hash de §2.2. No genera
 * ni redacta texto (eso sigue siendo exclusivo de Gemini 2.5 Flash) — solo vectoriza y
 * compara por similitud coseno, 100% en el proceso Node del backend.
 *
 * Implementación de referencia: `LocalSemanticMatcherAdapter` (mismo directorio).
 * Se cablea en el composition root (`presentation/server.ts`) sobre la misma conexión
 * SQLite que `SqliteDocumentRepository`. Esquema asociado:
 * `backend/src/infrastructure/persistence/embeddings_schema.sql`.
 */

// ==========================================
// 1. TIPOS Y ENUMERACIONES DEL MOTOR SEMÁNTICO
// ==========================================

/** Estado del ciclo de vida del modelo de inferencia */
export type ModeloEstado = 'NO_INICIALIZADO' | 'CARGANDO' | 'LISTO' | 'ERROR_INFERENCIA';

/** Dimensión del vector de embedding generado por bge-m3 (1024 floats) */
export const BGE_M3_EMBEDDING_DIM = 1024;

/**
 * Representa un documento candidato identificado por búsqueda de similitud coseno.
 * Extiende la información mínima necesaria para que la UI de vinculación
 * presente contexto al capturista sin requerir una consulta adicional.
 */
export interface DocumentoRelacionado {
  /**
   * Identificador único del documento relacionado.
   * Corresponde a DocumentoRegistro.id (UUID v4).
   */
  documentoId: string;

  /**
   * Nombre canónico del archivo si ya fue validado en HITL.
   * @example "2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.pdf"
   */
  nombreArchivoCanonico: string | null;

  /**
   * Número de oficio o folio extraído (desnormalizado para despliegue rápido).
   * @example "DSA-1042-2026"
   */
  numeroOficio: string | null;

  /**
   * Dependencia o área emisora del oficio.
   * @example "DIRECCIÓN GENERAL HCG"
   */
  dependenciaArea: string | null;

  /**
   * Síntesis ejecutiva del documento para previsualización en la UI.
   */
  asunto: string | null;

  /**
   * Puntuación de similitud coseno entre el vector de consulta y el vector
   * almacenado del documento candidato.
   * @range [0, 1] — 0 indica disimilitud total; 1 indica coincidencia exacta.
   */
  similitudScore: number;

  /**
   * Bandera booleana que indica si el documento supera el umbral dinámico
   * de vinculación. Permite a la UI distinguir visualmente candidatos
   * fuertes de resultados meramente informativos.
   *
   * Se calcula como: similitudScore >= umbralVinculacion
   * @default true cuando similitudScore >= 0.85
   */
  esCandidatoVinculacion: boolean;
}

/**
 * Parámetros de configuración para una búsqueda semántica.
 */
export interface BusquedaSemanticaParams {
  /**
   * Texto libre o fragmento de oficio contra el cual se genera el embedding de consulta.
   * El adapter internamente construye el "Document String" normalizado.
   */
  textoConsulta: string;

  /**
   * Identificador del documento actual que debe excluirse de los resultados
   * para evitar autorreferencias.
   * @example "e2a45a32-7c89-4d2b-9123-8cfb28d71001"
   */
  excluirDocumentoId?: string;

  /**
   * Número máximo de resultados a retornar.
   * @default 10
   */
  limite?: number;

  /**
   * Umbral mínimo de similitud para incluir un resultado.
   * Los documentos con similitudScore < umbralVinculacion se marcan
   * con esCandidatoVinculacion = false pero pueden seguir apareciendo
   * si superan un umbral informativo inferior (umbralVinculacion - 0.15).
   * @default 0.85
   */
  umbralVinculacion?: number;
}

/**
 * Resultado estructurado de una operación de búsqueda semántica.
 */
export interface ResultadoBusquedaSemantica {
  /**
   * Lista ordenada de documentos relacionados (mayor similitud primero).
   * Puede estar vacía si ningún documento supera el umbral informativo
   * o si el modelo no está listo.
   */
  documentos: DocumentoRelacionado[];

  /**
   * Cantidad total de vectores comparados en la búsqueda.
   */
  totalVectoresComparados: number;

  /**
   * Tiempo total de la operación (generación de embedding de consulta + comparación).
   * @unit milisegundos (ms)
   */
  duracionMs: number;

  /**
   * Estado del modelo al momento de la consulta.
   */
  modeloEstado: ModeloEstado;
}

/**
 * Documento normalizado listo para generación de embedding.
 * Representa el "Document String" construido a partir de MetadatosOficio.
 */
export interface DocumentStringInput {
  /** Área o dependencia emisora */
  dependenciaArea: string;
  /** Nombre completo del remitente */
  remitenteNombre: string;
  /** Síntesis ejecutiva del oficio */
  asunto: string;
}

/**
 * Registro de embedding persistido en SQLite.
 * Corresponde a una fila de la tabla `documentos_embeddings`.
 */
export interface EmbeddingRecord {
  /** Identificador único del registro de embedding */
  id: number;
  /** FK hacia documentos.id */
  documentoId: string;
  /** Vector serializado como BLOB (Float32Array → Buffer) */
  vectorBlob: Buffer;
  /** Dimensión del vector (debe ser 1024 para bge-m3) */
  dimension: number;
  /** Document String que originó el embedding (para auditoría) */
  documentString: string;
  /** SHA-256 del document string para evitar re-indexación redundante */
  contentHash: string;
  /** Marca de tiempo de creación */
  creadoEn: string;
}

// ==========================================
// 2. INTERFAZ PRINCIPAL DEL PROVEEDOR SEMÁNTICO
// ==========================================

/**
 * Contrato principal para el motor de búsqueda semántica local.
 *
 * Implementaciones deben garantizar:
 * - Inicialización perezosa del modelo ONNX (no se carga hasta la primera llamada).
 * - Procesamiento 100% local sin dependencias de red.
 * - Thread-safe: múltiples llamadas concurrentes a initialize() deben
 *   retornar la misma promesa (singleton de inicialización).
 * - Si el modelo no está en estado LISTO, las búsquedas retornan arrays vacíos
 *   en lugar de lanzar excepciones.
 */
export interface ILocalSemanticProvider {
  /**
   * Estado actual del modelo de inferencia.
   * Útil para que la UI muestre indicadores de carga.
   */
  readonly modeloEstado: ModeloEstado;

  /**
   * Inicialización perezosa del pipeline de inferencia.
   * Carga el modelo cuantizado `Xenova/bge-m3` en ONNX Runtime.
   * Si ya fue inicializado previamente, retorna inmediatamente.
   *
   * Transiciones de estado:
   * - NO_INICIALIZADO → CARGANDO → LISTO
   * - NO_INICIALIZADO → CARGANDO → ERROR_INFERENCIA
   *
   * @throws Error si la carga del modelo falla (estado pasa a ERROR_INFERENCIA).
   */
  initialize(): Promise<void>;

  /**
   * Genera un vector de embedding normalizado (L2) a partir de un Document String.
   * El vector resultante tiene dimensión 1024 (bge-m3) y está normalizado
   * para que la similitud coseno sea equivalente al producto punto.
   *
   * @param input - Componentes del Document String.
   * @returns Float32Array de 1024 dimensiones, normalizado L2.
   * @throws Error si el modelo no está en estado LISTO.
   */
  generateEmbedding(input: DocumentStringInput): Promise<Float32Array>;

  /**
   * Indexa un documento individual: genera su embedding y lo persiste en SQLite.
   * Si el documento ya tiene un embedding cuyo contentHash coincide,
   * la operación es idempotente (no duplica registros).
   *
   * @param documentoId - UUID v4 del documento a indexar.
   * @param input - Componentes del Document String.
   * @returns El registro de embedding creado o actualizado.
   */
  indexDocument(documentoId: string, input: DocumentStringInput): Promise<EmbeddingRecord>;

  /**
   * Procesa un lote de documentos para indexación masiva.
   * Útil durante la migración inicial o la reconstrucción del índice.
   *
   * @param lote - Array de pares [documentoId, DocumentStringInput].
   * @returns Cantidad de documentos indexados exitosamente.
   */
  batchIndex(lote: Array<[string, DocumentStringInput]>): Promise<number>;

  /**
   * Ejecuta una búsqueda de similitud coseno contra todos los embeddings almacenados.
   * Si el modelo no está en estado LISTO, retorna un resultado con array vacío
   * y modeloEstado indicando el estado actual (no lanza excepción).
   *
   * @param params - Parámetros de búsqueda (texto, exclusión, límites, umbral).
   * @returns Resultado estructurado con documentos ordenados por similitud descendente.
   */
  searchSimilar(params: BusquedaSemanticaParams): Promise<ResultadoBusquedaSemantica>;

  /**
   * Elimina el embedding asociado a un documento.
   * Útil cuando un documento es eliminado del sistema.
   *
   * @param documentoId - UUID v4 del documento.
   * @returns true si se eliminó un registro; false si no existía.
   */
  removeEmbedding(documentoId: string): Promise<boolean>;

  /**
   * Retorna la cantidad total de embeddings indexados.
   */
  countEmbeddings(): number;
}
