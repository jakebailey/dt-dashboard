/* eslint-disable unicorn/no-null */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    getLocallyInstalledDefinitelyTyped,
    parseDefinitions,
    TypingsData,
    TypingsVersions,
} from "@definitelytyped/definitions-parser";
import { parseHeaderOrFail } from "@definitelytyped/header-parser";
import { Command, Option } from "clipanion";
import fetch from "node-fetch";
import ora from "ora";
import PQueue from "p-queue";
import { SemVer } from "semver";

import { CachedInfo, PackageJSON } from "./common.js";

export class CheckCommand extends Command {
    static override paths = [[`check`]];

    definitelyTypedPath = Option.String({ required: true });
    cachePath = Option.String({ required: true });
    verbose = Option.Boolean(`--verbose`, false);

    spinner!: ReturnType<typeof ora>;
    count!: number;
    total!: number;

    #fetchQueue = new PQueue({ concurrency: 8 });

    async execute() {
        const defs = await this.#getAllDefinitions();
        const data: ReadonlyMap<string, TypingsVersions> = (defs as any).data;

        const allTypingsData = [];

        for (const v of data.values()) {
            for (const typingsData of v.getAll()) {
                allTypingsData.push(typingsData);
            }
        }

        allTypingsData.sort((a, b) => compareComparableValues(a.subDirectoryPath, b.subDirectoryPath));

        this.count = 0;
        this.total = allTypingsData.length;

        if (!this.verbose) {
            this.spinner = ora(`0/${this.total}`).start();
        }
        await Promise.all(allTypingsData.map((pkg) => this.#checkPackageCached(pkg)));

        if (!this.verbose) {
            this.spinner.stop();
        }
    }

    #updateSpinner(name: string) {
        if (!this.verbose) {
            this.count++;
            this.spinner.text = `${this.count}/${this.total} ${name}`;
        }
    }

    #log(message?: any, ...optionalParams: any[]) {
        if (this.verbose) {
            console.log(message, ...optionalParams);
        }
    }

    async #getAllDefinitions() {
        return parseDefinitions(
            getLocallyInstalledDefinitelyTyped(this.definitelyTypedPath),
            { definitelyTypedPath: this.definitelyTypedPath, nProcesses: os.availableParallelism() },
            console,
        );
    }

    async #checkPackageCached(data: TypingsData) {
        const dir = path.join(this.cachePath, data.subDirectoryPath[0]);
        await fs.promises.mkdir(dir, { recursive: true });
        const cachedPath = path.join(dir, `${data.subDirectoryPath.replace(/[/\\]/g, `@`)}.json`);
        let cached: CachedInfo | undefined;
        try {
            const contents = await fs.promises.readFile(cachedPath, { encoding: `utf8` });
            cached = CachedInfo.parse(JSON.parse(contents));
        } catch {
            // ignore
        }

        let result: CachedInfo | undefined;
        try {
            result = await this.#checkPackage(data, cached);
        } catch (e) {
            this.#log(`${data.unescapedName} ${e}`);
            result = { kind: `error`, message: `${(e as any).message || e}` };
        }

        await fs.promises.writeFile(cachedPath, JSON.stringify(result, undefined, 4));
        this.#updateSpinner(data.unescapedName);
    }

    async #checkPackage(data: TypingsData, cached: CachedInfo | undefined): Promise<CachedInfo> {
        // this.#log(`${data.fullNpmName} ${data.unescapedName} ${data.major}.${data.minor}`);

        const packageRoot = path.join(this.definitelyTypedPath, `types`, data.subDirectoryPath);
        const indexDtsPath = path.join(packageRoot, `index.d.ts`);
        const indexDts = await fs.promises.readFile(indexDtsPath, { encoding: `utf8` });
        const header = parseHeaderOrFail(indexDtsPath, indexDts);
        if (header.nonNpm) {
            return { kind: `non-npm` };
        }

        const versionQuery = data.isLatest ? `latest`
            : data.major === 0 ? `${data.major}.${data.minor}`
            : `${data.major}`;

        const url = `https://unpkg.com/${data.unescapedName}@${versionQuery}/package.json`;
        const result = await this.#fetchQueue.add(() => fetch(url), { throwOnTimeout: true });
        if (!result.ok) {
            if (result.status === 404) {
                this.#log(`${data.unescapedName} not found on npm`);
                return { kind: `not-in-registry` };
            }
            const message = `${data.unescapedName} failed to fetch package.json: ${result.status} ${result.statusText}`;
            this.#log(`${data.unescapedName} ${message}`);
            return { kind: `error`, message };
        }

        const contents = await result.json();
        let packageJSON: PackageJSON;
        try {
            packageJSON = PackageJSON.parse(contents, { mode: `passthrough` });
        } catch {
            const message = `failed to parse package.json`;
            this.#log(`${data.unescapedName} ${message}`);
            return { kind: `error`, message };
        }

        if (cached?.kind === `found` && packageJSON.version === cached.latest) {
            return cached;
        }

        let outOfDate = false;
        let hasTypes = false;

        if (data.isLatest) {
            const version = new SemVer(packageJSON.version, { loose: true });
            if (data.major === 0) {
                if (version.minor > data.minor) {
                    this.#log(`${data.unescapedName} is out of date`);
                    outOfDate = true;
                }
            } else {
                if (version.major > data.major) {
                    this.#log(`${data.unescapedName} is out of date`);
                    outOfDate = true;
                }
            }
        }

        if (packageJSONIsTyped(packageJSON)) {
            this.#log(`${data.unescapedName} has types`);
            hasTypes = true;
        } else {
            // TODO: stream the tarball to look for d.ts files.
        }

        return {
            kind: `found`,
            typesName: data.subDirectoryPath,
            typesVersion: `${data.major}.${data.minor}`,
            realName: data.unescapedName,
            latest: packageJSON.version,
            outOfDate,
            hasTypes,
        };
    }
}

function compareComparableValues(a: string | undefined, b: string | undefined) {
    // eslint-disable-next-line unicorn/no-nested-ternary
    return a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
}

function packageJSONIsTyped(p: PackageJSON): boolean {
    return !!p.types
        || !!p.typings
        || (!!p.exports && typeof p.exports === `object`
            && Object.values(p.exports).some((value) => typeof value !== `string` && value.types));
}
