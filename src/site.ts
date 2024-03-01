/* eslint-disable unicorn/no-array-push-push */
import * as fs from "node:fs";
import path from "node:path";

import { Command, Option } from "clipanion";
import { npmHighImpact } from "npm-high-impact";

import { CachedInfo } from "./common.js";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: `base` });

export class GenerateSiteCommand extends Command {
    static override paths = [[`generate-site`]];

    input = Option.String(`--input`, { required: true });
    output = Option.String(`--output`, { required: true });
    verbose = Option.Boolean(`--verbose`, false);

    override async execute(): Promise<number | void> {
        const highImpact = new Set(npmHighImpact);

        const data: CachedInfo[] = [];

        for (const file of iterateFiles(this.input)) {
            const content = fs.readFileSync(file, `utf8`);
            const json = JSON.parse(content);
            data.push(CachedInfo.parse(json));
        }

        if (data.length === 0) {
            throw new Error(`No data found`);
        }

        data.sort((a, b) => collator.compare(a.subDirectoryPath, b.subDirectoryPath));

        type Row = [
            typesPackageLink: string,
            currentPackageLink: string,
            statusOutdated: string,
            statusNotNeeded: string,
            deprecated: string,
            packageJsonTypeMatches: string,
            packageJsonExportsMismatch: string,
        ];
        const RowIndex = {
            typesPackageLink: 0,
            currentPackageLink: 1,
            statusOutdated: 2,
            statusNotNeeded: 3,
            deprecated: 4,
            packageJsonTypeMatches: 5,
            packageJsonExportsMismatch: 6,
        };

        const errorRows: Row[] = [];
        const notInRegistryRows: Row[] = [];
        const unpublishedRows: Row[] = [];
        const unmatchedVersionRows: Row[] = [];
        const outOfDateRows: Row[] = [];
        const minorOutOfDateRows: Row[] = [];
        const dtNotNeededRows: Row[] = [];
        const deprecatedRows: Row[] = [];
        const packageJsonTypeMismatchRows: Row[] = [];
        const packageJsonExportsMismatchRows: Row[] = [];

        const totalCount = data.length;
        let nonNpmCount = 0;
        let conflictCount = 0;

        for (const d of data) {
            const row: Row = [
                `[${d.fullNpmName}@${d.typesVersion}](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/${d.subDirectoryPath})`,
                `❓`,
                `✅`,
                `✅`,
                `✅`,
                `✅`,
                `✅`,
            ];

            switch (d.status.kind) {
                case `error`:
                    row[RowIndex.currentPackageLink] =
                        `[${d.unescapedName}](https://www.npmjs.com/package/${d.unescapedName})`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    errorRows.push(row);
                    break;
                case `found`: {
                    if (d.status.isDeprecated) {
                        row[RowIndex.deprecated] = `❌`;
                        deprecatedRows.push(row);
                    }

                    const hasProblem = d.status.hasTypes || d.status.outOfDate;
                    if (!hasProblem) {
                        continue;
                    }
                    row[RowIndex.currentPackageLink] =
                        `[${d.unescapedName}@${d.status.current}](https://www.npmjs.com/package/${d.unescapedName}/v/${d.status.current})`;

                    if (d.status.outOfDate === `too-new`) {
                        row[RowIndex.statusOutdated] = `🤨`;
                        unmatchedVersionRows.push(row);
                    }

                    if (d.status.outOfDate === `major`) {
                        row[RowIndex.statusOutdated] = `❌`;
                        outOfDateRows.push(row);
                    }

                    if (d.status.outOfDate === `minor`) {
                        row[RowIndex.statusOutdated] = `⚠️`;
                        minorOutOfDateRows.push(row);
                    }

                    if (d.status.hasTypes === `package.json`) {
                        row[RowIndex.statusNotNeeded] = `❌`;
                        dtNotNeededRows.push(row);
                    }

                    if (d.status.hasTypes === `entrypoint`) {
                        row[RowIndex.statusNotNeeded] = `⚠️`;
                        dtNotNeededRows.push(row);
                    }

                    if (d.status.hasTypes === `other`) {
                        row[RowIndex.statusNotNeeded] = `🤨`;
                        dtNotNeededRows.push(row);
                    }

                    if (!d.status.packageJsonTypeMatches) {
                        row[RowIndex.packageJsonTypeMatches] = `❌`;
                        packageJsonTypeMismatchRows.push(row);
                    }

                    if (!d.status.exportsSimilar) {
                        row[RowIndex.packageJsonExportsMismatch] = `❌`;
                        packageJsonExportsMismatchRows.push(row);
                    }

                    

                    break;
                }
                case `not-in-registry`:
                    row[RowIndex.currentPackageLink] = `❓`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    notInRegistryRows.push(row);
                    break;
                case `missing-version`:
                    row[RowIndex.currentPackageLink] =
                        `[${d.unescapedName}](https://www.npmjs.com/package/${d.unescapedName})`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    unmatchedVersionRows.push(row);
                    break;
                case `unpublished`:
                    row[RowIndex.currentPackageLink] =
                        `[${d.unescapedName}](https://registry.npmjs.org/${d.unescapedName}/)`;
                    row[RowIndex.statusOutdated] = `❓`;
                    row[RowIndex.statusNotNeeded] = `❓`;
                    unpublishedRows.push(row);
                    break;
                case `non-npm`:
                    nonNpmCount++;
                    continue;
                    case `conflict`:
                        conflictCount++;
                        continue;
                default:
                    // d.status.kind satisfies never;
            }

            if (highImpact.has(d.fullNpmName)) {
                row[RowIndex.typesPackageLink] = `🔥 ${row[RowIndex.typesPackageLink]}`;
            }

            if (highImpact.has(d.unescapedName) && row[RowIndex.currentPackageLink] !== `❓`) {
                row[RowIndex.currentPackageLink] = `🔥 ${row[RowIndex.currentPackageLink]}`;
            }
        }

        const lines: string[] = [];

        lines.push(`There are currently ${totalCount} packages in DefinitelyTyped.`);
        lines.push(``);
        lines.push(`Of them, ${nonNpmCount} are non-npm packages and ${conflictCount} intentionally conflict with npm packages.`);
        lines.push(``);
        lines.push(`Of the remaining ${totalCount - nonNpmCount - conflictCount} packages:`);
        lines.push(``);
        if (errorRows.length > 0) lines.push(`- ${errorRows.length} had errors while fetching info.`);
        if (notInRegistryRows.length > 0) {
            lines.push(
                `- ${notInRegistryRows.length} are missing from the npm registry and may need to be marked as non-npm.`,
            );
        }
        if (unpublishedRows.length > 0) {
            lines.push(
                `- ${unpublishedRows.length} appear to contain types for a package that has been unpublished.`,
            );
        }
        if (unmatchedVersionRows.length > 0) {
            lines.push(
                `- ${unmatchedVersionRows.length} appear to contain types for a version that does not match any on npm.`,
            );
        }
        if (dtNotNeededRows.length > 0) {
            lines.push(`- ${dtNotNeededRows.length} appear to be typed upstream and may be removable.`);
        }
        if (outOfDateRows.length > 0) {
            lines.push(`- ${outOfDateRows.length} are out of date (major version or 0.x mismatch).`);
        }
        if (minorOutOfDateRows.length > 0) {
            lines.push(`- ${minorOutOfDateRows.length} are out of date minorly (excluding 0.x packages).`);
        }
        if (deprecatedRows.length > 0) {
            lines.push(`- ${deprecatedRows.length} are for a package that has been deprecated.`);
        }
        if (packageJsonTypeMismatchRows.length > 0) {
            lines.push(`- ${packageJsonTypeMismatchRows.length} have a \`package.json\` type mismatch.`);
        }
        if (packageJsonExportsMismatchRows.length > 0) {
            lines.push(`- ${packageJsonExportsMismatchRows.length} have a \`package.json\` exports mismatch.`);
        }
        lines.push(``);

        function pushRows(rows: Row[]) {
            lines.push(`| Types | Current | Outdated? | DT Needed? | Deprecated? | \`type=\` OK? | \`exports\` OK? |`);
            lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
            for (const row of rows) {
                lines.push(`| ${row.join(` | `)} |`);
            }
        }

        function pushSection(title: string, rows: Row[]) {
            if (rows.length === 0) {
                return;
            }

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
        pushSection(`Unpublished`, unpublishedRows);
        pushSection(`Unmatched versions`, unmatchedVersionRows);
        pushSection(`Potentially removable`, dtNotNeededRows);
        pushSection(`Deprecated`, deprecatedRows);
        pushSection(`Out of date`, outOfDateRows);
        pushSection(`Out of date minorly`, minorOutOfDateRows);
        pushSection(`\`package.json\` type mismatch`, packageJsonTypeMismatchRows);
        pushSection(`\`package.json\` exports mismatch`, packageJsonExportsMismatchRows);

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
