/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Sincronización con Google Sheets API v4
 * Implementación PENDIENTE del puerto secundario IExternalSyncProvider.
 *
 * Versión: 1.0.0-MVP (placeholder de composition root)
 *
 * ⚠️ Igual que `PlaywrightRpaInjectionAdapter`: se provee para satisfacer la Inyección
 * de Dependencias del orquestador en `server.ts`. La integración real requiere una
 * Service Account de Google Cloud (credenciales `.env`, `chmod 600` por prd.md §5.3) y
 * el ID de la hoja de cálculo del Tablero de Control DSA, fuera del alcance de esta
 * tarea. El orquestador ya trata un fallo de `appendDocumentRow` como no bloqueante
 * (captura la excepción y persiste `errorSincronizacion` sin abortar el pipeline), por
 * lo que este stub es seguro de usar en desarrollo: el documento se completa igual y
 * queda marcado como pendiente de sincronizar.
 */

import type {
  DocumentSyncPayload,
  ExternalSyncError,
  ExternalSyncErrorCode,
  IExternalSyncProvider,
} from '../../contracts/IExternalSyncProvider';
import type { GoogleSheetsSync, RpaEjecucion } from '../../contracts/types';

export class ExternalSyncNotConfiguredError extends Error implements ExternalSyncError {
  public readonly code: ExternalSyncErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'ExternalSyncNotConfiguredError';
    this.code = 'EXTERNAL_SERVICE_UNAVAILABLE';
  }
}

export class GoogleSheetsExternalSyncAdapter implements IExternalSyncProvider {
  async appendDocumentRow(payload: DocumentSyncPayload): Promise<Readonly<GoogleSheetsSync>> {
    throw new ExternalSyncNotConfiguredError(
      `Google Sheets API no está configurada (falta credencial de Service Account). Documento pendiente: ${payload.documentId}.`
    );
  }

  async updateRowRpaStatus(_rowIndex: number, _rpaData: Readonly<RpaEjecucion>): Promise<Readonly<GoogleSheetsSync>> {
    throw new ExternalSyncNotConfiguredError('Google Sheets API no está configurada.');
  }

  async appendBatchRows(payloads: ReadonlyArray<DocumentSyncPayload>): Promise<ReadonlyArray<GoogleSheetsSync>> {
    return Promise.all(payloads.map((payload) => this.appendDocumentRow(payload)));
  }

  async checkConnection(): Promise<boolean> {
    return false;
  }
}
