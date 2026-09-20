/**
 * 出港行李装载核对中枢 —— 领域核心。
 *
 * 设计要点:
 * - 事件溯源:行李当前状态由扫描事件按 occurredAt(现场发生时间)折叠得出,
 *   receivedAt(系统接收时间)只用于幂等、冻结与证据判定;迟到、乱序、重复的
 *   扫描都不会破坏物理先后。
 * - 幂等:scanId 在航班内唯一,重试返回首次处理结果,不产生二次效果。
 * - 并发安全:所有领域变更都是同步函数,HTTP 层在解析完请求体后调用,中途没有
 *   await;Node 单线程下天然串行,一件行李绝不会同时处于两个有效位置。
 * - 更换容器/飞机不悄悄搬移归属:系统冻结受影响记录并要求重新扫描核对。
 */

export const SCAN_ACTIONS = Object.freeze([
  "ACCEPTED", // 收运
  "SORTED", // 分拣
  "LOADED_CONTAINER", // 装箱
  "LOADED_AIRCRAFT", // 装机
  "UNLOADED", // 卸下
  "VOIDED", // 作废
]);

export const PASSENGER_STATUSES = Object.freeze(["EXPECTED", "CHECKED_IN", "BOARDED", "NO_SHOW", "OFFLOADED"]);

export const EXCEPTION_TYPES = Object.freeze([
  "OFFLOAD_PENDING", // 减客后行李待卸下
  "LOCATION_CONFLICT", // 一件行李被扫进两个有效位置
  "ORDER_VIOLATION", // 扫描违反物理先后
  "CONTAINER_SWAP_REVERIFY", // 容器更换后待重新核对
  "AIRCRAFT_SWAP_REVERIFY", // 飞机更换后待重新核对
  "BOARDED_BAG_NOT_LOADED", // 已登机旅客的行李未装机
]);

export const DISPOSITION_ACTIONS = Object.freeze(["ACKNOWLEDGE", "VOID_SCAN"]);

const LOAD_ACTIONS = new Set(["LOADED_CONTAINER", "LOADED_AIRCRAFT"]);
const TERMINAL_STATES = new Set(["OFFLOADED", "VOIDED"]);

