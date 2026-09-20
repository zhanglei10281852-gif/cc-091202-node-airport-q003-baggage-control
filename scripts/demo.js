// 场景演示：减客 → 离线扫描补传 → 容器更换 → 异常处置 → 双人签署 → 关闭装载。
// 运行：npm run demo

import { once } from "node:events";
import { Engine } from "../src/engine.js";
import { seedFromFixture } from "../src/seed.js";
import { buildServer } from "../src/server.js";

const engine = new Engine();
const server = buildServer({ engine }).listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

function show(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// 1. 装载随附记录（含一次减客、一组离线扫描、容器更换前后数据）。
const seeded = await seedFromFixture(engine);
const flight = seeded.flightLegId;
show("随附记录已回放", seeded);

// 2. 按行李牌还原扫描链路：减客旅客的行李 7812345678。
const chainOffloaded = await call("GET", `/flights/${flight}/bags/7812345678/chain`);
show("链路还原：7812345678（减客旅客行李，迟到扫描已按发生时间归位）", {
  状态: `${chainOffloaded.data.state}，必须卸下=${chainOffloaded.data.mustOffload}`,
  轨迹: chainOffloaded.data.trajectory.map((s) => ({
    扫描: s.scanId,
    动作: s.action,
    容器: s.container,
    发生: s.occurredAt,
    接收延迟秒: s.ingestLagSeconds,
    结果状态: s.resultingState,
    推定环节: s.implied,
  })),
  异常: chainOffloaded.data.exceptions.map((e) => `${e.id} ${e.type} ${e.status} ${e.resolution ?? ""}`),
});

// 3. 链路还原：经历容器更换的行李 7812345679。
const chainSwapped = await call("GET", `/flights/${flight}/bags/7812345679/chain`);
show("链路还原：7812345679（容器更换前后）", {
  状态: `${chainSwapped.data.state} (${chainSwapped.data.container})`,
  轨迹: chainSwapped.data.trajectory.map((s) => `${s.scanId}:${s.action}${s.container ? `@${s.container}` : ""}→${s.resultingState}`),
  被拒扫描: chainSwapped.data.otherScans.filter((s) => s.status === "REJECTED"),
});

// 4. 当前阻止关闭装载的具体清单。
let blockers = await call("GET", `/flights/${flight}/blockers`);
show("阻止关闭装载的清单", blockers.data.blockers);

// 5. 直接关闭会被拒绝并返回同样的清单。
const premature = await call("POST", `/flights/${flight}/close`, { operator: "ops.chen" });
show("未处置即关闭（被拒绝）", { 状态码: premature.status, 错误: premature.data });

// 6. 对唯一未决异常（扫描枪把行李误传进已停用容器）录入处置结论。
const open = await call("GET", `/flights/${flight}/exceptions?status=OPEN`);
const target = open.data[0];
const disposition = await call("POST", `/flights/${flight}/exceptions/${target.id}/disposition`, {
  operator: "ops.chen",
  conclusion: "GUN-09 离线缓存误传，实物现场复核在 AKE12002CZ，未进入已停用的 AKE12001CZ",
  note: "扫描枪已送检",
});
show(`异常 ${target.id}（${target.type}）处置结论`, disposition.data.resolution);

// 7. 双人签署同一舱单版本；同一操作者不能签两次。
const version = (await call("GET", `/flights/${flight}/manifest`)).data.version;
await call("POST", `/flights/${flight}/sign`, { operator: "ops.chen" });
const dupSign = await call("POST", `/flights/${flight}/sign`, { operator: "ops.chen" });
show("同一操作者重复签署（被拒绝）", { 状态码: dupSign.status, 错误: dupSign.data.error });
await call("POST", `/flights/${flight}/sign`, { operator: "ops.li" });
show("双人签署完成", `舱单版本 ${version}：ops.chen、ops.li`);

// 8. 关闭装载。
const closed = await call("POST", `/flights/${flight}/close`, { operator: "ops.chen" });
show("关闭装载", closed.data);

// 9. 关闭后扫描被拒绝；重开留下操作者并递增版本，原签署失效。
const lateScan = await call("POST", `/flights/${flight}/scans`, {
  scanId: "scan-late",
  bagTag: "7812345679",
  action: "OFFLOADED",
});
show("关闭后到达的扫描（被拒绝）", { 状态码: lateScan.status, 错误: lateScan.data.error });

await call("POST", `/flights/${flight}/reopen`, { operator: "ops.li", reason: "接到补扫任务，重新核对" });
blockers = await call("GET", `/flights/${flight}/blockers`);
show("重开后阻止清单（签署已随版本递增失效）", blockers.data.blockers);

// 10. 审计日志：签署、撤回、重开、处置均留操作者。
const events = await call("GET", `/flights/${flight}/events`);
show("操作者留痕（节选）", events.data
  .filter((e) => ["SIGNED", "WITHDRAWN", "CLOSED", "REOPENED", "EXCEPTION_DISPOSITION", "CONTAINER_REPLACED", "PASSENGER_OFFLOADED"].includes(e.type))
  .map((e) => `#${e.seq} ${e.type} by ${e.actor}: ${e.summary}`));

server.close();
