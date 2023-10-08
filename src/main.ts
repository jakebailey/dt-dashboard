import { Cli } from "clipanion";

import { CheckCommand } from "./check.js";
import { GenerateCommand } from "./generate.js";

const cli = new Cli({
    binaryLabel: `dt-dashboard`,
    binaryName: `dt-dashboard`,
    enableCapture: true,
});

cli.register(CheckCommand);
cli.register(GenerateCommand);

void cli.runExit(process.argv.slice(2));
