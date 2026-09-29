const te = new TextEncoder();
const td = new TextDecoder();
const RED_KEY_TEXT = "reeden-resource-container-v1" + "reeden-private-red-bundle" + "not-a-user-password-boundary";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WATERMARK_START_PIXEL = 1000;
const PBKDF2_ITERATIONS = 200_000;
const LICENSE_PUBLIC_SPKI = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAszc8mgK9xNCDZqiErOURtOhOjpNwUB5stMlYjJKVIeaTVv8LZjU0XpuBLqtUHvdAJvxmL7hMYMYubHxaPmJOBBA52i7t0Q6wYHPc07EAZaO4SolhmHY63GzNuifmgMCiNCjgOvkX6o+gsRUJ5FXQmEqzWEcTx/dJz4fTdzruZ3C0o/blSRvvygejfajK2uuaTNgtlMjB3e7vIfi11qeLpOdFFHABweeRlg25vX0ZtZkIhfvE4rz60Em/T5Qw/cpDtqWWpsK1zq6rjWlI46QB7306avhKO54WEw8SWhMzZ0K3q2mbpct+yk1rLIS7f18SH+ueDp2QRdyTeHewi8NbOQIDAQAB";

const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");

export const CATEGORY_LABELS = Object.freeze({
  cover: "封面",
  splash: "启动图",
  theme_bg: "主题背景",
  carousel: "书架轮播",
  reader: "阅读背景",
  navbar: "导航图标",
  other: "其他图片",
});

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

export function isPng(bytes) {
  return bytes.length > 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

export function watermarkCategory(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("cover_gallery/")) return "cover";
  if (normalized.startsWith("custom_splash/")) return "splash";
  if (normalized.startsWith("navbar_pack/")) return "navbar";
  if (normalized.startsWith("reader_schema/")) return "reader";
  if (normalized.includes("bookshelf_carousel/")) return "carousel";
  if (normalized.endsWith("theme_bg.img") || normalized.includes("/theme_bg.")) return "theme_bg";
  return "other";
}

