import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The till must render fast on low-end counter hardware; no image optimisation
  // service is available in-shop when the network is down.
  images: { unoptimized: true },
};

export default nextConfig;
