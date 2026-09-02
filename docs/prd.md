```markdown
# Product Requirements Document (PRD)

| Metadata | Detalle |
| :--- | :--- |
| **Proyecto** | Oficialia-Digital-DSA (Middleware de Digitalización, Extracción y RPA) |
| **Organización** | División de Servicios Administrativos (DSA) - Hospital Civil de Guadalajara |
| **Versión** | 1.0.0-MVP |
| **Estado** | Aprobado para Desarrollo |
| **Tipo de Sistema** | Middleware de Extracción de Datos, Estandarización y RPA |

---

## 0. Resumen Ejecutivo
`Oficialia-Digital-DSA` es un middleware de procesamiento documental que automatiza la ingesta, normalización, extracción estructurada mediante IA multimodal y validación asistida (*Human-in-the-Loop*) de la correspondencia oficial recibida en la DSA. El sistema actúa como un puente operativo que estandariza el archivo digital local, mantiene un registro local/remoto de términos y automatiza la inyección de metadatos y documentos a la Intranet institucional (`op_cucs.fwx`) vía RPA, sin sustituir los sistemas oficiales de gestión documental del Hospital Civil de Guadalajara.

---

## 1. Objetivos Estratégicos (P0)

1. **Eficiencia Operativa:** Reducir el tiempo promedio de captura y registro por oficio de ~4 minutos a **< 10 segundos** de verificación visual activa por documento.
2. **Estandarización y Trazabilidad:** Eliminar discrepancias en nombres de archivo y extravío documental mediante una nomenclatura canónica forzada (`YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf`) y almacenamiento cronológico por carpetas.
3. **Automatización del Registro Institucional:** Eliminar la doble captura manual inyectando metadatos y adjuntando el PDF en el módulo legacy Webix de Oficialía de Partes (`op_cucs.fwx`) mediante Playwright en TypeScript.
4. **Control de Términos y Transparencia:** Centralizar los oficios procesados en un almacenamiento estructurado (SQLite WAL + JSON espejo + Google Sheets) para alertar sobre términos legales y plazos de respuesta de manera inmediata.

---

## 2. Alcance (The Guardrails)


```

+---------------------------------------------------------------------------------------------------+
|                                        IN-SCOPE (P0 / P1)                                         |
|                                                                                                   |
|  [ Ingesta Dual ]                                                                                 |
|  • Watchfolder local/SMB (storage/01_entrada/)                                                    |
|  • Drag & Drop web (Svelte 5 UI)                                                                  |
|         │                                                                                         |
|         ▼                                                                                         |
|  [ Worker Preprocesamiento (Python CLI / PyMuPDF + Pillow) ]                                      |
|  • Sanitización de PDF, renderizado de páginas y optimización para LLM                            |
|         │                                                                                         |
|         ▼                                                                                         |
|  [ Extracción Multimodal (@google/genai + Zod) ]                                                  |
|  • Inferencia con gemini-2.5-flash y validación estricta de esquema                               |
|         │                                                                                         |
|         ▼                                                                                         |
|  [ Validación HITL (Split-Screen UI) ]                                                            |
|  • Svelte 5 + Tailwind + Canvas interactivo PDF.js                                                |
|  • Edición rápida (< 10 seg) + Botón de confirmación unificada                                    |
|         │                                                                                         |
|         ▼                                                                                         |
|  [ Pipeline de Salida y RPA ]                                                                     |
|  • Renombrado canónico en storage/03_procesados/YYYY/MM/ + .json espejo                           |
|  • Persistencia en SQLite (better-sqlite3 en WAL) + Append a Google Sheets                        |
|  • Worker Playwright (TS) inyectando en op_cucs.fwx (Webix Intranet)                               |
+---------------------------------------------------------------------------------------------------+
|                                           OUT-OF-SCOPE                                            |
|  [X] Reemplazo o bypass de la Intranet institucional HCG                                          |
|  [X] Modelos locales pesados de OCR/LLM (Tesseract, Ollama, etc.)                                 |
|  [X] Firma electrónica avanzada (FIEL / e.firma) o estampado cronológico criptográfico            |
|  [X] Redacción asistida o generación automática de oficios de respuesta                           |
|  [X] Exposición a internet pública (arquitectura estrictamente para LAN hospitalaria / VPN)       |
|  [X] Gestión y despacho de correspondencia de salida institucional                                |
+---------------------------------------------------------------------------------------------------+