function concat(parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function base64urlToBytes(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function redKey() {
  return crypto.subtle.importKey(
    "raw",
    await sha256(te.encode(RED_KEY_TEXT)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
}

async function inflateRaw(data) {
  if (!("DecompressionStream" in globalThis)) throw new Error("当前浏览器版本不支持读取压缩 RED，请升级系统浏览器");
  const stream = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

async function readZip(zip) {
  let eocd = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 66_000); index -= 1) {
    if (u32(zip, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("RED 内的 ZIP 目录不完整");
  const count = u16(zip, eocd + 10);
  if (count > 20_000) throw new Error("RED 内资源数量异常");
  const centralOffset = u32(zip, eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || u32(zip, cursor) !== 0x02014b50) throw new Error("RED 的 ZIP 中央目录损坏");
    const method = u16(zip, cursor + 10);
    const compressedSize = u32(zip, cursor + 20);
    const nameLength = u16(zip, cursor + 28);
    const extraLength = u16(zip, cursor + 30);
    const commentLength = u16(zip, cursor + 32);
    const localOffset = u32(zip, cursor + 42);
    const path = td.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    if (localOffset + 30 > zip.length || u32(zip, localOffset) !== 0x04034b50) throw new Error("RED 的 ZIP 文件头损坏");
    const localNameLength = u16(zip, localOffset + 26);
    const localExtraLength = u16(zip, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > zip.length) throw new Error("RED 的 ZIP 资源越界");
    let data = zip.slice(start, start + compressedSize);
    if (method === 8) data = await inflateRaw(data);
    else if (method !== 0) throw new Error("当前浏览器不支持这个 ZIP 压缩方式");
    if (!path.endsWith("/")) entries.push({ path, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function parseRed(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 8 || td.decode(bytes.subarray(0, 3)) !== "RED") throw new Error("这不是有效的 RED 文件");
  if (bytes[3] === 4) return { kind: "plain", entries: await readZip(bytes.subarray(4)) };
  if (bytes[3] !== 16) throw new Error("暂不支持这个 RED 版本");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false);
  const headerEnd = 8 + headerLength;
  if (headerEnd > bytes.length || headerLength > 1_000_000) throw new Error("RED 文件头损坏");
  let header;
  try { header = JSON.parse(td.decode(bytes.subarray(8, headerEnd))); }
  catch { throw new Error("RED 文件头无法读取"); }
  const manifestLength = Number(header.manifestLength || 0);
  const manifestEnd = headerEnd + manifestLength;
  if (manifestLength < 16 || manifestEnd > bytes.length) throw new Error("RED 资源清单损坏");
  let manifest;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64urlToBytes(header.manifestNonce), tagLength: 128 },
      await redKey(),
      bytes.slice(headerEnd, manifestEnd),
    );
    manifest = JSON.parse(td.decode(plain));
  } catch { throw new Error("RED 清单解密或完整性校验失败"); }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > 20_000) throw new Error("RED 资源清单结构无效");
  const resources = bytes.subarray(manifestEnd);
  const entries = [];
  for (const item of manifest.entries) {
    const offset = Number(item.offset);
    const length = Number(item.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > resources.length) {
      throw new Error(`RED 资源越界：${String(item.path || "未知资源")}`);
    }
    const data = resources.slice(offset, offset + length);
    if (item.sha256 && hex(await sha256(data)) !== String(item.sha256).toLowerCase()) {
      throw new Error(`RED 资源完整性错误：${String(item.path || "未知资源")}`);
    }
    entries.push({ path: String(item.path || ""), data });
  }
  return { kind: "encrypted", entries };
}

async function canvasFromPng(bytes) {
  if (typeof document === "undefined") throw new Error("当前环境无法读取图片");
  const blob = new Blob([bytes], { type: "image/png" });
  const canvas = document.createElement("canvas");
  if ("createImageBitmap" in globalThis) {
    const source = await createImageBitmap(blob);
    canvas.width = source.width; canvas.height = source.height;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
    source.close();
    return canvas;
  }
  const source = await new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
    image.src = url;
  });
  canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
  return canvas;
}

export async function extractImageWatermark(bytes) {
  const canvas = await canvasFromPng(bytes);
  const pixels = canvas.width * canvas.height;
  if (pixels <= WATERMARK_START_PIXEL) return null;
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const read = count => {
    const output = new Uint8Array(count);
    let bitIndex = 0;
    for (let pixel = WATERMARK_START_PIXEL; pixel < pixels && bitIndex < count * 8; pixel += 1) {
      const position = pixel * 4;
      for (let channel = 0; channel < 3 && bitIndex < count * 8; channel += 1) {
        output[bitIndex >> 3] |= (data[position + channel] & 1) << (7 - (bitIndex & 7));
        bitIndex += 1;
      }
    }
    return output;
  };
  const header = read(4);
  const prefix = String.fromCharCode(header[0], header[1]);
  const length = (header[2] << 8) | header[3];
  if (prefix === "WM" && length >= 5 && length <= 12) {
    const value = td.decode(read(4 + length).subarray(4));
    return /^\d{5,12}$/.test(value) ? { type: "qq", qq: value } : null;
  }
  if (prefix === "EW" && length >= 36 && length <= 96) {
    const raw = read(4 + length).subarray(4);
    const offline = raw.length === 36 && raw[0] === 0x45 && raw[1] === 0x57 && raw[2] === 0x33 && raw[3] === 0x01;
    const legacy = raw.length >= 36 && raw[0] === 0x45 && raw[1] === 0x57 && raw[2] === 0x32 && raw[3] === 0x01;
    if (offline || legacy) return { type: "token", token: bytesToBase64url(raw), mode: offline ? "offline" : "legacy-online" };
  }
  return null;
}

export async function tokenId(token) {
  return hex(await sha256(te.encode(String(token || "")))).slice(0, 12).toUpperCase();
}

export function validateRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("分发记录不是有效的 JSON 对象");
  if (registry.format === "RED-DISTRIBUTION-REGISTRY-V2" && Array.isArray(registry.records)) return registry;
  if (registry.format === "ERROR-DOOR-DISTRIBUTION-3" && Number(registry.schema_version) === 3 && Array.isArray(registry.sources) && Array.isArray(registry.recipients)) return registry;
  throw new Error("这不是错误的门支持的分发记录");
}

