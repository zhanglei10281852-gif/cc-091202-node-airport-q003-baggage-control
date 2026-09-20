import assert from "node:assert/strict";
import test from "node:test";
import {
  closeFlight,
  computeBlockers,
  createFlight,
  createStore,
  dispositionException,
  generateManifest,
  ingestScan,
  offloadPassenger,
  reopenFlight,
  registerBag,
  registerPassenger,
  setPassengerStatus,
  signManifest,
  swapAircraft,
  swapContainer,
  withdrawSignature,
} from "../src/domain.js";

function makeStore() {
  let tick = 0;
  return createStore({
    now: () => new Date(Date.parse("2026-09-12T20:00:00+08:00") + (tick += 1) * 1000).toISOString(),
  });
}

function setupFlightWithBag(store, { bagTag = "T1", passengerId = "P1" } = {}) {
  createFlight(store, { flightLegId: "F1", aircraftId: "B-1" });
  registerPassenger(store, "F1", { passengerId });
  registerBag(store, "F1", { bagTag, passengerId });
  return store.flights.get("F1");
}

function scan(store, payload) {
  return ingestScan(store, "F1", payload);
}

function bagOf(store, bagTag = "T1") {
  return store.flights.get("F1").bags.get(bagTag);
}

function openExceptions(store) {
  return [...store.flights.get("F1").exceptions.values()].filter((ex) => ex.status === "OPEN");
}

test("迟到乱序扫描按 occurredAt 重排,物理先后不被破坏", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "s", bagTag: "T1", action: "SORTED", occurredAt: "2026-09-12T16:30:00+08:00" });

  // 装机扫描先到达(发生 18:01),装箱扫描离线补传后到(发生 17:55)
  scan(store, { scanId: "scan-2", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T18:01:00+08:00" });
  assert.equal(bagOf(store).state, "ON_AIRCRAFT");

  scan(store, { scanId: "scan-1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:55:00+08:00" });
  const bag = bagOf(store);
  assert.equal(bag.state, "ON_AIRCRAFT");
  assert.equal(bag.container, "AKE1"); // 重排后:先装箱后装机,归属清晰
  assert.equal(bag.position, "11P");
  assert.equal(openExceptions(store).length, 0);
  const flight = store.flights.get("F1");
  assert.equal(flight.scans.get("scan-1").result, "APPLIED");
  assert.equal(flight.scans.get("scan-2").result, "APPLIED");
});

test("同一 scanId 重试幂等,不产生二次效果", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  const payload = { scanId: "x1", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" };
  const first = scan(store, payload);
  assert.equal(first.duplicate, false);
  const versionAfterFirst = store.flights.get("F1").contentVersion;

  const second = scan(store, payload);
  assert.equal(second.duplicate, true);
  assert.equal(second.scan.scanId, "x1");
  assert.equal(bagOf(store).events.length, 1);
  assert.equal(store.flights.get("F1").contentVersion, versionAfterFirst);
});

test("同一件行李被扫进两个集装器:后者判为冲突,行李不双挂", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  const conflict = scan(store, { scanId: "c2", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE2", occurredAt: "2026-09-12T17:05:00+08:00" });

  assert.equal(conflict.scan.result, "CONTESTED");
  assert.equal(bagOf(store).container, "AKE1"); // 唯一有效位置不变
  const exceptions = openExceptions(store);
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].type, "LOCATION_CONFLICT");
  assert.deepEqual(exceptions[0].evidence, ["c2"]);

  // 处置:作废错误扫描后重新折叠,历史恢复干净
  const dispositioned = dispositionException(store, "F1", exceptions[0].exceptionId, { operator: "sup-01", action: "VOID_SCAN", scanId: "c2" });
  assert.equal(dispositioned.status, "DISPOSITIONED");
  assert.equal(store.flights.get("F1").scans.get("c2").result, "VOIDED_BY_OPERATOR");
  assert.equal(bagOf(store).container, "AKE1");
  assert.equal(openExceptions(store).length, 0);
});

test("违反物理先后的扫描被判 ORDER_VIOLATION", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  // 未收运直接装箱
  const result = scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  assert.equal(result.scan.result, "CONTESTED");
  assert.equal(bagOf(store).state, "NONE");
  assert.equal(openExceptions(store)[0].type, "ORDER_VIOLATION");

  // 迟到的收运扫描(发生时间更早)补传后,历史重排为合法轨迹
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  assert.equal(bagOf(store).state, "IN_CONTAINER");
  assert.equal(bagOf(store).container, "AKE1");
});

