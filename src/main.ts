import { Cli } from "clipanion";

import { CheckCommand } from "./check.js";
import { GenerateSiteCommand } from "./site.js";

const cli = new Cli({
    binaryLabel: `dt-dashboard`,
    binaryName: `dt-dashboard`,
    enableCapture: true,
});

cli.register(CheckCommand);
cli.register(GenerateSiteCommand);

void cli.runExit(process.argv.slice(2));
