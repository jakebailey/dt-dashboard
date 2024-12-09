import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { Command, Option } from "clipanion";
import { glob } from "glob";
import fetch from "make-fetch-happen";
import { Minimatch } from "minimatch";
import ora from "ora";
import PQueue from "p-queue";
import pacote from "pacote";
import prettyMilliseconds from "pretty-ms";
import * as semver from "semver";

import {
    CachedInfo,
    CachedStatus,
    dashboardVersion,
    DTPackageJson,
    FatalError,
    forEachFileInMetadata,
    Metadata,
    NpmManifest,
} from "./common.js";

const dtsMatcher = new Minimatch(`**/*.d.{ts,cts,mts,*.ts}`, { optimizationLevel: 2 });

interface TypingsData {
    unescapedName: string;
    fullNpmName: string;
    subDirectoryPath: string;
    major: number;
    minor: number;
    nonNpm: boolean | `conflict` | undefined;
    isLatest: boolean;
    packageJsonType: string | undefined;
    exports: unknown;
}

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
        let start = Date.now();

        this.definitelyTypedPath = path.resolve(this.definitelyTypedPath);

        console.log(`loading DT`);
        const allPackageJsons = await glob(`types/**/package.json`, {
            cwd: this.definitelyTypedPath,
            ignore: `**/node_modules/**`,
            follow: false,
        });

        const allTypingsData: TypingsData[] = [];
        await Promise.all(allPackageJsons.map(async (packageJsonPath) => {
            const typingsData = await this.#getTypingsData(packageJsonPath);
            if (typingsData) {
                allTypingsData.push(typingsData);
            }
        }));

        allTypingsData.sort((a, b) => compareComparableValues(a.subDirectoryPath, b.subDirectoryPath));

        console.log(`done loading DT (${prettyMilliseconds(Date.now() - start)})`);
        start = Date.now();

        this.count = 0;
        this.total = allTypingsData.length;

        if (!this.verbose) {
            this.spinner = ora(`0/${this.total}`).start();
        }
        await Promise.all(allTypingsData.map((pkg) => this.#checkPackageCached(pkg)));

        if (!this.verbose) {
            this.spinner.stop();
        }

        console.log(`done in ${prettyMilliseconds(Date.now() - start)}`);
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

    async #getTypingsData(packageJsonPath: string): Promise<TypingsData | undefined> {
        packageJsonPath = path.resolve(this.definitelyTypedPath, packageJsonPath);
        const packageJsonContents = await fs.promises.readFile(packageJsonPath, { encoding: `utf8` });
        const packageJson = DTPackageJson.parse(JSON.parse(packageJsonContents), { mode: `passthrough` });

        if (!packageJson.name?.startsWith(typesPrefix)) {
            return undefined;
        }

        const subDirectoryPath = path.relative(
            path.join(this.definitelyTypedPath, `types`),
            path.dirname(packageJsonPath),
        );

        assert(packageJson.version);
        const version = new semver.SemVer(packageJson.version);

        const typesNameWithoutPrefix = removeTypesPrefix(packageJson.name);
        const unescapedName = unmangleScopedPackage(typesNameWithoutPrefix) ?? typesNameWithoutPrefix;

        const isLatest = path.join(subDirectoryPath, `..`) === `.`;

        return {
            unescapedName,
            fullNpmName: packageJson.name,
            subDirectoryPath,
            major: version.major,
            minor: version.minor,
            nonNpm: packageJson.nonNpm,
            isLatest,
            packageJsonType: packageJson.type,
            exports: packageJson.exports,
        };
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
            dashboardVersion,
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

        if (data.nonNpm) {
            return { kind: data.nonNpm === `conflict` ? `conflict` : `non-npm` };
        }

        const specifier = data.major === 0 ? `${data.major}.${data.minor}`
            : `${data.major}`;

        const specifierOrLatest = data.isLatest ? `latest` : specifier;

        let fullManifest: NpmManifest;
        let latestManifest: NpmManifest;
        try {
            fullManifest = await this.#getManifest(data.unescapedName, specifierOrLatest, true);
            latestManifest = specifierOrLatest === `latest` ? fullManifest
                : await this.#getManifest(data.unescapedName, `latest`, true);
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
                this.#log(`${data.unescapedName} did not match ${specifierOrLatest} but package does exist on npm`);
                return { kind: `missing-version` };
            }

            const message = `${data.unescapedName} failed to resolve manifest: ${e.code}`;
            this.#log(`${data.unescapedName} ${message}`);
            return { kind: `error`, message };
        }

        let currentVersion = new semver.SemVer(fullManifest.version, { loose: true });
        let currentVersionString = currentVersion.format();

        if (
            specifierOrLatest === `latest`
            && (currentVersion.major < data.major
                || (currentVersion.major === data.major && currentVersion.minor < data.minor))
        ) {
            // We were looking for the latest, but found something older than the types package.
            // This can mean that the types package really is too new, that the types are for a prerelease
            // version, or that the latest tag doesn't actually point to the newest version.
            // TODO: perhaps we should just always ask for the packument.
            try {
                const packument = await this.#getPackument(data.unescapedName);
                const versions = Object.keys(packument.versions).filter((version) =>
                    semver.satisfies(version, `^${specifier}`, { loose: true, includePrerelease: true })
                );
                versions.sort((a, b) => semver.compare(b, a));
                const latest = versions[0];
                if (latest) {
                    // const old = currentVersionString;
                    fullManifest = await this.#getManifest(data.unescapedName, latest, true);
                    currentVersion = new semver.SemVer(fullManifest.version, { loose: true });
                    currentVersionString = currentVersion.format();
                    // if (currentVersionString !== old) {
                    //     this.#log(`${data.unescapedName} ${old} is too new, using ${currentVersionString}`);
                    // }
                }
            } catch {
                // ignore
            }
        }

        const isDeprecated = !!fullManifest.deprecated || !!latestManifest.deprecated;

        if (
            cached?.kind === `found` && cached.current === fullManifest.version && cached.isDeprecated === isDeprecated
        ) {
            return cached;
        }

        let outOfDate: `major` | `minor` | `too-new` | undefined;
        let hasTypes: `package.json` | `entrypoint` | `other` | undefined;

        if (data.isLatest) {
            if (
                currentVersion.major < data.major
                || (currentVersion.major === data.major && currentVersion.minor < data.minor)
            ) {
                this.#log(`${data.unescapedName} is too new`);
                outOfDate = `too-new`;
            } else if (currentVersion.major > data.major) {
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

        if (packageJSONIsTyped(fullManifest)) {
            this.#log(`${data.unescapedName} has types (package.json)`);
            hasTypes = `package.json`;
        } else {
            const { response, metadata } = await this.#tryGetPackageMetadata(data.unescapedName, currentVersionString);
            if (response) {
                const message = `failed to fetch metadata: ${response.status} ${response.statusText}`;
                this.#log(`${data.unescapedName} ${message}`);
                return { kind: `error`, message };
            }

            const candidates = new Set<string>();
            function addCandidateFromJs(candidate: string) {
                for (const c of filenameToPossibleDeclarations(candidate)) {
                    candidates.add(c);
                }
            }

            if (fullManifest.exports) {
                function walkObject(exports: unknown) {
                    if (!exports) return;
                    if (typeof exports === `string`) {
                        addCandidateFromJs(exports);
                    } else if (typeof exports === `object`) {
                        for (const value of Object.values(exports)) {
                            walkObject(value);
                        }
                    }
                }
                walkObject(fullManifest.exports);
            } else {
                candidates.add(`/index.d.ts`);
                if (typeof fullManifest.main === `string`) {
                    addCandidateFromJs(fullManifest.main);
                }
            }

            let foundEntrypoint;
            let foundOther;
            forEachFileInMetadata(metadata, (filename) => {
                if (filename.includes(`/node_modules/`)) {
                    // I can't believe you've done this.
                    return;
                }
                // eslint-disable-next-line unicorn/prefer-regexp-test
                if (dtsMatcher.match(filename)) {
                    foundOther = filename;
                }
                if (candidates.has(filename)) {
                    foundEntrypoint = filename;
                }
            });

            if (foundEntrypoint) {
                this.#log(`${data.unescapedName} has types (found ${foundEntrypoint} as entrypoint))`);
                hasTypes = `entrypoint`;
            } else if (foundOther) {
                this.#log(`${data.unescapedName} has types (found ${foundOther} as other file))`);
                hasTypes = `other`;
            }
        }

        return {
            kind: `found`,
            current: currentVersionString,
            outOfDate,
            hasTypes,
            packageJsonTypeMatches: (data.packageJsonType ?? `commonjs`) === (fullManifest.type ?? `commonjs`),
            exportsSimilar: exportsSimilar(data.exports, fullManifest.exports),
            isDeprecated,
        };
    }

    #pacoteQueue = new PQueue({ concurrency: 20 });
    #packumentCache = new Map<string, pacote.Packument>();
    async #getManifest(name: string, specifier: string, fullMetadata: boolean) {
        const result = await this.#pacoteQueue.add(
            () => pacote.manifest(`${name}@${specifier}`, { fullMetadata, packumentCache: this.#packumentCache }),
            { throwOnTimeout: true },
        );
        return NpmManifest.parse(result, { mode: `passthrough` });
    }

    async #getPackument(name: string) {
        const result = await this.#pacoteQueue.add(
            () => pacote.packument(name, { packumentCache: this.#packumentCache }),
            { throwOnTimeout: true },
        );
        return result;
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
    return a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
}

function packageJSONIsTyped(p: NpmManifest): boolean {
    return !!p.types
        || !!p.typings
        || (!!p.exports && typeof p.exports === `object`
            && Object.values(p.exports).some((value) => typeof value !== `string` && value.types));
}

const declarationMappings = new Map([
    [`.cjs`, `.d.cts`],
    [`.mjs`, `.d.mts`],
    [`.js`, `.d.ts`],
]);

function filenameToPossibleDeclarations(filename: string): string[] {
    const ext = path.extname(filename);
    const staticMapping = declarationMappings.get(ext);
    const arr = staticMapping ? [filename.slice(0, -ext.length) + staticMapping]
        : [`${filename}.d.ts`, `${filename}/index.d.ts`];
    return arr.map((p) => path.posix.resolve(`/`, p));
}

// Based on `getPackageNameFromAtTypesDirectory` in TypeScript.
function unmangleScopedPackage(packageName: string): string | undefined {
    const separator = `__`;
    return packageName.includes(separator) ? `@${packageName.replace(separator, `/`)}` : undefined;
}

const typesPrefix = `@types/`;
function removeTypesPrefix(name: string) {
    return name.startsWith(typesPrefix) ? name.slice(typesPrefix.length) : name;
}

function exportsSimilar(a: {} | undefined | null, b: {} | undefined | null): boolean {
    a ??= undefined;
    b ??= undefined;
    if (typeof a !== typeof b) return false;
    if (typeof a !== `object` || typeof b !== `object`) return true;
    if (Array.isArray(a) || Array.isArray(b)) return true;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    aKeys.sort();
    bKeys.sort();
    for (const [i, aKey] of aKeys.entries()) {
        if (aKey !== bKeys[i]) return false;
    }

    return true;
}
