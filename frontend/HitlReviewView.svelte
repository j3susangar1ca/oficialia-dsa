<script lang="ts">
  // ============================================================
  // HitlReviewView.svelte
  // Oficialia-Digital-DSA — Validación Human-in-the-Loop (HITL)
  // Pantalla dividida: Visor PDF.js (izq) + Formulario reactivo (der)
  // Svelte 5 (Runes) · TypeScript · Tailwind CSS · pdfjs-dist
  // ============================================================

  import { onMount, onDestroy } from "svelte";
  import * as pdfjsLib from "pdfjs-dist";
  // El worker se resuelve como URL de asset en Vite.
  // Alternativa (sin bundler): pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

  // -----------------------------------------
  // Tipos de dominio (ver types.ts)
  // -----------------------------------------
  export type IngestaOrigen = "SCANNER_ADF" | "WEB_DRAG_DROP";
  export type ProcedenciaTipo = "HCG" | "Ajena";

  export interface MetadatosOficio {
    numeroOficio: string;
    fechaEmision: string; // YYYY-MM-DD
    procedencia: ProcedenciaTipo;
    dependenciaArea: string;
    remitenteNombre: string;
    remitenteCargo: string;
    destinatarioNombre: string;
    destinatarioCargo: string;
    asunto: string;
    plazoDias: number | null;
    contieneDatosSensibles: boolean;
  }

  export interface DocumentoRegistro {
    id: string;
    nombreArchivoOriginal: string;
    estado: string;
    metadatosExtraidos: MetadatosOficio | null;
    // ... resto de campos omitidos por brevedad en la vista HITL
  }

  // -----------------------------------------
  // Props del componente
  // -----------------------------------------

  interface Props {
    /** Documento a revisar (debe tener metadatosExtraidos ya poblados). */
    documento: DocumentoRegistro;
    /**
     * Fuente del PDF: ArrayBuffer precargado o URL de streaming (blob:/http:).
     * El orquestador Fastify expone el archivo en `rutaArchivoActual`.
     */
    src: ArrayBuffer | string;
    /** Callback de confirmación: recibe los metadatos validados por el humano. */
    onconfirm?: (validados: MetadatosOficio) => void | Promise<void>;
    /** Callback opcional al cancelar/descartar la revisión. */
    oncancel?: () => void;
  }

  let { documento, src, onconfirm, oncancel }: Props = $props();

  // ============================================================
  // 1) ESTADO DEL FORMULARIO (Runes: $state)
  // ============================================================

  // Inicializa el formulario desde los metadatos extraídos por Gemini.
  // Si por algún边缘 caso no existieran, se usan defaults seguros.
  const defaults: MetadatosOficio = {
    numeroOficio: "S/N",
    fechaEmision: new Date().toISOString().slice(0, 10),
    procedencia: "Ajena",
    dependenciaArea: "",
    remitenteNombre: "",
    remitenteCargo: "NO ESPECIFICADO",
    destinatarioNombre: "",
    destinatarioCargo: "NO ESPECIFICADO",
    asunto: "",
    plazoDias: null,
    contieneDatosSensibles: false,
  };

  let form = $state<MetadatosOficio>({
    ...defaults,
    ...(documento.metadatosExtraidos ?? {}),
  });

  // Estado de envío: bloquea la UI tras la confirmación.
  let enviando = $state(false);
  let errorMsg = $state<string | null>(null);

  // ============================================================
  // 2) VALIDACIÓN DERIVADA (Runes: $derived)
  // ============================================================

  // Fecha estricta YYYY-MM-DD.
  const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

  let errores = $derived({
    numeroOficio: form.numeroOficio.trim().length === 0
      ? "El folio es obligatorio (use 'S/N')."
      : /[\/\\:*?"<>|]/.test(form.numeroOficio)
        ? "Caracteres / \\ : * ? \" < > | no permitidos."
        : null,
    fechaEmision: !RE_FECHA.test(form.fechaEmision)
      ? "Formato requerido: YYYY-MM-DD."
      : null,
    dependenciaArea: form.dependenciaArea.trim().length === 0
      ? "Especifique la dependencia emisora."
      : null,
    remitenteNombre: form.remitenteNombre.trim().length === 0
      ? "Nombre del firmante obligatorio."
      : null,
    destinatarioNombre: form.destinatarioNombre.trim().length === 0
      ? "Nombre del destinatario obligatorio."
      : null,
    asunto: form.asunto.trim().length < 5
      ? "Síntesis demasiado corta (mín. 5 caracteres)."
      : null,
    plazoDias:
      form.plazoDias !== null && (!Number.isInteger(form.plazoDias) || form.plazoDias < 0)
        ? "Debe ser un entero positivo o vacío."
        : null,
  });

  let hayErrores = $derived(Object.values(errores).some((e) => e !== null));
  let puedeConfirmar = $derived(!hayErrores && !enviando);

  // Banderas reactivas para resaltar campos inválidos sólo tras interacción.
  let tocadas = $state<Record<string, boolean>>({});

  // ============================================================
  // 3) NORMALIZACIÓN EN $effect (mayúsculas / sanitización)
  // ============================================================
  // Aplica las mismas reglas del contrato Zod del PRD.
  $effect(() => {
    // Normaliza a mayúsculas y trim sin mutar si ya está normalizado
    // (evita loops infinitos comparando longitud/contenido).
    const upper = (v: string) => v.toUpperCase().trim();

    if (form.dependenciaArea !== upper(form.dependenciaArea)) {
      form.dependenciaArea = upper(form.dependenciaArea);
    }
    if (form.remitenteNombre !== upper(form.remitenteNombre)) {
      form.remitenteNombre = upper(form.remitenteNombre);
    }
    if (form.remitenteCargo !== upper(form.remitenteCargo)) {
      form.remitenteCargo = upper(form.remitenteCargo);
    }
    if (form.destinatarioNombre !== upper(form.destinatarioNombre)) {
      form.destinatarioNombre = upper(form.destinatarioNombre);
    }
    if (form.destinatarioCargo !== upper(form.destinatarioCargo)) {
      form.destinatarioCargo = upper(form.destinatarioCargo);
    }
    // Asunto: colapsa saltos de línea a espacios.
    const asuntoLimpio = form.asunto.replace(/[\r\n]+/g, " ").trim();
    if (form.asunto !== asuntoLimpio) {
      form.asunto = asuntoLimpio;
    }
    // Sanitiza folio reemplazando caracteres reservados por '-'.
    const folioLimpio = form.numeroOficio.replace(/[\/\\:*?"<>|]/g, "-");
    if (form.numeroOficio !== folioLimpio) {
      form.numeroOficio = folioLimpio;
    }
  });

  // ============================================================
  // 4) VISOR PDF.js (Canvas)
  // ============================================================

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let renderTask: pdfjsLib.RenderTask | null = null;
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;

  let numPaginas = $state(0);
  let paginaActual = $state(1);
  let escala = $state(1.0); // escala base de render
  let rotacion = $state(0); // grados (0 | 90 | 180 | 270)
  let ajusteAncho = $state(true); // auto-fit al ancho del panel
  let cargandoPdf = $state(true);
  let pdfError = $state<string | null>(null);

  const ESCALA_MIN = 0.25;
  const ESCALA_MAX = 4.0;

  // Ancho disponible del panel izquierdo para calcular "fit to width".
  let panelAncho = $state(0);

  async function cargarPdf() {
    cargandoPdf = true;
    pdfError = null;
    try {
      const params: pdfjsLib.DocumentInitParameters =
        src instanceof ArrayBuffer
          ? { data: new Uint8Array(src) }
          : { url: src };

      const tarea = pdfjsLib.getDocument(params);
      pdfDoc = await tarea.promise;
      numPaginas = pdfDoc.numPages;
      paginaActual = 1;
      await renderizarPagina();
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
      pdfDoc = null;
      numPaginas = 0;
    } finally {
      cargandoPdf = false;
    }
  }

  // Re-renderiza cuando cambian página, escala, rotación o ajuste al ancho.
  $effect(() => {
    // Reaccionar a estos valores (dependencias del effect):
    void paginaActual;
    void escala;
    void rotacion;
    void ajusteAncho;
    void panelAncho;
    if (pdfDoc && canvasEl) {
      renderizarPagina();
    }
  });

  async function renderizarPagina() {
    if (!pdfDoc || !canvasEl) return;
    const page = await pdfDoc.getPage(paginaActual);

    // Si "ajustar al ancho" está activo, calcula escala según el panel.
    let escalaFinal = escala;
    if (ajusteAncho && panelAncho > 0) {
      const viewportBase = page.getViewport({ scale: 1, rotation: rotacion });
      escalaFinal = panelAncho / viewportBase.width;
      escalaFinal = Math.min(Math.max(escalaFinal, ESCALA_MIN), ESCALA_MAX);
    }

    const viewport = page.getViewport({ scale: escalaFinal, rotation: rotacion });
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;

    // Ajusta el canvas a alta resolución (devicePixelRatio) para nitidez.
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.floor(viewport.width * dpr);
    canvasEl.height = Math.floor(viewport.height * dpr);
    canvasEl.style.width = `${Math.floor(viewport.width)}px`;
    canvasEl.style.height = `${Math.floor(viewport.height)}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Cancela cualquier render previo en curso.
    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        /* ignore */
      }
    }

    renderTask = page.render({
      canvasContext: ctx,
      viewport,
    });

    try {
      await renderTask.promise;
    } catch (err) {
      // 'RenderingCancelledException' es esperada al re-renderizar rápido.
      if (
        !(err instanceof Error && err.name === "RenderingCancelledException")
      ) {
        console.error("Render PDF falló:", err);
      }
    } finally {
      renderTask = null;
    }
  }

  // --- Controles del visor ---
  function zoomIn() {
    ajusteAncho = false;
    escala = Math.min(escala * 1.2, ESCALA_MAX);
  }
  function zoomOut() {
    ajusteAncho = false;
    escala = Math.max(escala / 1.2, ESCALA_MIN);
  }
  function rotar() {
    rotacion = (rotacion + 90) % 360;
  }
  function ajustarAncho() {
    ajusteAncho = true;
  }
  function paginaAnterior() {
    if (paginaActual > 1) paginaActual -= 1;
  }
  function paginaSiguiente() {
    if (paginaActual < numPaginas) paginaActual += 1;
  }

  // Observa el ancho del panel izquierdo para el auto-fit.
  let resizeObserver: ResizeObserver | null = null;
  let panelIzqEl = $state<HTMLElement | null>(null);

  $effect(() => {
    if (panelIzqEl) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          panelAncho = entry.contentRect.width;
        }
      });
      resizeObserver.observe(panelIzqEl);
      return () => {
        resizeObserver?.disconnect();
        resizeObserver = null;
      };
    }
  });

  // ============================================================
  // 5) CONFIRMACIÓN HITL
  // ============================================================

  async function confirmar() {
    if (!puedeConfirmar) return;
    // Marca todos los campos como tocados para mostrar errores residuales.
    tocadas = {
      numeroOficio: true,
      fechaEmision: true,
      dependenciaArea: true,
      remitenteNombre: true,
      destinatarioNombre: true,
      asunto: true,
      plazoDias: true,
    };
    if (hayErrores) {
      errorMsg = "Revise los campos marcados antes de confirmar.";
      return;
    }

    errorMsg = null;
    enviando = true;

    // Construye el contrato inmutable validado.
    const validados: MetadatosOficio = {
      numeroOficio: form.numeroOficio.replace(/[\/\\:*?"<>|]/g, "-").trim() || "S/N",
      fechaEmision: form.fechaEmision,
      procedencia: form.procedencia,
      dependenciaArea: form.dependenciaArea.toUpperCase().trim(),
      remitenteNombre: form.remitenteNombre.toUpperCase().trim(),
      remitenteCargo: form.remitenteCargo.toUpperCase().trim() || "NO ESPECIFICADO",
      destinatarioNombre: form.destinatarioNombre.toUpperCase().trim(),
      destinatarioCargo: form.destinatarioCargo.toUpperCase().trim() || "NO ESPECIFICADO",
      asunto: form.asunto.replace(/[\r\n]+/g, " ").trim(),
      plazoDias:
        form.plazoDias === null || form.plazoDias === undefined
          ? null
          : Math.max(0, Math.floor(form.plazoDias)),
      contieneDatosSensibles: form.contieneDatosSensibles,
    };

    try {
      await onconfirm?.(validados);
      // El orquestador (Fastify) se encarga de la transición de estado
      // (APROBADO_HITL -> EN_RPA -> COMPLETADO). Aquí sólo bloqueamos la UI.
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Error al registrar en Intranet.";
      // Permite reintento manual si el orquestador lo permite (ERROR_RPA).
      enviando = false;
    }
  }

  // ============================================================
  // 6) CICLO DE VIDA
  // ============================================================

  onMount(() => {
    cargarPdf();
  });

  onDestroy(() => {
    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        /* ignore */
      }
    }
    pdfDoc?.destroy().catch(() => {});
  });

  // Atajos de teclado para el visor.
  function onKey(e: KeyboardEvent) {
    if (enviando) return;
    switch (e.key) {
      case "ArrowLeft":
        paginaAnterior();
        break;
      case "ArrowRight":
        paginaSiguiente();
        break;
      case "+":
      case "=":
        zoomIn();
        break;
      case "-":
        zoomOut();
        break;
      case "r":
      case "R":
        rotar();
        break;
      case "f":
      case "F":
        ajustarAncho();
        break;
    }
  }

  // Helper para marcar campo tocado y mostrar error.
  function tocar(campo: string) {
    tocadas = { ...tocadas, [campo]: true };
  }
  function errVisible(campo: string): string | null {
    return tocadas[campo] ? (errores as Record<string, string | null>)[campo] : null;
  }

  // Plazo: el input numérico puede quedar vacío -> null.
  function onPlazoInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const raw = input.value.trim();
    if (raw === "") {
      form.plazoDias = null;
    } else {
      const n = Number(raw);
      form.plazoDias = Number.isFinite(n) && n >= 0 ? Math.floor(n) : form.plazoDias;
    }
  }
</script>

<div
  class="flex h-screen w-full flex-col bg-slate-900 text-slate-100 lg:flex-row"
  role="application"
  aria-label="Revisión Human-in-the-Loop de oficio"
  onkeydown={onKey}
  tabindex="-1"
>
  <!-- ============================================================ -->
  <!-- BARRA SUPERIOR DE CONTEXTO                                    -->
  <!-- ============================================================ -->
  <header class="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-4 py-3 lg:absolute lg:top-0 lg:left-0 lg:right-0 lg:z-20">
    <div class="flex items-center gap-3">
      <span class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-emerald-600 font-bold text-white">
        DSA
      </span>
      <div class="leading-tight">
        <p class="text-sm font-semibold">Oficialía Digital · HITL</p>
        <p class="text-xs text-slate-400 truncate max-w-[40vw]">
          {documento.nombreArchivoOriginal}
        </p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span
        class="rounded-full px-3 py-1 text-xs font-medium {documento.estado === 'PENDIENTE_REVISION'
          ? 'bg-amber-500/20 text-amber-300'
          : 'bg-slate-700 text-slate-300'}"
      >
        Estado: {documento.estado}
      </span>
      {#if oncancel}
        <button
          type="button"
          class="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          onclick={oncancel}
          disabled={enviando}
        >
          Cancelar
        </button>
      {/if}
    </div>
  </header>

  <!-- ============================================================ -->
  <!-- PANEL IZQUIERDO — VISOR PDF.js                                -->
  <!-- ============================================================ -->
  <section
    bind:this={panelIzqEl}
    class="relative flex h-1/2 flex-col bg-slate-950 lg:mt-16 lg:h-[calc(100vh-4rem)] lg:w-1/2"
    aria-label="Visor de documento PDF"
  >
    <!-- Toolbar del visor -->
    <div class="flex items-center gap-1 border-b border-slate-800 bg-slate-900/80 px-3 py-2 backdrop-blur">
      <button
        type="button"
        class="visor-btn"
        title="Página anterior (←)"
        onclick={paginaAnterior}
        disabled={paginaActual <= 1 || cargandoPdf || enviando}
      >◀</button>

      <span class="px-2 text-xs tabular-nums text-slate-300">
        {paginaActual} / {numPaginas || "—"}
      </span>

      <button
        type="button"
        class="visor-btn"
        title="Página siguiente (→)"
        onclick={paginaSiguiente}
        disabled={paginaActual >= numPaginas || cargandoPdf || enviando}
      >▶</button>

      <span class="mx-1 h-5 w-px bg-slate-700"></span>

      <button
        type="button"
        class="visor-btn"
        title="Alejar (-)"
        onclick={zoomOut}
        disabled={cargandoPdf || enviando}
      >−</button>

      <button
        type="button"
        class="visor-btn"
        title="Acercar (+)"
        onclick={zoomIn}
        disabled={cargandoPdf || enviando}
      >+</button>

      <button
        type="button"
        class="visor-btn"
        title="Rotar 90° (R)"
        onclick={rotar}
        disabled={cargandoPdf || enviando}
      >⟳</button>

      <button
        type="button"
        class="visor-btn"
        title="Ajustar al ancho (F)"
        onclick={ajustarAncho}
        disabled={cargandoPdf || enviando}
        class:ring-2={ajusteAncho}
        class:ring-emerald-500={ajusteAncho}
      >⤢</button>

      <span class="ml-auto text-[10px] text-slate-500 hidden sm:block">
        Zoom: {Math.round(escala * 100)}% · Rot: {rotacion}°
      </span>
    </div>

    <!-- Área de render -->
    <div class="relative flex-1 overflow-auto p-4 flex justify-center items-start">
      {#if cargandoPdf}
        <div class="flex h-full w-full items-center justify-center">
          <div class="flex flex-col items-center gap-3 text-slate-400">
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500"></div>
            <p class="text-xs">Cargando documento…</p>
          </div>
        </div>
      {:else if pdfError}
        <div class="flex h-full w-full items-center justify-center">
          <div class="max-w-sm rounded-lg border border-red-800 bg-red-950/40 p-4 text-center text-red-300">
            <p class="font-semibold">No se pudo abrir el PDF</p>
            <p class="mt-1 text-xs text-red-400/80 break-words">{pdfError}</p>
          </div>
        </div>
      {:else}
        <canvas
          bind:this={canvasEl}
          class="shadow-2xl shadow-black/50 ring-1 ring-slate-700"
        ></canvas>
      {/if}
    </div>
  </section>

  <!-- ============================================================ -->
  <!-- PANEL DERECHO — FORMULARIO REACTIVO                           -->
  <!-- ============================================================ -->
  <section
    class="flex h-1/2 flex-col overflow-y-auto bg-slate-100 text-slate-800 lg:mt-16 lg:h-[calc(100vh-4rem)] lg:w-1/2"
    aria-label="Formulario de validación de metadatos"
  >
    <form
      class="flex flex-1 flex-col gap-5 p-5 lg:p-6"
      onsubmit={(e) => {
        e.preventDefault();
        confirmar();
      }}
    >
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-slate-900">Validación de Metadatos</h2>
        <span class="text-xs text-slate-500">
          Edite diferencias y confirme en &lt; 10 s
        </span>
      </div>

      {#if errorMsg}
        <div class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          ⚠ {errorMsg}
        </div>
      {/if}

      <!-- Procedencia (radio HCG / Ajena) -->
      <fieldset class="rounded-lg border border-slate-300 bg-white p-3">
        <legend class="px-1 text-xs font-semibold text-slate-600">Procedencia</legend>
        <div class="flex gap-4">
          {#each ["HCG", "Ajena"] as opt}
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="procedencia"
                value={opt}
                bind:group={form.procedencia}
                disabled={enviando}
                class="h-4 w-4 accent-emerald-600"
              />
              <span>{opt === "HCG" ? "HCG (Interno)" : "Ajena (Externo)"}</span>
            </label>
          {/each}
        </div>
      </fieldset>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- Número de Oficio -->
        <div class="sm:col-span-1">
          <label for="f-numero" class="form-label">Número de Oficio / Folio</label>
          <input
            id="f-numero"
            type="text"
            bind:value={form.numeroOficio}
            onblur={() => tocar("numeroOficio")}
            disabled={enviando}
            class="form-input {errVisible('numeroOficio') ? 'input-error' : ''}"
            placeholder="DSA-2026-089-OF o S/N"
          />
          {#if errVisible("numeroOficio")}
            <p class="form-error">{errVisible("numeroOficio")}</p>
          {/if}
        </div>

        <!-- Fecha de Emisión -->
        <div class="sm:col-span-1">
          <label for="f-fecha" class="form-label">Fecha de Emisión</label>
          <input
            id="f-fecha"
            type="date"
            bind:value={form.fechaEmision}
            onblur={() => tocar("fechaEmision")}
            disabled={enviando}
            class="form-input {errVisible('fechaEmision') ? 'input-error' : ''}"
          />
          {#if errVisible("fechaEmision")}
            <p class="form-error">{errVisible("fechaEmision")}</p>
          {/if}
        </div>

        <!-- Dependencia / Área -->
        <div class="sm:col-span-2">
          <label for="f-dependencia" class="form-label">Dependencia / Área emisora</label>
          <input
            id="f-dependencia"
            type="text"
            bind:value={form.dependenciaArea}
            onblur={() => tocar("dependenciaArea")}
            disabled={enviando}
            class="form-input uppercase {errVisible('dependenciaArea') ? 'input-error' : ''}"
            placeholder="DIRECCIÓN GENERAL HCG"
          />
          {#if errVisible("dependenciaArea")}
            <p class="form-error">{errVisible("dependenciaArea")}</p>
          {/if}
        </div>

        <!-- Remitente -->
        <div class="sm:col-span-1">
          <label for="f-rem-nombre" class="form-label">Remitente (Firmante)</label>
          <input
            id="f-rem-nombre"
            type="text"
            bind:value={form.remitenteNombre}
            onblur={() => tocar("remitenteNombre")}
            disabled={enviando}
            class="form-input uppercase {errVisible('remitenteNombre') ? 'input-error' : ''}"
          />
          {#if errVisible("remitenteNombre")}
            <p class="form-error">{errVisible("remitenteNombre")}</p>
          {/if}
        </div>

        <div class="sm:col-span-1">
          <label for="f-rem-cargo" class="form-label">Cargo del Remitente</label>
          <input
            id="f-rem-cargo"
            type="text"
            bind:value={form.remitenteCargo}
            disabled={enviando}
            class="form-input uppercase"
            placeholder="NO ESPECIFICADO"
          />
        </div>

        <!-- Destinatario -->
        <div class="sm:col-span-1">
          <label for="f-des-nombre" class="form-label">Destinatario</label>
          <input
            id="f-des-nombre"
            type="text"
            bind:value={form.destinatarioNombre}
            onblur={() => tocar("destinatarioNombre")}
            disabled={enviando}
            class="form-input uppercase {errVisible('destinatarioNombre') ? 'input-error' : ''}"
          />
          {#if errVisible("destinatarioNombre")}
            <p class="form-error">{errVisible("destinatarioNombre")}</p>
          {/if}
        </div>

        <div class="sm:col-span-1">
          <label for="f-des-cargo" class="form-label">Cargo del Destinatario</label>
          <input
            id="f-des-cargo"
            type="text"
            bind:value={form.destinatarioCargo}
            disabled={enviando}
            class="form-input uppercase"
            placeholder="NO ESPECIFICADO"
          />
        </div>

        <!-- Plazo (días) -->
        <div class="sm:col-span-1">
          <label for="f-plazo" class="form-label">Plazo de respuesta (días)</label>
          <input
            id="f-plazo"
            type="number"
            min="0"
            step="1"
            value={form.plazoDias ?? ""}
            oninput={onPlazoInput}
            onblur={() => tocar("plazoDias")}
            disabled={enviando}
            class="form-input {errVisible('plazoDias') ? 'input-error' : ''}"
            placeholder="Vacío si no aplica"
          />
          {#if errVisible("plazoDias")}
            <p class="form-error">{errVisible("plazoDias")}</p>
          {/if}
        </div>

        <!-- Datos sensibles (checkbox) -->
        <div class="sm:col-span-1 flex items-end">
          <label class="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              bind:checked={form.contieneDatosSensibles}
              disabled={enviando}
              class="h-4 w-4 accent-rose-600"
            />
            <span class="font-medium text-slate-700">
              Contiene datos sensibles (LGPDPPSO)
            </span>
          </label>
        </div>

        <!-- Asunto (textarea, full width) -->
        <div class="sm:col-span-2">
          <label for="f-asunto" class="form-label">Asunto / Síntesis</label>
          <textarea
            id="f-asunto"
            bind:value={form.asunto}
            onblur={() => tocar("asunto")}
            disabled={enviando}
            rows="4"
            class="form-input resize-y {errVisible('asunto') ? 'input-error' : ''}"
            placeholder="Síntesis del oficio (1 a 3 oraciones)."
          ></textarea>
          {#if errVisible("asunto")}
            <p class="form-error">{errVisible("asunto")}</p>
          {/if}
        </div>
      </div>

      <!-- Botón unificado de confirmación -->
      <div class="sticky bottom-0 mt-auto -mx-5 -mb-5 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur lg:-mx-6 lg:-mb-6 lg:px-6">
        <button
          type="submit"
          disabled={!puedeConfirmar}
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
        >
          {#if enviando}
            <svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"></path>
            </svg>
            <span>Registrando en Intranet…</span>
          {:else}
            <span>✓ Confirmar y Registrar en Intranet</span>
          {/if}
        </button>
        <p class="mt-2 text-center text-[11px] text-slate-500">
          Se moverá a <code>storage/03_procesados/YYYY/MM/</code> y se inyectará en
          <code>op_cucs.fwx</code> vía RPA.
        </p>
      </div>
    </form>
  </section>
</div>

<!-- ============================================================ -->
<!-- ESTILOS DE COMPONENTE (Tailwind utility classes reutilizables) -->
<!-- ============================================================ -->
<style>
  .visor-btn {
    @apply inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-sm text-slate-200 transition hover:bg-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40;
  }
  .form-label {
    @apply mb-1 block text-xs font-semibold text-slate-600;
  }
  .form-input {
    @apply w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400;
  }
  .input-error {
    @apply border-red-400 focus:border-red-500 focus:ring-red-500;
  }
  .form-error {
    @apply mt-1 text-xs text-red-600;
  }
</style>
