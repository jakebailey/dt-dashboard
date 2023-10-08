/* eslint-disable unicorn/no-array-push-push */
import * as fs from "node:fs";
import path from "node:path";

import { Command, Option } from "clipanion";

import { CachedInfo } from "./common.js";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: `base` });

export class GenerateCommand extends Command {
    static override paths = [[`generate`]];

    input = Option.String(`--input`, { required: true });
    output = Option.String(`--output`, { required: true });
    verbose = Option.Boolean(`--verbose`, false);

    override async execute(): Promise<number | void> {
        const data: CachedInfo[] = [];

        for (const file of iterateFiles(this.input)) {
            const content = fs.readFileSync(file, `utf8`);
            const json = JSON.parse(content);
            data.push(CachedInfo.parse(json));
        }

        data.sort((a, b) =>
            collator.compare(a.typesName, b.typesName) || collator.compare(a.typesVersion, b.typesVersion)
        );

        type Row = [
            typesPackageLink: string,
            typesVersion: string,
            realPackageLink: string,
            realPackageVersion: string,
            upstreamIsTyped: string,
        ];

        const rows: Row[] = [];

        const totalCount = data.length;
        let errorCount = 0;
        let notInRegistryCount = 0;
        let nonNpmCount = 0;
        let outOfDateCount = 0;
        let dtNotNeededCount = 0;

        for (const d of data) {
            const typesPackageLink = `[${d.typesName}](https://www.npmjs.com/package/${d.typesName})`;
            const typesVersion = d.typesVersion;
            let realPackageLink: string;
            let realPackageVersion: string;
            let dtIsNeeded: string;

            switch (d.status.kind) {
                case `error`:
                    errorCount++;
                    realPackageLink = `—`;
                    realPackageVersion = `—`;
                    dtIsNeeded = `—`;
                    break;
                case `found`:
                    if (!d.status.hasTypes && !d.status.outOfDate) {
                        continue;
                    }
                    realPackageLink =
                        `[${d.realName}](https://www.npmjs.com/package/${d.realName}/v/${d.status.latest})`;
                    if (d.status.outOfDate) {
                        realPackageVersion = `⚠️ ${d.status.latest}`;
                        outOfDateCount++;
                    } else {
                        realPackageVersion = d.status.latest;
                    }

                    if (d.status.hasTypes) {
                        dtIsNeeded = `❌`;
                        dtNotNeededCount++;
                    } else {
                        dtIsNeeded = `✅`;
                    }

                    break;
                case `not-in-registry`:
                    notInRegistryCount++;
                    realPackageLink = `❓`;
                    realPackageVersion = `❓`;
                    dtIsNeeded = `❓`;
                    break;
                case `non-npm`:
                    nonNpmCount++;
                    continue;
            }

            rows.push([typesPackageLink, typesVersion, realPackageLink, realPackageVersion, dtIsNeeded]);
        }

        const lines: string[] = [];

        lines.push(`# DT Dashboard`);
        lines.push(``);
        lines.push(`There are currently ${totalCount} packages in DefinitelyTyped.`);
        lines.push(``);
        lines.push(`Of them, ${nonNpmCount} are non-npm packages.`);
        lines.push(``);
        lines.push(`Of the remaining ${totalCount - nonNpmCount} packages:`);
        lines.push(``);
        lines.push(`- ${errorCount} errored while fetching package.json.`);
        lines.push(`- ${notInRegistryCount} are missing from the npm registry and may need to be marked as non-npm.`);
        lines.push(`- ${outOfDateCount} are out of date (major version or 0.x mismatch).`);
        lines.push(`- ${dtNotNeededCount} are now typed and can be removed from DefinitelyTyped.`);
        lines.push(``);

        lines.push(`## Packages`);
        lines.push(``);
        lines.push(`| Types Package | Types Version | Real Package | Real Package Version | DT Needed? |`);
        lines.push(`| ------------- | ------------- | ------------ | -------------------- | ---------- |`);
        for (const row of rows) {
            lines.push(`| ${row.join(` | `)} |`);
        }
        lines.push(``);

        await fs.promises.mkdir(this.output, { recursive: true });
        await fs.promises.writeFile(path.join(this.output, `README.md`), lines.join(`\n`));
    }
}

function* iterateFiles(dir: string): Generator<string> {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            yield* iterateFiles(filePath);
        } else {
            yield filePath;
        }
    }
}
