/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Suite de pruebas para LocalFileStorageAdapter
 * Runner: Vitest — fs real sobre un directorio temporal (sin mocks): el comportamiento
 * bajo prueba (rename atómico, creación de directorios YYYY/MM, hash post-escritura,
 * degradación ante archivo origen faltante) es exactamente la interacción con el
 * filesystem que se quiere verificar. Antes de este archivo, el adaptador central del
 * pipeline físico (storage/{01..04}) no tenía ninguna cobertura de pruebas.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalFileStorageAdapter, LocalStorageError } from './LocalFileStorageAdapter';
import type { MetadatosOficio } from '../../contracts/types';

const metadata: MetadatosOficio = {
  numeroOficio: 'DSA-1042-2026',
  fechaEmision: '2026-09-01',
  procedencia: 'HCG',
  dependenciaArea: 'DIRECCIÓN GENERAL HCG',
  remitenteNombre: 'DR. JAIME GONZÁLEZ',
  remitenteCargo: 'DIRECTOR GENERAL',
  destinatarioNombre: 'MTRO. LUIS PÉREZ',
  destinatarioCargo: 'DIRECTOR DE SERVICIOS ADMINISTRATIVOS',
  asunto: 'SOLICITUD DE DICTAMEN TÉCNICO.',
  plazoDias: 5,
  contieneDatosSensibles: false,
};

describe('LocalFileStorageAdapter', () => {
  let rootDir: string;
  let storage: LocalFileStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'oficialia-storage-'));
    storage = new LocalFileStorageAdapter({ rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('saveIncoming', () => {
    it('escribe el archivo en 01_entrada/ con un prefijo de timestamp y devuelve la ruta relativa', async () => {
      const relativePath = await storage.saveIncoming('oficio.pdf', Buffer.from('%PDF-1.4'));

      expect(relativePath).toMatch(/^01_entrada[\\/]\d+_oficio\.pdf$/);
      const content = await readFile(path.join(rootDir, relativePath), 'utf-8');
      expect(content).toBe('%PDF-1.4');
    });

    it('sanea caracteres reservados del filesystem en el nombre', async () => {
      const relativePath = await storage.saveIncoming('ofi:cio*raro?.pdf', Buffer.from('x'));
      expect(path.basename(relativePath)).toMatch(/^\d+_ofi-cio-raro-\.pdf$/);
    });

    it('descarta cualquier componente de ruta del nombre original (basename), no solo caracteres sueltos', async () => {
      // path.basename('a/b/../c') en POSIX ignora todo antes del último `/` — el
      // filename que llega desde afuera (multipart, un escáner) nunca debería poder
      // escribir fuera de 01_entrada/ vía "../../" en el nombre.
      const relativePath = await storage.saveIncoming('../../etc/oficio.pdf', Buffer.from('x'));
      expect(path.basename(relativePath)).toMatch(/^\d+_oficio\.pdf$/);
    });

    it('rechaza un buffer vacío con STORAGE_ERROR INVALID_FILE_NAME', async () => {
      await expect(storage.saveIncoming('vacio.pdf', new Uint8Array())).rejects.toMatchObject({
        code: 'INVALID_FILE_NAME',
      });
    });
  });

  describe('moveToInProcess', () => {
    it('mueve el archivo a 02_en_proceso/<uuid>.pdf de forma atómica (no queda copia en el origen)', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('contenido'));

      const inProcess = await storage.moveToInProcess(incoming, 'doc-uuid-1');

      expect(inProcess).toBe(path.join('02_en_proceso', 'doc-uuid-1.pdf'));
      await expect(readFile(path.join(rootDir, incoming))).rejects.toThrow(); // ya no existe en 01_entrada/
      expect(await readFile(path.join(rootDir, inProcess), 'utf-8')).toBe('contenido');
    });
  });

  describe('moveToCanonical', () => {
    it('crea storage/03_procesados/YYYY/MM/, mueve el PDF, escribe el JSON espejo y recalcula el hash sobre el archivo final', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('contenido-canonico'));
      const inProcess = await storage.moveToInProcess(incoming, 'doc-uuid-2');

      const result = await storage.moveToCanonical(
        inProcess,
        '2026',
        '09',
        '2026-09-01__DSA-1042-2026__DIR-GRAL.pdf',
        metadata
      );

      expect(result.canonicalPdfPath).toBe(
        path.join('03_procesados', '2026', '09', '2026-09-01__DSA-1042-2026__DIR-GRAL.pdf')
      );
      expect(result.mirrorJsonPath).toBe(
        path.join('03_procesados', '2026', '09', '2026-09-01__DSA-1042-2026__DIR-GRAL.json')
      );

      const expectedHash = createHash('sha256').update('contenido-canonico').digest('hex');
      expect(result.sha256Hash).toBe(expectedHash);

      const mirrorContent = JSON.parse(await readFile(path.join(rootDir, result.mirrorJsonPath), 'utf-8'));
      expect(mirrorContent).toEqual(metadata);

      // El archivo ya no está en 02_en_proceso/ tras el move atómico.
      await expect(readFile(path.join(rootDir, inProcess))).rejects.toThrow();
    });

    it('crea el árbol YYYY/MM recursivamente aunque no exista todavía', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('x'));
      const inProcess = await storage.moveToInProcess(incoming, 'doc-uuid-3');

      await storage.moveToCanonical(inProcess, '2027', '01', 'nuevo.pdf', metadata);

      const monthDirEntries = await readdir(path.join(rootDir, '03_procesados', '2027', '01'));
      expect(monthDirEntries.sort()).toEqual(['nuevo.json', 'nuevo.pdf']);
    });
  });

  describe('moveToError', () => {
    it('mueve el archivo a 04_errores/ y escribe un .error.txt con el motivo', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('x'));

      const errorPath = await storage.moveToError(incoming, 'CORRUPTED_PDF_STRUCTURE');

      expect(errorPath).toMatch(/^04_errores[\\/]\d+_oficio\.pdf$/);
      const reason = await readFile(path.join(rootDir, `${errorPath}.error.txt`), 'utf-8');
      expect(reason).toContain('CORRUPTED_PDF_STRUCTURE');
    });

    it('no lanza si el archivo origen ya no existe (allowMissingSource) — evita un segundo error al aislar un fallo', async () => {
      // Nunca se creó `01_entrada/inexistente.pdf` — simula una carrera donde el archivo
      // origen ya fue movido/borrado por otra vía antes de que moveToError se ejecute.
      const errorPath = await storage.moveToError(path.join('01_entrada', 'inexistente.pdf'), 'ALGUN_MOTIVO');
      expect(errorPath).toBe(path.join('04_errores', 'inexistente.pdf'));
    });
  });

  describe('readFile / exists', () => {
    it('exists() refleja la presencia real del archivo', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('x'));
      expect(await storage.exists(incoming)).toBe(true);
      expect(await storage.exists('01_entrada/no-existe.pdf')).toBe(false);
    });

    it('readFile lanza FILE_NOT_FOUND para una ruta inexistente', async () => {
      await expect(storage.readFile('01_entrada/fantasma.pdf')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('readFile devuelve los bytes exactos escritos', async () => {
      const incoming = await storage.saveIncoming('oficio.pdf', Buffer.from('contenido exacto'));
      const bytes = await storage.readFile(incoming);
      expect(Buffer.from(bytes).toString('utf-8')).toBe('contenido exacto');
    });
  });

  it('LocalStorageError conserva el `cause` original para trazabilidad', async () => {
    try {
      await storage.readFile('01_entrada/no-existe.pdf');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageError);
      expect((error as LocalStorageError).cause).toBeDefined();
    }
  });
});