export class DomainError extends Error {
  constructor(code, message, status = 409, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createStore(options = {}) {
  return {
    now: options.now ?? (() => new Date().toISOString()),
    flights: new Map(),
    exceptionSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("invalid_field", `字段 ${field} 不能为空`, 400, { field });
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return requireString(value, field);
}

function requireOperator(body) {
  return requireString(body?.operator, "operator");
}

function parseTime(value, field) {
  const ms = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(ms)) {
    throw new DomainError("invalid_field", `字段 ${field} 不是合法时间`, 400, { field });
  }
  return new Date(ms).toISOString();
}

function getFlight(store, flightLegId) {
  const flight = store.flights.get(flightLegId);
  if (!flight) throw new DomainError("flight_not_found", `航班 ${flightLegId} 不存在`, 404);
  return flight;
}

function requireOpen(flight) {
  if (flight.status !== "OPEN") {
    throw new DomainError("flight_closed", `航班 ${flight.flightLegId} 已关闭装载,请先重开`, 409);
  }
  return flight;
}

function getPassenger(flight, passengerId) {
  const passenger = flight.passengers.get(passengerId);
  if (!passenger) throw new DomainError("passenger_not_found", `旅客 ${passengerId} 不存在`, 404);
  return passenger;
}

function getBag(flight, bagTag) {
  const bag = flight.bags.get(bagTag);
  if (!bag) throw new DomainError("bag_not_found", `行李牌 ${bagTag} 不存在`, 404);
  return bag;
}

function bump(flight) {
  flight.contentVersion += 1;
}

function recordAudit(store, flight, actor, action, detail = {}, at = undefined) {
  flight.audit.push({
    seq: flight.audit.length + 1,
    at: at ?? store.now(),
    actor,
    action,
    detail,
  });
}

function isContainerRetired(flight, containerId) {
  const container = flight.containers.get(containerId);
  return container ? container.status === "RETIRED" : false;
}

// ---------------------------------------------------------------------------
// 航班 / 旅客 / 行李登记
// ---------------------------------------------------------------------------

export function createFlight(store, payload) {
  const flightLegId = requireString(payload?.flightLegId, "flightLegId");
  const aircraftId = requireString(payload?.aircraftId, "aircraftId");
  if (store.flights.has(flightLegId)) {
    throw new DomainError("flight_exists", `航班 ${flightLegId} 已存在`, 409);
  }
  const flight = {
    flightLegId,
    aircraftId,
    route: optionalString(payload?.route, "route"),
    status: "OPEN",
    contentVersion: 0,
    manifestSeq: 0,
    passengers: new Map(),
    bags: new Map(),
    containers: new Map(),
    scans: new Map(),
    exceptions: new Map(),
    manifests: new Map(),
    audit: [],
    createdAt: store.now(),
    closedBy: null,
    closedAt: null,
  };
  store.flights.set(flightLegId, flight);
  recordAudit(store, flight, optionalString(payload?.operator, "operator") ?? "system", "FLIGHT_CREATED", { aircraftId });
  return flight;
}

export function registerPassenger(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const passengerId = requireString(payload?.passengerId, "passengerId");
  if (flight.passengers.has(passengerId)) {
    throw new DomainError("passenger_exists", `旅客 ${passengerId} 已登记`, 409);
  }
  const passenger = {
    passengerId,
    name: optionalString(payload?.name, "name"),
    status: "EXPECTED",
    updatedAt: store.now(),
    updatedBy: optionalString(payload?.operator, "operator"),
  };
  flight.passengers.set(passengerId, passenger);
  bump(flight);
  return passenger;
}

export function registerBag(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const bagTag = requireString(payload?.bagTag, "bagTag");
  const passengerId = requireString(payload?.passengerId, "passengerId");
  getPassenger(flight, passengerId);
  if (flight.bags.has(bagTag)) {
    throw new DomainError("bag_exists", `行李牌 ${bagTag} 已登记`, 409);
  }
  const bag = {
    bagTag,
    passengerId,
    state: "NONE",
    container: null,
    position: null,
    loadedAircraftId: null,
    mustOffload: false,
    frozen: null,
    events: [],
    createdAt: store.now(),
  };
  flight.bags.set(bagTag, bag);
  bump(flight);
  return bag;
}

// ---------------------------------------------------------------------------
// 扫描折叠:事件溯源状态机
// ---------------------------------------------------------------------------

function compareEvents(a, b) {
  const byOccurred = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (byOccurred !== 0) return byOccurred;
  const byReceived = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
  if (byReceived !== 0) return byReceived;
  return a.scanId < b.scanId ? -1 : a.scanId > b.scanId ? 1 : 0;
}

/**
 * 纯函数:按 occurredAt 顺序回放一件行李的全部有效扫描,得出当前状态。
 * 违反物理先后或造成双位置的扫描标记为 CONTESTED 并记入 violations,不改变状态。
 */
function foldBagEvents(flight, bag) {
  const ordered = bag.events.map((id) => flight.scans.get(id)).sort(compareEvents);
  let state = "NONE";
  let container = null;
  let position = null;
  let loadedAircraftId = null;
  const violations = [];

  const contest = (ev, code, reason) => {
    ev.result = "CONTESTED";
    ev.note = reason;
    violations.push({ ev, code, reason });
  };

  for (const ev of ordered) {
    ev.note = null;
    if (ev.voidedByOperator) {
      ev.result = "VOIDED_BY_OPERATOR";
      continue;
    }
    switch (ev.action) {
      case "ACCEPTED":
        if (state === "NONE" || state === "OFFLOADED") {
          state = "CHECKED_IN";
          container = null;
          position = null;
          loadedAircraftId = null;
          ev.result = "APPLIED";
        } else {
          ev.result = "REDUNDANT";
        }
        break;

      case "SORTED":
        if (state === "CHECKED_IN") {
          state = "SORTED";
          ev.result = "APPLIED";
        } else if (state === "NONE") {
          contest(ev, "ORDER_VIOLATION", "sorted_before_acceptance");
        } else {
          ev.result = "REDUNDANT";
        }
        break;

      case "LOADED_CONTAINER": {
        const target = ev.container;
        if (state === "CHECKED_IN" || state === "SORTED" || state === "OFFLOADED") {
          state = "IN_CONTAINER";
          container = target;
          position = null;
          loadedAircraftId = null;
          ev.result = "APPLIED";
        } else if (state === "IN_CONTAINER") {
          if (container === target) {
            ev.result = "REDUNDANT";
          } else if (isContainerRetired(flight, container) && !isContainerRetired(flight, target)) {
            // 容器更换后的重新核对:只有从已停用容器扫入在用容器才允许直接迁移
            container = target;
            ev.result = "APPLIED";
            ev.note = "reverified_after_container_swap";
          } else {
            contest(ev, "LOCATION_CONFLICT", `bag_already_in_${container}`);
          }
        } else if (state === "ON_AIRCRAFT") {
          contest(ev, "LOCATION_CONFLICT", "bag_already_on_aircraft");
        } else if (state === "NONE") {
          contest(ev, "ORDER_VIOLATION", "container_load_before_acceptance");
        } else {
          contest(ev, "ORDER_VIOLATION", "scan_on_voided_bag");
        }
        break;
      }

      case "LOADED_AIRCRAFT": {
        const tail = ev.aircraftId ?? flight.aircraftId;
        if (state === "IN_CONTAINER" || state === "CHECKED_IN" || state === "SORTED" || state === "OFFLOADED") {
          state = "ON_AIRCRAFT";
          if (ev.position) position = ev.position;
          loadedAircraftId = tail;
          ev.result = "APPLIED";
        } else if (state === "ON_AIRCRAFT") {
          if (tail !== loadedAircraftId) {
            // 飞机更换后的重新核对:装机扫描盖的是新飞机的章
            loadedAircraftId = tail;
            if (ev.position) position = ev.position;
            ev.result = "APPLIED";
            ev.note = "reverified_after_aircraft_swap";
          } else if (!ev.position || !position || ev.position === position) {
            ev.result = "REDUNDANT";
          } else {
            contest(ev, "LOCATION_CONFLICT", `bag_already_at_position_${position}`);
          }
        } else if (state === "NONE") {
          contest(ev, "ORDER_VIOLATION", "aircraft_load_before_acceptance");
        } else {
          contest(ev, "ORDER_VIOLATION", "scan_on_voided_bag");
        }
        break;
      }

      case "UNLOADED":
        if (state === "CHECKED_IN" || state === "SORTED" || state === "IN_CONTAINER" || state === "ON_AIRCRAFT") {
          if (ev.container && container && ev.container !== container) {
            contest(ev, "LOCATION_CONFLICT", `unload_container_mismatch_${ev.container}`);
          } else if (ev.position && position && ev.position !== position) {
            contest(ev, "LOCATION_CONFLICT", `unload_position_mismatch_${ev.position}`);
          } else {
            state = "OFFLOADED";
            container = null;
            position = null;
            loadedAircraftId = null;
            ev.result = "APPLIED";
          }
        } else if (state === "OFFLOADED") {
          ev.result = "REDUNDANT";
        } else if (state === "NONE") {
          contest(ev, "ORDER_VIOLATION", "unload_before_acceptance");
        } else {
          contest(ev, "ORDER_VIOLATION", "scan_on_voided_bag");
        }
        break;

      case "VOIDED":
        if (state === "VOIDED") {
          ev.result = "REDUNDANT";
        } else {
          state = "VOIDED";
          container = null;
          position = null;
          loadedAircraftId = null;
          ev.result = "APPLIED";
        }
        break;

      default:
        contest(ev, "ORDER_VIOLATION", "unknown_action");
    }
  }
  return { ordered, state, container, position, loadedAircraftId, violations };
}

function lastApplied(ordered, actions, since = undefined) {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const ev = ordered[i];
    if (ev.result !== "APPLIED" || !actions.includes(ev.action)) continue;
    if (since && Date.parse(ev.receivedAt) < Date.parse(since)) continue;
    return ev;
  }
  return null;
}

function addEvidence(flight, exceptionId, scanId) {
  const exception = flight.exceptions.get(exceptionId);
  if (exception && scanId && !exception.evidence.includes(scanId)) {
    exception.evidence.push(scanId);
  }
}

function openException(store, flight, { type, bagTag = null, passengerId = null, container = null, detail = null, evidenceScanId = null, at = undefined }) {
  // 同一行李同一类型的未结案异常不重复开立,只补充证据与细节
  for (const existing of flight.exceptions.values()) {
    if (existing.status === "OPEN" && existing.type === type && existing.bagTag === bagTag && existing.passengerId === passengerId) {
      if (evidenceScanId) addEvidence(flight, existing.exceptionId, evidenceScanId);
      if (detail && !existing.details.includes(detail)) existing.details.push(detail);
      return existing;
    }
  }
  const exception = {
    exceptionId: `EX-${String((store.exceptionSeq += 1)).padStart(4, "0")}`,
    type,
    bagTag,
    passengerId,
    container,
    status: "OPEN",
    openedAt: at ?? store.now(),
    details: detail ? [detail] : [],
    evidence: evidenceScanId ? [evidenceScanId] : [],
    disposition: null,
  };
  flight.exceptions.set(exception.exceptionId, exception);
  return exception;
}

function freezeBag(store, flight, bag, reason, at) {
  const type = reason === "CONTAINER_SWAP" ? "CONTAINER_SWAP_REVERIFY" : "AIRCRAFT_SWAP_REVERIFY";
  const exception = openException(store, flight, {
    type,
    bagTag: bag.bagTag,
    passengerId: bag.passengerId,
    container: bag.container,
    detail: reason === "CONTAINER_SWAP" ? `container_${bag.container}_retired` : `aircraft_changed_to_${flight.aircraftId}`,
    at,
  });
  bag.frozen = { reason, since: at ?? store.now(), exceptionId: exception.exceptionId };
}

/**
 * 折叠一件行李的全部扫描并同步派生状态:违规异常、冻结、解冻、减客证据。
 * 任何新扫描、作废扫描、容器/飞机更换后都要重新折叠,保证结论始终来自完整历史。
 */
function applyFold(store, flight, bag, options = {}) {
  const { ordered, state, container, position, loadedAircraftId, violations } = foldBagEvents(flight, bag);
  bag.state = state;
  bag.container = container;
  bag.position = position;
  bag.loadedAircraftId = loadedAircraftId;

  for (const violation of violations) {
    openException(store, flight, {
      type: violation.code,
      bagTag: bag.bagTag,
      passengerId: bag.passengerId,
      detail: violation.reason,
      evidenceScanId: violation.ev.scanId,
      at: options.at,
    });
  }

  // 落在已停用容器或已更换飞机上的行李:冻结并要求重新核对,绝不悄悄搬移
  if (!bag.frozen && state === "IN_CONTAINER" && isContainerRetired(flight, container)) {
    freezeBag(store, flight, bag, "CONTAINER_SWAP", options.at);
  } else if (!bag.frozen && state === "ON_AIRCRAFT" && loadedAircraftId !== flight.aircraftId) {
    freezeBag(store, flight, bag, "AIRCRAFT_SWAP", options.at);
  }

  // 重新核对:冻结行李被扫到有效位置(或被卸下/作废)后解冻并留下证据
  if (bag.frozen) {
    const since = bag.frozen.since;
    let evidence = null;
    if (state === "OFFLOADED" || state === "VOIDED") {
      evidence = lastApplied(ordered, ["UNLOADED", "VOIDED"], since);
    } else if (bag.frozen.reason === "CONTAINER_SWAP" && state === "IN_CONTAINER" && !isContainerRetired(flight, container)) {
      evidence = lastApplied(ordered, ["LOADED_CONTAINER"], since);
    } else if (bag.frozen.reason === "AIRCRAFT_SWAP" && state === "ON_AIRCRAFT" && loadedAircraftId === flight.aircraftId) {
      evidence = lastApplied(ordered, ["LOADED_AIRCRAFT"], since);
    }
    if (evidence) {
      const exceptionId = bag.frozen.exceptionId;
      bag.frozen = null;
      addEvidence(flight, exceptionId, evidence.scanId);
    }
  }

  // 减客行李被卸下/作废后,卸下要求自动满足并回填证据
  if (bag.mustOffload && (state === "OFFLOADED" || state === "VOIDED")) {
    bag.mustOffload = false;
    const evidence = lastApplied(ordered, ["UNLOADED", "VOIDED"]);
    for (const exception of flight.exceptions.values()) {
      if (exception.type === "OFFLOAD_PENDING" && exception.bagTag === bag.bagTag && exception.status === "OPEN" && evidence) {
        addEvidence(flight, exception.exceptionId, evidence.scanId);
      }
    }
  }

  // 已登机旅客的行李被卸下 → 自动挂异常等待处置结论
  const passenger = flight.passengers.get(bag.passengerId);
  if (passenger && passenger.status === "BOARDED" && state === "OFFLOADED") {
    openException(store, flight, {
      type: "BOARDED_BAG_NOT_LOADED",
      bagTag: bag.bagTag,
      passengerId: passenger.passengerId,
      detail: "boarded_passenger_bag_offloaded",
      evidenceScanId: lastApplied(ordered, ["UNLOADED"])?.scanId ?? null,
      at: options.at,
    });
  }
  return bag;
}

// ---------------------------------------------------------------------------
// 扫描接收(含离线补传):幂等 + 准入校验 + 折叠
// ---------------------------------------------------------------------------

export function ingestScan(store, flightLegId, payload, options = {}) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const scanId = requireString(payload?.scanId, "scanId");
  const bagTag = requireString(payload?.bagTag, "bagTag");
  const action = requireString(payload?.action, "action");
  if (!SCAN_ACTIONS.includes(action)) {
    throw new DomainError("invalid_field", `未知扫描动作 ${action}`, 400, { field: "action" });
  }
  const occurredAt = parseTime(payload?.occurredAt, "occurredAt");
  const container = optionalString(payload?.container, "container");
  const position = optionalString(payload?.position, "position");
  if (action === "LOADED_CONTAINER" && !container) {
    throw new DomainError("invalid_field", "装箱扫描必须携带 container", 400, { field: "container" });
  }

