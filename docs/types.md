### 1. `types.ts` (Definiciones de TypeScript)

```typescript
/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Definiciones de Tipos Centralizadas y Modelo de Dominio
 * Versión: 1.0.0-MVP
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

// ==========================================
// 2. MODELADO DE ENTIDADES DEL DOMINIO
// ==========================================

/**
 * Metadatos estructurados extraídos del oficio
 * Cumple con el contrato de inferencia Zod y mapeo Webix
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

```

---

### 2. `schema.md` (Diccionario de Datos)

| Entidad | Campo | Tipo | Requerido | Descripción Técnica y Reglas |
| --- | --- | --- | --- | --- |
| **DocumentoRegistro** | `id` | `string (UUIDv4)` | Sí | Identificador primario global (PK). Generado en ingesta. |
| **DocumentoRegistro** | `nombreArchivoOriginal` | `string` | Sí | Nombre con el que ingresó el archivo al watchfolder o UI. |
| **DocumentoRegistro** | `nombreArchivoCanonico` | `string` | No | `YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf`. Obligatorio al finalizar HITL. |
| **DocumentoRegistro** | `rutaArchivoActual` | `string` | Sí | Ruta en disco del archivo (`storage/01_...` a `storage/03_...`). |
| **DocumentoRegistro** | `rutaEspejoJson` | `string` | No | Ubicación del `.json` espejo en `storage/03_procesados/YYYY/MM/`. |
| **DocumentoRegistro** | `origen` | `IngestaOrigen` | Sí | Enumeración: `'SCANNER_ADF'` | `'WEB_DRAG_DROP'`. |
| **DocumentoRegistro** | `estado` | `DocumentoEstado` | Sí | Estado transaccional en SQLite. Gobernado por la máquina de estados. |
| **DocumentoRegistro** | `sha256Hash` | `string` | Sí | Checksum de 64 caracteres para deduplicación atómica. |
| **DocumentoRegistro** | `metadatosExtraidos` | `MetadatosOficio` | No | Metadatos generados por IA. `null` hasta que concluya extracción. |
| **DocumentoRegistro** | `metadatosValidados` | `MetadatosOficio` | No | Contrato inmutable final verificado por humano en HITL. |
| **DocumentoRegistro** | `preproceso` | `PreprocesoMetadata` | No | Salida técnica de PyMuPDF. `null` si falla antes de preproceso. |
| **DocumentoRegistro** | `rpa` | `RpaEjecucion` | No | Datos de la automatización Playwright en `op_cucs.fwx`. |
| **DocumentoRegistro** | `sheetsSync` | `GoogleSheetsSync` | Sí | Estado de la sincronización hacia la API v4 de Google Sheets. |
| **DocumentoRegistro** | `revisorUsuarioId` | `string` | No | ID del capturista que accionó la validación en pantalla dividida. |
| **DocumentoRegistro** | `fechaIngesta` | `string (ISO 8601)` | Sí | Timestamp UTC de entrada al sistema (`YYYY-MM-DDTHH:mm:ss.sssZ`). |
| **DocumentoRegistro** | `fechaValidacionHitl` | `string (ISO 8601)` | No | Timestamp UTC de confirmación en Svelte 5. |
| **DocumentoRegistro** | `fechaFinalizacion` | `string (ISO 8601)` | No | Timestamp UTC al culminar almacenamiento y RPA. |
| **DocumentoRegistro** | `updatedAt` | `string (ISO 8601)` | Sí | Timestamp UTC de última mutación en base de datos. |
| **DocumentoRegistro** | `version` | `number` | Sí | Contador entero positivo para control de concurrencia optimista. |
| **MetadatosOficio** | `numeroOficio` | `string` | Sí | Folio sanitizado sin caracteres reservados. Obligatorio (`S/N` si carece). |
| **MetadatosOficio** | `fechaEmision` | `string (YYYY-MM-DD)` | Sí | Fecha del documento. Formato estricto para ordenación cronológica. |
| **MetadatosOficio** | `procedencia` | `ProcedenciaTipo` | Sí | Enumeración: `'HCG'` (Interno) o `'Ajena'` (Externo). |
| **MetadatosOficio** | `dependenciaArea` | `string` | Sí | Área emisora en mayúsculas estandarizadas. |
| **MetadatosOficio** | `remitenteNombre` | `string` | Sí | Nombre completo del firmante en mayúsculas. |
| **MetadatosOficio** | `remitenteCargo` | `string` | Sí | Cargo del firmante en mayúsculas. Default: `"NO ESPECIFICADO"`. |
| **MetadatosOficio** | `destinatarioNombre` | `string` | Sí | Nombre del destinatario en mayúsculas. |
| **MetadatosOficio** | `destinatarioCargo` | `string` | Sí | Cargo del destinatario en mayúsculas. Default: `"NO ESPECIFICADO"`. |
| **MetadatosOficio** | `asunto` | `string` | Sí | Síntesis del oficio en texto corrido sin retornos de carro. |
| **MetadatosOficio** | `plazoDias` | `number | null` | No | Días hábiles/naturales de término legal. `null` si no aplica plazo. |
| **MetadatosOficio** | `contieneDatosSensibles` | `boolean` | Sí | `true` si incluye diagnósticos, datos personales, etc. Default `false`. |
| **PreprocesoMetadata** | `pageCount` | `number` | Sí | Conteo entero de páginas del documento. |
| **PreprocesoMetadata** | `fileSizeBytes` | `number` | Sí | Peso del archivo en bytes (`octets`). |
| **PreprocesoMetadata** | `sha256Hash` | `string` | Sí | Hash hexadecimal SHA-256 verificado tras sanitización. |
| **PreprocesoMetadata** | `paginas` | `PaginaDimension[]` | Sí | Arreglo de dimensiones técnicas por página (ancho, alto, DPI). |
| **PreprocesoMetadata** | `processingDurationMs` | `number` | Sí | Tiempo de cómputo del worker Python en milisegundos. |
| **PreprocesoMetadata** | `isSanitized` | `boolean` | Sí | Bandera de integridad estructural del PDF. |
| **RpaEjecucion** | `id` | `string (UUIDv4)` | Sí | Identificador de ejecución RPA (PK). |
| **RpaEjecucion** | `documentoId` | `string (UUIDv4)` | Sí | Clave foránea referenciando a `DocumentoRegistro.id` (FK). |
| **RpaEjecucion** | `folioAcuseInstitucional` | `string` | No | Folio retornado por Webix (`op_cucs.fwx`). `null` si falló. |
| **RpaEjecucion** | `fechaEjecucion` | `string (ISO 8601)` | Sí | Timestamp UTC de ejecución del worker Playwright. |
| **RpaEjecucion** | `duracionMs` | `number` | Sí | Duración total de la automatización en milisegundos. |
| **RpaEjecucion** | `capturaAcusePath` | `string` | No | Ruta al screenshot del comprobante generado por Playwright. |
| **RpaEjecucion** | `intentos` | `number` | Sí | Cantidad de reintentos acumulados (0 para el primer intento). |
| **RpaEjecucion** | `mensajeError` | `string` | No | Detalle del error de selector o timeout en la Intranet. |
| **RpaEjecucion** | `exitoso` | `boolean` | Sí | `true` si el registro y subida del PDF en Webix fue confirmado. |
| **GoogleSheetsSync** | `sincronizado` | `boolean` | Sí | `true` si el append a la API de Google Sheets fue exitoso. |
| **GoogleSheetsSync** | `filaIndex` | `number` | No | Número de fila insertada en el tablero de control. |
| **GoogleSheetsSync** | `timestampSincronizacion` | `string (ISO 8601)` | No | Timestamp UTC de la llamada a Google Sheets API. |
| **GoogleSheetsSync** | `errorSincronizacion` | `string` | No | Mensaje de excepción si falló la API de Google. |

