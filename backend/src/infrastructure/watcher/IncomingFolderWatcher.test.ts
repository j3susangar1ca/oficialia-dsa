/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Suite de pruebas para IncomingFolderWatcher
 * Runner: Vitest — usa un directorio temporal real (fs real, sin mocks de fs) porque el
 * comportamiento bajo prueba (estabilidad por tamaño/mtime, rename a 04_errores/) es
 * exactamente la interacción con el sistema de archivos que se quiere verificar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IncomingFolderWatcher } from './IncomingFolderWatcher';
import { PdfPreprocessFailedError, type DocumentWorkflowOrchestrator } from '../../application/DocumentWorkflowOrchestrator';

describe('IncomingFolderWatcher', () => {
  let storageRoot: string;
  let entradaDir: string;
  let errorDir: string;
  let ingestAndExtract: ReturnType<typeof vi.fn>;
  let orchestrator: DocumentWorkflowOrchestrator;

  const STABLE_FOR_MS = 4_000;

  /** Marca el mtime de un archivo como "viejo" (fuera de la ventana de estabilidad) sin esperar en tiempo real. */
  async function ageFile(absolutePath: string, olderThanMs = STABLE_FOR_MS + 5_000): Promise<void> {
    const oldTime = new Date(Date.now() - olderThanMs);
    await utimes(absolutePath, oldTime, oldTime);
  }

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'oficialia-watcher-'));
    entradaDir = path.join(storageRoot, '01_entrada');
    errorDir = path.join(storageRoot, '04_errores');
    await mkdir(entradaDir, { recursive: true });

    ingestAndExtract = vi.fn();
    orchestrator = { ingestAndExtract } as unknown as DocumentWorkflowOrchestrator;
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  function buildWatcher(overrides: Partial<{ maxUnexpectedRetries: number }> = {}): IncomingFolderWatcher {
    return new IncomingFolderWatcher({
      storageRoot,
      orchestrator,
      stableForMs: STABLE_FOR_MS,
      maxUnexpectedRetries: overrides.maxUnexpectedRetries,
      // logger silencioso — las aserciones son sobre el filesystem y el mock del orquestador
    });
  }

  it('no ingiere un archivo recién visto (aún dentro de la ventana de estabilidad)', async () => {
    const filePath = path.join(entradaDir, 'SCAN_recien_llegado.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4 contenido'));

    const watcher = buildWatcher();
    await watcher.pollOnce();

    expect(ingestAndExtract).not.toHaveBeenCalled();
    // El archivo debe seguir en 01_entrada/ — no se tocó.
    expect(await readdir(entradaDir)).toContain('SCAN_recien_llegado.pdf');
  });

  it('ingiere un archivo estable (tamaño/mtime sin cambios entre dos polls) y borra el original', async () => {
    const filePath = path.join(entradaDir, 'SCAN_20260901_0042.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4 contenido estable'));
    await ageFile(filePath);

    ingestAndExtract.mockResolvedValue({ id: 'doc-watcher-1', estado: 'PENDIENTE_EXTRACCION' });

    const watcher = buildWatcher();
    await watcher.pollOnce(); // 1er poll: registra tamaño/mtime, aún no procesa
    expect(ingestAndExtract).not.toHaveBeenCalled();

    await watcher.pollOnce(); // 2do poll: mismo tamaño/mtime + fuera de la ventana => procesa
    await vi.waitFor(() => expect(ingestAndExtract).toHaveBeenCalledTimes(1));

    expect(ingestAndExtract).toHaveBeenCalledWith('SCAN_20260901_0042.pdf', 'SCANNER_ADF', expect.any(Buffer));

    await vi.waitFor(async () => {
      expect(await readdir(entradaDir)).not.toContain('SCAN_20260901_0042.pdf');
    });
  });

  it('nunca reingiere archivos depositados por la ruta HTTP (prefijo Date.now()_ de saveIncoming)', async () => {
    const httpUploadName = `${Date.now()}_oficio-subido-por-drag-and-drop.pdf`;
    const filePath = path.join(entradaDir, httpUploadName);
    await writeFile(filePath, Buffer.from('%PDF-1.4'));
    await ageFile(filePath);

    const watcher = buildWatcher();
    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(ingestAndExtract).not.toHaveBeenCalled();
    expect(await readdir(entradaDir)).toContain(httpUploadName); // no se tocó
  });

  it('PdfPreprocessFailedError: el orquestador ya persistió el resultado, así que borra el original sin reintentar', async () => {
    const filePath = path.join(entradaDir, 'CORRUPTO.pdf');
    await writeFile(filePath, Buffer.from('no es un pdf valido'));
    await ageFile(filePath);

    ingestAndExtract.mockRejectedValue(new PdfPreprocessFailedError('doc-error-1', 'Estructura de PDF corrupta'));

    const watcher = buildWatcher();
    await watcher.pollOnce();
    await watcher.pollOnce();

    await vi.waitFor(() => expect(ingestAndExtract).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      expect(await readdir(entradaDir)).not.toContain('CORRUPTO.pdf');
    });
    // No debe haberlo aislado él mismo en 04_errores/ — eso ya lo hizo el orquestador
    // con su propia copia del buffer (recordPreprocessFailure).
    await expect(readdir(errorDir)).rejects.toThrow();
  });

  it('documento duplicado (mensaje "duplicado"): borra el original sin reintentar', async () => {
    const filePath = path.join(entradaDir, 'DUPLICADO.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4'));
    await ageFile(filePath);

    ingestAndExtract.mockRejectedValue(new Error('Documento duplicado detectado con hash: abc123'));

    const watcher = buildWatcher();
    await watcher.pollOnce();
    await watcher.pollOnce();

    await vi.waitFor(async () => {
      expect(await readdir(entradaDir)).not.toContain('DUPLICADO.pdf');
    });
  });

  it('archivo vacío: se aísla en 04_errores/ sin invocar al orquestador', async () => {
    const filePath = path.join(entradaDir, 'VACIO.pdf');
    await writeFile(filePath, Buffer.alloc(0));
    await ageFile(filePath);

    const watcher = buildWatcher();
    await watcher.pollOnce();
    await watcher.pollOnce();

    await vi.waitFor(async () => {
      expect(await readdir(errorDir)).toContain('VACIO.pdf');
    });
    expect(ingestAndExtract).not.toHaveBeenCalled();
  });

  it('error inesperado: reintenta hasta maxUnexpectedRetries y luego aísla en 04_errores/', async () => {
    const filePath = path.join(entradaDir, 'FALLA_RARA.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4'));
    await ageFile(filePath);

    ingestAndExtract.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

    const watcher = buildWatcher({ maxUnexpectedRetries: 2 });

    // Poll 1: registra. Poll 2: primer intento fallido (attempts=1 < 2, no aísla aún).
    await watcher.pollOnce();
    await watcher.pollOnce();
    await vi.waitFor(() => expect(ingestAndExtract).toHaveBeenCalledTimes(1));
    expect(await readdir(entradaDir)).toContain('FALLA_RARA.pdf'); // sigue ahí, no se aisló todavía

    // El tamaño/mtime no cambiaron -> el próximo poll ya lo considera estable de nuevo
    // (no hace falta re-envejecerlo: el mtime real del archivo no se tocó).
    await watcher.pollOnce(); // poll 3: segundo intento fallido (attempts=2 >= 2 => aísla)
    await vi.waitFor(async () => {
      expect(await readdir(errorDir)).toContain('FALLA_RARA.pdf');
    });
    expect(ingestAndExtract).toHaveBeenCalledTimes(2);
    expect(await readdir(entradaDir)).not.toContain('FALLA_RARA.pdf');
  });
});