  // 幂等:同一 scanId 重试直接返回首次结果;曾被拒收的扫描也保持原结论
  const existing = flight.scans.get(scanId);
  if (existing) {
    if (existing.result === "REJECTED") {
      const error = new DomainError(existing.reason, `扫描 ${scanId} 曾被拒收:${existing.reason}`, 409);
      error.scan = existing;
      error.duplicate = true;
      throw error;
    }
    return { scan: existing, duplicate: true, bag: flight.bags.get(existing.bagTag) ?? null };
  }

  const receivedAt = options.receivedAt ? parseTime(options.receivedAt, "receivedAt") : store.now();
  const scan = {
    scanId,
    bagTag,
    flightLegId,
    action,
    container,
    position,
    occurredAt,
    receivedAt,
    actor: optionalString(payload?.actor, "actor"),
    aircraftId: action === "LOADED_AIRCRAFT" ? flight.aircraftId : undefined,
    result: "PENDING",
    note: null,
  };

  let bag = flight.bags.get(bagTag);
  if (!bag) {
    if (action === "ACCEPTED" && payload?.passengerId) {
      const passengerId = requireString(payload.passengerId, "passengerId");
      getPassenger(flight, passengerId);
      bag = {
        bagTag,
        passengerId,
        state: "NONE",
        container: null,
        position: null,
        loadedAircraftId: null,
        mustOffload: false,
        frozen: null,
        events: [],
        createdAt: receivedAt,
      };
      flight.bags.set(bagTag, bag);
    } else {
      throw new DomainError("unknown_bag", `行李牌 ${bagTag} 未登记,且扫描不是收运`, 404);
    }
  }