export function flattenRegistry(rawRegistry) {
  const registry = validateRegistry(rawRegistry);
  const result = [];
  if (registry.format === "RED-DISTRIBUTION-REGISTRY-V2") {
    for (const record of registry.records.slice(0, 10_000)) {
      result.push({
        ...record,
        batch_id: String(registry.batch_id || String(registry.source_sha256 || "").slice(0, 12).toUpperCase()),
        source_name: String(record.source_name || registry.source_name || ""),
        source_sha256: String(record.source_sha256 || registry.source_sha256 || "").toLowerCase(),
        created_at: String(record.created_at || registry.created_at || ""),
      });
    }
    return result;
  }
  const sources = new Map(registry.sources.map(source => [String(source.source_id || ""), source]));
  for (const recipient of registry.recipients.slice(0, 10_000)) {
    for (const generated of (Array.isArray(recipient.generated_files) ? recipient.generated_files : []).slice(0, 10_000)) {
      const source = sources.get(String(generated.source_id || "")) || {};
      result.push({
        ...generated,
        qq: String(recipient.qq || ""),
        label: String(recipient.label || ""),
        email: String(recipient.email || ""),
        mail_status: String(recipient.mail_status || "pending"),
        sent_at: String(recipient.sent_at || ""),
        batch_id: String(registry.batch_id || ""),
        source_name: String(generated.source_name || source.name || ""),
        source_sha256: String(generated.source_sha256 || source.sha256 || "").toLowerCase(),
        created_at: String(generated.created_at || registry.created_at || ""),
        package_file: String(generated.relative_path || generated.package_file || ""),
      });
    }
  }
  return result;
}

export function flattenBundles(bundles) {
  return (bundles || []).flatMap(bundle => flattenRegistry(bundle.registry || bundle));
}

export function resolveWatermarkToken(token, bundles) {
  return flattenBundles(bundles).find(record => String(record.watermark_token || "") === String(token || "")) || null;
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(String(value || ""))) return null;
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

async function recipientFingerprint(masterSecret, sourceHash, qq) {
  const salt = concat([sourceHash.slice(0, 16), new Uint8Array([0x9b, 0x17]), te.encode("red-dist-v2")]);
  const material = await crypto.subtle.importKey("raw", te.encode(masterSecret), "PBKDF2", false, ["deriveBits"]);
  const sourceKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    material,
    256,
  ));
  const hmacKey = await crypto.subtle.importKey("raw", sourceKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, concat([te.encode("recipient-v2"), new Uint8Array([0]), te.encode(qq)])));
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function queryHistory(qq, masterSecret, bundles) {
  const normalizedQQ = String(qq || "").trim();
  if (!/^\d{5,12}$/.test(normalizedQQ)) throw new Error("QQ 必须是 5–12 位数字");
  if (String(masterSecret || "").length < 10) throw new Error("核验密钥至少需要 10 个字符");
  const candidates = flattenBundles(bundles).filter(record => String(record.qq || "") === normalizedQQ);
  const expectedBySource = new Map();
  const matches = [];
  for (const record of candidates) {
    const sourceHashHex = String(record.source_sha256 || "").toLowerCase();
    const fingerprint = String(record.fingerprint || "").toLowerCase();
    const sourceHash = hexToBytes(sourceHashHex);
    if (!sourceHash || !/^[0-9a-f]{64}$/.test(fingerprint)) continue;
    if (!expectedBySource.has(sourceHashHex)) expectedBySource.set(sourceHashHex, hex(await recipientFingerprint(String(masterSecret), sourceHash, normalizedQQ)));
    if (safeEqual(expectedBySource.get(sourceHashHex), fingerprint)) matches.push(record);
  }
  matches.sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  return { matches, candidateCount: candidates.length };
}

