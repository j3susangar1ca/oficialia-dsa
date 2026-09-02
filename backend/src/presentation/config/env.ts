/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Configuración de Entorno (composition root)
 * Versión: 1.0.0-MVP
 *
 * Conforme a prd.md §5.3: credenciales y rutas se inyectan por variables de entorno
 * (`.env` con `chmod 600` en el servidor local), nunca hardcodeadas.
 */

export interface AppEnv {
  port: number;
  host: string;
  storageRoot: string;
  databasePath: string;
  pythonBin: string;
  pdfWorkerScriptPath: string;
  geminiApiKey: string | undefined;
  maxUploadBytes: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  };
}