  const reject = (code, message) => {
    scan.result = "REJECTED";
    scan.reason = code;
    flight.scans.set(scanId, scan); // 拒收也留痕,保证重试结论一致、链路可查
    const error = new DomainError(code, message, 409);
    error.scan = scan;
    throw error;
  };

  const passenger = flight.passengers.get(bag.passengerId);
  if (LOAD_ACTIONS.has(action) && passenger && (passenger.status === "OFFLOADED" || passenger.status === "NO_SHOW")) {
    reject("passenger_not_boardable", `旅客 ${passenger.passengerId} 已减客/未登机,禁止装载其行李`);
  }
  if (bag.frozen) {
    const allowed =
      bag.frozen.reason === "CONTAINER_SWAP" ? ["LOADED_CONTAINER", "UNLOADED", "VOIDED"] : ["LOADED_AIRCRAFT", "UNLOADED", "VOIDED"];
    if (!allowed.includes(action)) {
      reject("bag_frozen", `行李 ${bagTag} 已冻结(${bag.frozen.reason}),等待重新核对`);
    }
  }
  if (action === "LOADED_CONTAINER") {
    const known = flight.containers.get(container);
    if (known && known.status === "RETIRED") {
      reject("container_retired", `容器 ${container} 已停用,禁止继续装箱`);
    }
    if (!known) {
      flight.containers.set(container, { containerId: container, status: "ACTIVE", createdAt: receivedAt, retiredAt: null, retiredReason: null, replacedBy: null });
    }
  }

