import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pin the workspace root, or Next walks up and picks a stray lockfile
  // outside the repo when inferring what to trace
  turbopack: { root: path.join(__dirname) },
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
