/** @type {import('next').NextConfig} */
// /api/* is handled by the filesystem BFF proxy route
// (web/app/api/[...path]/route.ts), which gates on the clinician session and
// injects the server-only API key. No rewrite to the backend is needed.
const nextConfig = {};

export default nextConfig;
