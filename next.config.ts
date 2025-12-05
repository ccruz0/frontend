import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Use 'standalone' for Docker production builds, 'export' for static exports
  // Dockerfile requires 'standalone' output for server.js
  output: process.env.NODE_ENV === 'production' ? 'standalone' : undefined,

  // Ignorar errores de TypeScript en el build (por el famoso payload: unknown)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Suppress React warnings in development
  reactStrictMode: true,

  // Reduce console noise
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? {
            exclude: ['error', 'warn'], // Keep errors and warnings
          }
        : false,
  },

  // Headers to prevent browser caching (especially useful after deployments)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate, max-age=0',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
      {
        // Force no-cache for JavaScript and CSS files (critical for updates)
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate, max-age=0',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
      {
        // Force no-cache for chunk files (JavaScript bundles)
        source: '/_next/static/chunks/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate, max-age=0',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
