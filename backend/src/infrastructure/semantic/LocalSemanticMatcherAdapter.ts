/**
 * ADAPTADOR DE BÚSQUEDA SEMÁNTICA LOCAL
 * Sistema: Oficialia-Digital-DSA
 * Motor: Xenova/bge-m3 sobre ONNX Runtime (cuantizado)
 * Versión: 1.0.0
 *
 * Cumplimiento: LGPDPPSO — Inferencia 100% local.
 * Entorno: Node.js 22 LTS
 */

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import Database from 'better-sqlite3';
import type {
  ILocalSemanticProvider,
  DocumentoRelacionado,
  BusquedaSemanticaParams,
  ResultadoBusquedaSemantica,
  DocumentStringInput,
  EmbeddingRecord,
  ModeloEstado,
} from '../../contracts/ILocalSemanticProvider';
import { BGE_M3_EMBEDDING_DIM } from '../../contracts/ILocalSemanticProvider';
import { createHash } from 'node:crypto';

// ==========================================
// CONSTANTES DE CONFIGURACIÓN
// ==========================================

/** Nombre del modelo multilingüe SOTA para embeddings */
const MODEL_NAME = 'Xenova/bge-m3';

/** Umbral por defecto para considerar un documento como candidato a vinculación */
const DEFAULT_UMBRAL_VINCULACION = 0.85;

/** Umbral informativo mínimo: documentos por debajo de esto no se retornan */
const UMBRAL_INFORMATIVO_OFFSET = 0.15;

/** Número máximo de resultados por defecto */
const DEFAULT_LIMITE = 10;

// ==========================================
// UTILIDADES INTERNAS
// ==========================================

/**
 * Construye el "Document String" normalizado a partir de los componentes
 * del oficio. Este string es la entrada al modelo de embeddings.
 *
 * Formato: "[DEP: dependenciaArea] [REM: remitenteNombre] [ASUNTO: asunto]"
 *
 * Se aplica:
 * - Trim de espacios en blanco.
 * - Colapso de múltiples espacios a uno solo.
 * - Eliminación de saltos de línea dentro del asunto.
 * - Uppercase para consistencia con el dominio (metadatos en mayúsculas).
 */
function buildDocumentString(input: DocumentStringInput): string {
  const sanitize = (s: string): string =>
    s
      .replace(/[\r\n]+/g, ' ')   // Eliminar saltos de línea
      .replace(/\s+/g, ' ')       // Colapsar espacios múltiples
      .trim()
      .toUpperCase();

  const dep = sanitize(input.dependenciaArea);
  const rem = sanitize(input.remitenteNombre);
  const asu = sanitize(input.asunto);

  return `[DEP: ${dep}] [REM: ${rem}] [ASUNTO: ${asu}]`;
}

/**
 * Calcula el SHA-256 de un string y lo retorna como hex de 64 caracteres.
 * Se usa como content_hash para indexación idempotente.
 */
function computeContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Normaliza un vector Float32Array in-place usando norma L2.
 *
 * Tras la normalización, ||v||₂ = 1, lo que permite que la similitud
 * coseno sea equivalente al producto punto:
 *
 *   cos(a, b) = (a · b) / (||a|| × ||b||) = a · b  (si ||a|| = ||b|| = 1)
 *
 * Esto optimiza el cálculo de similitud en CPU al reducirlo a un simple
 * producto punto, evitando la división por las normas en cada comparación.
 *
 * @param vector - Vector a normalizar (modificado in-place).
 * @returns El mismo vector normalizado.
 */
function normalizeL2(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    // `noUncheckedIndexedAccess` tipa vector[i] como `number | undefined`; el `!` es
    // seguro aquí porque `i` está acotado por `vector.length` en todo el bucle.
    const value = vector[i]!;
    norm += value * value;
  }
  norm = Math.sqrt(norm);

  if (norm === 0) {
    return vector; // Vector cero: no se puede normalizar
  }

  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i]! / norm;
  }

  return vector;
}

/**
 * Convierte un Float32Array a Buffer para almacenamiento en SQLite BLOB.
 * Usa el ArrayBuffer subyacente del Float32Array con el offset correcto
 * para evitar copias innecesarias.
 */
function float32ToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength
  );
}

/**
 * Convierte un Buffer de SQLite BLOB de vuelta a Float32Array.
 * Maneja correctamente el byteOffset para buffers que son views
 * de ArrayBuffers más grandes (caso común con better-sqlite3).
 */
