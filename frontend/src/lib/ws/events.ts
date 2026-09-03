/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Copia estructural de `backend/src/presentation/ws/events.ts`. Ver nota en `../types.ts`.
 */

import type { DocumentoEstado, DocumentoRegistro } from '../types';

export interface NewDocumentPendingEvent {
  type: 'NEW_DOCUMENT_PENDING';
  documentId: string;
  document: DocumentoRegistro;
}

export interface DocumentStateChangedEvent {
  type: 'DOCUMENT_STATE_CHANGED';
  documentId: string;
  estado: DocumentoEstado;
  document?: DocumentoRegistro;
}

export interface PipelineErrorEvent {
  type: 'PIPELINE_ERROR';
  documentId: string;
  code: string;
  message: string;
}

export interface RpaCompletedEvent {
  type: 'RPA_COMPLETED';
  documentId: string;
  folioAcuseInstitucional: string | null;
}

export interface HeartbeatEvent {
  type: 'HEARTBEAT';
  ts: string;
}

export type DocumentServerEvent =
  NewDocumentPendingEvent | DocumentStateChangedEvent | PipelineErrorEvent | RpaCompletedEvent | HeartbeatEvent;

/** Type guard mínimo: valida forma antes de castear un mensaje WS crudo. */
export function isDocumentServerEvent(value: unknown): value is DocumentServerEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}
