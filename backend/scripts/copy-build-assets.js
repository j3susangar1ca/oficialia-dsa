#!/usr/bin/env node
/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Copia al build de producción (dist/) los archivos no-TypeScript que el código
 * resuelve en runtime relativos a `__dirname` — `tsc` solo emite `.js`/`.d.ts`/mapas de
 * fuente, nunca copia otros tipos de archivo.
 *
 * Bug real descubierto construyendo la imagen Docker del backend (ver Dockerfile): el
 * flujo de producción documentado en README.md §7 (`npm run build` + `node
 * dist/presentation/server.js`) SIEMPRE fallaba con
 * `ENOENT: .../dist/infrastructure/persistence/schema.sql` al arrancar —
 * `SqliteDocumentRepository` resuelve `schema.sql`/`embeddings_schema.sql` con
 * `path.resolve(__dirname, 'schema.sql')`, esperando encontrarlos junto al `.js`
 * compilado. `npm run dev` (tsx, corre directo sobre `src/`) nunca lo expuso porque ahí
 * los `.sql` sí están junto al `.ts` en disco.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** [directorio relativo a src/dist, extensiones a copiar tal cual] */
const ASSETS = [{ dir: 'infrastructure/persistence', extensions: ['.sql'] }];

for (const { dir, extensions } of ASSETS) {
  const srcDir = path.join(ROOT, 'src', dir);
  const destDir = path.join(ROOT, 'dist', dir);
  fs.mkdirSync(destDir, { recursive: true });

  for (const fileName of fs.readdirSync(srcDir)) {
    if (!extensions.some((ext) => fileName.endsWith(ext))) continue;
    fs.copyFileSync(path.join(srcDir, fileName), path.join(destDir, fileName));
    console.log(`[copy-build-assets] ${path.join(dir, fileName)} -> dist/${dir}/${fileName}`);
  }
}
