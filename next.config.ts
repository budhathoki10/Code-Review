import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  // Only relevant while testing through an ngrok tunnel instead of localhost.
  allowedDevOrigins: ["traveler-cookbook-natural-normally.trycloudflare.com"],
};

export default nextConfig;
