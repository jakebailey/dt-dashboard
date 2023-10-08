import { Cli } from "clipanion";

import { CheckCommand } from "./check.js";

const cli = new Cli({
    binaryLabel: `dt-dashboard`,
    binaryName: `dt-dashboard`,
    enableCapture: true,
});

cli.register(CheckCommand);

void cli.runExit(process.argv.slice(2));
