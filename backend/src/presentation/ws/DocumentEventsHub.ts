/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Hub de difusión WebSocket del avance del DocumentWorkflowOrchestrator
 * Versión: 1.0.0-MVP
 *
 * Implementa `WorkflowEventsListener` (capa de aplicación) y lo traduce al protocolo
 * `DocumentServerEvent` (capa de presentación), retransmitiéndolo a todos los sockets
 * activos. El orquestador nunca importa Fastify ni `ws`: solo conoce la interfaz
 * `WorkflowEventsListener`, preservando la regla de dependencia de Clean Architecture
 * (las capas internas no dependen de las externas).
 */

import type { WebSocket } from 'ws';

import type { WorkflowEventsListener } from '../../application/DocumentWorkflowOrchestrator';
import type { DocumentoEstado, DocumentoRegistro } from '../../contracts/types';
import { HITL_READY_STATES, type DocumentServerEvent } from './events';

const HEARTBEAT_INTERVAL_MS = 25_000;

export class DocumentEventsHub implements WorkflowEventsListener {
  private readonly sockets = new Set<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  register(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.broadcast({ type: 'HEARTBEAT', ts: new Date().toISOString() }), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    }
  }

  onDocumentEvent(documentId: string, estado: DocumentoEstado, document?: Readonly<DocumentoRegistro>): void {
    this.broadcast({ type: 'DOCUMENT_STATE_CHANGED', documentId, estado, document: document as DocumentoRegistro | undefined });

    if (HITL_READY_STATES.has(estado) && document) {
      this.broadcast({ type: 'NEW_DOCUMENT_PENDING', documentId, document: document as DocumentoRegistro });
    }
    if (estado === 'COMPLETADO' && document?.rpa) {
      this.broadcast({
        type: 'RPA_COMPLETED',
        documentId,
        folioAcuseInstitucional: document.rpa.folioAcuseInstitucional,
      });
    }
  }

  onPipelineError(documentId: string, code: string, message: string): void {
    this.broadcast({ type: 'PIPELINE_ERROR', documentId, code, message });
  }

  private broadcast(event: DocumentServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}