test("减客后立即标出待卸行李,禁止再装机,卸下并处置后结案", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });

  const { bagsMarked } = offloadPassenger(store, "F1", { passengerId: "P1", operator: "gate-01", reason: "no_show" });
  assert.deepEqual(bagsMarked, ["T1"]);
  assert.equal(bagOf(store).mustOffload, true);
  const pending = openExceptions(store).find((ex) => ex.type === "OFFLOAD_PENDING");
  assert.ok(pending);

  // 减客旅客的行李禁止装机
  assert.throws(() => scan(store, { scanId: "la", bagTag: "T1", action: "LOADED_AIRCRAFT", occurredAt: "2026-09-12T17:30:00+08:00" }), /已减客/);
  assert.equal(store.flights.get("F1").scans.get("la").result, "REJECTED");

  // 未卸下前不能结案
  assert.throws(() => dispositionException(store, "F1", pending.exceptionId, { operator: "sup-01", action: "ACKNOWLEDGE" }), /尚未卸下/);

  scan(store, { scanId: "u1", bagTag: "T1", action: "UNLOADED", occurredAt: "2026-09-12T17:40:00+08:00" });
  assert.equal(bagOf(store).state, "OFFLOADED");
  assert.equal(bagOf(store).mustOffload, false);
  assert.deepEqual(pending.evidence, ["u1"]); // 卸下扫描自动回填证据

  const done = dispositionException(store, "F1", pending.exceptionId, { operator: "sup-01", action: "ACKNOWLEDGE", note: "行李已退回分拣" });
  assert.equal(done.status, "DISPOSITIONED");
  assert.equal(done.disposition.operator, "sup-01");
});

