/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Esquema Zod de MetadatosOficio (forma de dominio, camelCase)
 * Versión: 1.0.0-MVP
 *
 * Esta es la fuente única de verdad para validar `MetadatosOficio` tanto en el
 * backend (endpoint POST /:id/confirm) como en el cliente Svelte 5 (validación
 * reactiva del formulario HITL antes de habilitar "Confirmar y Registrar").
 *
 * Nota de diseño: `prd.md` documenta un esquema Zod de referencia para la
 * extracción cruda de Gemini en snake_case (numero_oficio, fecha_emision, …),
 * consumido internamente por `GeminiAIExtractorAdapter`. Ese esquema describe
 * el contrato de *transporte* con el LLM. Este archivo, en cambio, valida la
 * forma de *dominio* (`MetadatosOficio` de `../types`, camelCase) que circula
 * por el resto del sistema (repositorio, orquestador, rutas HTTP y UI) una vez
 * mapeados los campos. Mantener ambos esquemas sincronizados en las reglas de
 * negocio (sanitización de folio, mayúsculas, plazoDias no-negativo, etc.) es
 * responsabilidad del adaptador de IA.
 */

import { z } from 'zod';

/** Caracteres reservados de un sistema de archivos, no permitidos en el folio. */
const FOLIO_RESERVED_CHARS_RE = /[\/\\:*?"<>|]/g;

export const ProcedenciaSchema = z.enum(['HCG', 'Ajena']);

export const MetadatosOficioSchema = z.object({
  numeroOficio: z
    .string()
    .trim()
    .min(1, 'El número de oficio es obligatorio (usar "S/N" si el documento carece de folio)')
    .transform((val) => val.replace(FOLIO_RESERVED_CHARS_RE, '-')),

  fechaEmision: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha requerido: YYYY-MM-DD')
    .refine((val) => !Number.isNaN(Date.parse(val)), 'La fecha de emisión no es una fecha calendario válida'),

  procedencia: ProcedenciaSchema,

  dependenciaArea: z
    .string()
    .trim()
    .min(1, 'Debe especificarse el área o dependencia emisora')
    .transform((val) => val.toUpperCase()),

  remitenteNombre: z
    .string()
    .trim()
    .min(1, 'Nombre del suscriptor o firmante')
    .transform((val) => val.toUpperCase()),

  remitenteCargo: z
    .string()
    .trim()
    .default('NO ESPECIFICADO')
    .transform((val) => (val.length > 0 ? val.toUpperCase() : 'NO ESPECIFICADO')),

  destinatarioNombre: z
    .string()
    .trim()
    .min(1, 'Nombre del funcionario destinatario')
    .transform((val) => val.toUpperCase()),

  destinatarioCargo: z
    .string()
    .trim()
    .default('NO ESPECIFICADO')
    .transform((val) => (val.length > 0 ? val.toUpperCase() : 'NO ESPECIFICADO')),

  asunto: z
    .string()
    .trim()
    .min(5, 'Síntesis del oficio (1 a 3 oraciones)')
    .transform((val) => val.replace(/[\r\n]+/g, ' ').trim()),

  plazoDias: z.number().int().nonnegative().nullable().default(null),

  contieneDatosSensibles: z.boolean().default(false),
});

/** Tipo inferido — debe permanecer estructuralmente compatible con `MetadatosOficio` de `../types`. */
export type MetadatosOficioInput = z.input<typeof MetadatosOficioSchema>;
export type MetadatosOficioParsed = z.output<typeof MetadatosOficioSchema>;

/**
 * Variante de solo-SALIDA de `MetadatosOficioSchema`, sin `.transform()`.
 *
 * `fastify-type-provider-zod` usa el mismo schema Zod tanto para validar el
 * request como para serializar el reply. Zod v4 trata cada `.transform()` como
 * unidireccional (no hay forma de "deshacerlo"), así que si `MetadatosOficioSchema`
 * se reutiliza en un `response` schema, Fastify intenta `encode()` (el parse
 * inverso) sobre datos que YA vienen normalizados desde el dominio, y Zod lanza
 * `ZodEncodeError: Encountered unidirectional transform during encode`.
 *
 * Esta variante repite las mismas restricciones de forma (para no perder
 * cobertura de tipos en el reply) pero sin los `.transform()`/`.default()` que
 * solo tienen sentido al validar *entrada* — los valores ya están saneados
 * (folio sin caracteres reservados, mayúsculas, etc.) para cuando llegan aquí.
 */
export const MetadatosOficioOutputSchema = z.object({
  numeroOficio: z.string(),
  fechaEmision: z.string(),
  procedencia: ProcedenciaSchema,
  dependenciaArea: z.string(),
  remitenteNombre: z.string(),
  remitenteCargo: z.string(),
  destinatarioNombre: z.string(),
  destinatarioCargo: z.string(),
  asunto: z.string(),
  plazoDias: z.number().int().nonnegative().nullable(),
  contieneDatosSensibles: z.boolean(),
});
