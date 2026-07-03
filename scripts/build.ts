// Compiles a self-contained `dokku-ink` binary with `bun build --compile`.
//
// Two Ink-specific quirks are handled here:
//   1. `react-devtools-core` is a DEV-only optional dep that Ink imports behind
//      a `DEV=true` guard. `--compile` still tries to resolve it at startup, so
//      we alias it to an empty stub (it never runs in production).
//   2. The entry point normally reads its version from package.json at runtime,
//      which doesn't exist inside a compiled binary. We inject it via --define.
//
// Usage: bun scripts/build.ts [bun-target] [outfile]
//   bun scripts/build.ts                       -> build/dokku-ink   (host)
//   bun scripts/build.ts bun-linux-x64 out/foo -> cross-compiled binary
import pkg from "../package.json" with { type: "json" };

const target = process.argv[2] || undefined; // e.g. bun-linux-x64; omit for host
const outfile = process.argv[3] ?? "build/dokku-ink";

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  target: "bun",
  compile: target ? { target, outfile } : { outfile },
  define: {
    __DOKKU_INK_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    {
      name: "stub-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: new URL("./stub-devtools.ts", import.meta.url).pathname,
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
console.log(`built ${outfile}${target ? ` (${target})` : ""}`);
