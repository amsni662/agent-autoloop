// Guards adapter configuration loading. Failure cases it prevents: paths or accounts baked into the code so the
// adapter only works on spider's Mac (the old bridges hard-coded /Users/spider); a missing switch silently
// defaulting to "everything on" when the file says otherwise; a missing required field starting the adapter and
// failing mid-run instead of at boot; "~" not expanding so state lands somewhere unexpected.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../adapters/chat/config.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-config-"));

test("配置文件提供全部路径和账号；features 三开关按文件来", () => {
  const file = join(dir, "wx.json");
  writeFileSync(
    file,
    JSON.stringify({
      hub: "http://127.0.0.1:9",
      me: "me@im.wechat",
      keysFile: join(dir, "keys.json"),
      rulesFile: join(dir, "rules.json"),
      stateFile: join(dir, "state.json"),
      features: { intake: true, notify: false, answers: true },
    }),
  );
  const config = loadConfig(file);
  assert.equal(config.hub, "http://127.0.0.1:9");
  assert.equal(config.me, "me@im.wechat");
  assert.deepEqual(config.features, { intake: true, notify: false, answers: true });
});

test("~ 展开、缺省开关全开、必填字段缺失报错", () => {
  const file = join(dir, "fs.json");
  writeFileSync(
    file,
    JSON.stringify({
      hub: "http://127.0.0.1:9",
      me: "ou_x",
      keysFile: "~/chat-keys.json",
      rulesFile: join(dir, "rules.json"),
      stateFile: "~/chat-state.json",
    }),
  );
  const config = loadConfig(file);
  assert.equal(config.keysFile, join(homedir(), "chat-keys.json"));
  assert.equal(config.stateFile, join(homedir(), "chat-state.json"));
  assert.deepEqual(config.features, { intake: true, notify: true, answers: true });

  for (const missing of ["hub", "me", "keysFile", "rulesFile", "stateFile"]) {
    const broken = join(dir, `broken-${missing}.json`);
    const full: Record<string, string> = {
      hub: "http://x",
      me: "m",
      keysFile: "k",
      rulesFile: "r",
      stateFile: "s",
    };
    delete full[missing];
    writeFileSync(broken, JSON.stringify(full));
    assert.throws(() => loadConfig(broken), new RegExp(missing));
  }
});
