/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Extracción Multimodal con Gemini 2.5 Flash
 * Implementación del puerto secundario IAIExtractorProvider sobre el SDK oficial @google/genai.
 *
 * Versión:      1.0.0-MVP
 * Runtime:      Node.js 22 LTS · TypeScript 5.x (modo estricto)
 * Dependencias: @google/genai >= 1.x · zod >= 4.x (única conversión Zod → responseSchema
 *               soportada: z.toJSONSchema, sin dependencias de terceros)
 * Ruta sugerida: src/infrastructure/ai/GeminiAIExtractorAdapter.ts
 *               (ajuste las rutas relativas de importación a su estructura real)
 *
 * Decisiones de diseño:
 *  - Contrato fiel: se implementa extractFromPages()/ping() EXACTAMENTE como los define
 *    contracts.md; la lógica del esbozo extract(imageBuffer, schema) del PRD se resuelve
 *    internamente (conversión de buffers a Part de Google y validación contra el esquema).
 *  - Generación controlada: responseMimeType "application/json" + responseSchema NATIVO
 *    de Gemini, derivado en caliente del esquema Zod (z.toJSONSchema con io:'input',
 *    forma de ENTRADA previa a las transformaciones de normalización del dominio). Si el
 *    runtime carece de esa API (zod 3.x), degrada sin fricción a un esquema estático espejo.
 *  - El esquema se deriva UNA sola vez en el constructor (eficiencia de CPU; el system
 *    prompt permanece estático para aprovechar el caché implícito del proveedor).
 *  - Telemetría: usageMetadata.promptTokenCount / candidatesTokenCount + latencia vía
 *    performance.now() + modelVersion de la respuesta cruda.
 *  - Doble capa de timeout: httpOptions.timeout del cliente (aborta el socket) y carrera
 *    de promesa que garantiza la excepción tipada INFERENCE_TIMEOUT aunque el SDK no
 *    propague el aborte.
 *  - Sin reintentos internos: la política de backoff/circuit-breaker es responsabilidad
 *    del orquestador (estados ERROR_EXTRACCION / reintentos), conforme al PRD.
 */

import { ApiError, GoogleGenAI, Type } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse, Part } from '@google/genai';
import { z } from 'zod';

import { SYSTEM_PROMPT_EXTRACCION_OFICIOS } from './prompts/systemPromptExtraccionOficios';

import type {
  AIExtractionError,
  AIExtractionErrorCode,
  ExtractionHints,
  ExtractionResult,
  ExtractionTelemetry,
  IAIExtractorProvider,
} from '../../contracts/IAIExtractorProvider';
import type { RenderedPageImage } from '../../contracts/IPdfProcessorProvider';
import type { MetadatosOficio } from '../../contracts/types';

// =============================================================================
// 1. CONFIGURACIÓN Y CONSTANTES
// =============================================================================

const DEFAULT_MODEL: string = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS: number = 45_000;

/** Valores de finishReason del candidato que representan bloqueo por seguridad o políticas. */
const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set<string>([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
]);

/** Opciones de construcción inyectadas por el composition root (Fastify). */
export interface GeminiAIExtractorOptions {
  /** Esquema Zod maestro del dominio (MetadatosOficioSchema). Obligatorio. */
  schema: z.ZodType;
  /** API Key de Google AI Studio; si se omite, se resuelve de GEMINI_API_KEY / GOOGLE_API_KEY. */
  apiKey?: string;
  /** Identificador del modelo multimodal objetivo (default: gemini-2.5-flash). */
  model?: string;
  /** Límite de espera de la inferencia HTTP en milisegundos (default: 45 000). */
  timeoutMs?: number;
  /** Presupuesto de razonamiento interno (thinking) en tokens; 0 lo desactiva para minimizar latencia. */
  thinkingBudget?: number;
  /** Temperatura de muestreo (default: 0 — extracción determinista). */
  temperature?: number;
  /** Tope de tokens de salida; si se omite, delega el default del modelo. */
  maxOutputTokens?: number;
}

// =============================================================================
// 2. ERROR TIPADO DEL DOMINIO (implementa el contrato AIExtractionError)
// =============================================================================

/**
 * Fallo estructurado de la fase de extracción por IA. Extiende Error para conservar
 * trazabilidad de stack, e implementa la interfaz AIExtractionError del contrato para
 * que los orquestadores lo consuman sin acoplarse al SDK de Google.
 */
