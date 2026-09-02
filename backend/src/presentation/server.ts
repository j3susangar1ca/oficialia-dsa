/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Servidor Fastify — Composition Root
 * Versión: 1.0.0-MVP
 *
 * Responsabilidades de este archivo, y SOLO estas:
 *   1. Registrar los plugins de transporte (@fastify/multipart, @fastify/websocket)
 *      y el type provider de Zod.
 *   2. Instanciar los siete adaptadores de infraestructura concretos.
 *   3. Inyectarlos manualmente (constructor injection) en el
 *      `DocumentWorkflowOrchestrator` — sin contenedor de DI, sin decoradores.
 *   4. Montar las rutas HTTP (`document.routes.ts`) y el endpoint WebSocket,
 *      pasándoles esas dependencias ya resueltas.
 *
 * Ninguna regla de negocio vive aquí: este archivo solo "cablea" (wiring).
 */

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { chromium, type Browser } from 'playwright';

import { DocumentWorkflowOrchestrator } from '../application/DocumentWorkflowOrchestrator';
import type { IRpaInjectionProvider } from '../contracts/IRpaInjectionProvider';
import { GeminiAIExtractorAdapter } from '../infrastructure/ai/GeminiAIExtractorAdapter';
import { PythonPdfProcessorAdapter } from '../infrastructure/pdf/PythonPdfProcessorAdapter';
import { SqliteDocumentRepository } from '../infrastructure/persistence/SqliteDocumentRepository';
import { PlaywrightRpaAdapter } from '../infrastructure/rpa/PlaywrightRpaAdapter';
import { PlaywrightRpaInjectionAdapter } from '../infrastructure/rpa/PlaywrightRpaInjectionAdapter';
import { LocalSemanticMatcherAdapter } from '../infrastructure/semantic/LocalSemanticMatcherAdapter';
import { LocalFileStorageAdapter } from '../infrastructure/storage/LocalFileStorageAdapter';
import { GoogleSheetsExternalSyncAdapter } from '../infrastructure/sync/GoogleSheetsExternalSyncAdapter';
import { MetadatosOficioSchema } from '../contracts/schemas/metadatosOficio.schema';
import { loadEnv } from './config/env';
import { documentRoutes } from './routes/document.routes';
import { DocumentEventsHub } from './ws/DocumentEventsHub';

