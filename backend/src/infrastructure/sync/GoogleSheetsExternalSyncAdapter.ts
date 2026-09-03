/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Sincronización con Google Sheets API v4
 * Implementación del puerto secundario IExternalSyncProvider.
 *
 * Versión: 2.0.0
 *
 * Reemplaza el placeholder que siempre lanzaba ExternalSyncNotConfiguredError. Esta
 * implementación es real (googleapis + Service Account) pero se entrega SIN
 * credenciales configuradas — requiere que quien despliegue el sistema agregue:
 *   - GOOGLE_SHEETS_SPREADSHEET_ID (.env)
 *   - Credenciales de la Service Account, por CUALQUIERA de estas dos vías:
 *       a) GOOGLE_SERVICE_ACCOUNT_JSON — el JSON completo de la key, como string,
 *          en una sola línea (.env).
 *       b) GOOGLE_APPLICATION_CREDENTIALS — ruta a un archivo .json en disco
 *          (variable de entorno estándar de Application Default Credentials que
 *          `google-auth-library` lee sola; no se referencia aquí).
 * Sin `GOOGLE_SHEETS_SPREADSHEET_ID`, `configured` queda en `false` y todos los métodos
 * de escritura lanzan `ExternalSyncNotConfiguredError` (mismo comportamiento honesto que
 * el placeholder anterior) — el orquestador ya trata un fallo de `appendDocumentRow`
 * como no bloqueante (captura la excepción y persiste `errorSincronizacion` sin abortar
 * el pipeline), así que el sistema funciona igual en desarrollo sin credenciales.
 *
 * Layout de columnas del tablero (fila 1 = encabezados, no gestionados aquí):
 *   A: Fecha registro   B: ID documento     C: Folio oficio      D: Fecha emisión
 *   E: Procedencia      F: Dependencia/Área G: Remitente         H: Asunto
 *   I: Plazo (días)     J: Datos sensibles  K: Archivo canónico
 *   L: Folio acuse RPA  M: RPA exitoso
 */

import { google, type sheets_v4 } from 'googleapis';

import type {
  DocumentSyncPayload,
  ExternalSyncError,
  ExternalSyncErrorCode,
  IExternalSyncProvider,
} from '../../contracts/IExternalSyncProvider';
import type { GoogleSheetsSync, RpaEjecucion } from '../../contracts/types';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
/** Rango usado para localizar la pestaña al hacer append; A:M cubre las 13 columnas del layout de arriba. */
const APPEND_RANGE_SUFFIX = 'A:M';

export class ExternalSyncNotConfiguredError extends Error implements ExternalSyncError {
  public readonly code: ExternalSyncErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'ExternalSyncNotConfiguredError';
    this.code = 'EXTERNAL_SERVICE_UNAVAILABLE';
  }
}

export class GoogleSheetsApiError extends Error implements ExternalSyncError {
  public readonly code: ExternalSyncErrorCode;
  public readonly spreadsheetId?: string;
  public readonly rowAttempted?: number;

  constructor(
    code: ExternalSyncErrorCode,
    message: string,
    attrs: { spreadsheetId?: string; rowAttempted?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: attrs.cause });
    this.name = 'GoogleSheetsApiError';
    this.code = code;
    this.spreadsheetId = attrs.spreadsheetId;
    this.rowAttempted = attrs.rowAttempted;
  }
}

export interface GoogleSheetsExternalSyncAdapterOptions {
  /** ID de la hoja de cálculo (segmento entre /d/ y /edit en la URL de Google Sheets). */
  spreadsheetId?: string;
  /** Nombre de la pestaña destino dentro de la hoja (default "Hoja1"). */
  sheetName?: string;
  /**
   * JSON completo de la Service Account (contenido del archivo de credenciales), como
   * string — alternativa a `GOOGLE_APPLICATION_CREDENTIALS` cuando no es práctico dejar
   * el .json en disco (p. ej. inyectado por un secret manager como variable de entorno).
   */
  serviceAccountJson?: string;
}

