/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Cliente WebSocket de bajo nivel para `GET /ws/documents`
 * Versión: 1.0.0-MVP
 *
 * Clase TS plana (sin runes): encapsula reconexión con backoff exponencial + jitter y
 * el parseo/validación de `DocumentServerEvent`. `documentState.svelte.ts` la envuelve
 * dentro de un `$effect` para atar su ciclo de vida al del componente — esta clase en sí
 * no depende de Svelte, por lo que es trivialmente testeable de forma aislada.
 */

import { isDocumentServerEvent, type DocumentServerEvent } from './events';

export type DocumentSocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface DocumentSocketOptions {
  /** URL completa del endpoint WS, ej. `ws://localhost:3000/ws/documents`. */
  url: string;
  onEvent: (event: DocumentServerEvent) => void;
  onStatusChange?: (status: DocumentSocketStatus) => void;
  /** Retardo base del backoff exponencial en ms (por defecto 1000). */
  baseBackoffMs?: number;
  /** Techo del backoff exponencial en ms (por defecto 30000). */
  maxBackoffMs?: number;
}

export class DocumentSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByClient = false;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: DocumentSocketOptions) {
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  connect(): void {
    this.closedByClient = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closedByClient = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private openSocket(): void {
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.options.url);
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setStatus('open');
    });

    socket.addEventListener('message', (evt: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return; // mensaje corrupto: se ignora, no se rompe la conexión
      }
      if (isDocumentServerEvent(parsed)) {
        // El mapeo de PIPELINE_ERROR a estado de UI es responsabilidad del consumidor
        // (documentState.svelte.ts); aquí solo se garantiza la forma del evento.
        this.options.onEvent(parsed);
      }
    });

    socket.addEventListener('close', () => {
      this.ws = null;
      if (this.closedByClient) return;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' se dispara justo después de 'error' en la mayoría de los navegadores;
      // la reconexión se programa ahí para no duplicar el temporizador.
    });
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const exponential = this.baseBackoffMs * 2 ** this.reconnectAttempt;
    const withJitter = Math.min(exponential, this.maxBackoffMs) * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByClient) this.openSocket();
    }, withJitter);
  }

  private setStatus(status: DocumentSocketStatus): void {
    this.options.onStatusChange?.(status);
  }
}
