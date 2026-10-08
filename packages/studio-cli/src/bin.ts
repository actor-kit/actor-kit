#!/usr/bin/env node
import { runCli } from "./cli";

const code = await runCli(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