export class GeminiExtractionError extends Error implements AIExtractionError {
  public readonly code: AIExtractionErrorCode;
  public readonly rawResponse?: string;
  public readonly validationIssues?: Array<{ path: string; message: string }>;

  constructor(
    code: AIExtractionErrorCode,
    message: string,
    attributes: {
      rawResponse?: string;
      validationIssues?: Array<{ path: string; message: string }>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: attributes.cause });
    this.name = 'GeminiExtractionError';
    this.code = code;
    this.rawResponse = attributes.rawResponse;
    this.validationIssues = attributes.validationIssues;
  }
}

// =============================================================================
// 3. DERIVACIÓN Zod → responseSchema NATIVO DE GEMINI
//    (sin dependencias externas: zod.toJSONSchema + normalización al subconjunto
//     de Schema que aceptan tanto Google AI Studio como Vertex AI)
// =============================================================================

/** Subconjunto de Schema del SDK compatible con AI Studio y Vertex AI. */
interface GeminiSchemaNode {
  type?: Type;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchemaNode;
  properties?: Record<string, GeminiSchemaNode>;
  required?: string[];
  propertyOrdering?: string[];
  anyOf?: GeminiSchemaNode[];
}

/** Vista mínima del JSON Schema emitido por z.toJSONSchema (draft-7). */
interface JsonSchemaLike {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaLike;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  anyOf?: JsonSchemaLike[];
  $defs?: Record<string, JsonSchemaLike>;
}

/**
 * Esquema estático espejo de MetadatosOficioSchema. Se utiliza únicamente como
 * degradación cuando el runtime de zod no expone z.toJSONSchema (zod 3.x).
 * ⚠️ Mantener en sincronía manual con el esquema Zod maestro del dominio.
 */
const METADATOS_OFICIO_FALLBACK_SCHEMA: GeminiSchemaNode = {
  type: Type.OBJECT,
  description: 'Metadatos estructurados de un oficio de correspondencia oficial mexicana.',
  properties: {
    numero_oficio: { type: Type.STRING, description: 'Folio asignado por el emisor; "S/N" si carece de él.' },
    fecha_emision: { type: Type.STRING, description: 'Fecha de emisión en ISO 8601 estricto: YYYY-MM-DD.' },
    procedencia: {
      type: Type.STRING,
      enum: ['HCG', 'Ajena'],
      description: 'HCG si el emisor es interno del Hospital Civil de Guadalajara; Ajena si es externo.',
    },
    dependencia_area: { type: Type.STRING, description: 'Dependencia o área emisora, en mayúsculas.' },
    remitente_nombre: { type: Type.STRING, description: 'Nombre completo del firmante, en mayúsculas.' },
    remitente_cargo: { type: Type.STRING, description: 'Cargo del firmante; "NO ESPECIFICADO" si no aparece.' },
    destinatario_nombre: { type: Type.STRING, description: 'Nombre del destinatario, en mayúsculas.' },
    destinatario_cargo: { type: Type.STRING, description: 'Cargo del destinatario; "NO ESPECIFICADO" si no aparece.' },
    asunto: { type: Type.STRING, description: 'Síntesis del oficio: párrafo continuo de 1 a 3 líneas, sin saltos de línea.' },
    plazo_dias: { type: Type.INTEGER, nullable: true, description: 'Término de respuesta en días (entero no negativo); null si no aplica.' },
    contiene_datos_sensibles: { type: Type.BOOLEAN, description: 'true únicamente si el contenido expone datos personales sensibles (LGPDPPSO).' },
  },
  required: [
    'numero_oficio',
    'fecha_emision',
    'procedencia',
    'dependencia_area',
    'remitente_nombre',
    'destinatario_nombre',
    'asunto',
  ],
  propertyOrdering: [
    'numero_oficio',
    'fecha_emision',
    'procedencia',
    'dependencia_area',
    'remitente_nombre',
    'remitente_cargo',
    'destinatario_nombre',
    'destinatario_cargo',
    'asunto',
    'plazo_dias',
    'contiene_datos_sensibles',
  ],
};

/**
 * Convierte un nodo de JSON Schema al subconjunto GeminiSchemaNode, descartando las
 * palabras clave que la API no acepta (pattern, minLength, minimum, additionalProperties,
 * default, etc.). La validación de esas restricciones permanece del lado de Zod
 * (defensa en profundidad: responseSchema fuerza la forma; Zod exige el contrato).
 */