test("容器更换:冻结受影响行李并要求重新核对,不悄悄搬移归属", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });

  const { affectedBags } = swapContainer(store, "F1", { oldContainerId: "AKE1", newContainerId: "AKE2", operator: "lm-01", reason: "uld_damaged" });
  assert.deepEqual(affectedBags, ["T1"]);
  const bag = bagOf(store);
  assert.equal(bag.container, "AKE1"); // 归属未被悄悄搬移
  assert.equal(bag.frozen.reason, "CONTAINER_SWAP");
  assert.equal(store.flights.get("F1").containers.get("AKE1").status, "RETIRED");

  // 冻结期间:普通扫描被拒,已停用容器拒装
  assert.throws(() => scan(store, { scanId: "s1", bagTag: "T1", action: "SORTED", occurredAt: "2026-09-12T17:10:00+08:00" }), /冻结/);
  assert.throws(() => scan(store, { scanId: "c2", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:10:00+08:00" }), /已停用/);

  // 未重新核对前不能结案
  const exception = openExceptions(store).find((ex) => ex.type === "CONTAINER_SWAP_REVERIFY");
  assert.throws(() => dispositionException(store, "F1", exception.exceptionId, { operator: "sup-01", action: "ACKNOWLEDGE" }), /仍冻结/);

  // 重新核对:扫入新容器后解冻并留证据
  scan(store, { scanId: "c3", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE2", occurredAt: "2026-09-12T17:20:00+08:00" });
  assert.equal(bagOf(store).container, "AKE2");
  assert.equal(bagOf(store).frozen, null);
  assert.deepEqual(exception.evidence, ["c3"]);
  dispositionException(store, "F1", exception.exceptionId, { operator: "sup-01", action: "ACKNOWLEDGE" });
  assert.equal(openExceptions(store).length, 0);
});

test("飞机更换:已装机行李冻结,需在新飞机上重新扫描核对", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  scan(store, { scanId: "l1", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T17:30:00+08:00" });
  assert.equal(bagOf(store).loadedAircraftId, "B-1");

  swapAircraft(store, "F1", { newAircraftId: "B-2", operator: "lm-01", reason: "机务故障" });
  const bag = bagOf(store);
  assert.equal(bag.loadedAircraftId, "B-1"); // 历史归属不变
  assert.equal(bag.frozen.reason, "AIRCRAFT_SWAP");
  assert.equal(store.flights.get("F1").aircraftId, "B-2");

  // 在新飞机上重新扫描:解冻,归属更新到新飞机
  scan(store, { scanId: "l2", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T18:00:00+08:00" });
  assert.equal(bagOf(store).loadedAircraftId, "B-2");
  assert.equal(bagOf(store).frozen, null);
  const exception = [...store.flights.get("F1").exceptions.values()].find((ex) => ex.type === "AIRCRAFT_SWAP_REVERIFY");
  assert.deepEqual(exception.evidence, ["l2"]);
});

function readyToClose(store) {
  // 旅客登机 + 行李装机 + 出舱单 + 双人签署
  setPassengerStatus(store, "F1", "P1", { status: "BOARDED", operator: "gate-01" });
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  scan(store, { scanId: "l1", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T17:30:00+08:00" });
  const manifest = generateManifest(store, "F1", { operator: "lm-01" });
  signManifest(store, "F1", manifest.version, { operator: "lm-01" });
  signManifest(store, "F1", manifest.version, { operator: "ctl-02" });
  return manifest;
}

test("关闭装载:双人签署同一舱单版本且无阻塞项才可关闭", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  readyToClose(store);
  const closed = closeFlight(store, "F1", { operator: "ctl-02" });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closedBy, "ctl-02");

  // 关闭后拒收扫描
  assert.throws(() => scan(store, { scanId: "z", bagTag: "T1", action: "UNLOADED", occurredAt: "2026-09-12T19:00:00+08:00" }), /已关闭装载/);
});

test("签署必须基于同一舱单版本:内容变化后旧签署失效", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  const manifest = readyToClose(store);

  // 签署后来了一条新扫描 → 舱单过期
  scan(store, { scanId: "extra", bagTag: "T1", action: "UNLOADED", position: "11P", occurredAt: "2026-09-12T18:00:00+08:00" });
  const blockers = computeBlockers(store, store.flights.get("F1"));
  assert.ok(blockers.some((b) => b.code === "MANIFEST_STALE"));
  assert.throws(() => closeFlight(store, "F1", { operator: "ctl-02" }), (error) => {
    assert.equal(error.code, "close_blocked");
    assert.ok(error.details.blockers.some((b) => b.code === "MANIFEST_STALE"));
    return true;
  });
  void manifest;
});

test("同一操作者签两次不算双人签署;撤回签署留痕", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  setPassengerStatus(store, "F1", "P1", { status: "BOARDED", operator: "gate-01" });
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "l1", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T17:30:00+08:00" });
  const manifest = generateManifest(store, "F1", { operator: "lm-01" });
  signManifest(store, "F1", manifest.version, { operator: "lm-01" });
  assert.throws(() => signManifest(store, "F1", manifest.version, { operator: "lm-01" }), /已签署/);

  let blockers = computeBlockers(store, store.flights.get("F1"));
  assert.ok(blockers.some((b) => b.code === "SIGNATURES_REQUIRED" && b.have === 1));

  signManifest(store, "F1", manifest.version, { operator: "ctl-02" });
  blockers = computeBlockers(store, store.flights.get("F1"));
  assert.equal(blockers.length, 0);

  // 撤回一人 → 重新出现签署阻塞,审计留痕
  withdrawSignature(store, "F1", manifest.version, "ctl-02");
  blockers = computeBlockers(store, store.flights.get("F1"));
  assert.ok(blockers.some((b) => b.code === "SIGNATURES_REQUIRED"));
  const audit = store.flights.get("F1").audit;
  assert.ok(audit.some((entry) => entry.action === "SIGNATURE_WITHDRAWN" && entry.actor === "ctl-02"));
});

test("重开航班:留下操作者,原舱单失效需重新签署", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  readyToClose(store);
  closeFlight(store, "F1", { operator: "ctl-02" });

  const reopened = reopenFlight(store, "F1", { operator: "duty-mgr", reason: "临时加客" });
  assert.equal(reopened.status, "OPEN");
  assert.ok(store.flights.get("F1").audit.some((entry) => entry.action === "FLIGHT_REOPENED" && entry.actor === "duty-mgr"));

  // 原舱单因 contentVersion 变化而失效
  assert.throws(() => closeFlight(store, "F1", { operator: "ctl-02" }), /阻塞/);
  const manifest2 = generateManifest(store, "F1", { operator: "lm-01" });
  signManifest(store, "F1", manifest2.version, { operator: "lm-01" });
  signManifest(store, "F1", manifest2.version, { operator: "ctl-02" });
  assert.equal(closeFlight(store, "F1", { operator: "ctl-02" }).status, "CLOSED");
});

test("关闭阻塞清单:已登机旅客行李未装机、已装机行李旅客未登机", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  setPassengerStatus(store, "F1", "P1", { status: "BOARDED", operator: "gate-01" });

  // 旅客已登机但行李还在容器里 → 阻塞
  let blockers = computeBlockers(store, store.flights.get("F1"));
  assert.ok(blockers.some((b) => b.code === "BOARDED_BAG_NOT_ON_AIRCRAFT" && b.bagTag === "T1"));

  // 旅客未登机但行李已装机 → 阻塞(安全红线)
  setPassengerStatus(store, "F1", "P1", { status: "CHECKED_IN", operator: "gate-01" });
  scan(store, { scanId: "l1", bagTag: "T1", action: "LOADED_AIRCRAFT", position: "11P", occurredAt: "2026-09-12T17:30:00+08:00" });
  blockers = computeBlockers(store, store.flights.get("F1"));
  assert.ok(blockers.some((b) => b.code === "LOADED_BAG_PASSENGER_NOT_BOARDED" && b.bagTag === "T1"));
});

test("卸下扫描的位置/容器不匹配时不改变归属,判为冲突", () => {
  const store = makeStore();
  setupFlightWithBag(store);
  scan(store, { scanId: "a", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  scan(store, { scanId: "c1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" });
  const result = scan(store, { scanId: "u1", bagTag: "T1", action: "UNLOADED", container: "AKE9", occurredAt: "2026-09-12T17:30:00+08:00" });
  assert.equal(result.scan.result, "CONTESTED");
  assert.equal(bagOf(store).state, "IN_CONTAINER");
  assert.equal(bagOf(store).container, "AKE1");
});
