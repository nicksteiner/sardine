import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

/**
 * Generates PWA icons from a single SVG source.
 *
 * Run: npm run pwa:icons
 *
 * Outputs PNG icons into app/public/:
 *   - pwa-64x64.png, pwa-192x192.png, pwa-512x512.png (manifest icons)
 *   - maskable-icon-512x512.png (Android adaptive icons)
 *   - apple-touch-icon-180x180.png (iOS home screen icon — iPad needs this)
 *   - favicon.ico
 */
export default defineConfig({
  headLinkOptions: {
    preset: '2023',
  },
  preset: {
    ...minimal2023Preset,
    // iOS needs opaque background for apple-touch-icon (no transparency)
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, 'favicon.ico']],
    },
    maskable: {
      sizes: [512],
      padding: 0.3, // safe zone for Android adaptive masking
      resizeOptions: { background: '#0a1628', fit: 'contain' },
    },
    apple: {
      sizes: [180],
      padding: 0.1,
      resizeOptions: { background: '#0a1628', fit: 'contain' },
    },
  },
  images: ['app/public/sardine-icon.svg'],
});
