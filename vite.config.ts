import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// getUserMedia, WebCrypto and service workers all require a secure origin.
// localhost counts as secure, but a phone hitting this machine over the LAN does
// not — run `npm run dev:https` (development) or `npm run preview:https` (the real
// build, for offline testing) and accept the self-signed certificate warning.
const useHttps = process.env.HTTPS === '1';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.svg', 'logo.png', 'logo-192.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Records can be large; never try to precache runtime data.
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'DRISHTI — Drug Sample Imaging, Standardization & Testing Information System',
        short_name: 'DRISHTI',
        description:
          'Colour-calibrated capture and tamper-evident recording of presumptive colorimetric field test results.',
        // Black, matching the achromatic dark palette. The splash screen and the
        // installed-app chrome are drawn from these before any CSS loads, so a
        // navy value here produced a blue flash ahead of a black interface.
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        // An SVG 'any' icon for browsers that take it, plus rasterised PNGs because
        // several Android launchers and the iOS home screen still expect real PNGs
        // at fixed sizes. The maskable PNG is a separate render with no framing
        // brackets and a tighter eye, so it survives the platform cropping its
        // corners to a circle. All are generated from src/core/brand/logo.ts by
        // `npm run logo`, so they cannot drift from the source mark.
        icons: [
          { src: 'logo.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    https: useHttps ? {} : undefined,
  },
  /*
   * The preview server matters more than it looks: it is the only way to exercise
   * the service worker, because vite-plugin-pwa does not generate one in dev. So
   * offline behaviour can only be tested against `vite preview`, and testing it on
   * a phone needs HTTPS for the same reason the dev server does — a service worker
   * will not register on an insecure LAN origin, which means no offline support and
   * no camera either.
   */
  preview: {
    host: true,
    port: 4173,
    https: useHttps ? {} : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