function normalizeSheetRow(payload: DocumentSyncPayload): unknown[] {
  const { metadata, rpaExecution } = payload;
  return [
    payload.timestamp,
    payload.documentId,
    metadata.numeroOficio,
    metadata.fechaEmision,
    metadata.procedencia,
    metadata.dependenciaArea,
    metadata.remitenteNombre,
    metadata.asunto,
    metadata.plazoDias ?? '',
    metadata.contieneDatosSensibles,
    payload.canonicalFileName,
    rpaExecution?.folioAcuseInstitucional ?? '',
    rpaExecution?.exitoso ?? '',
  ];
}

/** Traduce un error de la API de Google (googleapis lanza objetos con `.code`/`.status` HTTP) a ExternalSyncErrorCode. */
function mapGoogleApiError(cause: unknown, spreadsheetId: string, rowAttempted?: number): GoogleSheetsApiError {
  const httpStatus =
    (cause as { code?: number; status?: number; response?: { status?: number } })?.code ??
    (cause as { response?: { status?: number } })?.response?.status;
  const message = cause instanceof Error ? cause.message : String(cause);

  if (httpStatus === 401 || httpStatus === 403 || /invalid_grant|permission/i.test(message)) {
    return new GoogleSheetsApiError('GOOGLE_AUTH_FAILED', `Autenticación con Google fallida: ${message}`, {
      spreadsheetId,
      rowAttempted,
      cause,
    });
  }
  if (httpStatus === 404) {
    return new GoogleSheetsApiError(
      'SPREADSHEET_NOT_FOUND',
      `Hoja de cálculo no encontrada (${spreadsheetId}): ${message}`,
      {
        spreadsheetId,
        rowAttempted,
        cause,
      }
    );
  }
  if (httpStatus === 429) {
    return new GoogleSheetsApiError('RATE_LIMIT_QUOTA_EXCEEDED', `Cuota de Google Sheets API excedida: ${message}`, {
      spreadsheetId,
      rowAttempted,
      cause,
    });
  }
  if (/unable to parse range|not found/i.test(message)) {
    return new GoogleSheetsApiError('WORKSHEET_TAB_NOT_FOUND', `Pestaña de la hoja no encontrada: ${message}`, {
      spreadsheetId,
      rowAttempted,
      cause,
    });
  }
  return new GoogleSheetsApiError('APPEND_ROW_FAILED', `Fallo al escribir en Google Sheets: ${message}`, {
    spreadsheetId,
    rowAttempted,
    cause,
  });
}

