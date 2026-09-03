/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Configuración de Entorno (composition root)
 * Versión: 1.0.0-MVP
 *
 * Conforme a prd.md §5.3: credenciales y rutas se inyectan por variables de entorno
 * (`.env` con `chmod 600` en el servidor local), nunca hardcodeadas.
 */

/** Selección del adaptador `IRpaInjectionProvider` cableado en el composition root. */
export type RpaMode = 'stub' | 'playwright';

export interface AppEnv {
  port: number;
  host: string;
  storageRoot: string;
  databasePath: string;
  pythonBin: string;
  pdfWorkerScriptPath: string;
  geminiApiKey: string | undefined;
  maxUploadBytes: number;
  /**
   * `'stub'` (default): usa `PlaywrightRpaInjectionAdapter`, que nunca lanza un
   * navegador y reporta `checkIntranetHealth() === false` honestamente.
   * `'playwright'`: usa `PlaywrightRpaAdapter` (automatización real contra
   * `op_cucs.fwx`) — requiere `npm run rpa:install-browsers` y credenciales/CVEs de
   * Intranet en `.env` (ver `.env.example`).
   */
  rpaMode: RpaMode;
  /** Navegador Playwright visible (para depuración) cuando `rpaMode === 'playwright'`. */
  rpaHeadless: boolean;
  /**
   * Habilita `IncomingFolderWatcher` (vigilancia de `storage/01_entrada/` para la
   * ingesta SCANNER_ADF, prd.md §2.1). Default `true` — se puede apagar en despliegues
   * donde el volumen del escáner aún no está montado, o en tests.
   */
  watchfolderEnabled: boolean;
  /** Intervalo de poll del watchfolder, en ms (ver docstring de IncomingFolderWatcher sobre por qué polling y no fs.watch). */
  watchfolderPollIntervalMs: number;
  /** Tiempo sin cambios de tamaño/mtime para considerar un archivo del watchfolder "estable" y listo para ingerir. */
  watchfolderStableForMs: number;
  /**
   * Config de `GoogleSheetsExternalSyncAdapter` (puerto `IExternalSyncProvider`). Sin
   * `googleSheetsSpreadsheetId`, el adaptador queda `configured === false` y todo
   * método de escritura lanza `ExternalSyncNotConfiguredError` (ver su docstring) —
   * el orquestador ya trata eso como no bloqueante.
   */
  googleSheetsSpreadsheetId: string | undefined;
  googleSheetsSheetName: string | undefined;
  googleServiceAccountJson: string | undefined;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadEnv(): AppEnv {
  return {
    port: readNumber('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    storageRoot: process.env.STORAGE_ROOT ?? 'storage',
    databasePath: process.env.DATABASE_PATH ?? 'data/oficialia.db',
    pythonBin: process.env.PYTHON_BIN ?? 'python3',
    pdfWorkerScriptPath: process.env.PDF_WORKER_SCRIPT_PATH ?? 'scripts/pdf_worker.py',
    geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    maxUploadBytes: readNumber('MAX_UPLOAD_BYTES', 25 * 1024 * 1024), // 25 MB por oficio
    rpaMode: process.env.RPA_MODE === 'playwright' ? 'playwright' : 'stub',
    rpaHeadless: readBoolean('RPA_HEADLESS', true),
    watchfolderEnabled: readBoolean('WATCHFOLDER_ENABLED', true),
    watchfolderPollIntervalMs: readNumber('WATCHFOLDER_POLL_INTERVAL_MS', 5_000),
    watchfolderStableForMs: readNumber('WATCHFOLDER_STABLE_FOR_MS', 4_000),
    googleSheetsSpreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || undefined,
    googleSheetsSheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || undefined,
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined,
  };
}
