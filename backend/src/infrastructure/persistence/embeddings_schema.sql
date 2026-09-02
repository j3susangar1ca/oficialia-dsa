-- =====================================================================
-- ESQUEMA DE PERSISTENCIA VECTORIAL — Oficialia-Digital-DSA
-- Motor: SQLite 3.35+ con WAL
-- Modelo: Xenova/bge-m3 (1024 dimensiones, Float32)
-- Versión: 1.0.0
--
-- ⚠️ FUERA DE ALCANCE de docs/prd.md v1.0.0-MVP (ver nota en
-- backend/src/infrastructure/semantic/ILocalSemanticProvider.ts). NO se ejecuta junto
-- a `schema.sql` en el arranque del servidor ni se referencia desde
-- `presentation/server.ts`. Aplicar manualmente solo si se retoma la Fase 2 de
-- búsqueda semántica.
-- =====================================================================

-- Hereda la configuración PRAGMA del esquema principal:
-- PRAGMA journal_mode = WAL;
-- PRAGMA synchronous = NORMAL;
-- PRAGMA foreign_keys = ON;
-- PRAGMA busy_timeout = 5000;
-- PRAGMA temp_store = MEMORY;
-- PRAGMA cache_size = -64000;
-- PRAGMA mmap_size = 268435456;

-- =====================================================================
-- TABLA: documentos_embeddings
-- Almacena vectores de embedding generados por Xenova/bge-m3
-- Vinculada 1:1 con la tabla principal `documentos`
-- =====================================================================
CREATE TABLE IF NOT EXISTS documentos_embeddings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,

    -- FK hacia la tabla raíz de documentos.
    -- UNIQUE garantiza relación 1:1: un documento tiene a lo sumo un embedding.
    -- ON DELETE CASCADE asegura limpieza automática si el documento se elimina.
    documento_id        TEXT NOT NULL UNIQUE
        REFERENCES documentos(id) ON DELETE CASCADE,

    -- Vector de embedding serializado como BLOB.
    -- Representa un Float32Array de 1024 dimensiones convertido a Buffer.
    -- Tamaño fijo: 1024 × 4 bytes = 4096 bytes por registro.
    vector              BLOB NOT NULL,

    -- Dimensión del vector almacenado. Debe ser 1024 para bge-m3.
    -- Se almacena explícitamente para validación de integridad al deserializar.
    dimension           INTEGER NOT NULL DEFAULT 1024
        CHECK (dimension > 0),

    -- Document String que originó el embedding.
    -- Formato: "[DEP: ...] [REM: ...] [ASUNTO: ...]"
    -- Se conserva para auditoría, depuración y posible re-indexación selectiva.
    document_string     TEXT NOT NULL,

    -- SHA-256 del document_string para detección de cambios.
    -- Permite operaciones de indexación idempotentes: si el hash no cambió,
    -- no es necesario regenerar el embedding.
    content_hash        TEXT NOT NULL,

    -- Marca de tiempo de creación/actualización del embedding.
    creado_en           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Restricción de longitud del BLOB: exactamente dimension × 4 bytes.
    -- SQLite no soporta CHECK con length() de forma universal en todas las
    -- versiones, por lo que esta validación se refuerza en la capa de aplicación.
    -- CHECK (length(vector) = dimension * 4)
    CONSTRAINT chk_vector_size CHECK (length(vector) = dimension * 4)
);

-- =====================================================================
-- ÍNDICES OPTIMIZADOS PARA RECUPERACIÓN
-- =====================================================================

-- Índice principal para lookup directo por documento_id.
-- Aunque UNIQUE ya crea un índice implícito, este índice cubierto
-- mejora las consultas que solo necesitan documento_id y vector.
CREATE INDEX IF NOT EXISTS idx_embeddings_documento_id
    ON documentos_embeddings(documento_id);

-- Índice para detectar embeddings obsoletos por content_hash.
-- Permite encontrar rápidamente si un embedding necesita regeneración
-- comparando el hash actual del document_string contra el almacenado.
CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash
    ON documentos_embeddings(content_hash);

-- Índice para listados cronológicos de embeddings (depuración, auditoría).
CREATE INDEX IF NOT EXISTS idx_embeddings_creado_en
    ON documentos_embeddings(creado_en);

-- =====================================================================
-- VISTA AUXILIAR: Estado de cobertura de embeddings
-- Útil para monitorear qué porcentaje de documentos tiene embedding generado.
-- =====================================================================
CREATE VIEW IF NOT EXISTS v_embeddings_cobertura AS
SELECT
    COUNT(d.id)                                         AS total_documentos,
    COUNT(e.documento_id)                               AS total_con_embedding,
    COUNT(d.id) - COUNT(e.documento_id)                 AS total_sin_embedding,
    ROUND(
        100.0 * COUNT(e.documento_id) / NULLIF(COUNT(d.id), 0),
        2
    )                                                   AS porcentaje_cobertura
FROM documentos d
LEFT JOIN documentos_embeddings e ON e.documento_id = d.id
WHERE d.estado NOT IN ('ERROR_PREPROCESO');  -- Excluir documentos corruptos

-- =====================================================================
-- NOTAS DE IMPLEMENTACIÓN
-- =====================================================================
--
-- 1. SERIALIZACIÓN DEL VECTOR:
--    Float32Array (JS) → Buffer.from(float32Array.buffer) → BLOB (SQLite)
--    BLOB (SQLite) → new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
--
-- 2. TAMAÑO POR REGISTRO:
--    1024 dimensiones × 4 bytes/float = 4,096 bytes ≈ 4 KB por embedding.
--    Para 10,000 documentos: ~40 MB de almacenamiento adicional.
--
-- 3. ESTRATEGIA DE BÚSQUEDA:
--    Los vectores se cargan completos en memoria (Node.js) y se comparan
--    mediante producto punto (válido como coseno dado normalización L2).
--    Para el volumen esperado (< 50,000 documentos), esta estrategia
--    es más rápida que cualquier aproximación basada en índices ANN.
--
-- 4. INTEGRIDAD REFERENCIAL:
--    ON DELETE CASCADE garantiza que al eliminar un documento de la tabla
--    `documentos`, su embedding asociado se elimina automáticamente.
--
-- =====================================================================