  flight.scans.set(scanId, scan);
  bag.events.push(scanId);
  applyFold(store, flight, bag);

  // 收运扫描生效时,旅客若尚未值机则联动为已值机
  if (action === "ACCEPTED" && scan.result === "APPLIED" && passenger && passenger.status === "EXPECTED") {
    passenger.status = "CHECKED_IN";
    passenger.updatedAt = receivedAt;
    passenger.updatedBy = scan.actor ?? "system:scan";
  }

  bump(flight);
  return { scan, duplicate: false, bag };
}

// ---------------------------------------------------------------------------
// 减客 / 登机资格
// ---------------------------------------------------------------------------

function markBagsForOffload(store, flight, passenger, at) {
  const marked = [];
  for (const bag of flight.bags.values()) {
    if (bag.passengerId !== passenger.passengerId || TERMINAL_STATES.has(bag.state)) continue;
    bag.mustOffload = bag.state === "IN_CONTAINER" || bag.state === "ON_AIRCRAFT";
    openException(store, flight, {
      type: "OFFLOAD_PENDING",
      bagTag: bag.bagTag,
      passengerId: passenger.passengerId,
      detail: bag.mustOffload ? "bag_loaded_must_unload" : "bag_not_loaded_must_intercept",
      at,
    });
    marked.push(bag.bagTag);
  }
  return marked;
}

export function offloadPassenger(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const passengerId = requireString(payload?.passengerId, "passengerId");
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const passenger = getPassenger(flight, passengerId);
  if (passenger.status === "OFFLOADED") {
    throw new DomainError("already_offloaded", `旅客 ${passengerId} 已减客`, 409);
  }
  passenger.status = "OFFLOADED";
  passenger.updatedAt = at;
  passenger.updatedBy = operator;
  const bagsMarked = markBagsForOffload(store, flight, passenger, at);
  bump(flight);
  recordAudit(store, flight, operator, "PASSENGER_OFFLOADED", { passengerId, reason: optionalString(payload?.reason, "reason"), bagsMarked }, at);
  return { passenger, bagsMarked };
}

export function setPassengerStatus(store, flightLegId, passengerId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const status = requireString(payload?.status, "status");
  if (status === "OFFLOADED") {
    throw new DomainError("use_offload_endpoint", "减客请使用 /offloads,以便同步标出待卸行李", 400);
  }
  if (!PASSENGER_STATUSES.includes(status)) {
    throw new DomainError("invalid_field", `未知旅客状态 ${status}`, 400, { field: "status" });
  }
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const passenger = getPassenger(flight, passengerId);
  const previous = passenger.status;
  passenger.status = status;
  passenger.updatedAt = at;
  passenger.updatedBy = operator;

  if (status === "NO_SHOW") {
    markBagsForOffload(store, flight, passenger, at);
  }
  if (status === "BOARDED") {
    for (const bag of flight.bags.values()) {
      if (bag.passengerId !== passengerId) continue;
      bag.mustOffload = false; // 重新登机后卸下要求解除,异常仍待处置留痕
      if (bag.state === "OFFLOADED") {
        openException(store, flight, {
          type: "BOARDED_BAG_NOT_LOADED",
          bagTag: bag.bagTag,
          passengerId,
          detail: "boarded_with_bag_offloaded",
          at,
        });
      }
    }
  }
  bump(flight);
  recordAudit(store, flight, operator, "PASSENGER_STATUS_CHANGED", { passengerId, from: previous, to: status }, at);
  return passenger;
}

// ---------------------------------------------------------------------------
// 容器 / 飞机更换:冻结受影响记录,要求重新核对
// ---------------------------------------------------------------------------

