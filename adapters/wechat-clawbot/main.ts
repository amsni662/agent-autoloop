// WeChat ClawBot chat entrypoint: `node adapters/wechat-clawbot/main.ts <config.json>`. Two loops share one state
// file — inbound getUpdates, outbound card delivery — each behind its own switch in `features`.
import { readFileSync } from "node:fs";
import { createWechatApp } from "./app.ts";
import { createTransportIO, type IlinkAccount } from "./ilink.ts";
import { loadConfig } from "../chat/config.ts";

const configFile = process.argv[2];
if (!configFile) {
  console.error("用法：node adapters/wechat-clawbot/main.ts <config.json>");
  process.exit(64);
}

const config = loadConfig(configFile);
if (!config.accountFile) {
  console.error("配置里要写 accountFile（ilink 绑定文件）");
  process.exit(64);
}
const account = JSON.parse(readFileSync(config.accountFile, "utf8")) as IlinkAccount;

const stopping = new AbortController();
const io = await createTransportIO(account, stopping.signal, config.transportDir).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
const app = await createWechatApp({ configFile, io });

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
let stopped = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function intake() {
  while (!stopped) {
    try {
      await app.pollOnce();
    } catch (error) {
      if (stopped) break;
      log(`收消息出错：${String(error).slice(0, 200)}`);
      await sleep(5_000);
    }
  }
}

async function deliver() {
  while (!stopped) {
    try {
      if (!(await app.deliverOnce(25))) await sleep(1_000);
    } catch (error) {
      if (stopped) break;
      log(`发卡出错：${String(error).slice(0, 200)}`);
      await sleep(5_000);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    stopped = true;
    stopping.abort();
  });
}

log(
  `wechat-clawbot 启动：hub=${config.hub} intake=${config.features.intake} notify=${config.features.notify} answers=${config.features.answers}`,
);
const loops = [];
if (config.features.intake) loops.push(intake());
if (config.features.notify) loops.push(deliver());
if (!loops.length) log("三个开关全关着，只待命");
await Promise.all(loops);
await app.stop();
log("已停");
