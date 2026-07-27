#!/usr/bin/env bun
import { createCLI } from "@bunli/core";
// Imported rather than discovered, so the CLI works from any directory.
import config from "../bunli.config.ts";
import { setup, start, status, stop, sync } from "./commands.ts";

const { name, version, description } = config;
const cli = await createCLI({ name, version, description });

for (const command of [setup, start, stop, status, sync]) cli.command(command);

await cli.run();
