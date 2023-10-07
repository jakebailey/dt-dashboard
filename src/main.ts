import os from "node:os";
import path from "node:path";

import {
    getLocallyInstalledDefinitelyTyped,
    parseDefinitions,
    TypingsVersions,
} from "@definitelytyped/definitions-parser";
import { Command, Option, runExit } from "clipanion";

void runExit(
    { enableCapture: true },
    class MainCommand extends Command {
        dtRoot = Option.String({ required: true });

        async execute() {
            const dtRoot = path.resolve(this.dtRoot);
            const defs = await getAllDefinitions(dtRoot);
            const data: ReadonlyMap<string, TypingsVersions> = (defs as any).data;

            for (const pkg of data.values()) {
                for (const version of pkg.getAll()) {
                    const { fullNpmName: typesName, unescapedName, major, minor } = version;
                    console.log(`${typesName} ${unescapedName} ${major}.${minor}`);
                }
            }
        }
    },
);

function getAllDefinitions(dtRoot: string) {
    return parseDefinitions(
        getLocallyInstalledDefinitelyTyped(dtRoot),
        { definitelyTypedPath: dtRoot, nProcesses: os.availableParallelism() },
        console,
    );
}
