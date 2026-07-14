/**
 * Minimal in-memory ustar (POSIX.1-1988 tar) + gzip for `.mspack` archives
 * (design D3/§4). Dependency-free by intent. Pack payloads are small text
 * artifacts, so archives are built and extracted entirely in memory.
 *
 * The extraction guard IS the security surface (design §12, zip-slip row):
 * only regular files and directories are accepted; link entries of any kind,
 * absolute paths, `..` segments, backslashes, and empty/oversized names are
 * hard refusals — extraction never writes to disk here (callers receive
 * {path, data} pairs and stage them), which keeps the guard testable in
 * isolation.
 */
import { gzipSync, gunzipSync } from "node:zlib";

export type TarFile = { path: string; data: Buffer };

const BLOCK = 512;

function padTo(buffer: Buffer, size: number): Buffer {
  if (buffer.length % size === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(size - (buffer.length % size))]);
}

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, "0");
  return Buffer.from(`${text}\0`, "ascii");
}

function tarHeader(path: string, size: number, typeflag: "0" | "5"): Buffer {
  if (Buffer.byteLength(path, "utf-8") > 100) {
    // Keep it simple and predictable: pack-relative artifact paths are short.
    throw new Error(`tar: path longer than 100 bytes not supported: ${path}`);
  }
  const header = Buffer.alloc(BLOCK);
  header.write(path, 0, 100, "utf-8");
  octal(0o644, 8).copy(header, 100); // mode
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136); // mtime: fixed 0 for reproducible archives
  header.write("        ", 148, 8, "ascii"); // checksum placeholder
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/** Build a gzipped ustar archive from in-memory files. Paths must be archive-relative. */
export function createTarGz(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    assertSafeArchivePath(file.path);
    parts.push(tarHeader(file.path, file.data.length, "0"));
    parts.push(padTo(file.data, BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

export function assertSafeArchivePath(path: string): void {
  if (!path || path.length > 100) throw new Error(`unsafe archive path (empty or too long): ${JSON.stringify(path)}`);
  if (path.startsWith("/") || path.includes("\\")) throw new Error(`unsafe archive path (absolute or backslash): ${path}`);
  if (path.includes("\0")) throw new Error("unsafe archive path (NUL byte)");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe archive path (traversal or empty segment): ${path}`);
  }
}

/**
 * Extract a gzipped ustar archive fully in memory, enforcing the guard.
 * Throws on ANY unsafe entry — a partially-hostile archive yields nothing.
 */
export function extractTarGz(archive: Buffer): TarFile[] {
  const raw = gunzipSync(archive);
  const files: TarFile[] = [];
  let offset = 0;
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size for entry ${name}`);
    const typeflag = header.subarray(156, 157).toString("ascii");
    offset += BLOCK;
    const dataEnd = offset + size;
    if (dataEnd > raw.length) throw new Error(`tar: truncated entry ${name}`);
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      assertSafeArchivePath(name);
      files.push({ path: name, data: Buffer.from(raw.subarray(offset, dataEnd)) });
    } else if (typeflag === "5") {
      // Directory entries: validate the path but carry no data. Trailing "/" allowed.
      assertSafeArchivePath(name.replace(/\/+$/, ""));
    } else {
      // Links (hard/sym), devices, FIFOs — hostile in this context. Refuse the archive.
      throw new Error(`tar: refused entry type '${typeflag}' for ${name} (links and specials are not allowed)`);
    }
    offset = dataEnd + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }
  return files;
}
