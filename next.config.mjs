/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A production build writes to its own directory, so running `npm run build`
  // can never overwrite the chunks a running `next dev` is serving.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