function convertNode(node: JsonSchemaLike, defs: Record<string, JsonSchemaLike>): GeminiSchemaNode {
  // Resolución de referencias internas generadas por zod para subesquemas reutilizados.
  if (typeof node.$ref === 'string') {
    const refName = node.$ref.split('/').pop();
    return refName !== undefined && defs[refName] !== undefined
      ? convertNode(defs[refName]!, defs)
      : { type: Type.STRING };
  }

  // Uniones anyOf: una rama null se colapsa como nullable de la rama superviviente.
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    const nonNullBranches = node.anyOf.filter((branch) => branch.type !== 'null');
    if (nonNullBranches.length === 1) {
      const collapsed = convertNode(nonNullBranches[0]!, defs);
      return { ...collapsed, nullable: true };
    }
    return { anyOf: nonNullBranches.map((branch) => convertNode(branch, defs)) };
  }

  const rawType = node.type;
  const typeList: string[] = Array.isArray(rawType) ? rawType : rawType !== undefined ? [rawType] : [];
  const isNullable = typeList.includes('null');
  const primaryType = typeList.find((candidate) => candidate !== 'null') ?? 'string';

  const geminiNode: GeminiSchemaNode = {};
  if (typeof node.description === 'string' && node.description.length > 0) {
    geminiNode.description = node.description;
  }
  if (Array.isArray(node.enum) && node.enum.every((value) => typeof value === 'string')) {
    geminiNode.enum = node.enum as string[];
  }

  switch (primaryType) {
    case 'object': {
      geminiNode.type = Type.OBJECT;
      const properties = node.properties ?? {};
      geminiNode.properties = Object.fromEntries(
        Object.entries(properties).map(
          ([key, value]): [string, GeminiSchemaNode] => [key, convertNode(value, defs)]
        )
      );
      const propertyKeys = Object.keys(properties);
      if (propertyKeys.length > 0) {
        // propertyOrdering estabiliza el orden de emisión del JSON del modelo.
        geminiNode.propertyOrdering = propertyKeys;
      }
      if (Array.isArray(node.required) && node.required.length > 0) {
        geminiNode.required = node.required.filter((key) => key in properties);
      }
      break;
    }
    case 'array':
      geminiNode.type = Type.ARRAY;
      if (node.items !== undefined) {
        geminiNode.items = convertNode(node.items, defs);
      }
      break;
    case 'integer':
      geminiNode.type = Type.INTEGER;
      break;
    case 'number':
      geminiNode.type = Type.NUMBER;
      break;
    case 'boolean':
      geminiNode.type = Type.BOOLEAN;
      break;
    default:
      geminiNode.type = Type.STRING;
      break;
  }

  if (isNullable) {
    geminiNode.nullable = true;
  }
  return geminiNode;
}

/**
 * Deriva el responseSchema nativo de Gemini a partir del esquema Zod del dominio.
 * Usa z.toJSONSchema con io:'input' (forma previa a las transformaciones de
 * normalización: trim/uppercase/sanitización se aplican en el parseo Zod local).
 * Devuelve undefined si la derivación no es posible, activando el fallback estático.
 */
function tryDeriveFromZod(schema: z.ZodType): GeminiSchemaNode | undefined {
  const zodNamespace = z as unknown as {
    toJSONSchema?: (
      target: z.ZodType,
      params: { io: 'input'; unrepresentable: 'any' }
    ) => JsonSchemaLike;
  };
  if (typeof zodNamespace.toJSONSchema !== 'function') {
    return undefined;
  }
  try {
    const jsonSchema = zodNamespace.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    const defs = jsonSchema.$defs ?? {};
    const node = convertNode(jsonSchema, defs);
    return node.type === Type.OBJECT ? node : undefined;
  } catch {
    return undefined;
  }
}

/** Punto único de resolución del responseSchema (derivado en caliente o fallback). */
function resolveResponseSchema(schema: z.ZodType): GeminiSchemaNode {
  return tryDeriveFromZod(schema) ?? METADATOS_OFICIO_FALLBACK_SCHEMA;
}

// =============================================================================
// 4. UTILIDADES DE TRANSPORTE
// =============================================================================

/** Conversión cero-copia de Uint8Array a Base64 para inlineData del SDK. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Sanitiza defensivamente envoltorios de bloque de código. Con responseMimeType JSON
 * el modelo no debería emitirlos; la capa existe para degradar con elegancia si un
 * proveedor intermedio los inyectara.
 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** Extrae el status HTTP de errores del SDK (ApiError) o de errores con campo status. */