```

### 2.1. In-Scope (P0: Crítico para MVP)
* **Ingesta Dual:**
  * Vigilancia asíncrona de directorio local/SMB (`storage/01_entrada/`) para PDFs generados por escáner departamental vía ADF.
  * Endpoint HTTP y zona Drag & Drop en la UI web para oficios recibidos digitalmente.
* **Preprocesamiento Rápido de PDF:**
  * Subproceso CLI en Python 3 (`fitz` / `Pillow`) para validar integridad del PDF, corregir orientación de páginas y preparar imágenes/buffers optimizados.
* **Extracción Estructurada con Gemini:**
  * Inferencia sobre el documento mediante Gemini API (`gemini-2.5-flash`) utilizando el SDK `@google/genai` y tipado/parseo con Zod.
* **Interfaz de Validación Human-in-the-Loop (HITL):**
  * Pantalla dividida en Svelte 5: visor en canvas renderizado por PDF.js a la izquierda y formulario reactivo con metadatos precargados a la derecha.
  * Disparador único: `[Confirmar y Registrar en Intranet]`.
* **Estandarización y Archivo Canónico:**
  * Renombrado atómico: `YYYY-MM-DD__[FOLIO-SANITIZADO]__[REMITENTE-RESUMIDO].pdf`.
  * Estructuración cronológica en disco: `storage/03_procesados/YYYY/MM/`.
  * Generación de archivo JSON espejo junto a cada PDF final.
* **Persistencia Local e Indexación Externa:**
  * Registro transaccional en base de datos SQLite administrada con `better-sqlite3` en modo WAL.
  * Sincronización en tiempo real hacia hoja centralizada de Google Sheets para control administrativo.
* **Inyección Automatizada (RPA):**
  * Script Playwright en TypeScript para iniciar sesión, navegar por el formulario Webix de `op_cucs.fwx`, rellenar campos, adjuntar el PDF renombrado y capturar el acuse institucional.

### 2.2. In-Scope (P1: Fase Complementaria)
* **Detección de Folios Duplicados:** Alerta en UI si el `numero_oficio` ya existe registrado en la base SQLite local.
* **Manejo de Reintentos de RPA:** Si la Intranet falla por timeout o sesión expirada, mantener el registro en estado `ERROR_RPA` y permitir reintento manual con un clic sin reescanear ni reextraer metadatos.

### 2.3. Out-of-Scope (Límites Estrictos)
* **Sustitución de Sistemas Oficiales:** El sistema no almacena de forma definitiva con validez legal independiente a la Intranet del hospital.
* **Firma Electrónica:** No valida certificados de firma electrónica avanzada.
* **Redacción Automatizada:** No redacta respuestas a solicitudes.
* **OCR Local:** No se ejecutan motores OCR locales pesados en el servidor de la DSA.

---

## 3. Esquema de Datos P0 y Contrato de Extracción

### 3.1. Definición del Esquema Zod (TypeScript)

```typescript
import { z } from "zod";

