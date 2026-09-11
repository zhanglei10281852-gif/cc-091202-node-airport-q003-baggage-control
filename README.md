# 出港行李装载资料服务

这里整理行李牌、集装器和航班舱单之间的关联示例。`fixtures/context.json` 包含一次旅客减客、离线扫描迟到和容器替换，事件的 `occurredAt` 与 `receivedAt` 用于区分现场发生顺序和系统接收顺序。

使用 Node.js 20 以上版本执行 `npm test` 与 `npm start`，健康探针为 `GET /health`。容器方式执行 `docker compose up --build`。样例均为脱敏数据，本地密钥、真实行李信息和运行日志由 `.gitignore` 排除。
