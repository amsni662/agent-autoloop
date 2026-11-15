// Feishu chat entrypoint: `node adapters/feishu-chat/main.ts <config.json>`. One process owns the
// im.message.receive_v1 stream; card.action.trigger stays with the hub's own feishu channel.
import { createFeishuApp } from "./app.ts";
import { loadConfig } from "../chat/config.ts";

const configFile = process.argv[2];
if (!configFile) {
  console.error("用法：node adapters/feishu-chat/main.ts <config.json>");
  process.exit(64);
}
const config = loadConfig(configFile);
const app = await createFeishuApp({ configFile });
console.log(
  `feishu-chat 启动：hub=${config.hub} intake=${config.features.intake} notify=${config.features.notify} answers=${config.features.answers}`,
);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void app.stop().then(() => process.exit(0)));
