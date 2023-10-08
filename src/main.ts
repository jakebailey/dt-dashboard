import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as v from "@badrap/valita";
import {
    getLocallyInstalledDefinitelyTyped,
    parseDefinitions,
    TypingsData,
    TypingsVersions,
} from "@definitelytyped/definitions-parser";
import { parseHeaderOrFail } from "@definitelytyped/header-parser";
import { Command, Option, runExit } from "clipanion";
import fetch from "node-fetch";
import * as semver from "semver";

void runExit(
    { enableCapture: true },
    class MainCommand extends Command {
        definitelyTypedPath = Option.String({ required: true });
        cachePath = Option.String({ required: true });

        async execute() {
            const definitelyTypedPath = path.resolve(this.definitelyTypedPath);
            const defs = await getAllDefinitions(definitelyTypedPath);
            const data: ReadonlyMap<string, TypingsVersions> = (defs as any).data;

            const allTypingsData = [];

            for (const v of data.values()) {
                for (const typingsData of v.getAll()) {
                    allTypingsData.push(typingsData);
                }
            }

            allTypingsData.sort((a, b) => compareComparableValues(a.subDirectoryPath, b.subDirectoryPath));

            for (const pkg of allTypingsData) {
                await checkPackage(definitelyTypedPath, pkg);
            }
        }
    },
);

function compareComparableValues(a: string | undefined, b: string | undefined) {
    // eslint-disable-next-line unicorn/no-nested-ternary
    return a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
}

function getAllDefinitions(definitelyTypedPath: string) {
    return parseDefinitions(
        getLocallyInstalledDefinitelyTyped(definitelyTypedPath),
        { definitelyTypedPath, nProcesses: os.availableParallelism() },
        console,
    );
}

const PackageJSON = v.object({
    version: v.string(),
    types: v.string().optional(),
    typings: v.string().optional(),
    exports: v.record(v.union(v.string(), v.object({ types: v.string().optional() }))).optional(),
});
type PackageJSON = v.Infer<typeof PackageJSON>;

function packageJSONIsTyped(p: PackageJSON): boolean {
    return !!p.types
        || !!p.typings
        || (!!p.exports && Object.values(p.exports).some((value) => typeof value !== `string` && value.types));
}

async function checkPackage(definitelyTypedPath: string, data: TypingsData) {
    // console.log(`${data.fullNpmName} ${data.unescapedName} ${data.major}.${data.minor}`);

    const packageRoot = path.join(definitelyTypedPath, `types`, data.subDirectoryPath);
    const indexDtsPath = path.join(packageRoot, `index.d.ts`);
    const indexDts = await fs.promises.readFile(indexDtsPath, { encoding: `utf8` });
    const header = parseHeaderOrFail(indexDtsPath, indexDts);
    if (header.nonNpm) {
        return;
    }

    const url = `https://unpkg.com/${data.unescapedName}@${data.isLatest ? `latest` : data.major}/package.json`;
    const result = await fetch(url);
    if (!result.ok) {
        if (result.status === 404) {
            console.log(`${data.unescapedName} not found on npm`);
        } else {
            console.log(`${data.unescapedName} failed to fetch ${result.status} ${result.statusText}`);
        }
        return;
    }

    const contents = await result.json();
    const parsed = PackageJSON.parse(contents, { mode: `strip` });

    if (data.isLatest) {
        const version = new semver.SemVer(parsed.version);
        if (data.major === 0) {
            if (version.minor > data.minor) {
                console.log(`${data.unescapedName} is out of date`);
            }
        } else {
            if (version.major > data.major) {
                console.log(`${data.unescapedName} is out of date`);
            }
        }
    }

    if (packageJSONIsTyped(parsed)) {
        console.log(`${data.unescapedName} has types`);
    }
}
