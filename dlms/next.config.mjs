/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // The import upload POSTs a spreadsheet to a server action, and Next 14's
    // default action body limit is 1 MB — below what uploadImportAction allows,
    // so a file between the two would be rejected by the framework before the
    // action could report anything useful.
    //
    // SOURCE OF TRUTH: modules/manufacturing/domain/importLimits.ts
    // (MAX_UPLOAD_BYTES / MAX_UPLOAD_LABEL). The action and the upload form both
    // import it. A next.config.mjs cannot import from app code, so this literal
    // is a hand-kept duplicate — nothing enforces that the two agree, and the
    // build will not complain if they drift. Change both together, or the
    // framework starts rejecting uploads the action would have accepted (or the
    // reverse). 4 MB also sits under Vercel's ~4.5 MB platform request limit, so
    // the advertised cap is the real cap in every environment.
    serverActions: { bodySizeLimit: '4mb' },
  },
}
export default nextConfig