/** Extrae el número de fila 1-indexed de un `updatedRange`/`tableRange` tipo `"Hoja1!A143:M143"`. */
function parseRowIndexFromRange(range: string | null | undefined): number | null {
  if (!range) return null;
  const match = range.match(/![A-Z]+(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

export class GoogleSheetsExternalSyncAdapter implements IExternalSyncProvider {
  private readonly spreadsheetId: string | undefined;
  private readonly sheetName: string;
  private readonly serviceAccountJson: string | undefined;
  private sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null;

  constructor(options: GoogleSheetsExternalSyncAdapterOptions = {}) {
    this.spreadsheetId = options.spreadsheetId?.trim() || undefined;
    this.sheetName = options.sheetName?.trim() || 'Hoja1';
    this.serviceAccountJson = options.serviceAccountJson?.trim() || undefined;
  }

  /** `false` sin GOOGLE_SHEETS_SPREADSHEET_ID — no tiene sentido intentar autenticar sin saber a qué hoja escribir. */
  get configured(): boolean {
    return this.spreadsheetId !== undefined;
  }

  /**
   * Cliente de la API v4, creado de forma perezosa (nunca al arrancar el servidor —
   * mismo patrón que `LocalSemanticMatcherAdapter`/`ILocalSemanticProvider`). Si
   * `serviceAccountJson` no se proveyó, `google.auth.GoogleAuth` intenta Application
   * Default Credentials (p. ej. `GOOGLE_APPLICATION_CREDENTIALS` apuntando a un
   * archivo), sin que este adaptador necesite leer esa variable directamente.
   */
  private getSheetsClient(): Promise<sheets_v4.Sheets> {
    if (!this.sheetsClientPromise) {
      this.sheetsClientPromise = (async () => {
        const auth = new google.auth.GoogleAuth({
          scopes: SCOPES,
          credentials: this.serviceAccountJson ? JSON.parse(this.serviceAccountJson) : undefined,
        });
        const authClient = await auth.getClient();
        return google.sheets({ version: 'v4', auth: authClient as never });
      })();
    }
    return this.sheetsClientPromise;
  }

  /** Lanza `ExternalSyncNotConfiguredError` si falta `spreadsheetId`; si no, lo devuelve ya no-nulo. */
  private requireSpreadsheetId(): string {
    if (!this.spreadsheetId) {
      throw new ExternalSyncNotConfiguredError(
        'Google Sheets no está configurado: falta GOOGLE_SHEETS_SPREADSHEET_ID en .env. ' +
          'Ver el docstring de GoogleSheetsExternalSyncAdapter para las credenciales requeridas.'
      );
    }
    return this.spreadsheetId;
  }

  async appendDocumentRow(payload: DocumentSyncPayload): Promise<Readonly<GoogleSheetsSync>> {
    const spreadsheetId = this.requireSpreadsheetId();

    try {
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${this.sheetName}!${APPEND_RANGE_SUFFIX}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [normalizeSheetRow(payload)] },
      });

      const filaIndex = parseRowIndexFromRange(response.data.updates?.updatedRange);
      return {
        sincronizado: true,
        filaIndex,
        timestampSincronizacion: new Date().toISOString(),
        errorSincronizacion: null,
      };
    } catch (cause) {
      throw mapGoogleApiError(cause, spreadsheetId);
    }
  }

  async updateRowRpaStatus(rowIndex: number, rpaData: Readonly<RpaEjecucion>): Promise<Readonly<GoogleSheetsSync>> {
    const spreadsheetId = this.requireSpreadsheetId();

    if (!Number.isInteger(rowIndex) || rowIndex < 2) {
      throw new GoogleSheetsApiError('INVALID_RANGE_SPECIFICATION', `Índice de fila inválido: ${rowIndex}`, {
        spreadsheetId,
        rowAttempted: rowIndex,
      });
    }

    try {
      const sheets = await this.getSheetsClient();
      // Columnas L (folioAcuseInstitucional) y M (exitoso) — ver layout en el docstring del archivo.
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${this.sheetName}!L${rowIndex}:M${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[rpaData.folioAcuseInstitucional ?? '', rpaData.exitoso]] },
      });

      return {
        sincronizado: true,
        filaIndex: rowIndex,
        timestampSincronizacion: new Date().toISOString(),
        errorSincronizacion: null,
      };
    } catch (cause) {
      throw mapGoogleApiError(cause, spreadsheetId, rowIndex);
    }
  }

  /**
   * Un solo `values.append` con todas las filas en `requestBody.values` — una sola
   * solicitud HTTP en vez de N, tal como pide el `@performance` del contrato. Las filas
   * quedan consecutivas: se deriva el índice de cada una a partir de la fila inicial que
   * reporta `updatedRange` (Sheets API no devuelve un índice por fila insertada).
   */
  async appendBatchRows(payloads: ReadonlyArray<DocumentSyncPayload>): Promise<ReadonlyArray<GoogleSheetsSync>> {
    const spreadsheetId = this.requireSpreadsheetId();
    if (payloads.length === 0) return [];

    try {
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${this.sheetName}!${APPEND_RANGE_SUFFIX}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: payloads.map(normalizeSheetRow) },
      });

      const firstRow = parseRowIndexFromRange(response.data.updates?.updatedRange);
      const timestampSincronizacion = new Date().toISOString();
      return payloads.map((_, index) => ({
        sincronizado: true,
        filaIndex: firstRow !== null ? firstRow + index : null,
        timestampSincronizacion,
        errorSincronizacion: null,
      }));
    } catch (cause) {
      throw mapGoogleApiError(cause, spreadsheetId);
    }
  }

  async checkConnection(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const sheets = await this.getSheetsClient();
      await sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId as string, fields: 'spreadsheetId' });
      return true;
    } catch {
      return false;
    }
  }
}