---

### 3. `mockData.json` (Dataset de Prueba)

```json
[
  {
    "id": "e2a45a32-7c89-4d2b-9123-8cfb28d71001",
    "nombreArchivoOriginal": "SCAN_20260901_0042.pdf",
    "nombreArchivoCanonico": "2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.pdf",
    "rutaArchivoActual": "storage/03_procesados/2026/09/2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.pdf",
    "rutaEspejoJson": "storage/03_procesados/2026/09/2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.json",
    "origen": "SCANNER_ADF",
    "estado": "COMPLETADO",
    "sha256Hash": "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
    "metadatosExtraidos": {
      "numeroOficio": "DSA-1042-2026",
      "fechaEmision": "2026-09-01",
      "procedencia": "HCG",
      "dependenciaArea": "DIRECCIÓN GENERAL HCG",
      "remitenteNombre": "DR. JAIME AGUSTÍN GONZÁLEZ ÁLVAREZ",
      "remitenteCargo": "DIRECTOR GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS",
      "asunto": "SOLICITUD DE DICTAMEN TÉCNICO Y FINANCIERO PARA LA ADQUISICIÓN DE EQUIPO MÉDICO DE ALTA ESPECIALIDAD CORRESPONDIENTE AL EJERCICIO FISCAL 2026.",
      "plazoDias": 5,
      "contieneDatosSensibles": false
    },
    "metadatosValidados": {
      "numeroOficio": "DSA-1042-2026",
      "fechaEmision": "2026-09-01",
      "procedencia": "HCG",
      "dependenciaArea": "DIRECCIÓN GENERAL HCG",
      "remitenteNombre": "DR. JAIME AGUSTÍN GONZÁLEZ ÁLVAREZ",
      "remitenteCargo": "DIRECTOR GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS",
      "asunto": "SOLICITUD DE DICTAMEN TÉCNICO Y FINANCIERO PARA LA ADQUISICIÓN DE EQUIPO MÉDICO DE ALTA ESPECIALIDAD CORRESPONDIENTE AL EJERCICIO FISCAL 2026.",
      "plazoDias": 5,
      "contieneDatosSensibles": false
    },
    "preproceso": {
      "pageCount": 2,
      "fileSizeBytes": 1548230,
      "sha256Hash": "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
      "paginas": [
        { "pageNumber": 1, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 2, "widthPx": 2480, "heightPx": 3508, "dpi": 300 }
      ],
      "processingDurationMs": 420,
      "isSanitized": true
    },
    "rpa": {
      "id": "f5b61a9c-0123-4e89-b123-cba987654321",
      "documentoId": "e2a45a32-7c89-4d2b-9123-8cfb28d71001",
      "folioAcuseInstitucional": "HCG-OP-2026-009821",
      "fechaEjecucion": "2026-09-01T14:35:10.120Z",
      "duracionMs": 4150,
      "capturaAcusePath": "storage/03_procesados/2026/09/acuse_f5b61a9c.png",
      "intentos": 1,
      "mensajeError": null,
      "exitoso": true
    },
    "sheetsSync": {
      "sincronizado": true,
      "filaIndex": 142,
      "timestampSincronizacion": "2026-09-01T14:35:12.800Z",
      "errorSincronizacion": null
    },
    "revisorUsuarioId": "USR-CAPTURISTA-04",
    "fechaIngesta": "2026-09-01T14:30:00.000Z",
    "fechaValidacionHitl": "2026-09-01T14:34:55.200Z",
    "fechaFinalizacion": "2026-09-01T14:35:13.000Z",
    "updatedAt": "2026-09-01T14:35:13.000Z",
    "version": 4
  },
  {
    "id": "b3f89e21-6a10-41bc-9988-123456789abc",
    "nombreArchivoOriginal": "OFICIO_SECRETARIA_SALUD_JALISCO_EXPEDIENTE_CLINICO_CONFIDENCIAL_REQUERIMIENTO_URGENTE_2026_FIRMADO.pdf",
    "nombreArchivoCanonico": null,
    "rutaArchivoActual": "storage/02_en_proceso/b3f89e21-6a10-41bc-9988-123456789abc.pdf",
    "rutaEspejoJson": null,
    "origen": "WEB_DRAG_DROP",
    "estado": "PENDIENTE_REVISION",
    "sha256Hash": "b9c8d7e6f5a43210feebdaedcbaf0123456789abcdef0123456789abcdef0123",
    "metadatosExtraidos": {
      "numeroOficio": "SSJ-DGJ-2026-891-B",
      "fechaEmision": "2026-08-31",
      "procedencia": "Ajena",
      "dependenciaArea": "SECRETARÍA DE SALUD DEL ESTADO DE JALISCO - DIRECCIÓN GENERAL JURÍDICA",
      "remitenteNombre": "LIC. MARÍA GUADALUPE RAMÍREZ VILLASEÑOR",
      "remitenteCargo": "DIRECTORA GENERAL DE ASUNTOS JURÍDICOS",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS DEL HCG",
      "asunto": "REQUERIMIENTO DE COPIA CERTIFICADA DEL EXPEDIENTE CLÍNICO INTEGRAL DEL PACIENTE CON IDENTIFICADOR RESERVADO PARA ATENCIÓN DE JUICIO DE AMPARO INDIRECTO 543/2026.",
      "plazoDias": 3,
      "contieneDatosSensibles": true
    },
    "metadatosValidados": null,
    "preproceso": {
      "pageCount": 14,
      "fileSizeBytes": 8945120,
      "sha256Hash": "b9c8d7e6f5a43210feebdaedcbaf0123456789abcdef0123456789abcdef0123",
      "paginas": [
        { "pageNumber": 1, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 2, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 3, "widthPx": 2480, "heightPx": 3508, "dpi": 300 }
      ],
      "processingDurationMs": 1820,
      "isSanitized": true
    },
    "rpa": null,
    "sheetsSync": {
      "sincronizado": false,
      "filaIndex": null,
      "timestampSincronizacion": null,
      "errorSincronizacion": null
    },
    "revisorUsuarioId": null,
    "fechaIngesta": "2026-09-01T15:10:00.000Z",
    "fechaValidacionHitl": null,
    "fechaFinalizacion": null,
    "updatedAt": "2026-09-01T15:10:45.000Z",
    "version": 2
  },
  {
    "id": "c7a10293-8472-4fbc-b091-a1b2c3d4e5f6",
    "nombreArchivoOriginal": "OF_SIN_FOLIO_DELEGACION_SINDICAL.pdf",
    "nombreArchivoCanonico": null,
    "rutaArchivoActual": "storage/02_en_proceso/c7a10293-8472-4fbc-b091-a1b2c3d4e5f6.pdf",
    "rutaEspejoJson": null,
    "origen": "SCANNER_ADF",
    "estado": "ERROR_RPA",
    "sha256Hash": "7f8e9d0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e",
    "metadatosExtraidos": {
      "numeroOficio": "S-N",
      "fechaEmision": "2026-08-28",
      "procedencia": "HCG",
      "dependenciaArea": "SINDICATO ÚNICO DE TRABAJADORES DEL HCG",
      "remitenteNombre": "C. JUAN MANUEL HERNÁNDEZ LÓPEZ",
      "remitenteCargo": "SECRETARIO GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS",
      "asunto": "SOLICITUD DE REVISIÓN DE CONDICIONES GENERALES DE TRABAJO EN EL ÁREA DE LAVANDERÍA CENTRAL.",
      "plazoDias": null,
      "contieneDatosSensibles": false
    },
    "metadatosValidados": {
      "numeroOficio": "S-N",
      "fechaEmision": "2026-08-28",
      "procedencia": "HCG",
      "dependenciaArea": "SINDICATO ÚNICO DE TRABAJADORES DEL HCG",
      "remitenteNombre": "C. JUAN MANUEL HERNÁNDEZ LÓPEZ",
      "remitenteCargo": "SECRETARIO GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS",
      "asunto": "SOLICITUD DE REVISIÓN DE CONDICIONES GENERALES DE TRABAJO EN EL ÁREA DE LAVANDERÍA CENTRAL.",
      "plazoDias": null,
      "contieneDatosSensibles": false
    },
    "preproceso": {
      "pageCount": 1,
      "fileSizeBytes": 451200,
      "sha256Hash": "7f8e9d0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e",
      "paginas": [
        { "pageNumber": 1, "widthPx": 2480, "heightPx": 3508, "dpi": 300 }
      ],
      "processingDurationMs": 280,
      "isSanitized": true
    },
    "rpa": {
      "id": "a9012345-bcde-4f01-2345-6789abcdef01",
      "documentoId": "c7a10293-8472-4fbc-b091-a1b2c3d4e5f6",
      "folioAcuseInstitucional": null,
      "fechaEjecucion": "2026-09-01T15:20:00.000Z",
      "duracionMs": 30120,
      "capturaAcusePath": null,
      "intentos": 3,
      "mensajeError": "TimeoutError: Target closed while waiting for selector '#webix_form_submit_btn' on page op_cucs.fwx",
      "exitoso": false
    },
    "sheetsSync": {
      "sincronizado": false,
      "filaIndex": null,
      "timestampSincronizacion": null,
      "errorSincronizacion": "Encolado postergado debido a error en fase RPA."
    },
    "revisorUsuarioId": "USR-CAPTURISTA-02",
    "fechaIngesta": "2026-09-01T15:15:00.000Z",
    "fechaValidacionHitl": "2026-09-01T15:18:30.000Z",
    "fechaFinalizacion": null,
    "updatedAt": "2026-09-01T15:20:30.000Z",
    "version": 5
  },
  {
    "id": "d89e012a-3456-4789-0123-abcdef456789",
    "nombreArchivoOriginal": "PROPUESTA_PROVEEDOR_EQUIPO_HOSPITALARIO_LUMINIS_SA_DE_CV.pdf",
    "nombreArchivoCanonico": null,
    "rutaArchivoActual": "storage/02_en_proceso/d89e012a-3456-4789-0123-abcdef456789.pdf",
    "rutaEspejoJson": null,
    "origen": "WEB_DRAG_DROP",
    "estado": "EN_EXTRACCION",
    "sha256Hash": "4a5b6c7d8e9f0123456789abcdef0123456789abcdef0123456789abcdef0123",
    "metadatosExtraidos": null,
    "metadatosValidados": null,
    "preproceso": {
      "pageCount": 5,
      "fileSizeBytes": 3210400,
      "sha256Hash": "4a5b6c7d8e9f0123456789abcdef0123456789abcdef0123456789abcdef0123",
      "paginas": [
        { "pageNumber": 1, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 2, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 3, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 4, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 5, "widthPx": 2480, "heightPx": 3508, "dpi": 300 }
      ],
      "processingDurationMs": 710,
      "isSanitized": true
    },
    "rpa": null,
    "sheetsSync": {
      "sincronizado": false,
      "filaIndex": null,
      "timestampSincronizacion": null,
      "errorSincronizacion": null
    },
    "revisorUsuarioId": null,
    "fechaIngesta": "2026-09-01T15:22:10.000Z",
    "fechaValidacionHitl": null,
    "fechaFinalizacion": null,
    "updatedAt": "2026-09-01T15:22:15.000Z",
    "version": 1
  },
  {
    "id": "f1029384-7561-4829-bbcc-001122334455",
    "nombreArchivoOriginal": "DOCUMENTO_CORRUPTO_O_CONTRASENA_PROTEGIDO.pdf",
    "nombreArchivoCanonico": null,
    "rutaArchivoActual": "storage/04_errores/DOCUMENTO_CORRUPTO_O_CONTRASENA_PROTEGIDO.pdf",
    "rutaEspejoJson": null,
    "origen": "SCANNER_ADF",
    "estado": "ERROR_PREPROCESO",
    "sha256Hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "metadatosExtraidos": null,
    "metadatosValidados": null,
    "preproceso": null,
    "rpa": null,
    "sheetsSync": {
      "sincronizado": false,
      "filaIndex": null,
      "timestampSincronizacion": null,
      "errorSincronizacion": null
    },
    "revisorUsuarioId": null,
    "fechaIngesta": "2026-09-01T15:25:00.000Z",
    "fechaValidacionHitl": null,
    "fechaFinalizacion": null,
    "updatedAt": "2026-09-01T15:25:02.000Z",
    "version": 1
  },
  {
    "id": "a5c719e0-1284-4b55-8910-feedaabb1234",
    "nombreArchivoOriginal": "OF_CONACyT_INVESTIGACION_BIOMEDICA_2026.pdf",
    "nombreArchivoCanonico": "2026-08-15__CONAHCYT-SEC-098-2026__CONAHCYT.pdf",
    "rutaArchivoActual": "storage/03_procesados/2026/08/2026-08-15__CONAHCYT-SEC-098-2026__CONAHCYT.pdf",
    "rutaEspejoJson": "storage/03_procesados/2026/08/2026-08-15__CONAHCYT-SEC-098-2026__CONAHCYT.json",
    "origen": "WEB_DRAG_DROP",
    "estado": "COMPLETADO",
    "sha256Hash": "99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff",
    "metadatosExtraidos": {
      "numeroOficio": "CONAHCYT-SEC-098/2026",
      "fechaEmision": "2026-08-15",
      "procedencia": "Ajena",
      "dependenciaArea": "CONSEJO NACIONAL DE HUMANIDADES, CIENCIAS Y TECNOLOGÍAS",
      "remitenteNombre": "DRA. MARÍA ELENA ÁLVAREZ-BUYLLA",
      "remitenteCargo": "DIRECTORA GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "NO ESPECIFICADO",
      "asunto": "NOTIFICACIÓN DE ASIGNACIÓN DE FONDOS CONCURRENTES PARA PROYECTO DE INVESTIGACIÓN CLÍNICA EN ONCOLOGÍA.",
      "plazoDias": 15,
      "contieneDatosSensibles": false
    },
    "metadatosValidados": {
      "numeroOficio": "CONAHCYT-SEC-098-2026",
      "fechaEmision": "2026-08-15",
      "procedencia": "Ajena",
      "dependenciaArea": "CONAHCYT",
      "remitenteNombre": "DRA. MARÍA ELENA ÁLVAREZ-BUYLLA",
      "remitenteCargo": "DIRECTORA GENERAL",
      "destinatarioNombre": "MTRO. LUIS ALBERTO PÉREZ GÓMEZ",
      "destinatarioCargo": "DIRECTOR DE SERVICIOS ADMINISTRATIVOS",
      "asunto": "NOTIFICACIÓN DE ASIGNACIÓN DE FONDOS CONCURRENTES PARA PROYECTO DE INVESTIGACIÓN CLÍNICA EN ONCOLOGÍA.",
      "plazoDias": 15,
      "contieneDatosSensibles": false
    },
    "preproceso": {
      "pageCount": 4,
      "fileSizeBytes": 2890100,
      "sha256Hash": "99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff",
      "paginas": [
        { "pageNumber": 1, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 2, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 3, "widthPx": 2480, "heightPx": 3508, "dpi": 300 },
        { "pageNumber": 4, "widthPx": 2480, "heightPx": 3508, "dpi": 300 }
      ],
      "processingDurationMs": 590,
      "isSanitized": true
    },
    "rpa": {
      "id": "e8129384-9012-4cba-8910-112233445566",
      "documentoId": "a5c719e0-1284-4b55-8910-feedaabb1234",
      "folioAcuseInstitucional": "HCG-OP-2026-008912",
      "fechaEjecucion": "2026-08-16T09:12:00.000Z",
      "duracionMs": 3890,
      "capturaAcusePath": "storage/03_procesados/2026/08/acuse_e8129384.png",
      "intentos": 1,
      "mensajeError": null,
      "exitoso": true
    },
    "sheetsSync": {
      "sincronizado": true,
      "filaIndex": 110,
      "timestampSincronizacion": "2026-08-16T09:12:04.100Z",
      "errorSincronizacion": null
    },
    "revisorUsuarioId": "USR-CAPTURISTA-01",
    "fechaIngesta": "2026-08-16T09:05:00.000Z",
    "fechaValidacionHitl": "2026-08-16T09:11:40.000Z",
    "fechaFinalizacion": "2026-08-16T09:12:05.000Z",
    "updatedAt": "2026-08-16T09:12:05.000Z",
    "version": 4
  }
]
