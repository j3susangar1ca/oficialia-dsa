/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Esquema Zod de `MetadatosOficio` (validación reactiva del panel derecho del Split-Screen)
 * Versión: 1.0.0-MVP
 *
 * Copia estructural de `backend/src/contracts/schemas/metadatosOficio.schema.ts` — ver la
 * nota de `../types.ts` sobre por qué no hay un import compartido todavía. Las mismas
 * reglas de negocio (folio sanitizado, mayúsculas, plazoDias no-negativo) deben permanecer
 * sincronizadas en ambos lados: el backend es la autoridad final (nunca confiar solo en
 * la validación de cliente), pero duplicarla aquí permite calcular `formValid` sin una
 * ida y vuelta de red por cada tecla.
 */

import { z } from 'zod';

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

export type MetadatosOficioDraft = z.input<typeof MetadatosOficioSchema>;
