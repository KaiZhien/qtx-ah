/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // The import upload POSTs a spreadsheet to a server action, and Next 14's
    // default action body limit is 1 MB — below what uploadImportAction itself
    // allows, so a file between the two would be rejected by the framework
    // before the action could report anything useful. 4 MB is the one number
    // this app uses: it matches uploadImportAction's own check and the form's
    // helper text, and it sits under Vercel's ~4.5 MB platform request limit so
    // the advertised cap is the real cap in every environment.
    serverActions: { bodySizeLimit: '4mb' },
  },
}
export default nextConfig
