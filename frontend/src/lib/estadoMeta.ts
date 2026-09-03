/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Metadata visual de `DocumentoEstado`: única fuente de verdad para etiqueta, color de
 * badge y grupo de bandeja — evita repetir mapeos de estado en la lista, el detalle y
 * los filtros.
 */

import type { DocumentoEstado } from './types';

export interface EstadoMeta {
  label: string;
  /** Clases Tailwind del badge (fondo + texto), tono suave conforme al resto de la UI. */
  badgeClass: string;
  /** Color sólido para puntos/indicadores pequeños. */
  dotClass: string;
}

const ESTADO_META: Record<DocumentoEstado, EstadoMeta> = {
  PENDIENTE_PREPROCESO: { label: 'En cola', badgeClass: 'bg-slate-100 text-slate-600', dotClass: 'bg-slate-400' },
  EN_PREPROCESO: { label: 'Preprocesando', badgeClass: 'bg-sky-50 text-sky-700', dotClass: 'bg-sky-500' },
  PENDIENTE_EXTRACCION: { label: 'En cola de IA', badgeClass: 'bg-slate-100 text-slate-600', dotClass: 'bg-slate-400' },
  EN_EXTRACCION: { label: 'Extrayendo datos', badgeClass: 'bg-sky-50 text-sky-700', dotClass: 'bg-sky-500' },
  PENDIENTE_REVISION: { label: 'Por revisar', badgeClass: 'bg-amber-50 text-amber-700', dotClass: 'bg-amber-500' },
  EN_REVISION: { label: 'En revisión', badgeClass: 'bg-amber-50 text-amber-700', dotClass: 'bg-amber-500' },
  APROBADO_HITL: { label: 'Aprobado', badgeClass: 'bg-brand-50 text-brand-700', dotClass: 'bg-brand-500' },
  EN_RPA: { label: 'Registrando en Intranet', badgeClass: 'bg-brand-50 text-brand-700', dotClass: 'bg-brand-500' },
  COMPLETADO: { label: 'Completado', badgeClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
  ERROR_PREPROCESO: { label: 'Error de preproceso', badgeClass: 'bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
  ERROR_EXTRACCION: { label: 'Error de extracción', badgeClass: 'bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
  ERROR_RPA: { label: 'Error al registrar', badgeClass: 'bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
};

export function estadoMeta(estado: DocumentoEstado): EstadoMeta {
  return ESTADO_META[estado];
}

/** Grupos de la bandeja: cada pestaña filtra por uno o varios `DocumentoEstado`. */
export interface BandejaGrupo {
  id: string;
  label: string;
  /** `undefined` => sin filtro de estado (todos los documentos). */
  estados?: DocumentoEstado[];
}

export const BANDEJA_GRUPOS: readonly BandejaGrupo[] = [
  { id: 'pendientes', label: 'Por revisar', estados: ['PENDIENTE_REVISION', 'EN_REVISION'] },
  {
    id: 'en-proceso',
    label: 'En proceso',
    estados: [
      'PENDIENTE_PREPROCESO',
      'EN_PREPROCESO',
      'PENDIENTE_EXTRACCION',
      'EN_EXTRACCION',
      'APROBADO_HITL',
      'EN_RPA',
    ],
  },
  { id: 'errores', label: 'Con errores', estados: ['ERROR_PREPROCESO', 'ERROR_EXTRACCION', 'ERROR_RPA'] },
  { id: 'completados', label: 'Completados', estados: ['COMPLETADO'] },
  { id: 'todos', label: 'Todos' },
];

const RTF = new Intl.RelativeTimeFormat('es-MX', { numeric: 'auto' });

/** Fecha relativa corta ("hace 5 min", "hace 2 h") para listas densas; cae a fecha corta si es vieja. */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return 'justo ahora';
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 6) return RTF.format(Math.round(diffSec / 86400), 'day');

  return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
