#!/usr/bin/env node
// Fake lark-cli for the Feishu chat adapter tests. Behavior it must have for the tests to mean anything:
// `event consume` writes noise lines before NDJSON, may split a JSON record across stdout chunks, then keeps
// running only while stdin is open (a closed stdin exits it, like the real consume); `im +messages-send` appends
// its argv as a JSON line to $LARK_LOG so tests see exactly what would have been sent.
import { appendFileSync } from "node:fs";

const [verb, ...rest] = process.argv.slice(2);
if (verb === "event" && rest[0] === "consume") {
  const lines = (process.env.LARK_EVENTS ?? "").split("\n").filter(Boolean);
  process.stdout.write("[event] listening for events\n");
  for (const line of lines) {
    // Split every record in two chunks: the adapter must buffer until a full line arrives.
    const mid = Math.max(1, Math.floor(line.length / 2));
    process.stdout.write(line.slice(0, mid));
    process.stdout.write(line.slice(mid) + "\n");
  }
  if (process.env.LARK_EXIT_AFTER) {
    setTimeout(() => process.exit(0), 100).unref();
    process.stdin.resume();
  } else {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  }
} else if (verb === "im" && rest[0] === "+messages-send") {
  if (process.env.LARK_LOG) appendFileSync(process.env.LARK_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
  if (process.env.LARK_SEND_FAIL) {
    console.error("send failed by fixture");
    process.exit(1);
  }
  console.log(JSON.stringify({ code: 0, data: { message_id: "om_fake_sent" } }));
} else {
  console.error(`fake lark-cli: unknown ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
