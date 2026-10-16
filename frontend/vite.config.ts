import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { allowedOrigins, DEV_TOKEN, tokenFile, trustedBrowserRequest, trustedProxyRequest } from "../backend/src/security";

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const hosts = allowedOrigins.map(origin => new URL(origin).host);

function protectProxy(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    if (!trustedBrowserRequest(req, hosts) || (req.url?.startsWith("/api") && !trustedProxyRequest(req, hosts))) {
      res.statusCode = 403;
      res.end("Untrusted browser origin or host");
      return;
    }
    next();
  });
  server.httpServer?.prependListener("upgrade", (req, socket) => {
    if (!trustedProxyRequest(req, hosts)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
}

export default defineConfig({
  plugins: [react(), {
    name: "local-api-access",
    configureServer: protectProxy,
    configurePreviewServer: protectProxy,
  }],
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/chiptool-token", tokenFile] },
    proxy: {
      "/api": {
        target: apiTarget, ws: true, changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", proxyReq => proxyReq.setHeader("x-chiptool-token", DEV_TOKEN));
          proxy.on("proxyReqWs", proxyReq => proxyReq.setHeader("x-chiptool-token", DEV_TOKEN));
        }
      }
    }
  }
});