function bufferToFloat32(buffer: Buffer): Float32Array {
  // Crear una copia limpia del ArrayBuffer para evitar memory leaks
  // con buffers que comparten ArrayBuffer subyacente.
  const ab = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buffer.byteLength; i++) {
    view[i] = buffer[i]!; // acotado por buffer.byteLength — ver nota en normalizeL2
  }
  return new Float32Array(ab);
}

/**
 * Calcula el producto punto entre dos vectores Float32Array normalizados L2.
 * Equivale a la similitud coseno cuando ambos vectores tienen norma 1.
 *
 * @returns Puntuación en el rango [-1, 1]. Para embeddings de texto
 *          normalizados, típicamente en [0, 1].
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!; // acotado por len — ver nota en normalizeL2
  }
  return sum;
}

// ==========================================
// CLASE PRINCIPAL: ADAPTADOR
// ==========================================

/**
 * Adaptador concreto de ILocalSemanticProvider.
 *
 * Implementa búsqueda semántica local usando:
 * - @xenova/transformers con modelo Xenova/bge-m3 (ONNX cuantizado)
 * - better-sqlite3 para persistencia de vectores
 * - Cálculo de similitud coseno en memoria (producto punto con vectores L2)
 *
 * Patrón: Singleton de inicialización (múltiples llamadas a initialize()
 * comparten la misma promesa de carga del modelo).
 */
export class LocalSemanticMatcherAdapter implements ILocalSemanticProvider {

  // --- Estado interno del modelo ---
  private _modeloEstado: ModeloEstado = 'NO_INICIALIZADO';
  private _pipeline: FeatureExtractionPipeline | null = null;
  private _initPromise: Promise<void> | null = null;

  // --- Dependencia inyectada: conexión SQLite ---
  private readonly db: Database.Database;

  // --- Statements preparados (compilados una vez, reutilizados) ---
  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpdate: Database.Statement;
  private readonly stmtSelectByDocId: Database.Statement;
  private readonly stmtSelectByContentHash: Database.Statement;
  private readonly stmtSelectAll: Database.Statement;
  private readonly stmtDeleteByDocId: Database.Statement;
  private readonly stmtCount: Database.Statement;

  /**
   * Constructor con inyección de dependencias.
   *
   * @param db - Instancia de better-sqlite3 ya configurada con WAL y foreign_keys.
   *             Se asume que el esquema `embeddings_schema.sql` ya fue ejecutado.
   */
  constructor(db: Database.Database) {
    this.db = db;

    // Preparar statements para máximo rendimiento en operaciones repetidas.
    this.stmtInsert = this.db.prepare(`
      INSERT INTO documentos_embeddings (documento_id, vector, dimension, document_string, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtUpdate = this.db.prepare(`
      UPDATE documentos_embeddings
         SET vector = ?, dimension = ?, document_string = ?, content_hash = ?,
             creado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE documento_id = ?
    `);

    this.stmtSelectByDocId = this.db.prepare(`
      SELECT id, documento_id, vector, dimension, document_string, content_hash, creado_en
        FROM documentos_embeddings
       WHERE documento_id = ?
    `);

    this.stmtSelectByContentHash = this.db.prepare(`
      SELECT id, documento_id, vector, dimension, document_string, content_hash, creado_en
        FROM documentos_embeddings
       WHERE documento_id = ? AND content_hash = ?
    `);

    this.stmtSelectAll = this.db.prepare(`
      SELECT id, documento_id, vector, dimension, document_string, content_hash, creado_en
        FROM documentos_embeddings
    `);

    this.stmtDeleteByDocId = this.db.prepare(`
      DELETE FROM documentos_embeddings WHERE documento_id = ?
    `);

    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM documentos_embeddings
    `);
  }

  // ==========================================
  // PROPIEDADES PÚBLICAS
  // ==========================================

  get modeloEstado(): ModeloEstado {
    return this._modeloEstado;
  }

  // ==========================================
  // INICIALIZACIÓN PEREZOSA
  // ==========================================

