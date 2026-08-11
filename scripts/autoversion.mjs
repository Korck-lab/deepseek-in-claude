// Auto-version hook (post-commit): reads the commit message from
// COMMIT_EDITMSG — the only moment the *new* message is readable (pre-commit
// runs before the message exists on git >= 2.4x, and index edits made in
// prepare-commit-msg never land in the commit). Bumps the VERSION file, stages
// it; .githooks/post-commit then amends so the bump lands IN the commit.
// Exit 0 = no bump, 1 = bumped (post-commit amends).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const versionFile = `${root}/VERSION`;

const msgPath = execFileSync("git", ["rev-parse", "--git-path", "COMMIT_EDITMSG"], {
  encoding: "utf8",
}).trim();
if (!existsSync(msgPath)) process.exit(0); // standalone run, nothing pending

const msg = readFileSync(msgPath, "utf8");
const subject = msg.split("\n")[0] || "";
if (/^Merge\b/i.test(subject)) process.exit(0);

if (/BREAKING CHANGE/i.test(msg) || /^[a-z]+(\(.+\))?!:/.test(subject)) {
  bump("major");
} else if (/^feat(\(.+\))?:/.test(subject)) {
  bump("minor");
} else if (/^(fix|perf)(\(.+\))?:/.test(subject)) {
  bump("patch");
} else {
  console.log(`autoversion: no bump (${subject})`);
  process.exit(0);
}

function bump(type) {
  const [major, minor, patch] = readFileSync(versionFile, "utf8").trim().split(".").map(Number);
  const next =
    type === "major" ? `${major + 1}.0.0`
    : type === "minor" ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
  writeFileSync(versionFile, `${next}\n`);
  execFileSync("git", ["add", "VERSION"]);
  console.log(`autoversion: bumped to ${next}`);
  process.exit(1);
}
