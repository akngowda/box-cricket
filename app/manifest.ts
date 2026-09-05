import type { MetadataRoute } from 'next';

/** Phase 7 — installable to the home screen, no app store. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Box Cricket',
    short_name: 'Box Cricket',
    description: 'Weekend box cricket — live scores, scorecards and rankings',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1512',
    theme_color: '#0b1512',
    orientation: 'portrait',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
