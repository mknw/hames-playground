#!/usr/bin/env node
// prepublishOnly guard: refuse to publish unless HEAD is exactly the release tag
// for the package in the current directory (`@hames-ai/<pkg>@<version>`, which the
// release workflow pushes on the "version packages" merge commit).
//
// 0.3.0 was published from `main` after the tag, so its tarball carried commits
// its changelog never described; npm versions are immutable, so the guard is the
// only fix. Run by each package's `prepublishOnly` with the package as cwd.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `${name}@${version}`;

let tags;
try {
  tags = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    encoding: "utf8",
  }).split("\n");
} catch (err) {
  console.error(
    `Cannot read git tags (${err.message.split("\n")[0]}); refusing to publish ${tag}.`,
  );
  process.exit(1);
}

if (!tags.includes(tag)) {
  console.error(
    `Refusing to publish ${tag}: HEAD is not that tag.\n` +
      `Publish from the tag, not from a branch: git checkout ${tag}`,
  );
  process.exit(1);
}