function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    const raw = (error as { status?: number | string }).status;
    return typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10) || undefined;
  }
  const duckStatus = (error as { status?: number | string } | null | undefined)?.status;
  if (typeof duckStatus === 'number') {
    return duckStatus;
  }
  if (typeof duckStatus === 'string' && /^\d{3}$/.test(duckStatus)) {
    return Number.parseInt(duckStatus, 10);
  }
  return undefined;
}

// =============================================================================
// 5. ADAPTADOR — IMPLEMENTACIÓN DEL PUERTO IAIExtractorProvider
// =============================================================================

export class GeminiAIExtractorAdapter implements IAIExtractorProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly schema: z.ZodType;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly thinkingBudget?: number;
  private readonly maxOutputTokens?: number;
  private readonly responseSchema: GeminiSchemaNode;

  constructor(options: GeminiAIExtractorOptions) {
    const apiKey: string | undefined =
      options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        '[GeminiAIExtractorAdapter] Credencial ausente: inyecte options.apiKey o defina GEMINI_API_KEY en el entorno.'
      );
    }

    this.model = options.model ?? DEFAULT_MODEL;
    this.schema = options.schema;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.temperature = options.temperature ?? 0;
    this.thinkingBudget = options.thinkingBudget;
    this.maxOutputTokens = options.maxOutputTokens;
    this.responseSchema = resolveResponseSchema(options.schema);

    this.client = new GoogleGenAI({
      apiKey,
      // Primera capa de timeout: aborta el socket HTTP del proveedor.
      httpOptions: { timeout: this.timeoutMs },
    });
  }

  /**
   * Extrae los metadatos de un oficio procesando las imágenes renderizadas de sus páginas.
   *
   * @param pages   Colección de imágenes de alta resolución del documento.
   * @param hints   Parámetros opcionales (procedencia preliminar, año de contexto).
   * @returns       Resultado tipado inmutable (MetadatosOficio + telemetría de consumo).
   * @throws {GeminiExtractionError} Mapeado a AIExtractionErrorCode según el contrato.
   */
  public async extractFromPages(
    pages: ReadonlyArray<RenderedPageImage>,
    hints?: ExtractionHints
  ): Promise<ExtractionResult> {
    const startedAt = performance.now();

    if (pages.length === 0) {
      throw new GeminiExtractionError(
        'DOCUMENT_UNREADABLE_OR_EMPTY',
        'No se recibieron páginas renderizadas para someter a inferencia multimodal.'
      );
    }

    // Orden de lectura natural del documento (carátula primero).
    const orderedPages: ReadonlyArray<RenderedPageImage> = [...pages].sort(
      (a, b) => a.pageNumber - b.pageNumber
    );
    if (orderedPages.some((page) => page.imageBuffer.byteLength === 0)) {
      throw new GeminiExtractionError(
        'DOCUMENT_UNREADABLE_OR_EMPTY',
        'Al menos una página renderizada llegó con buffer vacío (0 bytes): el documento no es legible para el motor OCR.'
      );
    }

    const contents: Content[] = this.buildContents(orderedPages, hints);

    let response: GenerateContentResponse;
    try {
      response = await this.withTimeout(
        this.client.models.generateContent({
          model: this.model,
          contents,
          config: this.buildGenerationConfig({ structured: true }),
        })
      );
    } catch (error) {
      // Los timeouts de la carrera de promesa ya arrojan el error tipado: reemitir tal cual.
      if (error instanceof GeminiExtractionError) {
        throw error;
      }
      throw this.mapTransportError(error, performance.now() - startedAt);
    }

    // --- Fase 2: filtros de seguridad y salud de la candidata -----------------

    const promptBlock = response.promptFeedback?.blockReason;
    if (promptBlock !== undefined && promptBlock !== null) {
      throw new GeminiExtractionError(
        'SAFETY_CONTENT_BLOCKED',
        `La solicitud fue bloqueada por filtros de seguridad del proveedor (blockReason=${String(promptBlock)}).`
      );
    }

    const candidate = response.candidates?.[0];
    const finishReason = candidate !== undefined ? String(candidate.finishReason ?? '') : '';

    if (SAFETY_FINISH_REASONS.has(finishReason)) {
      throw new GeminiExtractionError(
        'SAFETY_CONTENT_BLOCKED',
        `La generación fue interrumpida por políticas de seguridad del modelo (finishReason=${finishReason}).`
      );
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new GeminiExtractionError(
        'MALFORMED_JSON_RESPONSE',
        'La respuesta JSON fue truncada al agotarse el presupuesto de tokens de salida (finishReason=MAX_TOKENS). ' +
          'Aumente options.maxOutputTokens o reduzca options.thinkingBudget.'
      );
    }
    if (candidate === undefined) {
      throw new GeminiExtractionError(
        'AI_SERVICE_UNAVAILABLE',
        'El proveedor respondió sin candidatos de generación utilizables.'
      );
    }

    const rawText: string = response.text ?? '';
    if (rawText.trim().length === 0) {
      throw new GeminiExtractionError(
        'DOCUMENT_UNREADABLE_OR_EMPTY',
        'El modelo no produjo texto: la imagen está probablemente en blanco, es ilegible o carece de contenido extraíble.'
      );
    }

    // --- Fase 3: parseo JSON del payload estructurado --------------------------

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFences(rawText));
    } catch (error) {
      throw new GeminiExtractionError(
        'MALFORMED_JSON_RESPONSE',
        'La respuesta del modelo no es JSON parseable a pesar del modo de salida forzada.',
        { rawResponse: rawText, cause: error }
      );
    }

    // --- Fase 4: validación estricta del contrato de dominio (Zod) -------------

    const validated = this.schema.safeParse(parsedJson);
    if (!validated.success) {
      throw new GeminiExtractionError(
        'SCHEMA_VALIDATION_FAILED',
        'El JSON devuelto por el modelo viola el contrato estricto MetadatosOficio (validación Zod).',
        {
          rawResponse: rawText,
          validationIssues: validated.error.issues.map(
            (issue): { path: string; message: string } => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })
          ),
          cause: validated.error,
        }
      );
    }

    // --- Fase 5: consolidación de resultado y telemetría -----------------------

    const metadata = Object.freeze(validated.data) as Readonly<MetadatosOficio>;
    const usage = response.usageMetadata;

    const telemetry: ExtractionTelemetry = {
      // Tokens de entrada (imágenes + system instruction), según usageMetadata.
      promptTokens: usage?.promptTokenCount ?? 0,
      // Tokens de salida generados en el JSON (excluye thoughts, conforme al contrato).
      completionTokens: usage?.candidatesTokenCount ?? 0,
      latencyMs: Math.round(performance.now() - startedAt),
      modelVersion: response.modelVersion || this.model,
    };

    return { metadata, telemetry };
  }

  /**
   * Diagnóstico de disponibilidad y conectividad con el proveedor de IA.
   * Un HTTP 200 con candidata confirma simultáneamente: servicio operativo,
   * credenciales válidas y cuota disponible; suficiente para circuit breakers.
   */
  public async ping(): Promise<boolean> {
    try {
      await this.withTimeout(
        this.client.models.generateContent({
          model: this.model,
          contents: [{ role: 'user', parts: [{ text: 'Diagnóstico de disponibilidad: responda OK.' }] }],
          config: this.buildGenerationConfig({ structured: false }),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /** Configuración de generación: JSON forzado + responseSchema cuando es extracción. */
  private buildGenerationConfig(mode: { structured: boolean }): GenerateContentConfig {
    const config: GenerateContentConfig = {
      temperature: this.temperature,
      ...(this.thinkingBudget !== undefined
        ? { thinkingConfig: { thinkingBudget: this.thinkingBudget } }
        : {}),
      ...(this.maxOutputTokens !== undefined ? { maxOutputTokens: this.maxOutputTokens } : {}),
    };
    if (mode.structured) {
      config.systemInstruction = SYSTEM_PROMPT_EXTRACCION_OFICIOS;
      config.responseMimeType = 'application/json';
      config.responseSchema = this.responseSchema;
    } else {
      config.maxOutputTokens = this.maxOutputTokens ?? 64;
    }
    return config;
  }

  /**
   * Ensambla el turno multimodal del usuario: contexto textual → páginas en orden →
   * directiva de cierre. Los hints viajan aquí (no en el system prompt) para mantener
   * el prompt estático y cacheable, y aportar el año de contexto y la pista de ingesta.
   */
  private buildContents(
    pages: ReadonlyArray<RenderedPageImage>,
    hints?: ExtractionHints
  ): Content[] {
    const imageParts: Part[] = pages.map((page) => ({
      inlineData: {
        data: toBase64(page.imageBuffer),
        mimeType: page.mimeType,
      },
    }));

    const contextLines: string[] = [
      `FUENTE DOCUMENTAL: ${pages.length} página(s) digitalizada(s) adjunta(s) en su orden natural (la página 1 es la carátula).`,
    ];
    if (hints?.contextYear !== undefined) {
      contextLines.push(
        `CONTEXTO TEMPORAL: el año calendario vigente del sistema es ${hints.contextYear}; ` +
          'úselo para expandir años de dos dígitos y completar fechas sin año visible.'
      );
    }
    if (hints?.defaultProcedencia !== undefined) {
      contextLines.push(
        `PISTA DE INGESTA: el canal de captura sugiere procedencia preliminar "${hints.defaultProcedencia}"; ` +
          'tómela como hipótesis inicial y confírmela o réfutela contra el membrete del emisor.'
      );
    }

    return [
      {
        role: 'user',
        parts: [
          { text: contextLines.join('\n') },
          ...imageParts,
          {
            text:
              'TAREA: aplique íntegramente el protocolo institucional y devuelva únicamente el objeto JSON MetadatosOficio.',
          },
        ],
      },
    ];
  }

  /**
   * Segunda capa de timeout: carrera de promesa que garantiza el rechazo tipado
   * INFERENCE_TIMEOUT aunque el proveedor o el SDK no propaguen el aborte del socket.
   */
  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => {
        reject(
          new GeminiExtractionError(
            'INFERENCE_TIMEOUT',
            `La inferencia excedió el límite de ${this.timeoutMs} ms sin respuesta del proveedor.`
          )
        );
      }, this.timeoutMs);
      timer.unref?.();
      operation.then(
        (value: T) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * Traduce errores de transporte del SDK al enum AIExtractionErrorCode:
   * cuota (429/RESOURCE_EXHAUSTED) → MODEL_RATE_LIMIT_EXCEEDED · red/timeout →
   * INFERENCE_TIMEOUT o AI_SERVICE_UNAVAILABLE · autenticación y 5xx →
   * AI_SERVICE_UNAVAILABLE · 4xx de payload → AI_SERVICE_UNAVAILABLE con detalle.
   */
  private mapTransportError(error: unknown, elapsedMs: number): GeminiExtractionError {
    const status = extractHttpStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    const errno = (error as NodeJS.ErrnoException).code ?? '';

    // 1) Cuota o límite de tasa (HTTP 429 / RESOURCE_EXHAUSTED).
    if (status === 429 || /RESOURCE_EXHAUSTED|rate ?limit|quota/i.test(message)) {
      return new GeminiExtractionError(
        'MODEL_RATE_LIMIT_EXCEEDED',
        `Cuota o límite de tasa del proveedor agotado (status=${status ?? 'desconocido'}). ` +
          'Estrategia sugerida: backoff exponencial gobernado por el orquestador.',
        { cause: error }
      );
    }

    // 2) Timeouts: 408, abortes del socket y errores de red de expiración.
    if (
      status === 408 ||
      (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
      /ETIMEDOUT|ECONNABORTED|timed\s*out/i.test(`${errno} ${message}`)
    ) {
      return new GeminiExtractionError(
        'INFERENCE_TIMEOUT',
        `La llamada al modelo no completó en ${Math.round(elapsedMs)} ms (status=${status ?? 'red'}).`,
        { cause: error }
      );
    }

    // 3) Indisponibilidad del servicio y fallos de red de conectividad.
    if (
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed/i.test(`${message} ${errno}`)
    ) {
      return new GeminiExtractionError(
        'AI_SERVICE_UNAVAILABLE',
        `El servicio de inferencia no está disponible o la red institucional falló (status=${status ?? 'red'}).`,
        { cause: error }
      );
    }

    // 4) Credenciales rechazadas (la API Key es un problema de configuración del puerto).
    if (status === 401 || status === 403) {
      return new GeminiExtractionError(
        'AI_SERVICE_UNAVAILABLE',
        `Credenciales rechazadas por el proveedor (status=${status}). Verifique GEMINI_API_KEY.`,
        { cause: error }
      );
    }

    // 5) Solicitud malformada (responseSchema o imágenes inline inválidas).
    if (status === 400 || status === 422) {
      return new GeminiExtractionError(
        'AI_SERVICE_UNAVAILABLE',
        `El proveedor rechazó la solicitud por argumentos inválidos (status=${status}): revise responseSchema y las imágenes inline. ${message}`,
        { cause: error }
      );
    }

    // 6) Fallo no clasificado: degradación controlada con trazabilidad del origen.
    return new GeminiExtractionError(
      'AI_SERVICE_UNAVAILABLE',
      `Fallo no clasificado durante el transporte hacia el motor de inferencia: ${message}`,
      { cause: error }
    );
  }
}
