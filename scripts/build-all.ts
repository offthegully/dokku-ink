// Builds every release binary into ./build. Used locally (`bun run
// build:binaries`) and by the GitHub release workflow. Asset names match what
// install.sh expects: dokku-ink-<os>-<arch>.
const TARGETS: Array<{ target: string; asset: string }> = [
  { target: "bun-linux-x64", asset: "dokku-ink-linux-x64" },
  { target: "bun-linux-arm64", asset: "dokku-ink-linux-arm64" },
  { target: "bun-darwin-x64", asset: "dokku-ink-darwin-x64" },
  { target: "bun-darwin-arm64", asset: "dokku-ink-darwin-arm64" },
];

for (const { target, asset } of TARGETS) {
  const proc = Bun.spawn(
    ["bun", "scripts/build.ts", target, `build/${asset}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\nbuild failed for ${target}`);
    process.exit(code);
  }
}
console.log("\nall binaries built into ./build");
