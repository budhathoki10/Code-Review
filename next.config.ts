import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },

  // Set DEV_TUNNEL_ORIGIN (in .env, not committed) to whatever your current dev
  // tunnel hostname is (ngrok, TryCloudflare, etc.) instead of hardcoding one here —
  // TryCloudflare's Quick Tunnel in particular assigns a new random hostname on every
  // restart, so a hardcoded value goes stale and needs a fresh commit each time. Only
  // relevant while testing through a tunnel instead of localhost.
  allowedDevOrigins: process.env.AUTH_URL ? [process.env.AUTH_URL] : ["codereview.kushalbudhathoki.com.np"],

};

export default nextConfig;