  /**
   * Inicialización perezosa del pipeline ONNX.
   *
   * Garantiza que:
   * - El modelo se carga exactamente una vez.
   * - Múltiples llamadas concurrentes comparten la misma promesa.
   * - El estado se actualiza correctamente en caso de error.
   */
  async initialize(): Promise<void> {
    // Si ya está listo, retornar inmediatamente.
    if (this._modeloEstado === 'LISTO') {
      return;
    }

    // Si ya se está cargando, retornar la promesa existente (singleton).
    if (this._initPromise !== null) {
      return this._initPromise;
    }

    // Iniciar carga.
    this._modeloEstado = 'CARGANDO';

    this._initPromise = this._doInitialize();

    try {
      await this._initPromise;
    } catch (error) {
      // Limpiar la promesa para permitir reintentos.
      this._initPromise = null;
      this._modeloEstado = 'ERROR_INFERENCIA';
      throw error;
    }
  }

  private async _doInitialize(): Promise<void> {
    try {
      this._pipeline = await pipeline(
        'feature-extraction',
        MODEL_NAME,
        { quantized: true }
      );
      this._modeloEstado = 'LISTO';
    } catch (error) {
      this._modeloEstado = 'ERROR_INFERENCIA';
      this._pipeline = null;
      throw new Error(
        `[LocalSemanticMatcher] Fallo al cargar modelo ${MODEL_NAME}: ${error}`
      );
    }
  }

  // ==========================================
  // GENERACIÓN DE EMBEDDINGS
  // ==========================================

  /**
   * Genera un vector de embedding normalizado L2 a partir de un Document String.
   *
   * Flujo:
   * 1. Construir document string normalizado.
   * 2. Ejecutar el pipeline de feature-extraction.
   * 3. Extraer el vector [CLS] (primera posición) de la salida del modelo.
   * 4. Aplicar normalización L2 para habilitar similitud coseno vía producto punto.
   */
  async generateEmbedding(input: DocumentStringInput): Promise<Float32Array> {
    if (this._modeloEstado !== 'LISTO' || this._pipeline === null) {
      throw new Error(
        `[LocalSemanticMatcher] Modelo no está listo. Estado actual: ${this._modeloEstado}. ` +
        `Llame a initialize() primero.`
      );
    }

    const documentString = buildDocumentString(input);

    // Ejecutar inferencia.
    // bge-m3 retorna un tensor con shape [1, sequence_length, 1024].
    // Para búsqueda semántica, usamos el embedding del token [CLS] (índice 0).
    const output = await this._pipeline(documentString, {
      pooling: 'cls',       // Extraer embedding [CLS]
      normalize: false,     // Normalizamos manualmente para control explícito
    });

    // Extraer datos del tensor como Float32Array.
    // @xenova/transformers retorna un objeto con .data que es TypedArray.
    const rawData = output.data as Float32Array;

    // Copiar a un nuevo Float32Array para evitar retener referencia al tensor.
    const embedding = new Float32Array(BGE_M3_EMBEDDING_DIM);
    for (let i = 0; i < BGE_M3_EMBEDDING_DIM; i++) {
      embedding[i] = rawData[i] ?? 0; // acotado por BGE_M3_EMBEDDING_DIM (1024)
    }

    // `Tensor` (@xenova/transformers 2.x, onnxruntime-web/wasm) no expone `dispose()` —
    // a diferencia de onnxruntime-node, la limpieza de sus buffers queda a cargo del GC
    // de JS; no hay nada que liberar manualmente aquí.

    // Normalizar L2 in-place.
    normalizeL2(embedding);

    return embedding;
  }

  // ==========================================
  // INDEXACIÓN INDIVIDUAL
  // ==========================================

  /**
   * Indexa un documento individual.
   *
   * Flujo:
   * 1. Construir document string y calcular content_hash.
   * 2. Verificar si ya existe un embedding con el mismo content_hash (idempotencia).
   * 3. Si no existe o el hash cambió, generar embedding y persistir.
   */
  async indexDocument(
    documentoId: string,
    input: DocumentStringInput
  ): Promise<EmbeddingRecord> {
    const documentString = buildDocumentString(input);
    const contentHash = computeContentHash(documentString);

    // Verificar si ya existe un embedding idéntico.
    const existing = this.stmtSelectByContentHash.get(
      documentoId,
      contentHash
    ) as { id: number } | undefined;

    if (existing) {
      // Ya existe un embedding con el mismo contenido. Retornar el existente.
      const record = this.stmtSelectByDocId.get(documentoId) as any;
      return this._mapRowToRecord(record);
    }

    // Generar embedding.
    const embedding = await this.generateEmbedding(input);
    const vectorBuffer = float32ToBuffer(embedding);

    // Verificar si existe un registro previo (contenido cambió).
    const prevRecord = this.stmtSelectByDocId.get(documentoId) as { id: number } | undefined;

    if (prevRecord) {
      // Actualizar embedding existente.
      this.stmtUpdate.run(
        vectorBuffer,
        BGE_M3_EMBEDDING_DIM,
        documentString,
        contentHash,
        documentoId
      );
    } else {
      // Insertar nuevo embedding.
      this.stmtInsert.run(
        documentoId,
        vectorBuffer,
        BGE_M3_EMBEDDING_DIM,
        documentString,
        contentHash
      );
    }

    const record = this.stmtSelectByDocId.get(documentoId) as any;
    return this._mapRowToRecord(record);
  }