export function swapContainer(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const oldContainerId = requireString(payload?.oldContainerId, "oldContainerId");
  const newContainerId = requireString(payload?.newContainerId, "newContainerId");
  if (oldContainerId === newContainerId) {
    throw new DomainError("invalid_field", "新旧容器不能相同", 400, { field: "newContainerId" });
  }
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const oldContainer = flight.containers.get(oldContainerId);
  if (!oldContainer) throw new DomainError("container_not_found", `容器 ${oldContainerId} 不存在`, 404);
  if (oldContainer.status !== "ACTIVE") {
    throw new DomainError("container_not_active", `容器 ${oldContainerId} 当前状态为 ${oldContainer.status}`, 409);
  }
  const existingNew = flight.containers.get(newContainerId);
  if (existingNew && existingNew.status !== "ACTIVE") {
    throw new DomainError("container_not_active", `新容器 ${newContainerId} 当前状态为 ${existingNew.status}`, 409);
  }
  if (!existingNew) {
    flight.containers.set(newContainerId, { containerId: newContainerId, status: "ACTIVE", createdAt: at, retiredAt: null, retiredReason: null, replacedBy: null });
  }
  oldContainer.status = "RETIRED";
  oldContainer.retiredAt = at;
  oldContainer.retiredReason = optionalString(payload?.reason, "reason");
  oldContainer.replacedBy = newContainerId;

  // 重新折叠仍挂在旧容器上的行李:折叠会冻结它们并要求重新核对,归属不变
  const affected = [];
  for (const bag of flight.bags.values()) {
    if (bag.container === oldContainerId && (bag.state === "IN_CONTAINER" || bag.state === "ON_AIRCRAFT")) {
      applyFold(store, flight, bag, { at });
      affected.push(bag.bagTag);
    }
  }
  bump(flight);
  recordAudit(store, flight, operator, "CONTAINER_SWAPPED", { oldContainerId, newContainerId, reason: oldContainer.retiredReason, affectedBags: affected }, at);
  return { oldContainer, newContainer: flight.containers.get(newContainerId), affectedBags: affected };
}

export function swapAircraft(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const newAircraftId = requireString(payload?.newAircraftId, "newAircraftId");
  if (newAircraftId === flight.aircraftId) {
    throw new DomainError("invalid_field", "新飞机与当前飞机相同", 400, { field: "newAircraftId" });
  }
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const previousAircraftId = flight.aircraftId;
  flight.aircraftId = newAircraftId;

  // 已装机行李仍“在旧飞机上”:重新折叠触发冻结,等待在新飞机上重新扫描核对
  const affected = [];
  for (const bag of flight.bags.values()) {
    if (bag.state === "ON_AIRCRAFT" && bag.loadedAircraftId === previousAircraftId) {
      applyFold(store, flight, bag, { at });
      affected.push(bag.bagTag);
    }
  }
  bump(flight);
  recordAudit(store, flight, operator, "AIRCRAFT_SWAPPED", { previousAircraftId, newAircraftId, reason: optionalString(payload?.reason, "reason"), affectedBags: affected }, at);
  return { previousAircraftId, newAircraftId, affectedBags: affected };
}

// ---------------------------------------------------------------------------
// 异常处置
// ---------------------------------------------------------------------------

export function dispositionException(store, flightLegId, exceptionId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const action = requireString(payload?.action, "action");
  if (!DISPOSITION_ACTIONS.includes(action)) {
    throw new DomainError("invalid_field", `未知处置动作 ${action}`, 400, { field: "action" });
  }
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const exception = flight.exceptions.get(exceptionId);
  if (!exception) throw new DomainError("exception_not_found", `异常 ${exceptionId} 不存在`, 404);
  if (exception.status !== "OPEN") {
    throw new DomainError("already_dispositioned", `异常 ${exceptionId} 已有处置结论`, 409);
  }
  const bag = exception.bagTag ? flight.bags.get(exception.bagTag) : null;

  if (action === "VOID_SCAN") {
    const scanId = requireString(payload?.scanId, "scanId");
    const scan = flight.scans.get(scanId);
    if (!scan) throw new DomainError("scan_not_found", `扫描 ${scanId} 不存在`, 404);
    if (exception.bagTag && scan.bagTag !== exception.bagTag) {
      throw new DomainError("scan_bag_mismatch", `扫描 ${scanId} 不属于异常涉及的行李`, 400);
    }
    if (scan.voidedByOperator) throw new DomainError("scan_already_voided", `扫描 ${scanId} 已被作废`, 409);
    if (scan.result === "REJECTED") throw new DomainError("scan_not_in_fold", `扫描 ${scanId} 未进入有效历史,无需作废`, 400);
    scan.voidedByOperator = { operator, at };
    const scanBag = flight.bags.get(scan.bagTag);
    if (scanBag) applyFold(store, flight, scanBag, { at });
  } else {
    // ACKNOWLEDGE 的安全闸:关键异常必须先有客观证据,不能只凭口头结论
    if (exception.type === "OFFLOAD_PENDING" && bag && !TERMINAL_STATES.has(bag.state) && bag.state !== "NONE") {
      throw new DomainError("bag_not_unloaded", `行李 ${bag.bagTag} 尚未卸下/作废,不能结案`, 409, { state: bag.state });
    }
    if ((exception.type === "CONTAINER_SWAP_REVERIFY" || exception.type === "AIRCRAFT_SWAP_REVERIFY") && bag && bag.frozen) {
      throw new DomainError("bag_still_frozen", `行李 ${bag.bagTag} 仍冻结,请先重新扫描核对`, 409);
    }
  }

  exception.status = "DISPOSITIONED";
  exception.disposition = {
    action,
    operator,
    note: optionalString(payload?.note, "note"),
    scanId: action === "VOID_SCAN" ? payload.scanId : null,
    at,
  };
  bump(flight);
  recordAudit(store, flight, operator, "EXCEPTION_DISPOSITIONED", { exceptionId, type: exception.type, action, bagTag: exception.bagTag }, at);
  return exception;
}

