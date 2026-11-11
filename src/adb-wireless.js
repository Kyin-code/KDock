export function parseAdbMdns(list) {
  const out = [];
  for (const raw of (list || [])) {
    const match = /^(.+?)\s+_(adb(?:-tls-connect|-tls-pairing)?)\._tcp\.?\s+([0-9.]+):(\d+)/.exec(String(raw).trim());
    if (!match) continue;
    out.push({
      name: match[1].replace(/\s+\(\d+\)$/, ""),
      kind: match[2],
      host: match[3],
      port: Number(match[4]),
    });
  }
  return out;
}

export function pairGuidFromText(text) {
  return (/\[guid=([^\]]+)\]/.exec(String(text || "")) || [])[1] || "";
}

export function normalizeAdbAddress(raw, port = null) {
  const value = String(raw || "").trim();
  if (!value) return { host: "", port: 0, target: "" };
  const withPort = /^(.+):(\d+)$/.exec(value);
  if (withPort) {
    const parsed = Number(withPort[2]);
    return Number.isInteger(parsed) && parsed > 0
      ? { host: withPort[1], port: parsed, target: `${withPort[1]}:${parsed}` }
      : { host: withPort[1], port: 0, target: "" };
  }
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed > 0
    ? { host: value, port: parsed, target: `${value}:${parsed}` }
    : { host: value, port: 0, target: "" };
}

export function findAdbConnectService(services, { guid = "", host = "" } = {}) {
  const connectable = (services || []).filter(
    (service) => service.kind === "adb-tls-connect" || service.kind === "adb",
  );
  const byGuid = guid
    ? connectable.find((service) => service.name === guid)
    : null;
  if (byGuid) return byGuid;
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost) return null;
  return connectable.find((service) => service.host === normalizedHost) || null;
}