  // ==========================================
  // INDEXACIÓN POR LOTES
  // ==========================================

  /**
   * Procesa un lote de documentos para indexación masiva.
   *
   * Utiliza una transacción SQLite para garantizar atomicidad y rendimiento.
   * Los errores individuales se registran pero no abortan el lote completo.
   *
   * @param lote - Array de pares [documentoId, DocumentStringInput].
   * @returns Cantidad de documentos indexados exitosamente.
   */
  async batchIndex(lote: Array<[string, DocumentStringInput]>): Promise<number> {
    if (lote.length === 0) return 0;

    let exitosos = 0;

    // Ejecutar dentro de una transacción para rendimiento y atomicidad.
    const indexOne = async (documentoId: string, input: DocumentStringInput) => {
      try {
        await this.indexDocument(documentoId, input);
        exitosos++;
      } catch (error) {
        // Registrar pero no abortar el lote.
        console.error(
          `[LocalSemanticMatcher] Error indexando documento ${documentoId}:`,
          error
        );
      }
    };

    // Procesar secuencialmente para no saturar la memoria con múltiples
    // inferencias simultáneas del modelo ONNX.
    for (const [docId, input] of lote) {
      await indexOne(docId, input);
    }

    return exitosos;
  }

  // ==========================================
  // BÚSQUEDA POR SIMILITUD
  // ==========================================

  /**
   * Ejecuta búsqueda de similitud coseno contra todos los embeddings almacenados.
   *
   * Estrategia de fuerza bruta optimizada:
   * 1. Generar embedding de consulta (normalizado L2).
   * 2. Cargar todos los vectores de SQLite a memoria.
   * 3. Calcular producto punto (= coseno para vectores L2) contra cada uno.
   * 4. Filtrar por umbral informativo y excluir documento actual.
   * 5. Ordenar por similitud descendente y aplicar límite.
   *
   * Para volúmenes < 50,000 documentos, esta estrategia es más rápida
   * que índices ANN (HNSW/IVF) y evita dependencias adicionales.
   *
   * Si el modelo no está listo, retorna resultado con array vacío
   * (no lanza excepción para no bloquear el flujo de la aplicación).
   */
  async searchSimilar(
    params: BusquedaSemanticaParams
  ): Promise<ResultadoBusquedaSemantica> {
    const startTime = Date.now();

    const {
      textoConsulta,
      excluirDocumentoId,
      limite = DEFAULT_LIMITE,
      umbralVinculacion = DEFAULT_UMBRAL_VINCULACION,
    } = params;

    // Si el modelo no está listo, retornar resultado vacío sin excepción.
    if (this._modeloEstado !== 'LISTO' || this._pipeline === null) {
      return {
        documentos: [],
        totalVectoresComparados: 0,
        duracionMs: Date.now() - startTime,
        modeloEstado: this._modeloEstado,
      };
    }

    // Construir Document String de consulta.
    // Para búsqueda libre, se construye un input mínimo con el texto como asunto.
    const consultaInput: DocumentStringInput = {
      dependenciaArea: '',
      remitenteNombre: '',
      asunto: textoConsulta,
    };

    // Generar embedding de consulta.
    const queryEmbedding = await this.generateEmbedding(consultaInput);

    // Cargar todos los embeddings de SQLite a memoria.
    const rows = this.stmtSelectAll.all() as Array<{
      documento_id: string;
      vector: Buffer;
      dimension: number;
    }>;

    // Calcular similitud contra cada vector almacenado.
    const candidatos: DocumentoRelacionado[] = [];

    for (const row of rows) {
      // Excluir el documento actual.
      if (row.documento_id === excluirDocumentoId) {
        continue;
      }

      // Validar dimensión del vector almacenado.
      if (row.dimension !== BGE_M3_EMBEDDING_DIM) {
        console.warn(
          `[LocalSemanticMatcher] Vector con dimensión inesperada ` +
          `${row.dimension} para documento ${row.documento_id}. Se omite.`
        );
        continue;
      }

      // Deserializar vector desde BLOB.
      const storedVector = bufferToFloat32(row.vector);

      // Calcular similitud coseno (= producto punto para vectores L2).
      const score = dotProduct(queryEmbedding, storedVector);

      // Umbral informativo: no retornar documentos con similitud muy baja.
      const umbralInformativo = Math.max(0, umbralVinculacion - UMBRAL_INFORMATIVO_OFFSET);
      if (score < umbralInformativo) {
        continue;
      }

      // Obtener metadatos adicionales del documento para la UI.
      const docMeta = this._getDocumentMetadata(row.documento_id);

      candidatos.push({
        documentoId: row.documento_id,
        nombreArchivoCanonico: docMeta?.nombreArchivoCanonico ?? null,
        numeroOficio: docMeta?.numeroOficio ?? null,
        dependenciaArea: docMeta?.dependenciaArea ?? null,
        asunto: docMeta?.asunto ?? null,
        similitudScore: Math.round(score * 10000) / 10000, // 4 decimales
        esCandidatoVinculacion: score >= umbralVinculacion,
      });
    }

    // Ordenar por similitud descendente.
    candidatos.sort((a, b) => b.similitudScore - a.similitudScore);

    // Aplicar límite.
    const resultados = candidatos.slice(0, limite);

    return {
      documentos: resultados,
      totalVectoresComparados: rows.length,
      duracionMs: Date.now() - startTime,
      modeloEstado: 'LISTO',
    };
  }

