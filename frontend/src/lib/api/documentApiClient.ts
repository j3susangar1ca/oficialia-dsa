/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Cliente HTTP hacia `document.routes.ts`
 * Versión: 1.0.0-MVP
 *
 * Capa fina sobre `fetch`, inyectada en `DocumentHitlState` por constructor (mismo
 * principio de Inyección de Dependencias que el backend): el store de runes nunca
 * construye URLs ni llama a `fetch` directamente, lo que permite sustituir este cliente
 * por un doble de prueba sin tocar la lógica reactiva.
 */

import type { MetadatosOficioDraft } from '../schemas/metadatosOficio.schema';
import type { DocumentoEstado, DocumentoRegistro, RelatedDocumentsResult } from '../types';

export class DocumentApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'DocumentApiError';
  }
}

export interface DocumentApiClientOptions {
  /** Origen HTTP del backend, ej. `http://localhost:3000` (sin slash final). */
  baseUrl: string;
}

async function parseErrorBody(response: Response): Promise<{ error: string; code?: string }> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return { error: body.error ?? response.statusText, code: body.code };
  } catch {
    return { error: response.statusText };
  }
}

export class DocumentApiClient {
  constructor(private readonly options: DocumentApiClientOptions) {}

  /** URL del endpoint WebSocket derivada del mismo origen HTTP configurado. */
  get wsUrl(): string {
    return `${this.options.baseUrl.replace(/^http/, 'ws')}/ws/documents`;
  }

  fileUrl(documentId: string): string {
    return `${this.options.baseUrl}/documents/${documentId}/file`;
  }

  async getDocument(documentId: string): Promise<DocumentoRegistro> {
    const response = await fetch(`${this.options.baseUrl}/documents/${documentId}`);
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as DocumentoRegistro;
  }

  /**
   * Bandeja de trabajo. Sin `estado`/`estados`, devuelve todos los documentos (hasta
   * `limit`) — usado por la pestaña "Todos" y por los grupos de `estadoMeta.ts`
   * (`BANDEJA_GRUPOS`), que filtran por uno o varios `DocumentoEstado` a la vez.
   */
  async listDocuments(params?: {
    estado?: DocumentoEstado;
    estados?: DocumentoEstado[];
    limit?: number;
    offset?: number;
  }): Promise<DocumentoRegistro[]> {
    const query = new URLSearchParams();
    if (params?.estado) query.set('estado', params.estado);
    if (params?.estados?.length) query.set('estados', params.estados.join(','));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';

    const response = await fetch(`${this.options.baseUrl}/documents${suffix}`);
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as DocumentoRegistro[];
  }

  async uploadDocument(file: File, origen: 'SCANNER_ADF' | 'WEB_DRAG_DROP' = 'WEB_DRAG_DROP'): Promise<{ documentId: string }> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await fetch(`${this.options.baseUrl}/documents/upload?origen=${origen}`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as { documentId: string };
  }

  async confirmDocument(
    documentId: string,
    payload: { metadata: MetadatosOficioDraft; userId: string; expectedVersion: number }
  ): Promise<DocumentoRegistro> {
    const response = await fetch(`${this.options.baseUrl}/documents/${documentId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as DocumentoRegistro;
  }

  /**
   * Oficios relacionados por similitud semántica (Puerto 7, `ILocalSemanticProvider`,
   * P1 — ver `docs/prd.md` §2.2). Nunca falla por "modelo no listo": el backend degrada
   * a `documentos: []` con `modeloEstado` reflejando el estado real.
   */
  async getRelatedDocuments(
    documentId: string,
    options?: { limite?: number; umbralVinculacion?: number }
  ): Promise<RelatedDocumentsResult> {
    const query = new URLSearchParams();
    if (options?.limite !== undefined) query.set('limite', String(options.limite));
    if (options?.umbralVinculacion !== undefined) query.set('umbralVinculacion', String(options.umbralVinculacion));
    const suffix = query.toString() ? `?${query.toString()}` : '';

    const response = await fetch(`${this.options.baseUrl}/documents/${documentId}/related${suffix}`);
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as RelatedDocumentsResult;
  }

  async retryRpa(documentId: string, expectedVersion: number): Promise<DocumentoRegistro> {
    const response = await fetch(`${this.options.baseUrl}/documents/${documentId}/retry-rpa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion }),
    });
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as DocumentoRegistro;
  }

  /** Reintenta render + extracción IA para un documento en ERROR_EXTRACCION (p. ej. timeout de Gemini). */
  async retryExtraction(documentId: string, expectedVersion: number): Promise<DocumentoRegistro> {
    const response = await fetch(`${this.options.baseUrl}/documents/${documentId}/retry-extraction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion }),
    });
    if (!response.ok) {
      const { error, code } = await parseErrorBody(response);
      throw new DocumentApiError(error, response.status, code);
    }
    return (await response.json()) as DocumentoRegistro;
  }
}