let publicKeyPromise;
function licensePublicKey() {
  if (!publicKeyPromise) {
    publicKeyPromise = crypto.subtle.importKey(
      "spki",
      base64ToBytes(LICENSE_PUBLIC_SPKI),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  return publicKeyPromise;
}

async function verifySignedBytes(payload, signature) {
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, await licensePublicKey(), signature, payload);
}

export async function verifyLicenseCodeLocal(licenseCode, machineCode, today = new Date().toISOString().slice(0, 10)) {
  const normalized = String(licenseCode || "").replace(/\s+/g, "");
  const machine = String(machineCode || "").trim().toUpperCase();
  if (!/^EDR-(?:[A-F0-9]{4}-){4}[A-F0-9]{4}$/.test(machine)) throw new Error("机器码格式无效");
  const parts = normalized.split(".");
  if (parts.length !== 3 || parts[0] !== "EDL1") throw new Error("授权码格式无效");
  const payloadBytes = base64urlToBytes(parts[1]);
  if (!await verifySignedBytes(payloadBytes, base64urlToBytes(parts[2]))) throw new Error("授权码签名无效");
  let payload;
  try { payload = JSON.parse(td.decode(payloadBytes)); }
  catch { throw new Error("授权码内容无效"); }
  if (payload?.v !== 1 || payload?.p !== "error-door") throw new Error("授权码不属于这个程序");
  if (String(payload.m || "") !== machine) throw new Error("授权码与该机器码不匹配");
  if (payload.exp && (!/^\d{4}-\d{2}-\d{2}$/.test(payload.exp) || today >= payload.exp)) throw new Error(`授权已于 ${payload.exp} 到期`);
  return { payload, machine };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function verifyAuthorizationState(state) {
  if (!state || !["ERROR-DOOR-AUTH-STATE-1", "ERROR-DOOR-AUTH-STATE-2"].includes(state.format)) throw new Error("授权状态文件格式无效");
  const payload = {
    format: state.format,
    revision: Number(state.revision),
    issued_at: String(state.issued_at || ""),
    revoked_license_ids: Array.isArray(state.revoked_license_ids) ? state.revoked_license_ids : [],
    revoked_machine_hashes: Array.isArray(state.revoked_machine_hashes) ? state.revoked_machine_hashes : [],
  };
  if (state.format === "ERROR-DOOR-AUTH-STATE-2") payload.minimum_client_version = String(state.minimum_client_version || "");
  if (!Number.isInteger(payload.revision) || payload.revision < 1 || Number.isNaN(Date.parse(payload.issued_at))) throw new Error("授权状态文件内容无效");
  const valid = await verifySignedBytes(te.encode(stableStringify(payload)), base64urlToBytes(state.signature));
  if (!valid) throw new Error("授权状态文件签名无效");
  return payload;
}

export async function applyAuthorizationState(localLicense, rawState) {
  const state = await verifyAuthorizationState(rawState);
  const licenseId = String(localLicense.payload.lid || "");
  const machineHash = hex(await sha256(te.encode(localLicense.machine)));
  if (licenseId && state.revoked_license_ids.includes(licenseId)) throw new Error("此授权已停止使用，请联系制作人@uyu");
  if (state.revoked_machine_hashes.includes(machineHash)) throw new Error("此设备的授权已停止使用，请联系制作人@uyu");
  return { ...localLicense, state };
}

export function maskEmail(email) {
  const value = String(email || "");
  const at = value.indexOf("@");
  if (at < 2) return value;
  return `${value.slice(0, 2)}${"*".repeat(Math.min(5, at - 2))}${value.slice(at)}`;
}
