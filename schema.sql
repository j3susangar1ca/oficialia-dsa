-- =====================================================================
-- ESQUEMA SQLite 3 — Oficialia-Digital-DSA
-- Versión: 1.0.0
-- Motor: SQLite 3.35+ (soporte para WAL, JSON y claves foráneas)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Configuración obligatoria de rendimiento y concurrencia
-- ---------------------------------------------------------------------
PRAGMA journal_mode = WAL;          -- Write-Ahead Logging para mejor concurrencia
PRAGMA synchronous = NORMAL;        -- Equilibrio entre durabilidad y velocidad
PRAGMA busy_timeout = 5000;         -- Espera máxima ante bloqueos (5 segundos)
PRAGMA foreign_keys = ON;           -- Integridad referencial activada
PRAGMA temp_store = MEMORY;         -- Almacenamiento temporal en RAM

-- Ajustes opcionales recomendados para cargas de trabajo intensivas
PRAGMA cache_size = -64000;         -- 64 MB de caché de páginas
PRAGMA mmap_size = 268435456;       -- 256 MB para I/O mapeado en memoria

-- =====================================================================
-- TABLA: documentos
-- Registro raíz del ciclo de vida documental
-- =====================================================================
CREATE TABLE IF NOT EXISTS documentos (
    id                         TEXT PRIMARY KEY,                -- UUID v4 generado por la aplicación
    nombre_archivo_original    TEXT NOT NULL,                   -- Nombre original al ingestar
    nombre_archivo_canonico    TEXT,                            -- Asignado tras validación HITL
    ruta_archivo_actual        TEXT NOT NULL,                   -- Ruta en sistema de archivos
    ruta_espejo_json           TEXT,                            -- Ruta del archivo JSON espejo
    origen                     TEXT NOT NULL
        CHECK (origen IN ('SCANNER_ADF', 'WEB_DRAG_DROP')),     -- Canal de ingesta
    estado                     TEXT NOT NULL
        CHECK (estado IN (
            'PENDIENTE_PREPROCESO', 'EN_PREPROCESO',
            'PENDIENTE_EXTRACCION', 'EN_EXTRACCION',
            'PENDIENTE_REVISION', 'EN_REVISION',
            'APROBADO_HITL', 'EN_RPA', 'COMPLETADO',
            'ERROR_PREPROCESO', 'ERROR_EXTRACCION', 'ERROR_RPA'
        )),                                                    -- Máquina de estados
    sha256_hash                TEXT NOT NULL UNIQUE,            -- Huella digital para deduplicación
    numero_oficio              TEXT,                            -- Desnormalizado para búsqueda rápida
    metadatos_extraidos        TEXT,                            -- JSON de MetadatosOficio (IA)
    metadatos_validados        TEXT,                            -- JSON de MetadatosOficio (HITL)
    revisor_usuario_id         TEXT,                            -- ID del capturista que validó
    fecha_ingesta              TEXT NOT NULL,                   -- ISO 8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ)
    fecha_validacion_hitl      TEXT,                            -- ISO 8601 UTC
    fecha_finalizacion         TEXT,                            -- ISO 8601 UTC
    updated_at                 TEXT NOT NULL,                   -- Última mutación en ISO 8601
    version                    INTEGER NOT NULL DEFAULT 1
        CHECK (version >= 1)                                    -- Control de concurrencia optimista
);

-- REGLA DE CONSISTENCIA:
-- El campo 'numero_oficio' debe mantenerse sincronizado con
-- json_extract(metadatos_extraidos, '$.numeroOficio') o
-- json_extract(metadatos_validados, '$.numeroOficio') tras cada actualización.
-- La responsabilidad recae en la capa de aplicación.

