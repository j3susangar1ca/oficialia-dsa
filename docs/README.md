# Documentación de diseño — Oficialia-Digital-DSA

Estos son los documentos de **especificación y diseño** originales del sistema. La
implementación real vive en [`../backend`](../backend) y [`../frontend`](../frontend);
estos archivos son la fuente de la que se derivó — y contra la que se debe seguir
validando cualquier cambio de contrato, esquema o flujo.

| Documento | Contenido | Dónde se implementa |
| --- | --- | --- |
| [`prd.md`](./prd.md) | Product Requirements Document: alcance, flujos de usuario, arquitectura técnica, `storage/` watchfolder. | Todo el repo; en particular `backend/src/presentation/` (rutas/flujos) y `backend/src/infrastructure/storage/`. |
| [`types.md`](./types.md) | Modelo de dominio (`DocumentoRegistro`, `MetadatosOficio`, máquina de estados) + diccionario de datos + dataset de prueba. | `backend/src/contracts/types.ts` (copia literal — ver cabecera de ese archivo). |
| [`contracts.md`](./contracts.md) | Los 7 puertos secundarios (6 del pipeline principal + `ILocalSemanticProvider`, P1 — Clean Architecture) + `DocumentWorkflowOrchestrator` + diagramas de secuencia. | `backend/src/contracts/*.ts` (6 puertos P0) + `backend/src/infrastructure/semantic/ILocalSemanticProvider.ts` (puerto 7, P1) y `backend/src/application/DocumentWorkflowOrchestrator.ts`. Las desviaciones deliberadas respecto a este boceto están documentadas inline con `@remarks`. |
| [`system_prompt.md`](./system_prompt.md) | System prompt institucional de extracción OCR/multimodal para Gemini. | `backend/src/infrastructure/ai/prompts/systemPromptExtraccionOficios.ts` (copia literal). |
| [`rpa/webix_dump_for_qwen.json`](./rpa/webix_dump_for_qwen.json) | Volcado DOM/Webix de `op_cucs.fwx` (Intranet HCG) — insumo de mapeo de campos para la automatización Playwright real. | Pendiente: `backend/src/infrastructure/rpa/PlaywrightRpaInjectionAdapter.ts` es hoy un placeholder documentado; este dump es el punto de partida para implementarlo. |

## Regla de sincronización

Estos documentos son la **fuente de verdad conceptual**. Si un cambio de código
modifica un contrato, un tipo de dominio o una regla de negocio descrita aquí,
actualiza primero el `.md` correspondiente y luego el código — no al revés — para que
ambos no diverjan.
