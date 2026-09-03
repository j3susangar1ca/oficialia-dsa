// SISTEMA OFICIALIA-DIGITAL-DSA
// Configuración raíz de ESLint (flat config) — cubre backend/ (Node + TS, CommonJS) y
// frontend/ (Svelte 5 + TS, ESM) desde un único archivo, ya que ninguno de los dos
// workspaces tenía linter configurado (el README prometía "análisis estático estricto",
// pero eso se reducía a `tsc --noEmit`/`svelte-check` — sin reglas de estilo ni
// detección de código muerto/imports no usados).
//
// Deliberadamente SIN reglas type-aware (`recommendedTypeChecked`): requerirían apuntar
// cada bloque de archivos a su propio `tsconfig.json` (backend y frontend tienen
// `rootDir`/`include` distintos) a cambio de una ganancia marginal sobre lo que
// `tsc --noEmit` (ya ejecutado en CI) cubre. El objetivo aquí es higiene básica —
// variables/imports no usados, errores comunes — no un segundo type-checker.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/storage/**',
      '**/data/**',
      'backend/.venv/**',
      'frontend/.svelte-kit/**',
      '**/*.min.*',
      '**/coverage/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Los dos spreads de eslint-plugin-svelte (recomendado + ajustes para no chocar con
  // Prettier) van JUNTOS y TEMPRANO — ambos redefinen `languageOptions.parser` para
  // `**/*.svelte.ts` (los módulos de estado Runes, p. ej. documentState.svelte.ts) hacia
  // `svelte-eslint-parser`. Ese parser espera una estructura de componente/módulo
  // Svelte, no un archivo TS corriente, y falla con "Unexpected token {" en el primer
  // `import { ... }`. El override de más abajo (bloque "frontend/**/*.ts") debe quedar
  // DESPUÉS de ambos spreads para ganar la fusión — si `flat/prettier` fuera lo último
  // del array (como en el ejemplo oficial del plugin), resetearía el parser de vuelta.
  ...svelte.configs['flat/recommended'],
  ...svelte.configs['flat/prettier'],

  // ---------------------------------------------------------------------
  // Backend — Node.js 22, TypeScript, CommonJS
  // ---------------------------------------------------------------------
  {
    files: ['backend/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // El propio tsconfig ya tiene noUnusedLocals/noUnusedParameters estrictos —
      // aquí solo se añade el patrón `_` para parámetros intencionalmente ignorados
      // (ya usado en el código, p. ej. RpaExecutionOptions no usadas en el stub RPA).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // ---------------------------------------------------------------------
  // Frontend — Svelte 5 (Runes) + TypeScript, navegador
  // ---------------------------------------------------------------------
  {
    files: ['frontend/**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Svelte 5 Runes ($state/$derived/$props/...) son globals implícitos del
      // compilador, no imports — sin esto, no-undef los marcaría en cada componente.
      'no-undef': 'off',
    },
  },
  {
    files: ['frontend/**/*.ts'],
    languageOptions: { parser: tseslint.parser, globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Desactiva únicamente las reglas de estilo JS/TS que Prettier ya gobierna.
  prettierConfig
);
