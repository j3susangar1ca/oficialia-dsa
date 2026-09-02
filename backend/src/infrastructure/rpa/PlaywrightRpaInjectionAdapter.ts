/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Inyección RPA en Intranet Webix (op_cucs.fwx)
 * Implementación PENDIENTE del puerto secundario IRpaInjectionProvider.
 *
 * Versión: 1.0.0-MVP (placeholder de composition root)
 *
 * ⚠️ Alcance de esta entrega: TAREA 1 (server.ts + document.routes.ts) requiere que el
 * `DocumentWorkflowOrchestrator` reciba una instancia inyectada de `IRpaInjectionProvider`
 * para poder componer el servidor Fastify. La automatización real contra
 * `https://sii.hcg.gob.mx/intranet/op_cucs.fwx` (mapeo de selectores Webix, credenciales
 * institucionales, captura de acuse) es un desarrollo propio de Playwright fuera del
 * alcance de esta tarea — ver `webix_dump_for_qwen.json` como insumo de mapeo de campos
 * cuando se implemente. Este adaptador cumple el contrato exactamente (misma forma,
 * mismos códigos de error tipados) para que:
 *   1. El servidor arranque y tipe correctamente vía Inyección de Dependencias.
 *   2. `checkIntranetHealth()` reporte `false` de forma honesta (permite exponer el
 *      estado real en un health-check sin fingir disponibilidad).
 *   3. Cualquier intento de inyección falle de forma controlada y tipada
 *      (`INTRANET_UNREACHABLE_OR_OFFLINE`), dejando el documento en `ERROR_RPA` con un
 *      mensaje explícito en vez de una excepción no manejada.
 *
 * Sustituir por la implementación real de Playwright sin tocar el orquestador ni las
 * rutas: basta con inyectar otra clase que satisfaga `IRpaInjectionProvider`.
 */

import type {
  IRpaInjectionProvider,
  RpaExecutionError,
  RpaErrorCode,
  RpaExecutionOptions,
  RpaInjectionPayload,
} from '../../contracts/IRpaInjectionProvider';
import type { RpaEjecucion } from '../../contracts/types';

export class RpaNotConfiguredError extends Error implements RpaExecutionError {
  public readonly code: RpaErrorCode;
  public readonly attemptCount: number;
  public readonly durationMs: number;

  constructor(message: string) {
    super(message);
    this.name = 'RpaNotConfiguredError';
    this.code = 'INTRANET_UNREACHABLE_OR_OFFLINE';
    this.attemptCount = 0;
    this.durationMs = 0;
  }
}

export class PlaywrightRpaInjectionAdapter implements IRpaInjectionProvider {
  async injectDocument(payload: RpaInjectionPayload, _options?: RpaExecutionOptions): Promise<Readonly<RpaEjecucion>> {
    throw new RpaNotConfiguredError(
      `El worker Playwright de op_cucs.fwx aún no está implementado. Documento pendiente: ${payload.documentId}. ` +
        'Configure PlaywrightRpaInjectionAdapter con las credenciales de la Intranet HCG antes de usar en producción.'
    );
  }

  async retryInjection(
    _previousExecutionId: string,
    payload: RpaInjectionPayload,
    options?: RpaExecutionOptions
  ): Promise<Readonly<RpaEjecucion>> {
    return this.injectDocument(payload, options);
  }

  async checkIntranetHealth(): Promise<boolean> {
    return false;
  }
}
