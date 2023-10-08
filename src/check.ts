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
import fetch from "make-fetch-happen";
import ora from "ora";
import PQueue from "p-queue";
import { SemVer } from "semver";

import { CachedInfo, CachedStatus, FatalError, PackageJSON } from "./common.js";

export class CheckCommand extends Command {
    static override paths = [[`check`]];

    definitelyTypedPath = Option.String(`--dt`, { required: true });
    input = Option.String(`--input`, { required: true });
    output = Option.String(`--output`, { required: true });
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
        const inputDir = path.join(this.input, data.subDirectoryPath[0]);
        const outputDir = path.join(this.output, data.subDirectoryPath[0]);
        const filename = `${data.subDirectoryPath.replace(/[/\\]/g, `@`)}.json`;

        await fs.promises.mkdir(outputDir, { recursive: true });
        let cached: CachedInfo | undefined;
        try {
            const inputPath = path.join(inputDir, filename);
            const contents = await fs.promises.readFile(inputPath, { encoding: `utf8` });
            cached = CachedInfo.parse(JSON.parse(contents));
        } catch {
            // ignore
        }

        const typesVersion = `${data.major}.${data.minor}`;

        if (cached?.typesVersion !== typesVersion) {
            cached = undefined;
        }

        let status: CachedStatus | undefined;
        try {
            status = await this.#checkPackage(data, cached?.status);
        } catch (e) {
            this.#log(`${data.unescapedName} ${e}`);
            if (e instanceof FatalError) {
                throw e;
            }
            status = { kind: `error`, message: `${(e as any).message || e}` };
        }

        cached = {
            dashboardVersion: 1,
            fullNpmName: data.fullNpmName,
            subDirectoryPath: data.subDirectoryPath,
            typesVersion,
            unescapedName: data.unescapedName,
            status,
        };

        const outputPath = path.join(outputDir, filename);
        await fs.promises.writeFile(outputPath, JSON.stringify(cached, undefined, 4));
        this.#updateSpinner(data.unescapedName);
    }

    async #checkPackage(data: TypingsData, cached: CachedStatus | undefined): Promise<CachedStatus> {
        // this.#log(`checking ${data.fullNpmName} ${data.unescapedName} ${data.major}.${data.minor}`);

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
        const result = await this.#fetchQueue.add(
            () => fetch(url, { retry: { retries: 5, randomize: true } }),
            { throwOnTimeout: true },
        );
        if (!result.ok) {
            if (result.status === 404) {
                this.#log(`${data.unescapedName} not found on npm`);
                return { kind: `not-in-registry` };
            }
            if (result.status === 524) {
                throw new FatalError(`timeout fetching ${url}`);
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

        if (cached?.kind === `found` && packageJSON.version === cached.current) {
            return cached;
        }

        let outOfDate = false;
        let minorOutOfDate = false;
        let hasTypes = false;

        if (data.isLatest) {
            const version = new SemVer(packageJSON.version, { loose: true });
            if (version.major > data.major) {
                this.#log(`${data.unescapedName} is out of date`);
                outOfDate = true;
            } else if (version.minor > data.minor) {
                if (data.major === 0) {
                    this.#log(`${data.unescapedName} is out of date`);
                    outOfDate = true;
                } else {
                    this.#log(`${data.unescapedName} is out of date minorly`);
                    minorOutOfDate = true;
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
            current: packageJSON.version,
            outOfDate,
            minorOutOfDate,
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