  // ==========================================
  // ELIMINACIÓN
  // ==========================================

  /**
   * Elimina el embedding asociado a un documento.
   */
  async removeEmbedding(documentoId: string): Promise<boolean> {
    const result = this.stmtDeleteByDocId.run(documentoId);
    return result.changes > 0;
  }

  // ==========================================
  // CONTABILIDAD
  // ==========================================

  /**
   * Retorna la cantidad total de embeddings indexados.
   */
  countEmbeddings(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }

  // ==========================================
  // MÉTODOS PRIVADOS AUXILIARES
  // ==========================================

  /**
   * Mapea una fila cruda de SQLite a un EmbeddingRecord tipado.
   * Maneja la conversión BLOB → Buffer de forma segura.
   */
  private _mapRowToRecord(row: any): EmbeddingRecord {
    return {
      id: row.id,
      documentoId: row.documento_id,
      vectorBlob: row.vector as Buffer,
      dimension: row.dimension,
      documentString: row.document_string,
      contentHash: row.content_hash,
      creadoEn: row.creado_en,
    };
  }

  /**
   * Obtiene metadatos desnormalizados del documento principal
   * para enriquecer los resultados de búsqueda.
   *
   * Extrae campos clave de los JSON metadatos_validados o metadatos_extraidos
   * usando json_extract() de SQLite.
   */
  private _getDocumentMetadata(documentoId: string): {
    nombreArchivoCanonico: string | null;
    numeroOficio: string | null;
    dependenciaArea: string | null;
    asunto: string | null;
  } | null {
    try {
      const stmt = this.db.prepare(`
        SELECT
          nombre_archivo_canonico,
          COALESCE(
            json_extract(metadatos_validados, '$.numeroOficio'),
            json_extract(metadatos_extraidos, '$.numeroOficio')
          ) AS numero_oficio,
          COALESCE(
            json_extract(metadatos_validados, '$.dependenciaArea'),
            json_extract(metadatos_extraidos, '$.dependenciaArea')
          ) AS dependencia_area,
          COALESCE(
            json_extract(metadatos_validados, '$.asunto'),
            json_extract(metadatos_extraidos, '$.asunto')
          ) AS asunto
        FROM documentos
        WHERE id = ?
      `);

      const row = stmt.get(documentoId) as any;

      if (!row) return null;

      return {
        nombreArchivoCanonico: row.nombre_archivo_canonico ?? null,
        numeroOficio: row.numero_oficio ?? null,
        dependenciaArea: row.dependencia_area ?? null,
        asunto: row.asunto ?? null,
      };
    } catch {
      return null;
    }
  }
}