// ---------------------------------------------------------------------------
// 舱单 / 签署 / 关闭 / 重开
// ---------------------------------------------------------------------------

export function buildSnapshot(store, flight) {
  const bags = [...flight.bags.values()];
  const onAircraft = bags.filter((bag) => bag.state === "ON_AIRCRAFT" && bag.loadedAircraftId === flight.aircraftId);
  const byState = {};
  for (const bag of bags) byState[bag.state] = (byState[bag.state] ?? 0) + 1;
  const positions = {};
  for (const bag of onAircraft) {
    const key = bag.position ?? "UNASSIGNED";
    (positions[key] ??= []).push(bag.bagTag);
  }
  const passengers = [...flight.passengers.values()];
  return {
    flightLegId: flight.flightLegId,
    aircraftId: flight.aircraftId,
    bags: {
      total: bags.length,
      byState,
      onAircraft: onAircraft.map((bag) => ({ bagTag: bag.bagTag, container: bag.container, position: bag.position, passengerId: bag.passengerId })),
      mustOffload: bags.filter((bag) => bag.mustOffload).map((bag) => bag.bagTag),
      frozen: bags.filter((bag) => bag.frozen).map((bag) => bag.bagTag),
    },
    containers: [...flight.containers.values()].map((container) => ({
      containerId: container.containerId,
      status: container.status,
      replacedBy: container.replacedBy,
      bags: bags.filter((bag) => bag.container === container.containerId && (bag.state === "IN_CONTAINER" || bag.state === "ON_AIRCRAFT")).map((bag) => bag.bagTag),
    })),
    positions,
    passengers: {
      total: passengers.length,
      boarded: passengers.filter((p) => p.status === "BOARDED").length,
      offloaded: passengers.filter((p) => p.status === "OFFLOADED" || p.status === "NO_SHOW").length,
    },
    openExceptions: [...flight.exceptions.values()].filter((ex) => ex.status === "OPEN").length,
  };
}

export function generateManifest(store, flightLegId, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const manifest = {
    version: (flight.manifestSeq += 1),
    contentVersion: flight.contentVersion,
    flightLegId,
    generatedAt: at,
    generatedBy: operator,
    snapshot: buildSnapshot(store, flight),
    signatures: [],
  };
  flight.manifests.set(manifest.version, manifest);
  recordAudit(store, flight, operator, "MANIFEST_GENERATED", { version: manifest.version, contentVersion: manifest.contentVersion }, at);
  return manifest;
}

function getManifest(flight, version) {
  const manifest = flight.manifests.get(Number(version));
  if (!manifest) throw new DomainError("manifest_not_found", `舱单版本 ${version} 不存在`, 404);
  return manifest;
}

export function latestManifest(flight) {
  let latest = null;
  for (const manifest of flight.manifests.values()) {
    if (!latest || manifest.version > latest.version) latest = manifest;
  }
  return latest;
}

export function signManifest(store, flightLegId, version, payload) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const operator = requireOperator(payload);
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const manifest = getManifest(flight, version);
  if (manifest.signatures.some((sig) => sig.operator === operator)) {
    throw new DomainError("already_signed", `${operator} 已签署过舱单版本 ${manifest.version}`, 409);
  }
  manifest.signatures.push({ operator, at });
  recordAudit(store, flight, operator, "MANIFEST_SIGNED", { version: manifest.version }, at);
  return manifest;
}

export function withdrawSignature(store, flightLegId, version, operator, payload = {}) {
  const flight = requireOpen(getFlight(store, flightLegId));
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const manifest = getManifest(flight, version);
  const index = manifest.signatures.findIndex((sig) => sig.operator === operator);
  if (index === -1) throw new DomainError("signature_not_found", `${operator} 未签署舱单版本 ${manifest.version}`, 404);
  manifest.signatures.splice(index, 1);
  recordAudit(store, flight, operator, "SIGNATURE_WITHDRAWN", { version: manifest.version }, at);
  return manifest;
}

/**
 * 当前阻止签署/关闭的完整清单:未结案异常、已登机旅客行李去向不明、
 * 已装机行李的旅客未登机、舱单过期、双人签署不足。
 */
