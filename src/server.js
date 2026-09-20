// 行李装载核对中枢 HTTP 接口。
// 无外部依赖：node:http 自带路由。所有业务规则在 Engine 内同步完成，
// 这里只负责解析、转发和错误映射。

import { createServer } from "node:http";
import { Engine, EngineError } from "./engine.js";
import { seedFromFixture } from "./seed.js";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new EngineError("PAYLOAD_TOO_LARGE", "请求体超过 1MB 限制", 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EngineError("BAD_JSON", "请求体不是合法 JSON", 400);
  }
}

// 需要非 200 状态码的处理器用 respond 包装返回值，避免与数组响应体混淆。
class RawResponse {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
const respond = (status, body) => new RawResponse(status, body);

// 路由表：[方法, 路径模式（:参数）, 处理器]。处理器返回响应体（默认 200）或 respond(状态码, 响应体)。
const routes = [
  ["GET", "/health", () => ({ status: "ok" })],

  ["GET", "/flights", (engine) => engine.listFlights()],
  ["POST", "/flights", (engine, body) => respond(201, engine.createFlight(body))],
  ["GET", "/flights/:flight", (engine, _body, p) => engine.flightSummary(p.flight)],
  ["GET", "/flights/:flight/manifest", (engine, _body, p) => engine.manifest(p.flight)],
  ["GET", "/flights/:flight/blockers", (engine, _body, p) => engine.blockers(p.flight)],
  ["GET", "/flights/:flight/events", (engine, _body, p) => engine.events(p.flight)],
  ["GET", "/flights/:flight/bags", (engine, _body, p) => engine.bags(p.flight)],
  ["GET", "/flights/:flight/bags/:bagTag/chain", (engine, _body, p) => engine.bagChain(p.flight, p.bagTag)],
  ["GET", "/flights/:flight/exceptions", (engine, _body, p, query) =>
    engine.exceptions(p.flight, { status: query.get("status") ?? undefined })],

  ["POST", "/flights/:flight/passengers", (engine, body, p) =>
    respond(201, engine.registerPassenger(p.flight, {
      passengerId: body.passengerId,
      bagTags: body.bagTags ?? (body.bagTag ? [body.bagTag] : []),
      name: body.name,
    }))],
  ["POST", "/flights/:flight/passengers/:passenger/board", (engine, _body, p) =>
    engine.boardPassenger(p.flight, p.passenger)],
  // 减客事件：到达后立即标记必须卸下的行李。
  ["POST", "/flights/:flight/passengers/:passenger/offload", (engine, body, p) =>
    engine.offloadPassenger(p.flight, p.passenger, {
      operator: body.operator,
      reason: body.reason,
      at: body.at,
    })],

  // 扫描接收：单条或批量（离线扫描枪补传）。逐条独立处理，互不影响。
  ["POST", "/flights/:flight/scans", (engine, body, p) => {
    const source = body.source;
    if (Array.isArray(body.scans)) {
      return { results: engine.ingestScans(p.flight, body.scans, { source }) };
    }
    return engine.ingestScan(p.flight, body, { source });
  }],

  ["POST", "/flights/:flight/containers/:uld/replace", (engine, body, p) =>
    engine.replaceContainer(p.flight, p.uld, {
      newContainer: body.newContainer,
      operator: body.operator,
      reason: body.reason,
    })],
  ["POST", "/flights/:flight/aircraft/change", (engine, body, p) =>
    engine.changeAircraft(p.flight, {
      newAircraftId: body.newAircraftId,
      operator: body.operator,
      reason: body.reason,
    })],

  ["POST", "/flights/:flight/exceptions/:exception/disposition", (engine, body, p) =>
    engine.dispositionException(p.flight, p.exception, {
      operator: body.operator,
      conclusion: body.conclusion,
      note: body.note,
    })],

  ["POST", "/flights/:flight/sign", (engine, body, p) => engine.sign(p.flight, body)],
  ["POST", "/flights/:flight/withdraw", (engine, body, p) => engine.withdraw(p.flight, body)],
  ["POST", "/flights/:flight/close", (engine, body, p) => engine.close(p.flight, body)],
  ["POST", "/flights/:flight/reopen", (engine, body, p) => engine.reopen(p.flight, body)],

  // 跨航班按行李牌还原扫描链路。
  ["GET", "/bags/:bagTag/chain", (engine, _body, p) => {
    const found = engine.findBag(p.bagTag);
    if (found.length === 0) {
      throw new EngineError("BAG_NOT_FOUND", `行李牌不存在: ${p.bagTag}`, 404);
    }
    return { bagTag: p.bagTag, flights: found };
  }],

  // 演示与联调用：从 fixtures/context.json 播种；重置清空全部数据。
  ["POST", "/admin/seed", async (engine) => seedFromFixture(engine)],
  ["POST", "/admin/reset", async (engine) => {
    engine.reset();
    return { status: "reset" };
  }],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

export function buildServer({ engine = new Engine() } = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const matched = matchRoute(request.method, url.pathname);
      if (!matched) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const body = request.method === "GET" ? {} : await readBody(request);
      const result = await matched.handler(engine, body, matched.params, url.searchParams);
      if (result instanceof RawResponse) {
        sendJson(response, result.status, result.body);
      } else {
        sendJson(response, 200, result);
      }
    } catch (err) {
      if (err instanceof EngineError) {
        const payload = { error: err.code, message: err.message };
        if (err.details !== undefined) payload.details = err.details;
        sendJson(response, err.httpStatus, payload);
      } else {
        sendJson(response, 500, { error: "internal_error", message: String(err?.message ?? err) });
      }
    }
  });
}

async function main() {
  const engine = new Engine();
  try {
    const summary = await seedFromFixture(engine);
    console.log(
      `已装载随附记录：航班 ${summary.flightLegId}，记录 ${summary.records} 条，` +
        `扫描应用 ${summary.scansApplied}、拒绝 ${summary.scansRejected}、重复 ${summary.scansDuplicate}，` +
        `未决异常 ${summary.openExceptions} 条`,
    );
  } catch (err) {
    console.warn(`随附记录装载失败（继续启动空实例）: ${err.message}`);
  }
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  buildServer({ engine }).listen(port, "0.0.0.0", () => {
    console.log(`行李装载核对中枢已启动: http://0.0.0.0:${port}`);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