export async function buildServer() {
  const env = loadEnv();

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
  }).withTypeProvider<ZodTypeProvider>();

  // --- Zod como fuente única de verdad para validación y serialización -----
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // --- Manejo centralizado de errores no capturados por las rutas -----------
  // DEBE registrarse ANTES de cualquier `fastify.register(...)` de rutas (abajo). Fastify
  // encapsula cada plugin registrado con `await fastify.register(...)` en su propio
  // contexto en cuanto esa promesa resuelve; un `setErrorHandler` puesto en el root
  // DESPUÉS de esos `register()` (como estaba antes) no se propaga retroactivamente a
  // esos contextos ya cerrados, y esas rutas quedan con el manejador por defecto de
  // Fastify — que responde `{statusCode, error: "Internal Server Error", message}`
  // filtrando el `.message` interno de la excepción (p. ej. rutas/errores del worker
  // Python) en vez del `{error, code}` genérico esperado por el frontend. Comprobado
  // reproduciendo el bug de forma aislada: mover este bloque aquí lo corrige.
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'Error no manejado en la solicitud');
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Error interno del servidor' : error.message,
      code: error.code ?? 'INTERNAL_ERROR',
    });
  });

  // --- Plugins de transporte -------------------------------------------------
  await fastify.register(cors, {
    // LAN hospitalaria / VPN (prd.md §2: fuera de alcance la exposición pública).
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: env.maxUploadBytes,
      files: 1,
    },
  });

  await fastify.register(websocket);

  // ===========================================================================
  // COMPOSITION ROOT — Inyección de Dependencias manual de los 7 puertos
  // ===========================================================================
  const eventsHub = new DocumentEventsHub();

  const storage = new LocalFileStorageAdapter({ rootDir: env.storageRoot });
  const repository = new SqliteDocumentRepository({ databasePath: env.databasePath });
  const pdfProcessor = new PythonPdfProcessorAdapter({
    pythonBin: env.pythonBin,
    scriptPath: env.pdfWorkerScriptPath,
  });
  const aiExtractor = new GeminiAIExtractorAdapter({
    // MetadatosOficioSchema (dominio, camelCase) es la ÚNICA fuente para derivar el
    // `responseSchema` nativo de Gemini (fuerza esas mismas claves en el JSON generado)
    // y para validar la respuesta — evita mantener un mapeo snake_case↔camelCase aparte.
    schema: MetadatosOficioSchema,
    apiKey: env.geminiApiKey,
  });
  // RPA: 'stub' (default) mantiene el placeholder honesto que nunca lanza un navegador;
  // 'playwright' (RPA_MODE=playwright) activa la automatización real contra op_cucs.fwx.
  // Ver docstrings de env.ts y de PlaywrightRpaAdapter para los requisitos de cada modo.
  let rpaInjection: IRpaInjectionProvider;
  let rpaBrowser: Browser | undefined;

  if (env.rpaMode === 'playwright') {
    rpaBrowser = await chromium.launch({ headless: env.rpaHeadless });
    rpaInjection = new PlaywrightRpaAdapter(rpaBrowser, { storageRoot: env.storageRoot });
  } else {
    rpaInjection = new PlaywrightRpaInjectionAdapter();
  }

  const externalSync = new GoogleSheetsExternalSyncAdapter();

  // Puerto 7 (P1, docs/prd.md §2.2): búsqueda semántica local. Reutiliza la misma
  // conexión/archivo SQLite que `repository` (better-sqlite3 es síncrono, un solo hilo
  // por conexión). Instanciarlo es barato — el modelo ONNX (~cientos de MB) solo se
  // carga en la primera llamada real a indexDocument()/searchSimilar() (ver
  // `initialize()` perezoso en LocalSemanticMatcherAdapter), así que no retrasa el
  // arranque del servidor ni bloquea el health-check.
  const semanticProvider = new LocalSemanticMatcherAdapter(repository.getRawDatabase());

  const orchestrator = new DocumentWorkflowOrchestrator(
    storage,
    repository,
    pdfProcessor,
    aiExtractor,
    rpaInjection,
    externalSync,
    eventsHub, // WorkflowEventsListener — retransmite el avance por WebSocket
    semanticProvider
  );

  // ===========================================================================
  // RUTAS
  // ===========================================================================
  await fastify.register(documentRoutes, {
    orchestrator,
    repository,
    storage,
    maxUploadBytes: env.maxUploadBytes,
  });

  // Endpoint de upgrade WebSocket: notifica NEW_DOCUMENT_PENDING / DOCUMENT_STATE_CHANGED /
  // PIPELINE_ERROR / RPA_COMPLETED en tiempo real (ver presentation/ws/events.ts).
  fastify.register(async (wsApp) => {
    wsApp.get('/ws/documents', { websocket: true }, (socket) => {
      eventsHub.register(socket);
    });
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    intranet: await rpaInjection.checkIntranetHealth(),
    sheets: await externalSync.checkConnection(),
    // No dispara la carga del modelo — solo refleja si ya se inicializó por una
    // indexación/búsqueda previa (ver comentario en la instanciación de semanticProvider).
    semantic: semanticProvider.modeloEstado,
  }));

  fastify.addHook('onClose', async () => {
    eventsHub.dispose();
    repository.close();
    await rpaBrowser?.close().catch(() => undefined);
  });

  return { fastify, env };
}

export async function startServer(): Promise<void> {
  const { fastify, env } = await buildServer();

  try {
    await fastify.listen({ port: env.port, host: env.host });
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      fastify.log.info(`Señal ${signal} recibida, cerrando servidor…`);
      await fastify.close();
      process.exit(0);
    });
  }
}

// Permite ejecutar `tsx src/presentation/server.ts` directamente en desarrollo.
if (require.main === module) {
  void startServer();
}
