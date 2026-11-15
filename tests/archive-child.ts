// Ran by archive-lock.test.ts as a separate process: write back to one project's archive COUNT times, each on the
// version read just before, so overlapping writers contend on the same bases for real. HALT kills this process
// mid-write-back, like kill -9 at that point.
import { readArchive, writeBack } from "../archive/store.ts";

const [project, root, count, me] = process.argv.slice(2);
const halt = process.env.HALT as "after-commit" | "after-tag" | undefined;
for (let i = 0; i < Number(count); i++) {
  const version = readArchive(project, root).version;
  writeBack(
    project,
    { base: version, log: [`${me} 的第 ${i} 笔`], status: `# 状态\n${me} 写到第 ${i} 笔\n` },
    { root, by: me, halt },
  );
}
