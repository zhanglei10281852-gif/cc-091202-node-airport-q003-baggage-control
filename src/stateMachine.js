// 行李轨迹状态机（纯函数，无副作用）。
//
// 有效轨迹必须遵守的物理先后：
//   收运 ACCEPTED → 分拣 SORTED → 装箱 LOADED_CONTAINER → 装机 LOADED_AIRCRAFT
//   卸下 OFFLOADED 使行李回到地面，之后可重新装箱 / 装机（即“重新核对”）。
//   作废 VOIDED 不直接参与轨迹：由引擎作废目标扫描后重新折叠剩余轨迹。
//
// 扫描可以迟到或重复：
//   - 迟到扫描按 occurredAt 插入轨迹后整体重新折叠验证；
//   - 与已应用扫描效果一致的重复扫描是幂等空操作（repeat）；
//   - 任何会使一件行李同时处于两个有效位置的扫描都会被拒绝（DOUBLE_POSITION）。

export const BagState = Object.freeze({
  EXPECTED: "EXPECTED", // 已登记（值机），尚无扫描
  ACCEPTED: "ACCEPTED", // 已收运
  SORTED: "SORTED", // 已分拣
  IN_CONTAINER: "IN_CONTAINER", // 已装箱（集装器）
  ON_AIRCRAFT: "ON_AIRCRAFT", // 已装机
  OFFLOADED: "OFFLOADED", // 已卸下，回到地面
});

export const ScanAction = Object.freeze({
  ACCEPTED: "ACCEPTED",
  SORTED: "SORTED",
  LOADED_CONTAINER: "LOADED_CONTAINER",
  LOADED_AIRCRAFT: "LOADED_AIRCRAFT",
  OFFLOADED: "OFFLOADED",
  VOIDED: "VOIDED",
});

export const RejectCode = Object.freeze({
  OUT_OF_SEQUENCE: "OUT_OF_SEQUENCE", // 违反物理先后
  DOUBLE_POSITION: "DOUBLE_POSITION", // 一件行李被算进两个有效位置
});

// 前向动作的物理顺序，用于计算跳级时的“推定经过”环节。
const FORWARD_ORDER = [
  ScanAction.ACCEPTED,
  ScanAction.SORTED,
  ScanAction.LOADED_CONTAINER,
  ScanAction.LOADED_AIRCRAFT,
];

// 各状态在前进轴上的位置；OFFLOADED 视为“已收运分拣过的地面行李”，
// 重新装载时只需补装箱环节。
function forwardIndex(state) {
  switch (state) {
    case BagState.EXPECTED:
      return -1;
    case BagState.ACCEPTED:
      return 0;
    case BagState.SORTED:
      return 1;
    case BagState.IN_CONTAINER:
      return 2;
    case BagState.ON_AIRCRAFT:
      return 3;
    case BagState.OFFLOADED:
      return 1;
    default:
      throw new Error(`未知行李状态: ${state}`);
  }
}

// 跳级扫描时推定经过的中间环节（扫描枪漏扫/离线时容忍，但在链路中标注）。
function impliedStages(fromState, toAction) {
  const from = forwardIndex(fromState);
  const to = FORWARD_ORDER.indexOf(toAction);
  if (to - from <= 1) return [];
  return FORWARD_ORDER.slice(from + 1, to);
}

function stepOk(scan, from, to) {
  return {
    scanId: scan.scanId,
    action: scan.action,
    container: to.container,
    state: to.state,
    implied: to.implied ?? [],
    repeat: false,
    offloadFrom: to.offloadFrom ?? null,
  };
}

function stepRepeat(scan, current) {
  return {
    scanId: scan.scanId,
    action: scan.action,
    container: current.container,
    state: current.state,
    implied: [],
    repeat: true,
    offloadFrom: null,
  };
}

function stepFail(scan, code, reason) {
  return { failure: { scanId: scan.scanId, code, reason } };
}

