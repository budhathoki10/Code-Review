import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  // Only relevant while testing through an ngrok tunnel instead of localhost.
  allowedDevOrigins: ["sasquatch-rickety-imaging.ngrok-free.dev"],
};

export default nextConfig;
