// Builds each watched repo's sandbox image from its own .factory/Dockerfile: `npm run build-images`.
// Run it again after a repo changes its Dockerfile. The agent user gets your UID/GID, so files the agent writes in the
// bind-mounted worktree stay yours.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { imageName } from "./sandbox.ts";
import { exec, kit, openRepo } from "./shared.ts";

const uid = exec(".", "id", ["-u"]);
const gid = exec(".", "id", ["-g"]);
for (const { slug, path } of kit().repos) {
  const repo = openRepo(slug, path);
  console.log(`${slug}: building ${imageName(repo)}`);
  execFileSync(
    "docker",
    [
      "build",
      "-t",
      imageName(repo),
      "--build-arg",
      `AGENT_UID=${uid}`,
      "--build-arg",
      `AGENT_GID=${gid}`,
      "-f",
      join(repo.root, ".factory/Dockerfile"),
      join(repo.root, ".factory"),
    ],
    { stdio: "inherit" },
  );
}