export function computeBlockers(store, flight) {
  const blockers = [];
  for (const exception of flight.exceptions.values()) {
    if (exception.status === "OPEN") {
      blockers.push({ code: "OPEN_EXCEPTION", exceptionId: exception.exceptionId, type: exception.type, bagTag: exception.bagTag, passengerId: exception.passengerId });
    }
  }
  for (const bag of flight.bags.values()) {
    const passenger = flight.passengers.get(bag.passengerId);
    const onCurrentAircraft = bag.state === "ON_AIRCRAFT" && bag.loadedAircraftId === flight.aircraftId;
    if (passenger && passenger.status === "BOARDED" && !onCurrentAircraft && bag.state !== "VOIDED") {
      const covered = [...flight.exceptions.values()].some(
        (ex) => ex.type === "BOARDED_BAG_NOT_LOADED" && ex.bagTag === bag.bagTag && ex.status === "DISPOSITIONED",
      );
      if (!covered) {
        blockers.push({ code: "BOARDED_BAG_NOT_ON_AIRCRAFT", bagTag: bag.bagTag, passengerId: passenger.passengerId, state: bag.state });
      }
    }
    if (onCurrentAircraft && passenger && passenger.status !== "BOARDED") {
      blockers.push({ code: "LOADED_BAG_PASSENGER_NOT_BOARDED", bagTag: bag.bagTag, passengerId: passenger.passengerId, passengerStatus: passenger.status });
    }
  }
  const latest = latestManifest(flight);
  if (!latest || latest.contentVersion !== flight.contentVersion) {
    blockers.push({ code: "MANIFEST_STALE", contentVersion: flight.contentVersion, manifestContentVersion: latest ? latest.contentVersion : null });
  } else if (new Set(latest.signatures.map((sig) => sig.operator)).size < 2) {
    blockers.push({ code: "SIGNATURES_REQUIRED", manifestVersion: latest.version, have: new Set(latest.signatures.map((sig) => sig.operator)).size, need: 2 });
  }
  return blockers;
}

export function closeFlight(store, flightLegId, payload) {
  const flight = getFlight(store, flightLegId);
  if (flight.status === "CLOSED") {
    throw new DomainError("already_closed", `航班 ${flightLegId} 已关闭装载`, 409);
  }
  const operator = requireOperator(payload);
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  const blockers = computeBlockers(store, flight);
  if (blockers.length > 0) {
    throw new DomainError("close_blocked", "存在未清除的关闭阻塞项", 409, { blockers });
  }
  flight.status = "CLOSED";
  flight.closedBy = operator;
  flight.closedAt = at;
  recordAudit(store, flight, operator, "FLIGHT_CLOSED", { manifestVersion: latestManifest(flight)?.version ?? null }, at);
  return flight;
}

export function reopenFlight(store, flightLegId, payload) {
  const flight = getFlight(store, flightLegId);
  if (flight.status !== "CLOSED") {
    throw new DomainError("not_closed", `航班 ${flightLegId} 未处于关闭状态`, 409);
  }
  const operator = requireOperator(payload);
  const reason = requireString(payload?.reason, "reason");
  const at = payload?.at ? parseTime(payload.at, "at") : store.now();
  flight.status = "OPEN";
  flight.closedBy = null;
  flight.closedAt = null;
  bump(flight); // 重开后原舱单失效,必须重新出单、重新双人签署
  recordAudit(store, flight, operator, "FLIGHT_REOPENED", { reason }, at);
  return flight;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function summarizeBag(bag) {
  return {
    bagTag: bag.bagTag,
    passengerId: bag.passengerId,
    state: bag.state,
    container: bag.container,
    position: bag.position,
    loadedAircraftId: bag.loadedAircraftId,
    mustOffload: bag.mustOffload,
    frozen: bag.frozen,
  };
}

export function flightSummary(store, flight) {
  const bags = [...flight.bags.values()];
  const passengers = [...flight.passengers.values()];
  const latest = latestManifest(flight);
  return {
    flightLegId: flight.flightLegId,
    aircraftId: flight.aircraftId,
    route: flight.route,
    status: flight.status,
    contentVersion: flight.contentVersion,
    counts: {
      passengers: passengers.length,
      boarded: passengers.filter((p) => p.status === "BOARDED").length,
      offloaded: passengers.filter((p) => p.status === "OFFLOADED" || p.status === "NO_SHOW").length,
      bags: bags.length,
      onAircraft: bags.filter((b) => b.state === "ON_AIRCRAFT" && b.loadedAircraftId === flight.aircraftId).length,
      frozen: bags.filter((b) => b.frozen).length,
      mustOffload: bags.filter((b) => b.mustOffload).length,
      openExceptions: [...flight.exceptions.values()].filter((ex) => ex.status === "OPEN").length,
    },
    latestManifest: latest
      ? { version: latest.version, contentVersion: latest.contentVersion, current: latest.contentVersion === flight.contentVersion, signatures: latest.signatures.length }
      : null,
    closedBy: flight.closedBy,
    closedAt: flight.closedAt,
    createdAt: flight.createdAt,
  };
}

export function bagTrace(store, flight, bagTag) {
  const bag = getBag(flight, bagTag);
  const inFold = bag.events.map((id) => flight.scans.get(id));
  const rejected = [...flight.scans.values()].filter((scan) => scan.bagTag === bagTag && scan.result === "REJECTED" && !bag.events.includes(scan.scanId));
  const events = [...inFold, ...rejected].sort(compareEvents);
  return {
    ...summarizeBag(bag),
    flightLegId: flight.flightLegId,
    events,
    exceptions: [...flight.exceptions.values()].filter((ex) => ex.bagTag === bagTag),
  };
}
