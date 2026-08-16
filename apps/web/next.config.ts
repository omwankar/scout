import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@scout/shared"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
