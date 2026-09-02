/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Contrato de Eventos WebSocket (Servidor → Cliente)
 * Versión: 1.0.0-MVP
 *
 * Único canal: `GET /ws/documents` (upgrade). Todo evento lleva `documentId` para que
 * el cliente filtre localmente (bandeja global vs. documento abierto en el Split-Screen).
 * Este archivo es la fuente de verdad del protocolo; el cliente Svelte 5
 * (`frontend/src/lib/ws/documentSocket.ts`) mantiene una copia estructural equivalente
 * porque no existe todavía un paquete compartido en el monorepo.
 */

import type { DocumentoEstado, DocumentoRegistro } from '../../contracts/types';

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
  | NewDocumentPendingEvent
  | DocumentStateChangedEvent
  | PipelineErrorEvent
  | RpaCompletedEvent
  | HeartbeatEvent;

/** Estados que, al alcanzarse, se retransmiten también como NEW_DOCUMENT_PENDING. */
export const HITL_READY_STATES: ReadonlySet<DocumentoEstado> = new Set<DocumentoEstado>(['PENDIENTE_REVISION']);
