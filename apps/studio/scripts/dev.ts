// The Agent's answer contract is compiled from the OpenUI library, so it has to
// be regenerated before the dev server serves a session. Same order as the
// official shadcn-chat example: generate, then serve.
const generate = Bun.spawn(["bun", "run", "generate:openui-prompt"], {
  cwd: import.meta.dir + "/..",
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await generate.exited) !== 0) {
  throw new Error("Generating the OpenUI answer contract failed.");
}

await Bun.spawn(["bun", "run", "dev:vite"], {
  cwd: import.meta.dir + "/..",
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).exited;
