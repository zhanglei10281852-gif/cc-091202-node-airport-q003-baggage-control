// 行李装载核对引擎。
//
// 设计要点：
// - 全部状态保存在内存中，所有变更方法均为同步方法：在 Node 单线程事件循环下，
//   “校验并应用”之间不会被其他请求插入，从机制上保证任何重试或并发扫描
//   都不会让一件行李同时处于两个有效位置。
// - 每次变更写入航班级审计日志（flight.log），舱单版本号随之递增；
//   签署 / 撤回不改变舱单内容，因此不递增版本——双人签署必须落在同一版本上。
// - 扫描以 scanId 幂等：同一 scanId 重复到达返回首次结果；载荷不一致则冲突。

import { BagState, RejectCode, ScanAction, foldTrajectory } from "./stateMachine.js";

export class EngineError extends Error {
  constructor(code, message, httpStatus = 400, details = undefined) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const ExceptionType = Object.freeze({
  MUST_OFFLOAD: "MUST_OFFLOAD", // 减客旅客行李仍处于装载状态，必须卸下
  DOUBLE_POSITION: "DOUBLE_POSITION", // 扫描试图把一件行李算进两个有效位置
  OUT_OF_SEQUENCE: "OUT_OF_SEQUENCE", // 扫描违反物理先后
  CONTAINER_RETIRED: "CONTAINER_RETIRED", // 扫描试图装入已停用（已更换）的容器
  CONTAINER_SWAP_FROZEN: "CONTAINER_SWAP_FROZEN", // 容器更换，受影响行李冻结待重新核对
  AIRCRAFT_SWAP_FROZEN: "AIRCRAFT_SWAP_FROZEN", // 飞机更换，已装机行李冻结待重新核对
  BOARDED_PAX_BAG_OFFLOADED: "BOARDED_PAX_BAG_OFFLOADED", // 已登机旅客的行李被卸下
  UNKNOWN_BAG: "UNKNOWN_BAG", // 扫描指向未登记的行李牌
});

const PASSENGER_STATUS = Object.freeze({
  CHECKED_IN: "CHECKED_IN",
  BOARDED: "BOARDED",
  OFFLOADED: "OFFLOADED",
});

const LOAD_ACTIONS = new Set([ScanAction.LOADED_CONTAINER, ScanAction.LOADED_AIRCRAFT]);
const LOADED_STATES = new Set([BagState.IN_CONTAINER, BagState.ON_AIRCRAFT]);

// 会改变舱单内容、需要递增版本号的日志类型。
const VERSION_BUMPING = new Set([
  "FLIGHT_CREATED",
  "PASSENGER_REGISTERED",
  "PASSENGER_BOARDED",
  "PASSENGER_OFFLOADED",
  "SCAN_APPLIED",
  "SCAN_VOIDED",
  "CONTAINER_REPLACED",
  "AIRCRAFT_CHANGED",
  "EXCEPTION_OPENED",
  "EXCEPTION_AUTO_RESOLVED",
  "EXCEPTION_DISPOSITION",
  "CLOSED",
  "REOPENED",
]);

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value, field) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new EngineError("VALIDATION", `字段 ${field} 不是合法时间: ${value}`, 400);
  }
  return ms;
}

// 轨迹排序键：现场发生时间优先，其次接收时间，最后 scanId 保证稳定。
function byPhysicalTime(a, b) {
  const t = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (t !== 0) return t;
  const r = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
  if (r !== 0) return r;
  return a.scanId < b.scanId ? -1 : a.scanId > b.scanId ? 1 : 0;
}

export class Engine {
  constructor({ clock = nowIso } = {}) {
    this.clock = clock;
    this.flights = new Map();
  }

  // ---------- 航班 ----------

  createFlight({ flightLegId, aircraftId, holds = ["H1"] }) {
    if (!flightLegId || !aircraftId) {
      throw new EngineError("VALIDATION", "flightLegId 与 aircraftId 必填", 400);
    }
    if (this.flights.has(flightLegId)) {
      throw new EngineError("FLIGHT_EXISTS", `航班已存在: ${flightLegId}`, 409);
    }
    const flight = {
      flightLegId,
      aircraftId,
      holds: [...holds],
      status: "OPEN",
      version: 0,
      passengers: new Map(),
      bags: new Map(),
      containers: new Map(),
      scans: new Map(),
      parkedByBag: new Map(), // bagTag -> [scanId]，未知行李牌的暂存扫描
      exceptions: new Map(),
      exceptionSeq: 0,
      signatures: [], // {operator, version, at, withdrawnAt}
      closures: [], // {operator, at, signedVersion}
      reopens: [], // {operator, reason, at}
      log: [],
      logSeq: 0,
    };
    this.flights.set(flightLegId, flight);
    this.#log(flight, "FLIGHT_CREATED", "system", `航班 ${flightLegId} 建立，机型 ${aircraftId}`);
    return this.flightSummary(flightLegId);
  }

  listFlights() {
    return [...this.flights.values()].map((f) => this.flightSummary(f.flightLegId));
  }

  flightSummary(flightLegId) {
    const f = this.#flight(flightLegId);
    return {
      flightLegId: f.flightLegId,
      aircraftId: f.aircraftId,
      holds: f.holds,
      status: f.status,
      manifestVersion: f.version,
      passengers: f.passengers.size,
      bags: f.bags.size,
      containers: f.containers.size,
      openExceptions: [...f.exceptions.values()].filter((e) => e.status === "OPEN").length,
      activeSignatures: this.#activeSignatures(f).length,
    };
  }

