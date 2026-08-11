// Tag hook (post-commit): creates an annotated v<version> tag after each commit
// whose version was just bumped. Skips if the tag already exists.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const version = readFileSync(`${root}/VERSION`, "utf8").trim();
const tag = `v${version}`;
try {
  const existing = execFileSync("git", ["tag", "-l", tag], { encoding: "utf8" }).trim();
  if (existing) {
    console.log(`autoversion: tag ${tag} already exists, skipping`);
    process.exit(0);
  }
  execFileSync("git", ["tag", "-a", tag, "-m", tag], { stdio: "inherit" });
  console.log(`autoversion: tagged ${tag}`);
} catch {
  // not a git repo or tag conflict — not fatal for commits
  console.log(`autoversion: tag ${tag} failed, skipping`);
}
