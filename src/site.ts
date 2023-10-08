/* eslint-disable unicorn/no-array-push-push */
import * as fs from "node:fs";
import path from "node:path";

import { Command, Option } from "clipanion";

import { CachedInfo } from "./common.js";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: `base` });

export class GenerateSiteCommand extends Command {
    static override paths = [[`generate-site`]];

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

        data.sort((a, b) => collator.compare(a.subDirectoryPath, b.subDirectoryPath));

        type Row = [
            typesPackageLink: string,
            currentPackageLink: string,
            statusOutdated: string,
            statusNotNeeded: string,
        ];
        const RowIndex = {
            typesPackageLink: 0,
            currentPackageLink: 1,
            statusOutdated: 2,
            statusNotNeeded: 3,
        };

        const errorRows: Row[] = [];
        const notInRegistryRows: Row[] = [];
        const outOfDateRows: Row[] = [];
        const minorOutOfDateRows: Row[] = [];
        const dtNotNeededRows: Row[] = [];

        const totalCount = data.length;
        let nonNpmCount = 0;

        for (const d of data) {
            const row: Row = [
                `[${d.fullNpmName}@${d.typesVersion}](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/${d.subDirectoryPath})`,
                `❓`,
                `✅`,
                `✅`,
            ];

            switch (d.status.kind) {
                case `error`:
                    row[RowIndex.currentPackageLink] = `❓`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    errorRows.push(row);
                    break;
                case `found`: {
                    const hasProblem = d.status.hasTypes || d.status.outOfDate || d.status.minorOutOfDate;
                    if (!hasProblem) {
                        continue;
                    }
                    row[RowIndex.currentPackageLink] =
                        `[${d.unescapedName}@${d.status.current}](https://www.npmjs.com/package/${d.unescapedName}/v/${d.status.current})`;

                    if (d.status.outOfDate) {
                        row[RowIndex.statusOutdated] = `❌`;
                        outOfDateRows.push(row);
                    }

                    if (d.status.minorOutOfDate) {
                        row[RowIndex.statusOutdated] = `⚠️`;
                        minorOutOfDateRows.push(row);
                    }

                    if (d.status.hasTypes) {
                        row[RowIndex.statusNotNeeded] = `❌`;
                        dtNotNeededRows.push(row);
                    }

                    break;
                }
                case `not-in-registry`:
                    row[RowIndex.currentPackageLink] = `❓`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    notInRegistryRows.push(row);
                    break;
                case `non-npm`:
                    nonNpmCount++;
                    continue;
            }
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
        lines.push(`- ${errorRows.length} had errors while fetching info.`);
        lines.push(
            `- ${notInRegistryRows.length} are missing from the npm registry and may need to be marked as non-npm.`,
        );
        lines.push(`- ${dtNotNeededRows.length} are now typed and can be removed from DefinitelyTyped.`);
        lines.push(`- ${outOfDateRows.length} are out of date (major version or 0.x mismatch).`);
        lines.push(`- ${minorOutOfDateRows.length} are out of date minorly (excluding 0.x packages).`);
        lines.push(``);

        function pushRows(rows: Row[]) {
            lines.push(`| Types | Current | Outdated? | DT Needed? |`);
            lines.push(`| --- | --- | --- | --- |`);
            for (const row of rows) {
                lines.push(`| ${row.join(` | `)} |`);
            }
        }

        function pushSection(title: string, rows: Row[]) {
            lines.push(`# ${title}`);
            lines.push(``);
            lines.push(`<details><summary>Expand...</summary>`);
            lines.push(``);
            pushRows(rows);
            lines.push(``);
            lines.push(`</details>`);
            lines.push(``);
            lines.push(`<br>`);
            lines.push(``);
        }

        pushSection(`Errors`, errorRows);

        pushSection(`Missing from registry`, notInRegistryRows);

        pushSection(`DT not needed`, dtNotNeededRows);

        pushSection(`Out of date`, outOfDateRows);

        pushSection(`Out of date minorly`, minorOutOfDateRows);

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
