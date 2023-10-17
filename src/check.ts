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
import pacote from "pacote";
import { SemVer } from "semver";

import { CachedInfo, CachedStatus, FatalError, findInMetadata, Metadata, PackageJSON } from "./common.js";

const dtsRegExp = /\.d\.[cm]?ts$/;

export class CheckCommand extends Command {
    static override paths = [[`check`]];

    definitelyTypedPath = Option.String(`--dt`, { required: true });
    input = Option.String(`--input`, { required: true });
    output = Option.String(`--output`, { required: true });
    verbose = Option.Boolean(`--verbose`, false);

    spinner!: ReturnType<typeof ora>;
    count!: number;
    total!: number;

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

    #updateSpinner(name: string, kind: string) {
        this.count++;
        const message = `${this.count}/${this.total} ${name} ${kind}`;
        if (this.verbose) {
            console.log(message);
        } else {
            this.spinner.text = message;
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
            dashboardVersion: 6,
            fullNpmName: data.fullNpmName,
            subDirectoryPath: data.subDirectoryPath,
            typesVersion,
            unescapedName: data.unescapedName,
            status,
        };

        const outputPath = path.join(outputDir, filename);
        await fs.promises.writeFile(outputPath, JSON.stringify(cached, undefined, 4));
        this.#updateSpinner(data.unescapedName, cached.status.kind);
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

        const specifier = data.isLatest ? `latest`
            : data.major === 0 ? `${data.major}.${data.minor}`
            : `${data.major}`;

        let fullManifest;
        try {
            fullManifest = await this.#getManifest(data.unescapedName, specifier, true);
        } catch (_e) {
            const e = _e as { code?: string; versions?: string[]; };

            if (e.code === `E404`) {
                this.#log(`${data.unescapedName} not found on npm`);
                return { kind: `not-in-registry` };
            }

            if (e.code === `ETARGET`) {
                if (!e.versions || e.versions.length === 0) {
                    this.#log(`${data.unescapedName} has no versions`);
                    return { kind: `unpublished` };
                }
                this.#log(`${data.unescapedName} did not match ${specifier} but package does exist on npm`);
                return { kind: `missing-version` };
            }

            const message = `${data.unescapedName} failed to resolve manifest: ${e.code}`;
            this.#log(`${data.unescapedName} ${message}`);
            return { kind: `error`, message };
        }

        const packageJSON = fullManifest;

        if (cached?.kind === `found` && packageJSON.version === cached.current) {
            return cached;
        }

        // TODO: some packages publish with the version string entirely wrong within package.json,
        // so we can't use this method to resolve versions all of the time.
        // Again, need to use the registry instead.
        const currentVersion = new SemVer(packageJSON.version, { loose: true });
        const currentVersionString = currentVersion.format();

        let outOfDate: `major` | `minor` | undefined;
        let hasTypes: "package.json" | "file" | undefined;

        if (data.isLatest) {
            if (currentVersion.major > data.major) {
                this.#log(`${data.unescapedName} is out of date`);
                outOfDate = `major`;
            } else if (currentVersion.minor > data.minor) {
                if (data.major === 0) {
                    this.#log(`${data.unescapedName} is out of date`);
                    outOfDate = `major`;
                } else {
                    this.#log(`${data.unescapedName} is out of date minorly`);
                    outOfDate = `minor`;
                }
            }
        }

        if (packageJSONIsTyped(packageJSON)) {
            this.#log(`${data.unescapedName} has types (package.json)`);
            hasTypes = `package.json`;
        } else {
            const { response, metadata } = await this.#tryGetPackageMetadata(data.unescapedName, currentVersionString);
            if (response) {
                const message =
                    `${data.unescapedName} failed to fetch jsdelivr metadata: ${response.status} ${response.statusText}`;
                this.#log(`${data.unescapedName} ${message}`);
                return { kind: `error`, message };
            }

            if (
                findInMetadata(metadata, (filename) => {
                    if (filename.includes(`/node_modules/`)) {
                        // I can't believe you've done this.
                        return false;
                    }
                    if (dtsRegExp.test(filename)) {
                        this.#log(`${data.unescapedName} has types (found ${filename}))`);
                        return true;
                    }

                    return false;
                })
            ) {
                hasTypes = `file`;
            }
        }

        return {
            kind: `found`,
            current: currentVersionString,
            outOfDate,
            hasTypes,
        };
    }

    #pacoteQueue = new PQueue({ concurrency: 20 });
    async #getManifest(name: string, specifier: string, fullMetadata: boolean) {
        const result = await this.#pacoteQueue.add(
            () => pacote.manifest(`${name}@${specifier}`, { fullMetadata }),
            { throwOnTimeout: true },
        );
        return PackageJSON.parse(result, { mode: `passthrough` });
    }

    async #tryGetPackageMetadata(name: string, specifier: string) {
        const url = `https://data.jsdelivr.com/v1/packages/npm/${name}@${specifier}?structure=tree`;
        let response = await this.#fetch(url);
        let metadata;

        if (response.ok) {
            try {
                metadata = Metadata.parse(await response.json(), { mode: `passthrough` });
            } catch {
                // ignore
            }
        }
        if (!response.ok || !metadata) {
            // Sometimes the info is too big for jsdelivr to handle, so we try unpkg instead.
            // Their APIs return similar enough results to be compatible.
            const url = `https://unpkg.com/${name}@${specifier}/?meta`;
            response = await this.#fetch(url);
            if (!response.ok) {
                return { response };
            }
            metadata = Metadata.parse(await response.json(), { mode: `passthrough` });
        }

        return { metadata };
    }

    #fetchQueues = new Map<string, PQueue>();
    #fetch(url: string) {
        const parsed = new URL(url);

        let queue = this.#fetchQueues.get(parsed.hostname);
        if (!queue) {
            queue = new PQueue({ concurrency: 10 });
            this.#fetchQueues.set(parsed.hostname, queue);
        }

        return queue.add(
            async () => {
                // const before = Date.now();
                const response = await fetch(url, {
                    headers: { "User-Agent": `github.com/jakebailey/dt-dashboard` },
                    retry: { retries: 5, randomize: true },
                    timeout: 60_000,
                });
                // const after = Date.now();
                // this.#log(`${url} ${response.status} ${response.statusText} ${after - before}ms`);
                return response;
            },
            { throwOnTimeout: true },
        );
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
