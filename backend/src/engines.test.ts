import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Regression tests for issue #341: keep the stated Node.js floor in package.json,
// .nvmrc, .npmrc, docs, CI, and Dockerfiles aligned with the Node 22.6+ features
// used by the workspace test scripts (--experimental-strip-types and node --test globs).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(raw: string): Semver {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  assert.ok(match, `Unable to parse version: ${raw}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? "0"),
    patch: Number(match[3] ?? "0"),
  };
}

function parseMinEngine(range: string): Semver {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  assert.ok(match, `Expected engines.node to be a >=X.Y range, got: ${range}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? "0"),
    patch: Number(match[3] ?? "0"),
  };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfiesMin(version: string, minRange: string): boolean {
  return compareSemver(parseVersion(version), parseMinEngine(minRange)) >= 0;
}

function readRepoFile(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "target",
  ".pgdata",
  ".smoke-pgdata",
  ".artifacts",
]);

const IGNORED_FILES = new Set([
  "pnpm-lock.yaml",
  "Cargo.lock",
  "backend/src/engines.test.ts",
]);

function collectRepoFiles(dir: string, relPrefix = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
    if (relPath.startsWith("backend/src/chain/generated/")) continue;
    if (IGNORED_FILES.has(relPath)) continue;
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      results.push(...collectRepoFiles(fullPath, relPath));
    } else if (st.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

test("version floor comparison handles Node 20, 22.5, 22.6, 22.14, and 24+", () => {
  assert.equal(satisfiesMin("20.19.0", ">=22.6"), false);
  assert.equal(satisfiesMin("22.5.1", ">=22.6"), false);
  assert.equal(satisfiesMin("22.6.0", ">=22.6"), true);
  assert.equal(satisfiesMin("22.14.0", ">=22.6"), true);
  assert.equal(satisfiesMin("24.0.0", ">=22.6"), true);
});

test("root package.json engines.node requires at least Node 22.6", () => {
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    engines?: { node?: string };
  };
  const nodeRange = pkg.engines?.node;
  assert.ok(typeof nodeRange === "string", "root package.json must define engines.node");
  const min = parseMinEngine(nodeRange);
  assert.ok(
    compareSemver(min, { major: 22, minor: 6, patch: 0 }) >= 0,
    `engines.node (${nodeRange}) must be >=22.6 because frontend tests require --experimental-strip-types`,
  );
  assert.equal(nodeRange, ">=22.6");
  assert.ok(
    satisfiesMin(process.versions.node, nodeRange),
    `current Node ${process.versions.node} must satisfy engines.node (${nodeRange})`,
  );
});

test("no workspace package.json declares a lower Node engine floor", () => {
  const workspacePackages = [
    "backend/package.json",
    "frontend/package.json",
    "reexecutor-agent/package.json",
    "db/package.json",
  ];
  for (const relPath of workspacePackages) {
    const pkg = JSON.parse(readRepoFile(relPath)) as {
      engines?: { node?: string };
    };
    if (pkg.engines?.node !== undefined) {
      const min = parseMinEngine(pkg.engines.node);
      assert.ok(
        compareSemver(min, { major: 22, minor: 6, patch: 0 }) >= 0,
        `${relPath} declares engines.node=${pkg.engines.node}, below >=22.6`,
      );
    }
  }
});

test(".nvmrc pins Node 22 and .npmrc enforces engine-strict=true", () => {
  const nvmrc = readRepoFile(".nvmrc").trim();
  assert.equal(nvmrc, "22");

  const npmrcLines = readRepoFile(".npmrc")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(
    npmrcLines.includes("engine-strict=true"),
    ".npmrc must contain engine-strict=true so pnpm rejects unsupported Node versions",
  );
});

test("README.md and CONTRIBUTING.md state the same Node minimum as package.json", () => {
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    engines?: { node?: string };
  };
  const floor = (pkg.engines?.node ?? "").replace(/^>=\s*/, "");
  assert.ok(floor.length > 0);

  const readme = readRepoFile("README.md");
  assert.match(
    readme,
    new RegExp(`Requirements:.*Node\\s+${floor.replace(".", "\\.")}\\+`),
    `README.md Requirements line must state Node ${floor}+`,
  );

  const contributing = readRepoFile("CONTRIBUTING.md");
  assert.match(
    contributing,
    new RegExp(`\\|\\s*Node\\.js\\s*\\|\\s*${floor.replace(".", "\\.")}\\+`),
    `CONTRIBUTING.md Prerequisites table must state ${floor}+ for Node.js`,
  );
});

test("CI workflow and Dockerfiles use Node 22+", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");
  const nodeVersionMatches = [...ci.matchAll(/node-version:\s*['"]?(\d+(?:\.\d+)*)['"]?/g)];
  assert.ok(nodeVersionMatches.length >= 2, "expected node-version entries in ci.yml");
  for (const match of nodeVersionMatches) {
    const version = parseVersion(match[1]);
    assert.ok(
      version.major >= 22,
      `ci.yml node-version ${match[1]} must be >= 22`,
    );
  }

  const dockerfiles = [
    "backend/Dockerfile",
    "frontend/Dockerfile",
    "reexecutor-agent/Dockerfile",
  ];
  for (const dockerfile of dockerfiles) {
    const content = readRepoFile(dockerfile);
    const fromMatches = [...content.matchAll(/^FROM\s+node:(\d+(?:\.\d+)*)/gm)];
    assert.ok(fromMatches.length >= 1, `${dockerfile} should have a FROM node: base image`);
    for (const match of fromMatches) {
      const version = parseVersion(match[1]);
      assert.ok(
        version.major >= 22,
        `${dockerfile} uses node:${match[1]}, must be >= 22`,
      );
    }
  }
});

test("repository has no stale Node 20 version floors", () => {
  const stalePatterns: Array<{ name: string; re: RegExp }> = [
    { name: "Node 20 mention", re: /\bnode(?:\.js)?\s+v?20(?:\.\d+)*\+?/i },
    { name: "Markdown table Node.js 20", re: /\|\s*Node\.js\s*\|\s*20\b/i },
    { name: "Docker node:20", re: /\bnode:20\b/i },
    { name: "CI node-version: 20", re: /\bnode-version:\s*['"]?20\b/i },
    { name: "package.json engines node 20", re: /"node"\s*:\s*"[^"]*\b20\b[^"]*"/ },
  ];

  const hits: string[] = [];
  for (const relPath of collectRepoFiles(REPO_ROOT)) {
    const ext = path.extname(relPath).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".ico", ".wasm", ".pdf", ".woff", ".woff2"].includes(ext)) {
      continue;
    }
    const content = readRepoFile(relPath);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { name, re } of stalePatterns) {
        if (re.test(lines[i])) {
          hits.push(`${relPath}:${i + 1} (${name}): ${lines[i].trim()}`);
        }
      }
    }
  }

  assert.deepEqual(hits, [], `Found stale Node 20 references:\n${hits.join("\n")}`);
});
