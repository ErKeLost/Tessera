await Bun.spawn(["bun", "run", "dev:vite"], {
  cwd: import.meta.dir + "/..",
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).exited;
