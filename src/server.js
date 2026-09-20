import { createServer } from "node:http";
import {
  DomainError,
  bagTrace,
  buildSnapshot,
  closeFlight,
  computeBlockers,
  createFlight,
  createStore,
  dispositionException,
  flightSummary,
  generateManifest,
  ingestScan,
  latestManifest,
  offloadPassenger,
  reopenFlight,
  registerBag,
  registerPassenger,
  setPassengerStatus,
  signManifest,
  summarizeBag,
  swapAircraft,
  swapContainer,
  withdrawSignature,
} from "./domain.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function send(response, status, payload) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError("payload_too_large", "请求体超过 1MB 上限", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("invalid_json", "请求体不是合法 JSON", 400);
  }
}

function getFlightOr404(store, flightLegId) {
  const flight = store.flights.get(flightLegId);
  if (!flight) throw new DomainError("flight_not_found", `航班 ${flightLegId} 不存在`, 404);
  return flight;
}

/**
 * 路由表:[方法, 路径正则, 处理器(store, 捕获组, body, query)]。
 * 处理器返回 [status, payload] 或 payload(默认 200)。
 */
const routes = [
  ["GET", /^\/health$/, () => ({ status: "ok" })],

  ["POST", /^\/flights$/, (store, _m, body) => {
    const flight = createFlight(store, body);
    return [201, flightSummary(store, flight)];
  }],
  ["GET", /^\/flights$/, (store) => [...store.flights.values()].map((flight) => flightSummary(store, flight))],
  ["GET", /^\/flights\/([^/]+)$/, (store, m) => flightSummary(store, getFlightOr404(store, m[1]))],

  ["POST", /^\/flights\/([^/]+)\/passengers$/, (store, m, body) => [201, registerPassenger(store, m[1], body)]],
  ["POST", /^\/flights\/([^/]+)\/passengers\/([^/]+)\/status$/, (store, m, body) => setPassengerStatus(store, m[1], m[2], body)],

  ["POST", /^\/flights\/([^/]+)\/bags$/, (store, m, body) => [201, summarizeBag(registerBag(store, m[1], body))]],
  ["GET", /^\/flights\/([^/]+)\/bags$/, (store, m, _b, query) => {
    const flight = getFlightOr404(store, m[1]);
    let bags = [...flight.bags.values()];
    if (query.get("state")) bags = bags.filter((bag) => bag.state === query.get("state"));
    return bags.map(summarizeBag);
  }],
  ["GET", /^\/flights\/([^/]+)\/bags\/([^/]+)\/trace$/, (store, m) => bagTrace(store, getFlightOr404(store, m[1]), m[2])],

  ["POST", /^\/flights\/([^/]+)\/scans$/, (store, m, body) => {
    const result = ingestScan(store, m[1], body);
    return [result.duplicate ? 200 : 201, { ...result, bag: result.bag ? summarizeBag(result.bag) : null }];
  }],
  ["POST", /^\/flights\/([^/]+)\/scans\/batch$/, (store, m, body) => {
    const scans = Array.isArray(body?.scans) ? body.scans : null;
    if (!scans) throw new DomainError("invalid_field", "请求体必须包含 scans 数组", 400, { field: "scans" });
    const results = scans.map((scan) => {
      try {
        const result = ingestScan(store, m[1], scan);
        return { scanId: scan?.scanId ?? null, status: result.duplicate ? "duplicate" : "accepted", result: result.scan.result };
      } catch (error) {
        if (error instanceof DomainError) return { scanId: scan?.scanId ?? null, status: "rejected", code: error.code, message: error.message };
        throw error;
      }
    });
    return { results };
  }],

  ["POST", /^\/flights\/([^/]+)\/offloads$/, (store, m, body) => {
    const { passenger, bagsMarked } = offloadPassenger(store, m[1], body);
    return { passenger, bagsMarked };
  }],
  ["POST", /^\/flights\/([^/]+)\/container-swaps$/, (store, m, body) => swapContainer(store, m[1], body)],
  ["POST", /^\/flights\/([^/]+)\/aircraft-swap$/, (store, m, body) => swapAircraft(store, m[1], body)],

  ["GET", /^\/flights\/([^/]+)\/exceptions$/, (store, m, _b, query) => {
    const flight = getFlightOr404(store, m[1]);
    let exceptions = [...flight.exceptions.values()];
    if (query.get("status")) exceptions = exceptions.filter((ex) => ex.status === query.get("status"));
    return exceptions;
  }],
  ["POST", /^\/flights\/([^/]+)\/exceptions\/([^/]+)\/dispositions$/, (store, m, body) => dispositionException(store, m[1], m[2], body)],

  ["GET", /^\/flights\/([^/]+)\/blockers$/, (store, m) => ({ blockers: computeBlockers(store, getFlightOr404(store, m[1])) })],

  ["POST", /^\/flights\/([^/]+)\/manifests$/, (store, m, body) => [201, generateManifest(store, m[1], body)]],
  ["GET", /^\/flights\/([^/]+)\/manifests\/latest$/, (store, m) => {
    const flight = getFlightOr404(store, m[1]);
    const manifest = latestManifest(flight);
    if (!manifest) throw new DomainError("manifest_not_found", "航班尚未生成舱单", 404);
    return manifest;
  }],
  ["POST", /^\/flights\/([^/]+)\/manifests\/([^/]+)\/signatures$/, (store, m, body) => signManifest(store, m[1], m[2], body)],
  ["DELETE", /^\/flights\/([^/]+)\/manifests\/([^/]+)\/signatures\/([^/]+)$/, (store, m) => withdrawSignature(store, m[1], m[2], m[3])],

  ["POST", /^\/flights\/([^/]+)\/close$/, (store, m, body) => flightSummary(store, closeFlight(store, m[1], body))],
  ["POST", /^\/flights\/([^/]+)\/reopen$/, (store, m, body) => flightSummary(store, reopenFlight(store, m[1], body))],

  ["GET", /^\/flights\/([^/]+)\/audit$/, (store, m) => getFlightOr404(store, m[1]).audit],
  ["GET", /^\/flights\/([^/]+)\/snapshot$/, (store, m) => buildSnapshot(store, getFlightOr404(store, m[1]))],

  // 跨航班按行李牌还原扫描链路
  ["GET", /^\/bags\/([^/]+)\/trace$/, (store, m) => {
    for (const flight of store.flights.values()) {
      if (flight.bags.has(m[1]) || [...flight.scans.values()].some((scan) => scan.bagTag === m[1])) {
        return bagTrace(store, flight, m[1]);
      }
    }
    throw new DomainError("bag_not_found", `行李牌 ${m[1]} 不存在`, 404);
  }],
];