  #flight(flightLegId) {
    const f = this.flights.get(flightLegId);
    if (!f) throw new EngineError("FLIGHT_NOT_FOUND", `航班不存在: ${flightLegId}`, 404);
    return f;
  }

  #assertOpen(flight) {
    if (flight.status !== "OPEN") {
      throw new EngineError("FLIGHT_CLOSED", `航班 ${flight.flightLegId} 已关闭装载，须先重开`, 409);
    }
  }

  #log(flight, type, actor, summary, detail = undefined) {
    flight.logSeq += 1;
    const entry = { seq: flight.logSeq, at: this.clock(), type, actor, summary };
    if (detail !== undefined) entry.detail = detail;
    flight.log.push(entry);
    if (VERSION_BUMPING.has(type)) flight.version += 1;
    return entry;
  }

  events(flightLegId) {
    return this.#flight(flightLegId).log;
  }

  // ---------- 旅客与登机资格 ----------

  registerPassenger(flightLegId, { passengerId, bagTags = [], name = undefined }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!passengerId) throw new EngineError("VALIDATION", "passengerId 必填", 400);
    if (flight.passengers.has(passengerId)) {
      throw new EngineError("PASSENGER_EXISTS", `旅客已登记: ${passengerId}`, 409);
    }
    for (const tag of bagTags) {
      if (flight.bags.has(tag)) {
        throw new EngineError("BAG_EXISTS", `行李牌已登记: ${tag}`, 409);
      }
    }
    const passenger = {
      passengerId,
      name: name ?? null,
      status: PASSENGER_STATUS.CHECKED_IN,
      bagTags: [...bagTags],
      offloadedAt: null,
    };
    flight.passengers.set(passengerId, passenger);
    for (const tag of bagTags) {
      flight.bags.set(tag, {
        bagTag: tag,
        passengerId,
        flightLegId,
        state: BagState.EXPECTED,
        container: null,
        lastContainer: null,
        trajectory: [], // 已应用扫描 scanId，按 occurredAt 排序
        mustOffload: false,
        mustOffloadAt: null,
        frozen: null, // {type, detail, since}
        registeredAt: this.clock(),
      });
    }
    this.#log(
      flight,
      "PASSENGER_REGISTERED",
      "system",
      `旅客 ${passengerId} 登记，托运行李 ${bagTags.length} 件`,
      { passengerId, bagTags },
    );
    // 重放此前因未知行李牌而暂存的扫描。
    for (const tag of bagTags) this.#replayParked(flight, tag);
    return passenger;
  }

  boardPassenger(flightLegId, passengerId) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    const pax = this.#passenger(flight, passengerId);
    if (pax.status === PASSENGER_STATUS.OFFLOADED) {
      throw new EngineError("PASSENGER_OFFLOADED", `旅客 ${passengerId} 已减客，不能恢复登机`, 409);
    }
    pax.status = PASSENGER_STATUS.BOARDED;
    this.#log(flight, "PASSENGER_BOARDED", "system", `旅客 ${passengerId} 已登机`, { passengerId });
    return pax;
  }

  // 减客：立即标记该旅客全部托运行李为“必须卸下”；
  // 已处于装载状态的行李立即挂 MUST_OFFLOAD 异常。
  offloadPassenger(flightLegId, passengerId, { operator = "system", reason = "", at = undefined } = {}) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    const pax = this.#passenger(flight, passengerId);
    if (pax.status === PASSENGER_STATUS.OFFLOADED) {
      throw new EngineError("PASSENGER_OFFLOADED", `旅客 ${passengerId} 已是减客状态`, 409);
    }
    const decidedAt = at ?? this.clock();
    parseTime(decidedAt, "at");
    pax.status = PASSENGER_STATUS.OFFLOADED;
    pax.offloadedAt = decidedAt;
    this.#log(
      flight,
      "PASSENGER_OFFLOADED",
      operator,
      `旅客 ${passengerId} 减客，${pax.bagTags.length} 件托运行李标记为必须卸下`,
      { passengerId, bagTags: pax.bagTags, reason, decidedAt },
    );
    for (const tag of pax.bagTags) {
      const bag = flight.bags.get(tag);
      bag.mustOffload = true;
      bag.mustOffloadAt = decidedAt;
      this.#evaluateBag(flight, bag);
    }
    return pax;
  }

  #passenger(flight, passengerId) {
    const pax = flight.passengers.get(passengerId);
    if (!pax) throw new EngineError("PASSENGER_NOT_FOUND", `旅客不存在: ${passengerId}`, 404);
    return pax;
  }

  // ---------- 扫描接收 ----------

  // 单条扫描入口。返回 { scanId, status, ... }；status ∈
  // APPLIED / REPEAT / DUPLICATE / REJECTED / PARKED / VOID_APPLIED。
  ingestScan(flightLegId, input, { source = undefined } = {}) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    const scan = this.#normalizeScan(input, source);

    const existing = flight.scans.get(scan.scanId);
    if (existing) {
      if (!this.#samePayload(existing, scan)) {
        throw new EngineError(
          "SCAN_CONFLICT",
          `scanId ${scan.scanId} 已存在但载荷不一致`,
          409,
          { first: this.#publicScan(existing), retry: scan },
        );
      }
      return { ...this.#publicScan(existing), duplicate: true, manifestVersion: flight.version };
    }

    if (scan.action === ScanAction.VOIDED) return this.#applyVoid(flight, scan);

    const bag = flight.bags.get(scan.bagTag);
    if (!bag) {
      // 未知行李牌：暂存扫描并挂异常，待行李登记后自动重放。
      const parked = { ...scan, status: "PARKED" };
      flight.scans.set(scan.scanId, parked);
      if (!flight.parkedByBag.has(scan.bagTag)) flight.parkedByBag.set(scan.bagTag, []);
      flight.parkedByBag.get(scan.bagTag).push(scan.scanId);
      const ex = this.#ensureException(flight, ExceptionType.UNKNOWN_BAG, {
        bagTag: scan.bagTag,
        scanId: scan.scanId,
        detail: `扫描 ${scan.scanId} 指向未登记的行李牌 ${scan.bagTag}，已暂存待登记后重放`,
        actor: scan.source ?? "scanner",
      });
      return { ...this.#publicScan(parked), exceptionId: ex.id, manifestVersion: flight.version };
    }
    return this.#applyScan(flight, bag, scan);
  }

  // 批量接收（离线扫描枪补传）：逐条独立处理，单条失败不影响整批。
  ingestScans(flightLegId, inputs, opts = {}) {
    return inputs.map((input) => {
      try {
        return this.ingestScan(flightLegId, input, opts);
      } catch (err) {
        if (err instanceof EngineError && err.code === "SCAN_CONFLICT") {
          return { scanId: input?.scanId ?? null, status: "CONFLICT", reason: err.message };
        }
        throw err;
      }
    });
  }

  #normalizeScan(input, source) {
    if (!input || typeof input !== "object") {
      throw new EngineError("VALIDATION", "扫描体必须是对象", 400);
    }
    const { scanId, bagTag, action } = input;
    if (!scanId || typeof scanId !== "string") {
      throw new EngineError("VALIDATION", "scanId 必填（作为幂等键）", 400);
    }
    if (!Object.values(ScanAction).includes(action)) {
      throw new EngineError("VALIDATION", `不支持的扫描动作: ${action}`, 400);
    }
    if (!bagTag || typeof bagTag !== "string") {
      throw new EngineError("VALIDATION", "bagTag 必填", 400);
    }
    const receivedAt = input.receivedAt ?? this.clock();
    parseTime(receivedAt, "receivedAt");
    const occurredAt = input.occurredAt ?? receivedAt;
    parseTime(occurredAt, "occurredAt");
    const scan = {
      scanId,
      bagTag,
      action,
      occurredAt,
      receivedAt,
      source: input.source ?? source ?? null,
    };
    if (action === ScanAction.LOADED_CONTAINER) {
      if (!input.container) {
        throw new EngineError("VALIDATION", "LOADED_CONTAINER 必须携带 container", 400);
      }
      scan.container = input.container;
    }
    if (action === ScanAction.LOADED_AIRCRAFT && input.container) {
      scan.container = input.container;
    }
    if (action === ScanAction.VOIDED) {
      if (!input.voids || typeof input.voids !== "string") {
        throw new EngineError("VALIDATION", "VOIDED 必须携带 voids（被作废的 scanId）", 400);
      }
      scan.voids = input.voids;
    }
    return scan;
  }

  #samePayload(a, b) {
    return (
      a.bagTag === b.bagTag &&
      a.action === b.action &&
      (a.container ?? null) === (b.container ?? null) &&
      a.occurredAt === b.occurredAt &&
      (a.voids ?? null) === (b.voids ?? null)
    );
  }

  #publicScan(scan) {
    const out = {
      scanId: scan.scanId,
      bagTag: scan.bagTag,
      action: scan.action,
      status: scan.status,
      occurredAt: scan.occurredAt,
      receivedAt: scan.receivedAt,
    };
    if (scan.container) out.container = scan.container;
    if (scan.reason) out.reason = scan.reason;
    if (scan.voids) out.voids = scan.voids;
    return out;
  }

  #applyScan(flight, bag, scan) {
    // 冻结中的行李仅允许卸下（离开被更换的容器/飞机后自动解冻）。
    if (bag.frozen && scan.action !== ScanAction.OFFLOADED) {
      return this.#reject(
        flight,
        bag,
        scan,
        "FROZEN",
        `行李处于冻结状态（${bag.frozen.detail}），须先卸下并重新核对`,
      );
    }
    // 减客行李：减客决定之后发生的装载一律拒绝；决定之前的迟到装载如实接收并报警。
    // 拒绝本身即处置（行李并未装上），不再挂异常，避免无谓阻塞关闭。
    if (bag.mustOffload && LOAD_ACTIONS.has(scan.action)) {
      if (Date.parse(scan.occurredAt) >= Date.parse(bag.mustOffloadAt)) {
        return this.#reject(flight, bag, scan, ExceptionType.MUST_OFFLOAD, "减客行李禁止重新装载");
      }
    }
    // 已停用容器禁止再装入。
    if (scan.action === ScanAction.LOADED_CONTAINER) {
      const container = flight.containers.get(scan.container);
      if (container && container.status === "REPLACED") {
        const ex = this.#ensureException(flight, ExceptionType.CONTAINER_RETIRED, {
          bagTag: bag.bagTag,
          container: scan.container,
          scanId: scan.scanId,
          detail: `容器 ${scan.container} 已更换为 ${container.replacedBy}，行李当前有效位置为 ${bag.container ?? bag.state}`,
          actor: scan.source ?? "scanner",
        });
        return this.#reject(
          flight,
          bag,
          scan,
          ExceptionType.CONTAINER_RETIRED,
          `容器 ${scan.container} 已停用（更换为 ${container.replacedBy}）`,
          ex.id,
        );
      }
    }

    // 把新扫描按 occurredAt 插入已应用轨迹，整体折叠验证物理先后。
    const sequence = [...bag.trajectory.map((id) => flight.scans.get(id)), scan].sort(byPhysicalTime);
    const folded = foldTrajectory(sequence);
    if (!folded.ok) {
      const { code, reason } = folded.failure;
      const ex = this.#ensureException(flight, code, {
        bagTag: bag.bagTag,
        passengerId: bag.passengerId,
        scanId: scan.scanId,
        detail: reason,
        actor: scan.source ?? "scanner",
      });
      return this.#reject(flight, bag, scan, code, reason, ex.id);
    }

    // 应用：更新轨迹与状态。
    const step = folded.steps[sequence.indexOf(scan)];
    const record = { ...scan, status: step.repeat ? "REPEAT" : "APPLIED" };
    flight.scans.set(scan.scanId, record);
    if (step.repeat) {
      this.#log(
        flight,
        "SCAN_REPEAT",
        scan.source ?? "scanner",
        `重复扫描 ${scan.scanId}（${scan.action} ${scan.container ?? ""}），状态不变`,
        { bagTag: bag.bagTag },
      );
      return { ...this.#publicScan(record), manifestVersion: flight.version };
    }

    const previousContainer = bag.container;
    bag.trajectory = sequence.map((s) => s.scanId);
    bag.state = folded.state;
    bag.container = folded.container;
    bag.lastContainer = folded.lastContainer;
    this.#syncContainerMembership(flight, bag, previousContainer);
    this.#log(
      flight,
      "SCAN_APPLIED",
      scan.source ?? "scanner",
      `扫描 ${scan.scanId} 应用：${bag.bagTag} → ${bag.state}${bag.container ? ` (${bag.container})` : ""}`,
      {
        bagTag: bag.bagTag,
        action: scan.action,
        container: scan.container ?? null,
        implied: step.implied,
        offloadFrom: step.offloadFrom ?? undefined,
      },
    );
    this.#evaluateBag(flight, bag);
    return { ...this.#publicScan(record), state: bag.state, manifestVersion: flight.version };
  }

  #reject(flight, bag, scan, code, reason, exceptionId = undefined) {
    const record = { ...scan, status: "REJECTED", reason };
    flight.scans.set(scan.scanId, record);
    this.#log(flight, "SCAN_REJECTED", scan.source ?? "scanner", `扫描 ${scan.scanId} 被拒绝：${reason}`, {
      bagTag: bag.bagTag,
      code,
      exceptionId,
    });
    const out = { ...this.#publicScan(record), manifestVersion: flight.version };
    if (exceptionId) out.exceptionId = exceptionId;
    return out;
  }

  // 作废一条已应用扫描：剔除后重新折叠；若会破坏轨迹连续性则拒绝作废。
  #applyVoid(flight, scan) {
    const target = flight.scans.get(scan.voids);
    const bag = target ? flight.bags.get(target.bagTag) : null;
    if (!target || (target.status !== "APPLIED" && target.status !== "REPEAT") || !bag) {
      const ex = this.#ensureException(flight, ExceptionType.OUT_OF_SEQUENCE, {
        bagTag: scan.bagTag,
        scanId: scan.scanId,
        detail: `作废目标 ${scan.voids} 不存在或已不是有效扫描`,
        actor: scan.source ?? "scanner",
      });
      const record = { ...scan, status: "REJECTED", reason: "作废目标不存在或已失效" };
      flight.scans.set(scan.scanId, record);
      this.#log(flight, "SCAN_REJECTED", scan.source ?? "scanner", `作废扫描 ${scan.scanId} 被拒绝：目标无效`, {
        exceptionId: ex.id,
      });
      return { ...this.#publicScan(record), exceptionId: ex.id, manifestVersion: flight.version };
    }

    const inTrajectory = bag.trajectory.includes(target.scanId);
    const remaining = bag.trajectory.filter((id) => id !== target.scanId);
    const folded = inTrajectory
      ? foldTrajectory(remaining.map((id) => flight.scans.get(id)).sort(byPhysicalTime))
      : { ok: true, state: bag.state, container: bag.container, lastContainer: bag.lastContainer };
    if (!folded.ok) {
      const record = { ...scan, status: "REJECTED", reason: `作废将破坏轨迹连续性：${folded.failure.reason}` };
      flight.scans.set(scan.scanId, record);
      this.#log(
        flight,
        "SCAN_REJECTED",
        scan.source ?? "scanner",
        `作废扫描 ${scan.scanId} 被拒绝：${record.reason}`,
        { bagTag: bag.bagTag },
      );
      return { ...this.#publicScan(record), manifestVersion: flight.version };
    }

    target.status = "VOIDED";
    target.voidedBy = scan.scanId;
    const record = { ...scan, status: "APPLIED" };
    flight.scans.set(scan.scanId, record);
    if (inTrajectory) {
      const previousContainer = bag.container;
      bag.trajectory = remaining;
      bag.state = folded.state;
      bag.container = folded.container;
      bag.lastContainer = folded.lastContainer;
      this.#syncContainerMembership(flight, bag, previousContainer);
    }
    this.#log(
      flight,
      "SCAN_VOIDED",
      scan.source ?? "scanner",
      `扫描 ${target.scanId} 被 ${scan.scanId} 作废，${bag.bagTag} 当前状态 ${bag.state}`,
      { bagTag: bag.bagTag, voidedScanId: target.scanId },
    );
    this.#evaluateBag(flight, bag);
    return { ...this.#publicScan(record), state: bag.state, manifestVersion: flight.version };
  }

  // 行李登记后重放暂存扫描；重放完毕自动解除 UNKNOWN_BAG 异常。
  #replayParked(flight, bagTag) {
    const ids = flight.parkedByBag.get(bagTag) ?? [];
    if (ids.length === 0) return;
    flight.parkedByBag.delete(bagTag);
    const bag = flight.bags.get(bagTag);
    const scans = ids.map((id) => flight.scans.get(id)).sort(byPhysicalTime);
    for (const parked of scans) {
      flight.scans.delete(parked.scanId);
      this.#applyScan(flight, bag, { ...parked });
    }
    this.#autoResolve(flight, ExceptionType.UNKNOWN_BAG, bagTag, "行李已登记，暂存扫描已重放", "system");
  }

  // ---------- 状态评估与异常生命周期 ----------

  // 每次行李状态变化后统一评估：该挂的异常挂上，该自动解除的解除。
  #evaluateBag(flight, bag) {
    const pax = flight.passengers.get(bag.passengerId);
    const loaded = LOADED_STATES.has(bag.state);

    if (bag.mustOffload && loaded) {
      this.#ensureException(flight, ExceptionType.MUST_OFFLOAD, {
        bagTag: bag.bagTag,
        passengerId: bag.passengerId,
        detail: `减客旅客 ${bag.passengerId} 的行李仍处于 ${bag.state}，必须卸下`,
        actor: "engine",
      });
    }
    if (bag.mustOffload && bag.state === BagState.OFFLOADED) {
      this.#autoResolve(flight, ExceptionType.MUST_OFFLOAD, bag.bagTag, "行李已卸下，减客处置完成", "engine");
    }

    if (pax && pax.status === PASSENGER_STATUS.BOARDED && bag.state === BagState.OFFLOADED) {
      this.#ensureException(flight, ExceptionType.BOARDED_PAX_BAG_OFFLOADED, {
        bagTag: bag.bagTag,
        passengerId: bag.passengerId,
        detail: `已登机旅客 ${bag.passengerId} 的行李被卸下，去向须明确`,
        actor: "engine",
      });
    }
    if (pax && pax.status === PASSENGER_STATUS.BOARDED && loaded) {
      this.#autoResolve(
        flight,
        ExceptionType.BOARDED_PAX_BAG_OFFLOADED,
        bag.bagTag,
        "行李已重新装载",
        "engine",
      );
    }

    // 冻结解除：行李离开被更换的容器/飞机（卸下）即完成重新核对的第一步。
    if (bag.frozen && !loaded) {
      const frozenType = bag.frozen.type;
      bag.frozen = null;
      this.#autoResolve(flight, frozenType, bag.bagTag, "行李已卸下原容器/飞机，冻结解除", "engine");
    }
  }

  #ensureException(flight, type, { bagTag = null, passengerId = null, container = null, scanId = null, detail, actor }) {
    for (const ex of flight.exceptions.values()) {
      if (ex.status === "OPEN" && ex.type === type && ex.bagTag === bagTag && ex.container === container) {
        return ex;
      }
    }
    flight.exceptionSeq += 1;
    const ex = {
      id: `EX-${String(flight.exceptionSeq).padStart(4, "0")}`,
      type,
      status: "OPEN",
      bagTag,
      passengerId,
      container,
      scanId,
      detail,
      openedAt: this.clock(),
      openedBy: actor,
      dispositions: [],
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    flight.exceptions.set(ex.id, ex);
    this.#log(flight, "EXCEPTION_OPENED", actor, `异常 ${ex.id}（${type}）：${detail}`, {
      exceptionId: ex.id,
      bagTag,
    });
    return ex;
  }

  #autoResolve(flight, type, bagTag, resolution, actor) {
    for (const ex of flight.exceptions.values()) {
      if (ex.status === "OPEN" && ex.type === type && ex.bagTag === bagTag) {
        ex.status = "RESOLVED";
        ex.resolvedAt = this.clock();
        ex.resolvedBy = actor;
        ex.resolution = resolution;
        this.#log(flight, "EXCEPTION_AUTO_RESOLVED", actor, `异常 ${ex.id}（${type}）自动解除：${resolution}`, {
          exceptionId: ex.id,
          bagTag,
        });
      }
    }
  }

  // 人工处置结论：所有异常关闭前都必须有处置结论。
  dispositionException(flightLegId, exceptionId, { operator, conclusion, note = "" }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!operator || !conclusion) {
      throw new EngineError("VALIDATION", "operator 与 conclusion 必填", 400);
    }
    const ex = flight.exceptions.get(exceptionId);
    if (!ex) throw new EngineError("EXCEPTION_NOT_FOUND", `异常不存在: ${exceptionId}`, 404);
    if (ex.status !== "OPEN") {
      throw new EngineError("EXCEPTION_ALREADY_RESOLVED", `异常 ${exceptionId} 已有处置结论`, 409);
    }
    ex.dispositions.push({ operator, conclusion, note, at: this.clock() });
    ex.status = "RESOLVED";
    ex.resolvedAt = this.clock();
    ex.resolvedBy = operator;
    ex.resolution = conclusion;
    this.#log(flight, "EXCEPTION_DISPOSITION", operator, `异常 ${exceptionId} 处置：${conclusion}`, {
      exceptionId,
      note,
    });
    return ex;
  }

  exceptions(flightLegId, { status = undefined } = {}) {
    const flight = this.#flight(flightLegId);
    const all = [...flight.exceptions.values()];
    return status ? all.filter((e) => e.status === status) : all;
  }

  // ---------- 容器与飞机更换 ----------

  // 容器更换：冻结受影响行李并要求重新核对，绝不悄悄搬移归属。
  replaceContainer(flightLegId, uld, { newContainer, operator, reason = "" }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!newContainer || !operator) {
      throw new EngineError("VALIDATION", "newContainer 与 operator 必填", 400);
    }
    const old = flight.containers.get(uld);
    if (!old) throw new EngineError("CONTAINER_NOT_FOUND", `容器不存在: ${uld}`, 404);
    if (old.status !== "ACTIVE") {
      throw new EngineError("CONTAINER_NOT_ACTIVE", `容器 ${uld} 已不是可用状态`, 409);
    }
    if (newContainer === uld) {
      throw new EngineError("VALIDATION", "新容器不能与原容器相同", 400);
    }
    old.status = "REPLACED";
    old.replacedBy = newContainer;
    old.replacedAt = this.clock();
    if (!flight.containers.has(newContainer)) {
      flight.containers.set(newContainer, {
        uld: newContainer,
        status: "ACTIVE",
        replacedBy: null,
        bags: new Set(),
        createdAt: this.clock(),
      });
    }
    const affected = [...old.bags];
    for (const tag of affected) {
      const bag = flight.bags.get(tag);
      bag.frozen = {
        type: ExceptionType.CONTAINER_SWAP_FROZEN,
        detail: `容器 ${uld} 已更换为 ${newContainer}，行李冻结待重新核对`,
        since: this.clock(),
      };
      this.#ensureException(flight, ExceptionType.CONTAINER_SWAP_FROZEN, {
        bagTag: tag,
        passengerId: bag.passengerId,
        container: uld,
        detail: `容器 ${uld} 更换为 ${newContainer}，行李 ${tag} 须卸下并重新核对装箱`,
        actor: operator,
      });
    }
    this.#log(
      flight,
      "CONTAINER_REPLACED",
      operator,
      `容器 ${uld} 更换为 ${newContainer}，冻结行李 ${affected.length} 件`,
      { uld, newContainer, reason, affectedBags: affected },
    );
    return { uld, newContainer, frozenBags: affected };
  }

  // 换机：已装机行李全部冻结，须卸下并重新核对装机。
  changeAircraft(flightLegId, { newAircraftId, operator, reason = "" }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!newAircraftId || !operator) {
      throw new EngineError("VALIDATION", "newAircraftId 与 operator 必填", 400);
    }
    if (newAircraftId === flight.aircraftId) {
      throw new EngineError("VALIDATION", "新机型不能与现机型相同", 400);
    }
    const previous = flight.aircraftId;
    flight.aircraftId = newAircraftId;
    const affected = [...flight.bags.values()]
      .filter((b) => b.state === BagState.ON_AIRCRAFT)
      .map((b) => b.bagTag);
    for (const tag of affected) {
      const bag = flight.bags.get(tag);
      bag.frozen = {
        type: ExceptionType.AIRCRAFT_SWAP_FROZEN,
        detail: `飞机 ${previous} 更换为 ${newAircraftId}，已装机行李冻结待重新核对`,
        since: this.clock(),
      };
      this.#ensureException(flight, ExceptionType.AIRCRAFT_SWAP_FROZEN, {
        bagTag: tag,
        passengerId: bag.passengerId,
        detail: `飞机更换（${previous} → ${newAircraftId}），行李 ${tag} 须卸下并重新装机核对`,
        actor: operator,
      });
    }
    this.#log(
      flight,
      "AIRCRAFT_CHANGED",
      operator,
      `飞机 ${previous} 更换为 ${newAircraftId}，冻结已装机行李 ${affected.length} 件`,
      { previous, newAircraftId, reason, affectedBags: affected },
    );
    return { previous, newAircraftId, frozenBags: affected };
  }

  // 维护“容器 → 行李”归属集合：行李只可能出现在一个容器的集合中。
  #syncContainerMembership(flight, bag, previousContainer) {
    if (previousContainer && previousContainer !== bag.container) {
      flight.containers.get(previousContainer)?.bags.delete(bag.bagTag);
    }
    if (bag.container && LOADED_STATES.has(bag.state)) {
      let container = flight.containers.get(bag.container);
      if (!container) {
        container = {
          uld: bag.container,
          status: "ACTIVE",
          replacedBy: null,
          bags: new Set(),
          createdAt: this.clock(),
        };
        flight.containers.set(bag.container, container);
      }
      container.bags.add(bag.bagTag);
    }
  }

  // ---------- 舱单、阻止签署清单、双人签署 ----------

  manifest(flightLegId) {
    const f = this.#flight(flightLegId);
    const open = [...f.exceptions.values()].filter((e) => e.status === "OPEN");
    return {
      flightLegId: f.flightLegId,
      aircraftId: f.aircraftId,
      holds: f.holds,
      status: f.status,
      version: f.version,
      generatedAt: this.clock(),
      passengers: [...f.passengers.values()].map((p) => ({
        passengerId: p.passengerId,
        name: p.name,
        status: p.status,
        bagTags: p.bagTags,
      })),
      bags: [...f.bags.values()].map((b) => this.#publicBag(f, b)),
      containers: [...f.containers.values()].map((c) => ({
        uld: c.uld,
        status: c.status,
        replacedBy: c.replacedBy,
        bags: [...c.bags],
      })),
      exceptions: {
        open: open.length,
        resolved: f.exceptions.size - open.length,
        openItems: open.map((e) => ({ id: e.id, type: e.type, bagTag: e.bagTag, detail: e.detail })),
      },
      signatures: {
        current: this.#activeSignatures(f).map((s) => ({ operator: s.operator, version: s.version, at: s.at })),
        history: f.signatures.map((s) => ({
          operator: s.operator,
          version: s.version,
          at: s.at,
          withdrawnAt: s.withdrawnAt,
        })),
      },
      closures: f.closures,
      reopens: f.reopens,
    };
  }

  #publicBag(flight, bag) {
    const pax = flight.passengers.get(bag.passengerId);
    return {
      bagTag: bag.bagTag,
      passengerId: bag.passengerId,
      passengerStatus: pax?.status ?? null,
      state: bag.state,
      container: bag.container,
      mustOffload: bag.mustOffload,
      frozen: bag.frozen ? bag.frozen.detail : null,
    };
  }

  // 当前阻止关闭装载的具体清单。
  blockers(flightLegId) {
    const f = this.#flight(flightLegId);
    if (f.status === "CLOSED") {
      return {
        flightLegId,
        status: f.status,
        manifestVersion: f.version,
        canClose: false,
        blockers: [{ type: "ALREADY_CLOSED", detail: "航班已关闭装载，如需变更请先重开" }],
      };
    }
    const blockers = [];
    const open = [...f.exceptions.values()].filter((e) => e.status === "OPEN");
    if (open.length > 0) {
      blockers.push({
        type: "OPEN_EXCEPTIONS",
        count: open.length,
        exceptions: open.map((e) => ({ id: e.id, type: e.type, bagTag: e.bagTag, detail: e.detail })),
      });
    }
    // 每个已登机旅客的托运行李去向必须明确（已装机）。
    const notLoaded = [];
    for (const pax of f.passengers.values()) {
      if (pax.status !== PASSENGER_STATUS.BOARDED) continue;
      for (const tag of pax.bagTags) {
        const bag = f.bags.get(tag);
        if (bag.state !== BagState.ON_AIRCRAFT) {
          notLoaded.push({ bagTag: tag, passengerId: pax.passengerId, state: bag.state });
        }
      }
    }
    if (notLoaded.length > 0) {
      blockers.push({ type: "BAGS_NOT_ON_AIRCRAFT", count: notLoaded.length, bags: notLoaded });
    }
    // 减客行李不得仍处于装载状态（兜底校验，正常已由异常覆盖）。
    const stillLoaded = [...f.bags.values()].filter((b) => b.mustOffload && LOADED_STATES.has(b.state));
    if (stillLoaded.length > 0) {
      blockers.push({
        type: "MUST_OFFLOAD_PENDING",
        count: stillLoaded.length,
        bags: stillLoaded.map((b) => b.bagTag),
      });
    }
    const signers = this.#activeSignatures(f);
    if (signers.length < 2) {
      blockers.push({
        type: "INSUFFICIENT_SIGNATURES",
        have: signers.length,
        need: 2,
        signedBy: signers.map((s) => s.operator),
        version: f.version,
      });
    }
    return {
      flightLegId,
      status: f.status,
      manifestVersion: f.version,
      canClose: blockers.length === 0,
      blockers,
    };
  }

  #activeSignatures(flight) {
    const seen = new Set();
    const active = [];
    for (const s of flight.signatures) {
      if (s.version === flight.version && !s.withdrawnAt && !seen.has(s.operator)) {
        seen.add(s.operator);
        active.push(s);
      }
    }
    return active;
  }

  sign(flightLegId, { operator }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!operator) throw new EngineError("VALIDATION", "operator 必填", 400);
    if (this.#activeSignatures(flight).some((s) => s.operator === operator)) {
      throw new EngineError(
        "SIGNATURE_EXISTS",
        `操作者 ${operator} 已签署当前舱单版本 ${flight.version}`,
        409,
      );
    }
    const signature = { operator, version: flight.version, at: this.clock(), withdrawnAt: null };
    flight.signatures.push(signature);
    this.#log(flight, "SIGNED", operator, `${operator} 签署舱单版本 ${flight.version}`, {
      version: flight.version,
    });
    return signature;
  }

  withdraw(flightLegId, { operator }) {
    const flight = this.#flight(flightLegId);
    this.#assertOpen(flight);
    if (!operator) throw new EngineError("VALIDATION", "operator 必填", 400);
    const signature = this.#activeSignatures(flight).find((s) => s.operator === operator);
    if (!signature) {
      throw new EngineError("NO_SIGNATURE", `操作者 ${operator} 在当前版本 ${flight.version} 没有有效签署`, 404);
    }
    signature.withdrawnAt = this.clock();
    this.#log(flight, "WITHDRAWN", operator, `${operator} 撤回舱单版本 ${flight.version} 的签署`, {
      version: flight.version,
    });
    return signature;
  }

  // 双人签署同一舱单版本 + 异常全部有处置结论 + 已登机旅客行李去向明确，才可关闭。
  close(flightLegId, { operator }) {
    const flight = this.#flight(flightLegId);
    if (!operator) throw new EngineError("VALIDATION", "operator 必填", 400);
    if (flight.status === "CLOSED") {
      throw new EngineError("ALREADY_CLOSED", `航班 ${flightLegId} 已关闭装载`, 409);
    }
    const { blockers } = this.blockers(flightLegId);
    if (blockers.length > 0) {
      throw new EngineError("CLOSE_BLOCKED", "存在阻止关闭装载的事项", 409, blockers);
    }
    const signedVersion = flight.version;
    flight.status = "CLOSED";
    flight.closures.push({ operator, at: this.clock(), signedVersion });
    this.#log(flight, "CLOSED", operator, `${operator} 关闭装载（签署版本 ${signedVersion}）`, {
      signedVersion,
    });
    return { flightLegId, status: flight.status, closedVersion: signedVersion };
  }

  reopen(flightLegId, { operator, reason = "" }) {
    const flight = this.#flight(flightLegId);
    if (!operator) throw new EngineError("VALIDATION", "operator 必填", 400);
    if (flight.status !== "CLOSED") {
      throw new EngineError("NOT_CLOSED", `航班 ${flightLegId} 未处于关闭状态`, 409);
    }
    flight.status = "OPEN";
    flight.reopens.push({ operator, reason, at: this.clock() });
    // 重开递增版本，此前的签署自然失效，须重新双人签署。
    this.#log(flight, "REOPENED", operator, `${operator} 重开装载：${reason || "未说明"}`, { reason });
    return { flightLegId, status: flight.status, manifestVersion: flight.version };
  }

  // ---------- 链路还原 ----------

  // 按行李牌还原完整扫描链路：已应用轨迹（含推定环节）、被拒/暂存/作废扫描、相关异常。
  bagChain(flightLegId, bagTag) {
    const flight = this.#flight(flightLegId);
    const bag = flight.bags.get(bagTag);
    const scans = [...flight.scans.values()].filter((s) => s.bagTag === bagTag);
    if (!bag && scans.length === 0) {
      throw new EngineError("BAG_NOT_FOUND", `行李牌不存在: ${bagTag}`, 404);
    }
    const applied = bag
      ? foldTrajectory(bag.trajectory.map((id) => flight.scans.get(id)).sort(byPhysicalTime))
      : null;
    const trajectory = bag
      ? bag.trajectory.map((id, index) => {
          const scan = flight.scans.get(id);
          const step = applied.steps[index];
          return {
            scanId: scan.scanId,
            action: scan.action,
            container: scan.container ?? null,
            occurredAt: scan.occurredAt,
            receivedAt: scan.receivedAt,
            ingestLagSeconds: Math.max(
              0,
              Math.round((Date.parse(scan.receivedAt) - Date.parse(scan.occurredAt)) / 1000),
            ),
            resultingState: step.state,
            resultingContainer: step.container,
            implied: step.implied,
            offloadFrom: step.offloadFrom,
          };
        })
      : [];
    const otherScans = scans
      .filter((s) => !bag || !bag.trajectory.includes(s.scanId))
      .sort(byPhysicalTime)
      .map((s) => ({
        ...this.#publicScan(s),
        voidedBy: s.voidedBy ?? undefined,
      }));
    return {
      flightLegId,
      bagTag,
      passengerId: bag?.passengerId ?? null,
      passengerStatus: bag ? (flight.passengers.get(bag.passengerId)?.status ?? null) : null,
      state: bag?.state ?? null,
      container: bag?.container ?? null,
      mustOffload: bag?.mustOffload ?? false,
      frozen: bag?.frozen ?? null,
      trajectory,
      otherScans,
      exceptions: [...flight.exceptions.values()].filter((e) => e.bagTag === bagTag),
    };
  }

  // 跨航班按行李牌查找（同一行李牌理论上只属于一个航班，这里防御性全量检索）。
  findBag(bagTag) {
    const found = [];
    for (const flight of this.flights.values()) {
      if (flight.bags.has(bagTag) || [...flight.scans.values()].some((s) => s.bagTag === bagTag)) {
        found.push(this.bagChain(flight.flightLegId, bagTag));
      }
    }
    return found;
  }

  bags(flightLegId) {
    const flight = this.#flight(flightLegId);
    return [...flight.bags.values()].map((b) => this.#publicBag(flight, b));
  }

  reset() {
    this.flights.clear();
  }
}
