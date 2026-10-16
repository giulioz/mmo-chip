import { constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const tokenFile = process.env.CHIPTOOL_TOKEN_FILE ?? path.join(repoRoot, "node_modules/.cache/chiptool-token");

// Shared only by the local backend, Vite proxy and Python sidecar. Never sent
// to browser JS or embedded in image URLs. Exclusive creation handles npm dev's
// simultaneously starting processes without rotating a running server's token.
function loadToken(): string {
  const supplied = process.env.CHIPTOOL_DEV_TOKEN;
  if (supplied) {
    if (supplied.length < 32) throw new Error("CHIPTOOL_DEV_TOKEN must have at least 32 characters");
    return supplied;
  }
  mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(tokenFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, randomBytes(32).toString("hex")); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("The dev token must be an owner-only regular file");
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const fd = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let token: string;
    try { token = readFileSync(fd, "utf8").trim(); } finally { closeSync(fd); }
    if (/^[a-f0-9]{64}$/.test(token)) return token;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("Invalid dev token file");
}
export const DEV_TOKEN = loadToken();
export const allowedOrigins = (process.env.CHIPTOOL_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173").split(",").map(value => new URL(value.trim()).origin);
export const backendHosts = ["localhost", "127.0.0.1", "[::1]"].map(host => `${host}:${process.env.PORT ?? 3001}`);

export function validToken(value: unknown, token = DEV_TOKEN): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value), expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Origin-less native clients must still carry the token. Browser embeds cannot
// supply it. Explicit origins also protect the Vite proxy from DNS rebinding
// and same-site requests originating on a different localhost port.
export function trustedBrowserRequest(request: IncomingMessage, hosts: readonly string[], origins = allowedOrigins): boolean {
  if (!hosts.includes(request.headers.host ?? "")) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.includes(origin)) return false;
  const referer = request.headers.referer;
  if (referer) {
    try { if (!origins.includes(new URL(referer).origin)) return false; } catch { return false; }
  }
  const site = request.headers["sec-fetch-site"];
  return site !== "cross-site" && (site !== "same-site" || origin !== undefined || referer !== undefined);
}

// The proxy must see positive evidence of a trusted browser request before
// attaching its private token. Legacy embeds omitting Origin, Referer and
// fetch metadata cannot get credentials through an origin-less GET.
export function trustedProxyRequest(request: IncomingMessage, hosts: readonly string[]): boolean {
  return trustedBrowserRequest(request, hosts) && Boolean(
    request.headers.origin || request.headers.referer || request.headers["sec-fetch-site"] === "same-origin" ||
    validToken(request.headers["x-chiptool-token"])
  );
}

export function requireAccess(token = DEV_TOKEN): RequestHandler {
  let active = 0;
  let budget = 400;
  let updated = Date.now();
  return (request, response, next) => {
    if (!validToken(request.headers["x-chiptool-token"], token)) {
      response.status(401).json({ error: "Local dev token required" }); return;
    }
    // Native clients prove possession of the token. Browser traffic also
    // has to match the configured host and frontend origin.
    if ((request.headers.origin || request.headers["sec-fetch-site"] || request.headers.referer) &&
        !trustedBrowserRequest(request, backendHosts)) {
      response.status(403).json({ error: "Untrusted browser origin or host" }); return;
    }
    const now = Date.now();
    budget = Math.min(400, budget + (now - updated) * 0.2);
    updated = now;
    if (active >= 64 || budget < 1) {
      response.setHeader("Retry-After", "1");
      response.status(429).json({ error: "Request limit reached; retry later" }); return;
    }
    budget--;
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once("finish", release); response.once("close", release);
    response.setHeader("Cache-Control", "no-store");
    next();
  };
}

export function safeId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new HttpError(400, "Invalid identifier");
  }
  return value;
}

// Reject symlinks in all existing path components as well as lexical escapes.
// A datastore supplied by another user cannot redirect operations outside it.
export function dataPath(dataRoot: string, ...parts: string[]): string {
  const base = path.resolve(dataRoot), target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) throw new HttpError(400, "Path outside datastore");
  let current = base;
  for (const part of ["", ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new HttpError(400, "Symlinks are not allowed in the datastore"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

export function positiveLimit(name: string, fallback: number, ceiling = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`Invalid ${name}`);
  return value;
}
export const limits = {
  uploadBytes: positiveLimit("CHIPTOOL_MAX_UPLOAD_BYTES", 1024 * 1024 * 1024),
  imagePixels: positiveLimit("CHIPTOOL_LIMIT_INPUT_PIXELS", 4_000_000_000),
  imageDimension: positiveLimit("CHIPTOOL_MAX_IMAGE_DIMENSION", 100_000),
  regionPixels: positiveLimit("CHIPTOOL_MAX_REGION_PIXELS", 4_194_304),
  regionDimension: positiveLimit("CHIPTOOL_MAX_REGION_DIMENSION", 4096),
};
export function checkRegion(width: number, height: number): void {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) ||
      width > limits.regionDimension || height > limits.regionDimension || width * height > limits.regionPixels) {
    throw new HttpError(413, "Image region exceeds processing limits");
  }
}
export function checkImage(width: number, height: number, pixelLimit = limits.imagePixels): void {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width > limits.imageDimension ||
      height > limits.imageDimension || width * height > pixelLimit) throw new HttpError(413, "Image exceeds import limits");
}