-- =====================================================================
-- TABLA: preproceso_metadata
-- Métricas técnicas generadas por el worker Python (PyMuPDF + Pillow)
-- =====================================================================
CREATE TABLE IF NOT EXISTS preproceso_metadata (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    documento_id              TEXT NOT NULL UNIQUE
        REFERENCES documentos(id) ON DELETE CASCADE,           -- Relación 1:1
    page_count                INTEGER NOT NULL,                -- Número total de páginas
    file_size_bytes           INTEGER NOT NULL,                -- Tamaño en bytes
    sha256_hash               TEXT NOT NULL,                   -- Hash del archivo original
    paginas                   TEXT NOT NULL,                   -- JSON array de PaginaDimension
    processing_duration_ms    INTEGER NOT NULL,                -- Duración del procesamiento
    is_sanitized              INTEGER NOT NULL DEFAULT 1
        CHECK (is_sanitized IN (0, 1)),                        -- Bandera de sanitización
    creado_en                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- =====================================================================
-- TABLA: rpa_ejecuciones
-- Resultado de la automatización Playwright en Webix Intranet
-- =====================================================================
CREATE TABLE IF NOT EXISTS rpa_ejecuciones (
    id                        TEXT PRIMARY KEY,                -- UUID v4
    documento_id              TEXT NOT NULL UNIQUE
        REFERENCES documentos(id) ON DELETE CASCADE,           -- Relación 1:1
    folio_acuse_institucional TEXT,                            -- Folio devuelto por op_cucs.fwx
    fecha_ejecucion           TEXT NOT NULL,                   -- ISO 8601 UTC
    duracion_ms               INTEGER NOT NULL,                -- Duración en milisegundos
    captura_acuse_path        TEXT,                            -- Ruta de la captura del acuse
    intentos                  INTEGER NOT NULL DEFAULT 0,      -- Número de reintentos
    mensaje_error             TEXT,                            -- Detalle del error (si falló)
    exitoso                   INTEGER NOT NULL
        CHECK (exitoso IN (0, 1)),                             -- 1 = éxito, 0 = fallo
    creado_en                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- =====================================================================
-- TABLA: google_sheets_sync
-- Estado de sincronización hacia el tablero central (Google Sheets)
-- =====================================================================
CREATE TABLE IF NOT EXISTS google_sheets_sync (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    documento_id               TEXT NOT NULL UNIQUE
        REFERENCES documentos(id) ON DELETE CASCADE,           -- Relación 1:1
    sincronizado               INTEGER NOT NULL DEFAULT 0
        CHECK (sincronizado IN (0, 1)),                        -- 1 = sincronizado, 0 = pendiente
    fila_index                 INTEGER,                        -- Fila insertada en la hoja
    timestamp_sincronizacion   TEXT,                           -- ISO 8601 UTC
    error_sincronizacion       TEXT,                           -- Mensaje de error (si lo hay)
    creado_en                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actualizado_en             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- =====================================================================
-- ÍNDICES B-TREE OPTIMIZADOS
-- =====================================================================

-- El índice UNIQUE de sha256_hash ya está creado por la restricción UNIQUE
-- en la definición de la columna. No se requiere índice adicional.

-- Búsqueda por número de oficio (findByFolio)
CREATE INDEX IF NOT EXISTS idx_documentos_numero_oficio
    ON documentos(numero_oficio);

-- Filtrado por estado (bandejas, colas)
CREATE INDEX IF NOT EXISTS idx_documentos_estado
    ON documentos(estado);

-- Índice compuesto para consultas de bandeja (estado + fecha)
CREATE INDEX IF NOT EXISTS idx_documentos_estado_fecha
    ON documentos(estado, fecha_ingesta);

-- Orden cronológico para listados
CREATE INDEX IF NOT EXISTS idx_documentos_fecha_ingesta
    ON documentos(fecha_ingesta);

-- Índice parcial para búsqueda por usuario revisor
CREATE INDEX IF NOT EXISTS idx_documentos_revisor
    ON documentos(revisor_usuario_id)
    WHERE revisor_usuario_id IS NOT NULL;

-- =====================================================================
-- CONTROL DE CONCURRENCIA OPTIMISTA
-- =====================================================================
-- La mutación atómica de versión se realiza con la siguiente sentencia:
--
--   UPDATE documentos
--      SET version = version + 1,
--          <otros campos a actualizar>,
--          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
--    WHERE id = ? AND version = ?;
--
-- Si el número de filas afectadas es 0, significa que la versión esperada
-- no coincide con la actual, lo que indica un conflicto de concurrencia.
-- El llamador debe manejar esta situación (reintentar o abortar).
-- =====================================================================