export const MetadatosOficioSchema = z.object({
  numero_oficio: z
    .string()
    .min(1, "El número de oficio o folio es obligatorio (usar 'S/N' si carece de él)")
    .transform((val) => val.trim().replace(/[\/\\:*?"<>|]/g, "-")),
  
  fecha_emision: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha requerido: YYYY-MM-DD"),
  
  procedencia: z.enum(["HCG", "Ajena"], {
    description: "HCG para dependencias internas, Ajena para emisores externos"
  }),
  
  dependencia_area: z
    .string()
    .min(1, "Debe especificarse el área o dependencia emisora")
    .transform((val) => val.toUpperCase().trim()),
  
  remitente_nombre: z
    .string()
    .min(1, "Nombre del suscriptor o firmante")
    .transform((val) => val.toUpperCase().trim()),
  
  remitente_cargo: z
    .string()
    .default("NO ESPECIFICADO")
    .transform((val) => val.toUpperCase().trim()),
  
  destinatario_nombre: z
    .string()
    .min(1, "Nombre del funcionario a quien se dirige")
    .transform((val) => val.toUpperCase().trim()),
  
  destinatario_cargo: z
    .string()
    .default("NO ESPECIFICADO")
    .transform((val) => val.toUpperCase().trim()),
  
  asunto: z
    .string()
    .min(5, "Síntesis del oficio (1 a 3 oraciones)")
    .transform((val) => val.replace(/[\r\n]+/g, " ").trim()),
  
  plazo_dias: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
  
  contiene_datos_sensibles: z
    .boolean()
    .default(false)
});

export type MetadatosOficio = z.infer<typeof MetadatosOficioSchema>;

```

### 3.2. Mapeo hacia el Módulo Webix de Intranet (`op_cucs.fwx`)

| Campo Zod | Tipo | Transformación / Sanitización | Destino en `op_cucs.fwx` |
| --- | --- | --- | --- |
| `numero_oficio` | `string` | Caracteres inválidos reemplazados por `-` | Input: Número / Folio de Oficio |
| `fecha_emision` | `string (YYYY-MM-DD)` | Conversión a `DD/MM/AAAA` en el worker RPA | Input: Fecha de Emisión |
| `procedencia` | `enum ("HCG", "Ajena")` | Mapeo directo a radio button institucional | Radio Button: Procedencia |
| `dependencia_area` | `string` | Mayúsculas normalizadas | Input / Autocompletado: Dependencia |
| `remitente_nombre` | `string` | Mayúsculas normalizadas | Input: Remitente |
| `remitente_cargo` | `string` | Mayúsculas normalizadas | Input: Cargo Remitente |
| `destinatario_nombre` | `string` | Mayúsculas normalizadas | Input: Destinatario |
| `destinatario_cargo` | `string` | Mayúsculas normalizadas | Input: Cargo Destinatario |
| `asunto` | `string` | Párrafo continuo sanitizado | Textarea: Asunto / Síntesis |
| `plazo_dias` | `number | null` | `0` si es nulo | Input: Término / Días Límite |
| `contiene_datos_sensibles` | `boolean` | Flag booleano | Checkbox: Información Confidencial |

---

## 4. Flujos de Usuario y de Sistema

### Flujo 1: Ingesta, Preprocesamiento y Extracción Asíncrona

```
[Escáner ADF / Web UI] ──> [storage/01_entrada/]
                                  │
                                  ▼ (Fastify Orchestrator detecta archivo)
                     [Mover a storage/02_en_proceso/]
                                  │
                                  ▼ (Subproceso CLI)
              [Python Worker (PyMuPDF / Pillow)]
              • Valida PDF y optimiza buffers/páginas
                                  │
                                  ▼ (SDK @google/genai)
                     [Gemini API (gemini-2.5-flash)]
                     • Extracción estructurada JSON
                                  │
                                  ▼ (Zod Validation)
              [Persistir en SQLite (better-sqlite3, WAL)]
              • Estado: PENDIENTE_REVISION
                                  │
                                  ▼
              [Emitir evento WebSocket a Frontend Svelte 5]

```

### Flujo 2: Verificación Human-in-the-Loop (HITL) en Svelte 5

```
[Capturista en Frontend] ──> [Abre documento desde la bandeja de pendientes]
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
   [Panel Izquierdo: PDF.js]                             [Panel Derecho: Formulario]
   • Canvas interactivo                                  • Campos precargados y validados
   • Zoom, rotación, navegación                          • Edición inline de discrepancias
            │                                                     │
            └──────────────────────────┬──────────────────────────┘
                                       ▼
                     [Revisión visual completada (< 10 seg)]
                                       ▼
                  [Clic: "Confirmar y Registrar en Intranet"]
                                       │
                                       ▼
             [UI bloquea edición y muestra indicador de progreso]

```

### Flujo 3: Estandarización, Indexación y Ejecución de RPA

```
[Confirmación Recibida en Fastify]
           │
           ├─► [1. Archivo Canónico]:
           │       • Mover a: storage/03_procesados/YYYY/MM/
           │       • Nombre: YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf
           │       • Generar espejo: YYYY-MM-DD__[FOLIO]__[REMITENTE].json
           │
           ├─► [2. Persistencia e Indexación]:
           │       • Actualizar registro en SQLite (WAL) -> ESTADO: EN_RPA
           │       • Append asíncrono a Google Sheets (Tablero de Control DSA)
           │
           └─► [3. Worker Playwright (TypeScript)]:
                   • Lanzar sesión en Intranet HCG
                   • Navegar a op_cucs.fwx (Webix Form)
                   • Setear campos con metadatos confirmados
                   • Subir PDF canónico
                   • Ejecutar Submit y capturar Acuse/Folio institucional
                   • Actualizar SQLite -> ESTADO: COMPLETADO

```

---

## 5. Arquitectura Técnica y Restricciones de Implementación

### 5.1. Stack Tecnológico Homologado

```
+-----------------------------------------------------------------------------------+
| FRONTEND:  Svelte 5 (Vite) + Tailwind CSS + PDF.js (Canvas Interactivo)          |
+-----------------------------------------------------------------------------------+
                                         │ (HTTP / WebSocket)
                                         ▼
+-----------------------------------------------------------------------------------+
| BACKEND:   Node.js (v22+) + TypeScript + Fastify (Orquestador Principal)         |
+-----------------------------------------------------------------------------------+
       │                                     │                             │
       ▼ (Subproceso CLI)                    ▼ (@google/genai + Zod)       ▼ (Native TS)
+------------------------+      +--------------------------+      +-----------------+
| WORKER PREPROCESO      |      | MOTOR DE EXTRACCIÓN      |      | WORKER RPA      |
| Python 3 + PyMuPDF     |      | Gemini API               |      | Playwright (TS) |
| (fitz) + Pillow        |      | (gemini-2.5-flash)       |      | Intranet Webix  |
+------------------------+      +--------------------------+      +-----------------+
                                             │                             │
                                             ▼                             ▼
+-----------------------------------------------------------------------------------+
| PERSISTENCIA LOCAL: SQLite en modo WAL administrado con better-sqlite3           |
| INTEGRACIÓN EXTERNA: Google Sheets API v4 (Control de Términos / Pendientes DSA)  |
+-----------------------------------------------------------------------------------+

```

* **Runtime y Backend:** Node.js v22+ LTS con TypeScript, ejecutando Fastify como servidor HTTP y orquestador de colas/eventos.
* **Preprocesamiento Documental:** Python 3 invocado vía subproceso CLI (`child_process.spawn`) utilizando `PyMuPDF` (`fitz`) y `Pillow` para sanitizar archivos, corregir orientación y renderizar páginas de alta resolución.
* **Motor de Extracción Inteligente:** SDK oficial `@google/genai` consumiendo `gemini-2.5-flash` con salida JSON forzada y validación en tiempo de ejecución mediante `Zod`.
* **Frontend y Visor HITL:** Svelte 5 asistido por Tailwind CSS y `pdfjs-dist` para el renderizado acelerado por hardware en elementos `<canvas>`.
* **Persistencia y Estado:** SQLite en modo WAL (Write-Ahead Logging) administrado de forma síncrona/segura con `better-sqlite3`.
* **RPA de Inyección:** Playwright nativo en TypeScript, configurado con selectores resistentes para la interfaz Webix del módulo `op_cucs.fwx`.

### 5.2. Estructura del Almacenamiento Local (Pipeline Watchfolder)

```text
storage/
├── 01_entrada/        # Directorio vigilado (ingesta de escáner ADF y cargas manuales)
├── 02_en_proceso/     # Archivos bloqueados durante preprocesamiento, inferencia y HITL
├── 03_procesados/     # Repositorio definitivo cronológico
│   └── YYYY/
│       └── MM/
│           ├── YYYY-MM-DD__[FOLIO]__[REMITENTE].pdf
│           └── YYYY-MM-DD__[FOLIO]__[REMITENTE].json
└── 04_errores/        # Documentos corruptos o con excepciones críticas de procesamiento

```

### 5.3. Seguridad, Resiliencia y Concurrencia

* **Concurrencia en Base de Datos:** SQLite debe operar obligatoriamente con `PRAGMA journal_mode = WAL;` y `PRAGMA busy_timeout = 5000;` para evitar bloqueos entre los hilos de Fastify, los workers de RPA y las consultas de la UI.
* **Aislamiento de Secretos:** Las credenciales de la Intranet hospitalaria, la API Key de Gemini y las llaves de servicio de Google deben inyectarse mediante variables de entorno en un archivo `.env` restringido (`chmod 600`) en el servidor local.
* **Políticas de Privacidad de Datos:** La invocación a Gemini API debe realizarse mediante conexiones seguras TLS sin retención de datos en la nube.
* **Idempotencia y Trazabilidad:** El worker de Playwright debe registrar en la base de datos el hash SHA-256 del PDF y el acuse devuelto por la Intranet institucional, impidiendo registros dobles del mismo oficio.

```

```