export function buildServer(options = {}) {
  const store = options.store ?? createStore();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      for (const [method, pattern, handler] of routes) {
        if (method !== request.method) continue;
        const match = pattern.exec(path);
        if (!match) continue;
        const needsBody = method === "POST" || method === "PUT" || method === "PATCH";
        const body = needsBody ? await readJsonBody(request) : {};
        const decoded = [match[0], ...match.slice(1).map((part) => decodeURIComponent(part))];
        const result = handler(store, decoded, body, url.searchParams);
        if (Array.isArray(result) && typeof result[0] === "number") {
          send(response, result[0], result[1]);
        } else {
          send(response, 200, result);
        }
        return;
      }
      send(response, 404, { error: { code: "not_found", message: "路由不存在" } });
    } catch (error) {
      if (error instanceof DomainError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        if (error.scan) payload.scan = error.scan;
        if (error.duplicate) payload.duplicate = true;
        send(response, error.status, payload);
      } else {
        send(response, 500, { error: { code: "internal_error", message: "服务器内部错误" } });
      }
    }
  });
  server.store = store;
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = buildServer();
  if (process.env.SEED_FILE) {
    const { seedFromFile } = await import("./seed.js");
    const summary = await seedFromFile(server.store, process.env.SEED_FILE);
    const failed = summary.outcomes.filter((outcome) => !outcome.ok);
    console.log(`已装载样例 ${process.env.SEED_FILE}:航班 ${summary.flightId},记录 ${summary.outcomes.length} 条,失败 ${failed.length} 条`);
    for (const outcome of failed) console.log(`  失败记录 ${outcome.record}: ${outcome.code} ${outcome.message}`);
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`行李装载核对中枢已启动,端口 ${port}`);
  });
}
