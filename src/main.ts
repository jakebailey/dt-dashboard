/* eslint-disable unicorn/no-nested-ternary */
/* eslint-disable unicorn/no-null */
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
import { SemVer } from "semver";

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
                await withCache(this.cachePath, pkg, (cached) => checkPackage(definitelyTypedPath, cached, pkg));
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

const CachedInfo = v.object({
    latest: v.string(),
    outOfDate: v.boolean(),
    hasTypes: v.boolean(),
}).nullable();
type CachedInfo = v.Infer<typeof CachedInfo>;

async function withCache(
    cachePath: string,
    data: TypingsData,
    fn: (cached: CachedInfo | undefined) => Promise<CachedInfo | undefined>,
) {
    const dir = path.join(cachePath, data.subDirectoryPath[0]);
    await fs.promises.mkdir(dir, { recursive: true });
    const cachedPath = path.join(dir, `${data.subDirectoryPath.replace(/[/\\]/g, `@`)}.json`);
    let cached: CachedInfo | undefined;
    try {
        const contents = await fs.promises.readFile(cachedPath, { encoding: `utf8` });
        cached = CachedInfo.parse(JSON.parse(contents));
    } catch {
        // ignore
    }

    const result = await fn(cached);
    if (result !== undefined) {
        await fs.promises.writeFile(cachedPath, JSON.stringify(result, undefined, 4));
    }
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

async function checkPackage(
    definitelyTypedPath: string,
    cached: CachedInfo | undefined,
    data: TypingsData,
): Promise<CachedInfo | undefined> {
    // console.log(`${data.fullNpmName} ${data.unescapedName} ${data.major}.${data.minor}`);

    const packageRoot = path.join(definitelyTypedPath, `types`, data.subDirectoryPath);
    const indexDtsPath = path.join(packageRoot, `index.d.ts`);
    const indexDts = await fs.promises.readFile(indexDtsPath, { encoding: `utf8` });
    const header = parseHeaderOrFail(indexDtsPath, indexDts);
    if (header.nonNpm) {
        return undefined;
    }

    const versionQuery = data.isLatest ? `latest`
        : data.major === 0 ? `${data.major}.${data.minor}`
        : `${data.major}`;

    const url = `https://unpkg.com/${data.unescapedName}@${versionQuery}/package.json`;
    const result = await fetch(url);
    if (!result.ok) {
        if (result.status === 404) {
            console.log(`${data.unescapedName} not found on npm`);
            return null;
        }
        throw new Error(`${data.unescapedName} failed to fetch ${result.status} ${result.statusText}`);
    }

    const contents = await result.json();
    const packageJSON = PackageJSON.parse(contents, { mode: `strip` });

    if (packageJSON.version === cached?.latest) {
        return cached;
    }

    let outOfDate = false;
    let hasTypes = false;

    if (data.isLatest) {
        const version = new SemVer(packageJSON.version);
        if (data.major === 0) {
            if (version.minor > data.minor) {
                console.log(`${data.unescapedName} is out of date`);
                outOfDate = true;
            }
        } else {
            if (version.major > data.major) {
                console.log(`${data.unescapedName} is out of date`);
                outOfDate = true;
            }
        }
    }

    if (packageJSONIsTyped(packageJSON)) {
        console.log(`${data.unescapedName} has types`);
        hasTypes = true;
    }

    return {
        latest: packageJSON.version,
        outOfDate,
        hasTypes,
    };
}