// 单步转移。current: {state, container, lastContainer}；scan: {scanId, action, container?}
function transition(current, scan) {
  const target = scan.container ?? null;
  switch (scan.action) {
    case ScanAction.ACCEPTED:
    case ScanAction.SORTED: {
      // 地面环节：只能前进；已经过该环节的重复扫描幂等。
      if (forwardIndex(current.state) < FORWARD_ORDER.indexOf(scan.action)) {
        return stepOk(scan, current, {
          state: scan.action,
          container: current.container,
          implied: impliedStages(current.state, scan.action),
        });
      }
      return stepRepeat(scan, current);
    }

    case ScanAction.LOADED_CONTAINER: {
      if (current.state === BagState.IN_CONTAINER || current.state === BagState.ON_AIRCRAFT) {
        if (current.container === target) return stepRepeat(scan, current);
        if (current.state === BagState.ON_AIRCRAFT && current.container === null) {
          // 散装已装机，后到的装箱补扫不反向改写状态。
          return stepRepeat(scan, current);
        }
        return stepFail(
          scan,
          RejectCode.DOUBLE_POSITION,
          `行李当前有效位置为 ${current.container}，不能同时装入 ${target}`,
        );
      }
      // 地面 / 已卸下 → 装箱
      return stepOk(scan, current, {
        state: BagState.IN_CONTAINER,
        container: target,
        implied: impliedStages(current.state, scan.action),
      });
    }

    case ScanAction.LOADED_AIRCRAFT: {
      if (current.state === BagState.ON_AIRCRAFT) {
        if (target === null || current.container === null || current.container === target) {
          return stepRepeat(scan, current);
        }
        return stepFail(
          scan,
          RejectCode.DOUBLE_POSITION,
          `行李已随 ${current.container} 装机，装机扫描却指向 ${target}`,
        );
      }
      if (current.state === BagState.IN_CONTAINER) {
        if (target !== null && target !== current.container) {
          return stepFail(
            scan,
            RejectCode.DOUBLE_POSITION,
            `行李在 ${current.container} 中，装机扫描却指向 ${target}`,
          );
        }
        return stepOk(scan, current, {
          state: BagState.ON_AIRCRAFT,
          container: current.container,
        });
      }
      // 地面 / 已卸下直接装机：容忍中间环节漏扫，标记推定；散装时 container 为空。
      return stepOk(scan, current, {
        state: BagState.ON_AIRCRAFT,
        container: target ?? current.lastContainer ?? null,
        implied: impliedStages(current.state, scan.action),
      });
    }

    case ScanAction.OFFLOADED: {
      if (current.state === BagState.IN_CONTAINER || current.state === BagState.ON_AIRCRAFT) {
        return stepOk(scan, current, {
          state: BagState.OFFLOADED,
          container: null,
          offloadFrom: current.state,
        });
      }
      if (current.state === BagState.OFFLOADED) return stepRepeat(scan, current);
      return stepFail(
        scan,
        RejectCode.OUT_OF_SEQUENCE,
        "行李尚未装箱/装机，不存在可卸下的装载记录",
      );
    }

    default:
      return stepFail(scan, RejectCode.OUT_OF_SEQUENCE, `不支持的扫描动作: ${scan.action}`);
  }
}

// 折叠一条按 occurredAt 排序的已应用扫描序列，验证物理先后并求出当前状态。
// scans: [{scanId, action, container?, occurredAt}]（VOIDED 动作的扫描不入列，
// 已被作废的扫描由引擎事先剔除）。
// 返回 { ok, state, container, lastContainer, steps, failure? }；
// steps 与输入一一对应，记录每一步的结果状态与推定环节，供链路还原使用。
export function foldTrajectory(scans) {
  let current = { state: BagState.EXPECTED, container: null, lastContainer: null };
  const steps = [];
  for (const scan of scans) {
    const result = transition(current, scan);
    if (result.failure) {
      return { ok: false, failure: result.failure, steps };
    }
    steps.push(result);
    if (!result.repeat) {
      current = {
        state: result.state,
        container: result.container,
        lastContainer:
          result.state === BagState.OFFLOADED ? current.container ?? current.lastContainer : result.container ?? current.lastContainer,
      };
    }
  }
  return {
    ok: true,
    state: current.state,
    container: current.state === BagState.OFFLOADED ? null : current.container,
    lastContainer: current.lastContainer,
    steps,
  };
}
