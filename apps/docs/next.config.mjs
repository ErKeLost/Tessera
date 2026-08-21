import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const isProduction = process.env.NODE_ENV === "production";

// This policy permits the inline assets Next/Fumadocs require while keeping
// executable plugins, framed embedding, and untrusted origins out of scope.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "Permissions-Policy", value: "accelerometer=(), autoplay=(self), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@data-elements/ai-sdk",
    "@data-elements/compiler",
    "@data-elements/core",
    "@data-elements/observability",
    "@data-elements/react",
    "@data-elements/runtime",
    "@data-elements/schema",
  ],
  outputFileTracingIncludes: {
    "/r/*": [".registry/**/*"],
  },
  async redirects() {
    return [
      {
        source: "/:lang/docs/agent-studio",
        destination: "/:lang/docs/agent",
        permanent: true,
      },
      {
        source: "/:lang/docs/agent-architecture",
        destination: "/:lang/docs/agent/architecture",
        permanent: true,
      },
      {
        source: "/:lang/docs/agent-architecture/:path*",
        destination: "/:lang/docs/agent/architecture/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withMDX(config);
