// Componentes .svelte reales incorporados (HitlReviewView + App) — se requiere
// vitePreprocess() para que svelte-check y Vite resuelvan TypeScript/PostCSS dentro de
// bloques <script lang="ts"> y <style>.
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
};
