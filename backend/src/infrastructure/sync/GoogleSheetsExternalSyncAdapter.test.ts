/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Suite de pruebas para GoogleSheetsExternalSyncAdapter
 * Runner: Vitest — mockea el módulo `googleapis` completo (nunca golpea la red real).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { valuesAppendMock, valuesUpdateMock, spreadsheetsGetMock, getClientMock, googleAuthCtorMock } = vi.hoisted(
  () => ({
    valuesAppendMock: vi.fn(),
    valuesUpdateMock: vi.fn(),
    spreadsheetsGetMock: vi.fn(),
    getClientMock: vi.fn(),
    googleAuthCtorMock: vi.fn(),
  })
);

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: googleAuthCtorMock.mockImplementation(() => ({ getClient: getClientMock })),
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        get: spreadsheetsGetMock,
        values: {
          append: valuesAppendMock,
          update: valuesUpdateMock,
        },
      },
    }),
  },
}));

import {
  ExternalSyncNotConfiguredError,
  GoogleSheetsApiError,
  GoogleSheetsExternalSyncAdapter,
} from './GoogleSheetsExternalSyncAdapter';
import type { DocumentSyncPayload } from '../../contracts/IExternalSyncProvider';
import type { MetadatosOficio } from '../../contracts/types';

const metadata: MetadatosOficio = {
  numeroOficio: 'DSA-1042-2026',
  fechaEmision: '2026-09-01',
  procedencia: 'HCG',
  dependenciaArea: 'DIRECCIÓN GENERAL HCG',
  remitenteNombre: 'DR. JAIME AGUSTÍN GONZÁLEZ ÁLVAREZ',
  remitenteCargo: 'DIRECTOR GENERAL',
  destinatarioNombre: 'MTRO. LUIS ALBERTO PÉREZ GÓMEZ',
  destinatarioCargo: 'DIRECTOR DE SERVICIOS ADMINISTRATIVOS',
  asunto: 'SOLICITUD DE DICTAMEN TÉCNICO.',
  plazoDias: 5,
  contieneDatosSensibles: false,
};

const payload: DocumentSyncPayload = {
  documentId: 'doc-1',
  canonicalFileName: '2026-09-01__DSA-1042-2026__DIR-GRAL-HCG.pdf',
  metadata,
  rpaExecution: {
    id: 'rpa-1',
    documentoId: 'doc-1',
    folioAcuseInstitucional: 'HCG-OP-2026-009821',
    fechaEjecucion: '2026-09-01T14:35:10.120Z',
    duracionMs: 4150,
    capturaAcusePath: null,
    intentos: 1,
    mensajeError: null,
    exitoso: true,
  },
  timestamp: '2026-09-01T14:35:12.800Z',
};

describe('GoogleSheetsExternalSyncAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClientMock.mockResolvedValue({});
  });

  describe('sin GOOGLE_SHEETS_SPREADSHEET_ID configurado', () => {
    it('appendDocumentRow lanza ExternalSyncNotConfiguredError sin intentar autenticar', async () => {
      const adapter = new GoogleSheetsExternalSyncAdapter();
      expect(adapter.configured).toBe(false);

      await expect(adapter.appendDocumentRow(payload)).rejects.toBeInstanceOf(ExternalSyncNotConfiguredError);
      expect(googleAuthCtorMock).not.toHaveBeenCalled();
      expect(valuesAppendMock).not.toHaveBeenCalled();
    });

    it('checkConnection devuelve false sin llamar a la API', async () => {
      const adapter = new GoogleSheetsExternalSyncAdapter();
      await expect(adapter.checkConnection()).resolves.toBe(false);
      expect(spreadsheetsGetMock).not.toHaveBeenCalled();
    });
  });

  describe('con spreadsheetId configurado', () => {
    it('appendDocumentRow arma la fila en el layout de columnas A:M y parsea filaIndex de updatedRange', async () => {
      valuesAppendMock.mockResolvedValue({ data: { updates: { updatedRange: 'Hoja1!A143:M143' } } });

      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });
      const result = await adapter.appendDocumentRow(payload);

      expect(valuesAppendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spreadsheetId: 'sheet-123',
          range: 'Hoja1!A:M',
          requestBody: {
            values: [
              [
                payload.timestamp,
                payload.documentId,
                metadata.numeroOficio,
                metadata.fechaEmision,
                metadata.procedencia,
                metadata.dependenciaArea,
                metadata.remitenteNombre,
                metadata.asunto,
                metadata.plazoDias,
                metadata.contieneDatosSensibles,
                payload.canonicalFileName,
                'HCG-OP-2026-009821',
                true,
              ],
            ],
          },
        })
      );
      expect(result).toEqual({
        sincronizado: true,
        filaIndex: 143,
        timestampSincronizacion: expect.any(String),
        errorSincronizacion: null,
      });
    });

    it('respeta sheetName personalizado', async () => {
      valuesAppendMock.mockResolvedValue({ data: { updates: { updatedRange: 'ControlDSA!A2:M2' } } });
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123', sheetName: 'ControlDSA' });

      await adapter.appendDocumentRow(payload);

      expect(valuesAppendMock).toHaveBeenCalledWith(expect.objectContaining({ range: 'ControlDSA!A:M' }));
    });

    it('updateRowRpaStatus escribe solo las columnas L:M', async () => {
      valuesUpdateMock.mockResolvedValue({ data: {} });
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });

      const result = await adapter.updateRowRpaStatus(143, payload.rpaExecution!);

      expect(valuesUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          spreadsheetId: 'sheet-123',
          range: 'Hoja1!L143:M143',
          requestBody: { values: [['HCG-OP-2026-009821', true]] },
        })
      );
      expect(result.filaIndex).toBe(143);
    });

    it('updateRowRpaStatus rechaza índices de fila inválidos sin llamar a la API', async () => {
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });
      await expect(adapter.updateRowRpaStatus(0, payload.rpaExecution!)).rejects.toBeInstanceOf(GoogleSheetsApiError);
      expect(valuesUpdateMock).not.toHaveBeenCalled();
    });

    it('appendBatchRows hace una sola llamada HTTP y deriva índices consecutivos', async () => {
      valuesAppendMock.mockResolvedValue({ data: { updates: { updatedRange: 'Hoja1!A10:M12' } } });
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });

      const payloads = [payload, { ...payload, documentId: 'doc-2' }, { ...payload, documentId: 'doc-3' }];
      const results = await adapter.appendBatchRows(payloads);

      expect(valuesAppendMock).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.filaIndex)).toEqual([10, 11, 12]);
    });

    it('appendBatchRows con lista vacía no llama a la API', async () => {
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });
      await expect(adapter.appendBatchRows([])).resolves.toEqual([]);
      expect(valuesAppendMock).not.toHaveBeenCalled();
    });

    it('checkConnection true cuando spreadsheets.get resuelve', async () => {
      spreadsheetsGetMock.mockResolvedValue({ data: { spreadsheetId: 'sheet-123' } });
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });
      await expect(adapter.checkConnection()).resolves.toBe(true);
    });

    it('checkConnection false cuando spreadsheets.get lanza', async () => {
      spreadsheetsGetMock.mockRejectedValue(new Error('network down'));
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });
      await expect(adapter.checkConnection()).resolves.toBe(false);
    });

    it('usa GOOGLE_SERVICE_ACCOUNT_JSON como credenciales explícitas cuando se provee', async () => {
      valuesAppendMock.mockResolvedValue({ data: { updates: { updatedRange: 'Hoja1!A2:M2' } } });
      const serviceAccountJson = JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: 'x' });

      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123', serviceAccountJson });
      await adapter.appendDocumentRow(payload);

      expect(googleAuthCtorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: 'x' },
        })
      );
    });

    // ------------------------------------------------------------------
    // Mapeo de errores de la API (mapGoogleApiError)
    // ------------------------------------------------------------------

    it.each([
      [{ code: 429 }, 'RATE_LIMIT_QUOTA_EXCEEDED'],
      [{ code: 404 }, 'SPREADSHEET_NOT_FOUND'],
      [{ code: 403 }, 'GOOGLE_AUTH_FAILED'],
      [{ code: 500 }, 'APPEND_ROW_FAILED'],
    ] as const)('mapea un error HTTP %j a %s', async (errorShape, expectedCode) => {
      valuesAppendMock.mockRejectedValue(Object.assign(new Error('fallo simulado'), errorShape));
      const adapter = new GoogleSheetsExternalSyncAdapter({ spreadsheetId: 'sheet-123' });

      const caught: GoogleSheetsApiError = await adapter.appendDocumentRow(payload).catch((e) => e);
      expect(caught).toBeInstanceOf(GoogleSheetsApiError);
      expect(caught.code).toBe(expectedCode);
      expect(caught.spreadsheetId).toBe('sheet-123');
    });
  });
});
